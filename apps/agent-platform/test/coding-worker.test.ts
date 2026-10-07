import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StubLLMProvider } from "../src/llm/stub-llm-provider.ts";
import type { LLMProvider } from "../src/llm/llm-provider.ts";
import type { CommandSandbox } from "../src/sandbox/command-sandbox.ts";
import { Workspace } from "../src/sandbox/workspace.ts";
import { CodingWorker } from "../src/tasks/coding-worker.ts";
import { TaskManager } from "../src/tasks/task-manager.ts";
import { InMemoryTaskStore } from "../src/tasks/task-store.ts";
import { TaskFailedError, type TaskWorkerInput } from "../src/tasks/task-worker.ts";
import { captureLogger, eventually, ScriptedLLMProvider, textResponse, toolCallResponse } from "./helpers.ts";

const fakeSandbox: CommandSandbox = {
  description: "a fake sandbox",
  run: async (_workspace, command) => ({ exitCode: 0, timedOut: false, output: `ran: ${command}` }),
};

async function setup(llm: LLMProvider, options: { sandbox?: CommandSandbox; maxSteps?: number } = {}) {
  const workspacesDir = await mkdtemp(path.join(tmpdir(), "coding-worker-test-"));
  const { logger, events } = captureLogger();
  const worker = new CodingWorker({ llm, workspacesDir, logger, ...options });
  const notes: string[] = [];
  const run = (input: Partial<TaskWorkerInput> = {}) =>
    worker.run(
      { taskId: "task_abc", conversationId: "c1", attempt: 1, requirements: ["Create a TypeScript server"], ...input },
      { signal: new AbortController().signal, reportProgress: (note) => notes.push(note) },
    );
  const workspace = () => Workspace.open(workspacesDir, "task_abc");
  return { run, notes, events, workspacesDir, workspace };
}

test("runs its own agent loop with workspace tools and returns a summary", async () => {
  const llm = new ScriptedLLMProvider([
    toolCallResponse({ id: "w1", name: "write_file", input: { path: "src/server.ts", content: "// server" } }),
    textResponse("Built a server. Run it with: node src/server.ts"),
  ]);
  const { run, notes, workspace } = await setup(llm);

  const result = await run({ requirements: ["Create a TypeScript server", "Use Fastify instead of Express"] });

  assert.match(result, /^Built a server\./);
  assert.match(result, /- src\/server\.ts$/m);
  assert.equal(await (await workspace()).readFile("src/server.ts"), "// server");
  assert.deepEqual(notes, ["Wrote src/server.ts (9 bytes)"]);
  // What the worker model was given: its own prompt, only workspace tools, numbered requirements.
  const [first] = llm.requests;
  assert.match(first!.systemPrompt, /coding agent .* isolated workspace/);
  assert.deepEqual(first!.tools.map((t) => t.name), ["delete_file", "list_files", "read_file", "write_file"]);
  assert.match(first!.messages[0]!.role === "user" ? first!.messages[0]!.content : "", /1\. Create a TypeScript server\n2\. Use Fastify/);
});

test("a path outside the workspace is refused and the model can carry on", async () => {
  const llm = new ScriptedLLMProvider([
    toolCallResponse({ id: "w1", name: "write_file", input: { path: "../../escape.txt", content: "x" } }),
    textResponse("Could not write there."),
  ]);
  const { run, workspacesDir } = await setup(llm);

  await run();

  const refusal = llm.requests[1]!.messages.at(-1);
  assert.ok(refusal?.role === "tool" && refusal.isError);
  assert.match(refusal.content, /outside the workspace/);
  await assert.rejects(access(path.join(workspacesDir, "..", "escape.txt")));
});

test("run_command is offered only when a sandbox is configured", async () => {
  const llm = new ScriptedLLMProvider([
    toolCallResponse({ id: "r1", name: "run_command", input: { command: "npm test" } }),
    textResponse("Tests pass."),
  ]);
  const { run, notes } = await setup(llm, { sandbox: fakeSandbox });

  await run();

  assert.ok(llm.requests[0]!.tools.some((t) => t.name === "run_command"));
  assert.match(llm.requests[0]!.tools.find((t) => t.name === "run_command")!.description, /a fake sandbox/);
  assert.deepEqual(notes, ["Ran `npm test` (exit 0)"]);
});

test("a revision sees the files of the previous attempt", async () => {
  const llm = new ScriptedLLMProvider([
    toolCallResponse({ id: "w1", name: "write_file", input: { path: "server.ts", content: "express" } }),
    textResponse("v1"),
    toolCallResponse({ id: "l1", name: "list_files", input: {} }),
    textResponse("v2"),
  ]);
  const { run } = await setup(llm);

  await run({ attempt: 1 });
  await run({ attempt: 2, requirements: ["Create a server", "Use Fastify instead of Express"] });

  const listing = llm.requests[3]!.messages.at(-1);
  assert.ok(listing?.role === "tool");
  assert.match(listing.content, /"path":"server.ts"/);
});

test("running out of steps fails the task with a readable reason", async () => {
  const call = { id: "l", name: "list_files", input: {} };
  const { run } = await setup(new ScriptedLLMProvider([toolCallResponse(call), toolCallResponse(call)]), { maxSteps: 2 });

  await assert.rejects(run(), (error: unknown) => error instanceof TaskFailedError && /within 2 steps/.test(error.message));
});

test("end to end with the stub LLM: a task writes into its workspace", async () => {
  const workspacesDir = await mkdtemp(path.join(tmpdir(), "coding-worker-e2e-"));
  const { logger, events } = captureLogger();
  const worker = new CodingWorker({ llm: new StubLLMProvider(), workspacesDir, sandbox: fakeSandbox, logger });
  const tasks = new TaskManager({ store: new InMemoryTaskStore(), worker, logger });

  const task = await tasks.start("c1", "Create a TypeScript server");
  await eventually(async () => (await tasks.get("c1", task.id)).status === "completed");

  const done = await tasks.get("c1", task.id);
  assert.equal(done.progress.length, 2);
  assert.match(done.progress[0]!, /^Wrote NOTES\.md \(\d+ bytes\)$/);
  assert.equal(done.progress[1], "Ran `ls -la && node --version` (exit 0)");
  assert.match(done.result ?? "", /- NOTES\.md/);
  const notes = await (await Workspace.open(workspacesDir, task.id)).readFile("NOTES.md");
  assert.match(notes, /1\. Create a TypeScript server/);
  // The worker's own loop is visible in the logs, tagged with the task.
  assert.ok(events().includes("worker.started"));
});
