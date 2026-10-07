import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type ConversationEvent, ConversationEvents } from "../src/events/conversation-events.ts";
import { StubLLMProvider } from "../src/llm/stub-llm-provider.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { SqliteConversationStore } from "../src/persistence/sqlite-conversation-store.ts";
import { SqliteTaskStore } from "../src/persistence/sqlite-task-store.ts";
import { AgentRuntime } from "../src/runtime/agent-runtime.ts";
import { TaskManager } from "../src/tasks/task-manager.ts";
import { createTaskTools } from "../src/tasks/task-tools.ts";
import { ToolExecutor } from "../src/tools/tool-executor.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { captureLogger, ControlledWorker, eventually } from "./helpers.ts";

/** One "process": runtime and task manager on the database file, as main.ts wires them. */
function boot(file: string) {
  const { logger, lines } = captureLogger();
  const database = openDatabase(file);
  const events = new ConversationEvents(logger);
  const seen: ConversationEvent[] = [];
  events.subscribeAll((event) => seen.push(event));
  const worker = new ControlledWorker();
  const tasks = new TaskManager({ store: new SqliteTaskStore(database), worker, logger, events });
  const registry = new ToolRegistry();
  for (const tool of createTaskTools(tasks)) registry.register(tool);
  const runtime = new AgentRuntime({
    llm: new StubLLMProvider(),
    store: new SqliteConversationStore(database),
    toolExecutor: new ToolExecutor({ registry }),
    logger,
    events,
  });
  return { database, tasks, runtime, worker, seen, lines };
}

async function databaseFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "agent-restart-")), "agent-platform.db");
}

test("after a crash: the conversation continues, and the task cut off is recorded as interrupted", async () => {
  const file = await databaseFile();
  const before = boot(file);
  await before.runtime.runTurn({ conversationId: "alice/demo", text: "hello" });
  await before.runtime.runTurn({ conversationId: "alice/demo", text: "Create a TypeScript server" });
  const [task] = await before.tasks.list("alice/demo");
  await eventually(() => before.worker.runs.length === 1);
  // Crash: no shutdown(), the process just ends with the task still running.
  before.database.close();

  const after = boot(file);
  assert.equal(await after.tasks.recoverInterrupted(), 1);

  const recovered = await after.tasks.get("alice/demo", task!.id);
  assert.equal(recovered.status, "failed");
  assert.match(recovered.error!, /Interrupted: the server stopped/);
  const update = after.seen.find((e) => e.type === "task.updated");
  assert.equal(update?.type === "task.updated" && update.change, "interrupted"); // not announced as a failure
  assert.ok(after.lines.some((line) => line.event === "task.failed" && line.recovered === true));

  // The history is all there, and the next turn builds on it.
  const reply = await after.runtime.runTurn({ conversationId: "alice/demo", text: "and now?" });
  assert.match(reply.reply, /context: 7 messages/);
  // Revising the interrupted task starts a new attempt.
  await after.tasks.revise("alice/demo", task!.id, "Use Fastify");
  await eventually(() => after.worker.runs.length === 1);
  assert.equal(after.worker.runs[0]!.input.attempt, 2);
  await after.tasks.shutdown();
  after.database.close();
});

test("after a clean shutdown there is nothing to recover", async () => {
  const file = await databaseFile();
  const before = boot(file);
  const task = await before.tasks.start("alice/demo", "Build an API");
  await eventually(() => before.worker.runs.length === 1);
  await before.tasks.shutdown();
  before.database.close();

  const after = boot(file);
  assert.equal(await after.tasks.recoverInterrupted(), 0);
  assert.match((await after.tasks.get("alice/demo", task.id)).error!, /Interrupted: the server shut down/);
  after.database.close();
});
