import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationStore } from "../src/conversation/in-memory-conversation-store.ts";
import { type ConversationEvent, ConversationEvents } from "../src/events/conversation-events.ts";
import type { LLMProvider } from "../src/llm/llm-provider.ts";
import { StubLLMProvider } from "../src/llm/stub-llm-provider.ts";
import { AgentRuntime } from "../src/runtime/agent-runtime.ts";
import { TaskManager } from "../src/tasks/task-manager.ts";
import { InMemoryTaskStore } from "../src/tasks/task-store.ts";
import { TaskFailedError } from "../src/tasks/task-worker.ts";
import { createGetCurrentTimeTool } from "../src/tools/get-current-time.ts";
import { ToolExecutor } from "../src/tools/tool-executor.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import {
  captureLogger,
  ControlledWorker,
  eventually,
  FIXED_NOW,
  ScriptedLLMProvider,
  textResponse,
} from "./helpers.ts";

function record(events: ConversationEvents, conversationId: string): ConversationEvent[] {
  const seen: ConversationEvent[] = [];
  events.subscribe(conversationId, (event) => seen.push(event));
  return seen;
}

function runtimeWith(llm: LLMProvider) {
  const { logger, events: logEvents } = captureLogger();
  const events = new ConversationEvents(logger);
  const registry = new ToolRegistry();
  registry.register(createGetCurrentTimeTool(() => FIXED_NOW));
  const toolExecutor = new ToolExecutor({ registry });
  const runtime = new AgentRuntime({ llm, store: new InMemoryConversationStore(), toolExecutor, logger, events });
  return { runtime, events, logEvents };
}

test("delivers a conversation's events to its subscribers and everything to subscribeAll", () => {
  const { logger } = captureLogger();
  const events = new ConversationEvents(logger);
  const a = record(events, "a");
  const all: ConversationEvent[] = [];
  const stopAll = events.subscribeAll((event) => all.push(event));

  events.publish({ type: "turn.started", conversationId: "a", turnId: "t1", initiator: "user", text: "hi" });
  events.publish({ type: "turn.started", conversationId: "b", turnId: "t2", initiator: "user", text: "hello" });
  stopAll();
  events.publish({ type: "turn.started", conversationId: "a", turnId: "t3", initiator: "user", text: "again" });

  assert.deepEqual(a.map((e) => e.type === "turn.started" && e.turnId), ["t1", "t3"]);
  assert.deepEqual(all.map((e) => e.conversationId), ["a", "b"]);
});

test("a failing subscriber is logged and doesn't stop the others", () => {
  const { logger, lines } = captureLogger();
  const events = new ConversationEvents(logger);
  events.subscribe("a", () => {
    throw new Error("socket closed");
  });
  const seen = record(events, "a");

  events.publish({ type: "turn.started", conversationId: "a", turnId: "t1", initiator: "user", text: "hi" });

  assert.equal(seen.length, 1);
  assert.equal(lines.at(-1)?.event, "events.listener_failed");
});

test("unsubscribing the last listener forgets the conversation", () => {
  const { logger } = captureLogger();
  const events = new ConversationEvents(logger);
  const seen: ConversationEvent[] = [];
  const stop = events.subscribe("a", (event) => seen.push(event));
  stop();
  stop(); // idempotent

  events.publish({ type: "turn.started", conversationId: "a", turnId: "t1", initiator: "user", text: "hi" });

  assert.equal(seen.length, 0);
});

test("a turn publishes started, its reply as it streams, then completed", async () => {
  const { runtime, events } = runtimeWith(new StubLLMProvider());
  const seen = record(events, "c1");

  const result = await runtime.runTurn({ conversationId: "c1", text: "hello there" });

  const { turnId } = result;
  assert.deepEqual(seen.at(0), { type: "turn.started", conversationId: "c1", turnId, initiator: "user", text: "hello there" });
  assert.deepEqual(seen.at(-1), { type: "turn.completed", conversationId: "c1", turnId, reply: result.reply });
  const deltas = seen.slice(1, -1);
  assert.ok(deltas.length > 1, "streamed in pieces");
  assert.equal(deltas.map((e) => (e.type === "reply.delta" && e.turnId === turnId ? e.text : "?")).join(""), result.reply);
});

test("tool calls and their outcomes are published as they happen", async () => {
  const { runtime, events } = runtimeWith(new StubLLMProvider());
  const seen = record(events, "c1");

  const result = await runtime.runTurn({ conversationId: "c1", text: "What time is it in Asia/Tokyo?" });

  const types = seen.map((e) => e.type).filter((type, i, all) => type !== all[i - 1]); // collapse delta runs
  assert.deepEqual(types, ["turn.started", "tool.called", "tool.finished", "reply.delta", "turn.completed"]);
  const called = seen.find((e) => e.type === "tool.called");
  const finished = seen.find((e) => e.type === "tool.finished");
  assert.ok(called?.type === "tool.called" && finished?.type === "tool.finished");
  assert.deepEqual([called.name, called.input], ["get_current_time", { timeZone: "Asia/Tokyo" }]);
  assert.deepEqual([finished.toolCallId, finished.isError], [called.toolCallId, false]);
  assert.match(result.reply, /get_current_time returned/);
});

test("failed and cancelled turns publish turn.failed with the reason only", async () => {
  const { runtime, events } = runtimeWith(new ScriptedLLMProvider([])); // no responses: generate() throws
  const seen = record(events, "c1");

  await assert.rejects(runtime.runTurn({ conversationId: "c1", text: "boom" }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.runTurn({ conversationId: "c1", text: "never mind" }, controller.signal));

  const failures = seen.filter((e) => e.type === "turn.failed");
  assert.deepEqual(failures.map((e) => e.type === "turn.failed" && e.reason), ["error", "cancelled"]);
  assert.ok(!JSON.stringify(failures).includes("no responses left"), "error details stay in the logs");
});

test("queued turns don't interleave their events", async () => {
  // The first reply is held back until the second turn has been submitted.
  const { promise: gate, resolve: open } = Promise.withResolvers<void>();
  const scripted = new ScriptedLLMProvider([textResponse("one"), textResponse("two")]);
  const llm: LLMProvider = {
    name: "gated",
    generate: async (request) => {
      if (scripted.requests.length === 0) await gate;
      return scripted.generate(request);
    },
  };
  const { runtime, events } = runtimeWith(llm);
  const seen = record(events, "c1");

  const first = runtime.runTurn({ conversationId: "c1", text: "first" });
  const second = runtime.runTurn({ conversationId: "c1", text: "second" });
  open();
  const [a, b] = await Promise.all([first, second]);

  assert.deepEqual(
    seen.map((e) => `${e.type}:${"turnId" in e ? e.turnId : ""}`),
    [`turn.started:${a.turnId}`, `turn.completed:${a.turnId}`, `turn.started:${b.turnId}`, `turn.completed:${b.turnId}`],
  );
});

function tasksWith(worker: ControlledWorker) {
  const { logger } = captureLogger();
  const events = new ConversationEvents(logger);
  const tasks = new TaskManager({ store: new InMemoryTaskStore(), worker, logger, events });
  return { tasks, events };
}

test("task changes are published in order, and a superseded attempt's updates are not", async () => {
  const worker = new ControlledWorker({ honourAbort: false });
  const { tasks, events } = tasksWith(worker);
  const seen = record(events, "c1");

  const task = await tasks.start("c1", "Build an API");
  await eventually(() => worker.runs.length === 1);
  worker.runs[0]!.context.reportProgress("Scaffolding");
  await eventually(() => seen.length === 2);
  await tasks.revise("c1", task.id, "Use Fastify");
  await eventually(() => worker.runs.length === 2);

  // The first attempt ignores the abort and finishes late: dropped, not published.
  worker.runs[0]!.resolve("Express version");
  worker.runs[1]!.resolve("Fastify version");
  await eventually(async () => (await tasks.get("c1", task.id)).status === "completed");

  const updates = seen.map((e) => (e.type === "task.updated" ? [e.change, e.task.attempt, e.task.status] : e.type));
  assert.deepEqual(updates, [
    ["started", 1, "running"],
    ["progress", 1, "running"],
    ["revised", 2, "running"],
    ["completed", 2, "completed"],
  ]);
  const completed = seen.at(-1);
  assert.ok(completed?.type === "task.updated" && completed.task.result === "Fastify version");
});

test("cancellation, failure and shutdown are published too", async () => {
  const worker = new ControlledWorker();
  const { tasks, events } = tasksWith(worker);
  const seen = record(events, "c1");

  const cancelled = await tasks.start("c1", "One");
  const failed = await tasks.start("c1", "Two");
  const interrupted = await tasks.start("c1", "Three");
  await eventually(() => worker.runs.length === 3);
  await tasks.cancel("c1", cancelled.id);
  worker.runs[1]!.reject(new TaskFailedError("tests failed"));
  await eventually(async () => (await tasks.get("c1", failed.id)).status === "failed");
  await tasks.shutdown();

  const last = (taskId: string) =>
    seen.findLast((e) => e.type === "task.updated" && e.task.taskId === taskId) as Extract<
      ConversationEvent,
      { type: "task.updated" }
    >;
  assert.equal(last(cancelled.id).change, "cancelled");
  assert.deepEqual([last(failed.id).change, last(failed.id).task.error], ["failed", "tests failed"]);
  assert.deepEqual([last(interrupted.id).change, last(interrupted.id).task.status], ["interrupted", "failed"]);
});

test("a published task is a snapshot, not a live view", async () => {
  const worker = new ControlledWorker();
  const { tasks, events } = tasksWith(worker);
  const seen = record(events, "c1");

  const task = await tasks.start("c1", "Build an API");
  await eventually(() => worker.runs.length === 1);
  worker.runs[0]!.context.reportProgress("one");
  worker.runs[0]!.context.reportProgress("two");
  await eventually(() => seen.length === 3);

  const progress = seen.map((e) => (e.type === "task.updated" ? e.task.progress : []));
  assert.deepEqual(progress, [[], ["one"], ["one", "two"]]);
  await tasks.cancel("c1", task.id);
});
