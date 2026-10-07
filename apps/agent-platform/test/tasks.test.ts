import assert from "node:assert/strict";
import { test } from "node:test";
import { SimulatedCodingWorker } from "../src/tasks/simulated-coding-worker.ts";
import { TaskManager } from "../src/tasks/task-manager.ts";
import { InMemoryTaskStore } from "../src/tasks/task-store.ts";
import { TaskFailedError } from "../src/tasks/task-worker.ts";
import { captureLogger, ControlledWorker, eventually } from "./helpers.ts";

function setup(options: { maxRunningPerConversation?: number; honourAbort?: boolean } = {}) {
  const worker = new ControlledWorker({ honourAbort: options.honourAbort });
  const { logger, events } = captureLogger();
  const manager = new TaskManager({ store: new InMemoryTaskStore(), worker, logger, ...options });
  const statusOf = async (taskId: string) => (await manager.get("c1", taskId)).status;
  return { manager, worker, events, statusOf };
}

test("start returns at once with a running task; the worker's result completes it later", async () => {
  const { manager, worker, statusOf } = setup();

  const task = await manager.start("c1", "Create a TypeScript server");

  assert.equal(task.status, "running");
  assert.match(task.id, /^task_[a-z0-9]{10}$/);
  await eventually(() => worker.runs.length === 1);
  assert.deepEqual(worker.runs[0]!.input.requirements, ["Create a TypeScript server"]);

  worker.runs[0]!.context.reportProgress("Planning the work");
  worker.runs[0]!.resolve("server created");

  await eventually(async () => (await statusOf(task.id)) === "completed");
  const done = await manager.get("c1", task.id);
  assert.equal(done.result, "server created");
  assert.deepEqual(done.progress, ["Planning the work"]);
});

test("revise restarts with the full requirements; a late result from the old attempt is dropped", async () => {
  // A worker that ignores cancellation, so the superseded attempt really does finish late.
  const { manager, worker, events, statusOf } = setup({ honourAbort: false });
  const task = await manager.start("c1", "Create a server with Express");
  await eventually(() => worker.runs.length === 1);

  const revised = await manager.revise("c1", task.id, "Use Fastify instead of Express");

  assert.equal(revised.attempt, 2);
  assert.equal(revised.status, "running");
  assert.ok(worker.runs[0]!.context.signal.aborted);
  await eventually(() => worker.runs.length === 2);
  assert.deepEqual(worker.runs[1]!.input.requirements, [
    "Create a server with Express",
    "Use Fastify instead of Express",
  ]);

  worker.runs[0]!.resolve("express server"); // too late: attempt 1 was superseded
  await eventually(() => events().includes("task.stale_update_dropped"));
  assert.equal(await statusOf(task.id), "running");

  worker.runs[1]!.resolve("fastify server");
  await eventually(async () => (await statusOf(task.id)) === "completed");
  assert.equal((await manager.get("c1", task.id)).result, "fastify server");
});

test("cancel stops the running attempt and is final", async () => {
  const { manager, worker } = setup();
  const task = await manager.start("c1", "Create a server");
  await eventually(() => worker.runs.length === 1);

  const cancelled = await manager.cancel("c1", task.id);

  assert.equal(cancelled.status, "cancelled");
  assert.ok(worker.runs[0]!.context.signal.aborted);
  await assert.rejects(manager.cancel("c1", task.id), /already cancelled/);
  await assert.rejects(manager.revise("c1", task.id, "more"), /was cancelled/);
});

test("revising a finished task runs it again", async () => {
  const { manager, worker, statusOf } = setup();
  const task = await manager.start("c1", "Create a server");
  await eventually(() => worker.runs.length === 1);
  worker.runs[0]!.resolve("done");
  await eventually(async () => (await statusOf(task.id)) === "completed");

  const revised = await manager.revise("c1", task.id, "Add tests");

  assert.equal(revised.status, "running");
  assert.equal(revised.result, undefined);
  await eventually(() => worker.runs.length === 2);
});

test("tasks are only visible to the conversation that started them", async () => {
  const { manager } = setup();
  const task = await manager.start("c1", "Create a server");

  await assert.rejects(manager.get("c2", task.id), /No task/);
  await assert.rejects(manager.cancel("c2", task.id), /No task/);
  assert.deepEqual(await manager.list("c2"), []);
  assert.equal((await manager.list("c1")).length, 1);
});

test("limits running tasks per conversation", async () => {
  const { manager } = setup({ maxRunningPerConversation: 2 });
  await manager.start("c1", "one");
  await manager.start("c1", "two");

  await assert.rejects(manager.start("c1", "three"), /already has 2 running tasks/);
  await manager.start("c2", "other conversation is unaffected");
});

test("worker failures: TaskFailedError messages are kept, other errors are hidden", async () => {
  const { manager, worker, statusOf } = setup();
  const expected = await manager.start("c1", "one");
  const unexpected = await manager.start("c1", "two");
  await eventually(() => worker.runs.length === 2);

  worker.runs[0]!.reject(new TaskFailedError("Tests failed: 3 of 10"));
  worker.runs[1]!.reject(new Error("token sk-secret leaked in a stack trace"));

  await eventually(async () => (await statusOf(expected.id)) === "failed" && (await statusOf(unexpected.id)) === "failed");
  assert.equal((await manager.get("c1", expected.id)).error, "Tests failed: 3 of 10");
  assert.doesNotMatch((await manager.get("c1", unexpected.id)).error ?? "", /sk-secret/);
});

test("shutdown records running tasks as interrupted", async () => {
  const { manager, worker, statusOf } = setup();
  const task = await manager.start("c1", "Create a server");
  await eventually(() => worker.runs.length === 1);

  await manager.shutdown();

  assert.equal(await statusOf(task.id), "failed");
  assert.match((await manager.get("c1", task.id)).error ?? "", /shut down/);
  assert.ok(worker.runs[0]!.context.signal.aborted);
});

test("SimulatedCodingWorker reports each step, and stops when aborted", async () => {
  const notes: string[] = [];
  const result = await new SimulatedCodingWorker({ stepDelayMs: 1 }).run(
    { taskId: "t", conversationId: "c", attempt: 2, requirements: ["Create a server", "Use Fastify"] },
    { signal: new AbortController().signal, reportProgress: (note) => notes.push(note) },
  );
  assert.deepEqual(notes, ["Planning the work", "Writing code", "Running checks"]);
  assert.match(result, /Attempt 2 finished.*Create a server \+ Use Fastify/);

  const controller = new AbortController();
  const pending = new SimulatedCodingWorker({ stepDelayMs: 60_000 }).run(
    { taskId: "t", conversationId: "c", attempt: 1, requirements: ["x"] },
    { signal: controller.signal, reportProgress: () => {} },
  );
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
