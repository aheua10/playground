import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationStore } from "../src/conversation/in-memory-conversation-store.ts";
import { type ConversationEvent, ConversationEvents } from "../src/events/conversation-events.ts";
import type { LLMProvider } from "../src/llm/llm-provider.ts";
import { StubLLMProvider } from "../src/llm/stub-llm-provider.ts";
import { AgentRuntime } from "../src/runtime/agent-runtime.ts";
import { TaskManager } from "../src/tasks/task-manager.ts";
import { startTaskNotifier } from "../src/tasks/task-notifier.ts";
import { InMemoryTaskStore } from "../src/tasks/task-store.ts";
import { createTaskTools } from "../src/tasks/task-tools.ts";
import { ToolExecutor } from "../src/tools/tool-executor.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { captureLogger, ControlledWorker, eventually, ScriptedLLMProvider, textResponse, toolCallResponse } from "./helpers.ts";

function setup(llm: LLMProvider) {
  const { logger, lines } = captureLogger();
  const events = new ConversationEvents(logger);
  const worker = new ControlledWorker();
  const tasks = new TaskManager({ store: new InMemoryTaskStore(), worker, logger, events });
  const registry = new ToolRegistry();
  for (const tool of createTaskTools(tasks)) registry.register(tool);
  const store = new InMemoryConversationStore();
  const runtime = new AgentRuntime({ llm, store, toolExecutor: new ToolExecutor({ registry }), logger, events });
  const stop = startTaskNotifier({ events, runtime });
  const seen: ConversationEvent[] = [];
  events.subscribe("c1", (event) => seen.push(event));
  return { tasks, worker, store, seen, lines, stop };
}

test("a finished task starts a platform turn that tells the user", async () => {
  const { tasks, worker, store, seen } = setup(new StubLLMProvider());
  const task = await tasks.start("c1", "Build an API");
  await eventually(() => worker.runs.length === 1);

  worker.runs[0]!.resolve("Built it.");
  await eventually(() => seen.some((e) => e.type === "turn.completed"));

  const started = seen.find((e) => e.type === "turn.started");
  assert.ok(started?.type === "turn.started");
  assert.equal(started.initiator, "platform");
  assert.match(started.text, new RegExp(`^Task ${task.id} has completed\\.\\n\\{`));
  const [notice, reply] = await store.getMessages("c1");
  assert.equal(notice?.role, "notice");
  assert.ok(reply?.role === "assistant");
  assert.equal(reply.content, `[stub] Heads-up: Task ${task.id} has completed.`);
});

test("failures are announced; cancellations and shutdowns are not", async () => {
  const { tasks, worker, store, seen } = setup(new StubLLMProvider());
  const failing = await tasks.start("c1", "One");
  const cancelled = await tasks.start("c1", "Two");
  await tasks.start("c1", "Three");
  await eventually(() => worker.runs.length === 3);

  worker.runs[0]!.reject(new Error("boom"));
  await eventually(() => seen.some((e) => e.type === "turn.completed"));
  await tasks.cancel("c1", cancelled.id);
  await tasks.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 20)); // room for an unwanted notice turn to start

  const notices = (await store.getMessages("c1")).filter((m) => m.role === "notice");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.content, new RegExp(`^Task ${failing.id} has failed\\.`));
});

test("a notice turn can look things up but can't act", async () => {
  // The model, prompted by the notice, tries to look something up (fine) and
  // to start more work on its own (refused).
  const llm = new ScriptedLLMProvider([
    toolCallResponse(
      { id: "a", name: "list_tasks", input: {} },
      { id: "b", name: "start_coding_task", input: { instruction: "Write the tests too" } },
    ),
    textResponse("Your API task is done. Want me to add tests?"),
  ]);
  const { tasks, worker, store, seen, lines } = setup(llm);
  await tasks.start("c1", "Build an API");
  await eventually(() => worker.runs.length === 1);

  worker.runs[0]!.resolve("Built it.");
  await eventually(() => seen.some((e) => e.type === "turn.completed"));

  const results = (await store.getMessages("c1")).filter((m) => m.role === "tool");
  assert.deepEqual(results.map((r) => [r.toolName, r.isError]), [["list_tasks", false], ["start_coding_task", true]]);
  assert.match(results[1]!.content, /not permitted here/);
  assert.equal((await tasks.list("c1")).length, 1, "no task was started");
  assert.ok(lines.some((line) => line.event === "tool.rejected" && line.reason === "not_permitted"));
});
