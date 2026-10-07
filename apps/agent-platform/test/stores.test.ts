import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ConversationStore } from "../src/conversation/conversation-store.ts";
import { InMemoryConversationStore } from "../src/conversation/in-memory-conversation-store.ts";
import type { Message } from "../src/core/messages.ts";
import { openDatabase, SCHEMA_VERSION } from "../src/persistence/database.ts";
import { SqliteConversationStore } from "../src/persistence/sqlite-conversation-store.ts";
import { SqliteTaskStore } from "../src/persistence/sqlite-task-store.ts";
import type { Task } from "../src/tasks/task.ts";
import { InMemoryTaskStore, type TaskStore } from "../src/tasks/task-store.ts";

// The same contract, checked against every implementation.
const implementations: { name: string; conversations: () => ConversationStore; tasks: () => TaskStore }[] = [
  { name: "in-memory", conversations: () => new InMemoryConversationStore(), tasks: () => new InMemoryTaskStore() },
  {
    name: "sqlite",
    conversations: () => new SqliteConversationStore(openDatabase(":memory:")),
    tasks: () => new SqliteTaskStore(openDatabase(":memory:")),
  },
];

const thinking = { type: "thinking", thinking: "", signature: "sig/+=abc" };
const turn: Message[] = [
  { role: "user", content: "What time is it? 🕰️" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "t1", name: "get_current_time", input: { timeZone: "UTC" } }],
    raw: { provider: "anthropic", data: [thinking, { type: "tool_use", id: "t1", name: "get_current_time", input: {} }] },
  },
  { role: "tool", toolCallId: "t1", toolName: "get_current_time", content: '{"iso":"…"}', isError: false },
  { role: "notice", content: "Task task_1 has completed." },
];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    conversationId: "alice/demo",
    instruction: "Build an API",
    revisions: [],
    status: "running",
    attempt: 1,
    progress: [],
    createdAt: "2026-10-07T12:00:00.000Z",
    updatedAt: "2026-10-07T12:00:00.000Z",
    ...overrides,
  };
}

for (const { name, conversations, tasks } of implementations) {
  test(`${name} conversation store: appends in order, per conversation, and returns copies`, async () => {
    const store = conversations();
    assert.deepEqual(await store.getMessages("alice/demo"), []);

    await store.appendMessages("alice/demo", turn.slice(0, 2));
    await store.appendMessages("alice/demo", turn.slice(2));
    await store.appendMessages("bob/demo", [{ role: "user", content: "hi" }]);

    const history = await store.getMessages("alice/demo");
    assert.deepEqual(history, turn);
    // Provider raw data must come back exactly as stored (signed thinking blocks are replayed).
    assert.equal(JSON.stringify(history[1]), JSON.stringify(turn[1]));
    assert.deepEqual(await store.getMessages("bob/demo"), [{ role: "user", content: "hi" }]);

    history.push({ role: "user", content: "not saved" });
    assert.equal((await store.getMessages("alice/demo")).length, 4);
  });

  test(`${name} task store: upserts, looks up by id, conversation and status, and returns copies`, async () => {
    const store = tasks();
    await store.save(task());
    await store.save(task({ id: "task_2", createdAt: "2026-10-07T12:01:00.000Z", status: "completed", result: "done" }));
    await store.save(task({ id: "task_3", conversationId: "bob/demo" }));

    const saved = await store.get("task_1");
    assert.deepEqual(saved, task());
    saved!.progress.push("not saved");
    assert.deepEqual((await store.get("task_1"))!.progress, []);
    assert.equal(await store.get("task_9"), undefined);

    await store.save(task({ status: "failed", error: "boom", attempt: 2, updatedAt: "2026-10-07T12:02:00.000Z" }));
    assert.deepEqual(await store.get("task_1"), task({ status: "failed", error: "boom", attempt: 2, updatedAt: "2026-10-07T12:02:00.000Z" }));

    assert.deepEqual((await store.listByConversation("alice/demo")).map((t) => t.id).sort(), ["task_1", "task_2"]);
    assert.deepEqual((await store.listByStatus("running")).map((t) => t.id), ["task_3"]);
    assert.deepEqual((await store.listByStatus("failed")).map((t) => t.id), ["task_1"]);
  });
}

async function tempDatabasePath(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "agent-db-")), "data", "agent-platform.db");
}

test("sqlite: everything survives closing and reopening the file", async () => {
  const file = await tempDatabasePath();
  const first = openDatabase(file);
  await new SqliteConversationStore(first).appendMessages("alice/demo", turn);
  await new SqliteTaskStore(first).save(task());
  first.close();

  const second = openDatabase(file);
  assert.deepEqual(await new SqliteConversationStore(second).getMessages("alice/demo"), turn);
  assert.deepEqual(await new SqliteTaskStore(second).get("task_1"), task());
  second.close();
});

test("sqlite: a turn's messages are appended together or not at all", async () => {
  const store = new SqliteConversationStore(openDatabase(":memory:"));
  await store.appendMessages("c", [{ role: "user", content: "kept" }]);
  // The second message can't be serialized, after the first was already inserted.
  const broken = { role: "assistant", content: "", toolCalls: [], raw: { provider: "x", data: 10n } } as Message;

  await assert.rejects(store.appendMessages("c", [{ role: "user", content: "rolled back" }, broken]), TypeError);

  assert.deepEqual(await store.getMessages("c"), [{ role: "user", content: "kept" }]);
});

test("sqlite: the schema is migrated once, and a newer schema is refused", async () => {
  const file = await tempDatabasePath();
  openDatabase(file).close();
  const raw = new DatabaseSync(file);
  assert.equal(raw.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
  raw.close();
  openDatabase(file).close(); // already current: nothing to do, no error

  const downgrade = new DatabaseSync(file);
  downgrade.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  downgrade.close();
  assert.throws(() => openDatabase(file), /newer than this code knows/);
});

test("sqlite: the database is private to the server's user", { skip: process.platform === "win32" }, async () => {
  const file = await tempDatabasePath();
  openDatabase(file).close();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
});
