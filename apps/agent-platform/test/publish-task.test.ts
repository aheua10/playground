import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { git } from "../src/repositories/git.ts";
import { compareUrl, createPublishTaskTool } from "../src/repositories/publish-task-tool.ts";
import { RepositoryCatalog } from "../src/repositories/repository-catalog.ts";
import { CodingWorker } from "../src/tasks/coding-worker.ts";
import { TaskManager } from "../src/tasks/task-manager.ts";
import { InMemoryTaskStore } from "../src/tasks/task-store.ts";
import { ToolExecutor } from "../src/tools/tool-executor.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { captureLogger, ControlledWorker, createRemote, eventually, ScriptedLLMProvider, textResponse, toolCallResponse } from "./helpers.ts";

async function setup() {
  const { repository, remoteDir } = await createRemote();
  const repositories = new RepositoryCatalog([repository]);
  const workspacesDir = await mkdtemp(path.join(tmpdir(), "publish-test-"));
  const { logger } = captureLogger();
  const llm = new ScriptedLLMProvider([
    toolCallResponse({ id: "w", name: "write_file", input: { path: "feature.txt", content: "new feature\n" } }),
    textResponse("Added the feature."),
  ]);
  const worker = new CodingWorker({ llm, workspacesDir, repositories, logger });
  const tasks = new TaskManager({ store: new InMemoryTaskStore(), worker, logger });
  const registry = new ToolRegistry();
  registry.register(createPublishTaskTool({ tasks, repositories, workspacesDir, logger }));
  const executor = new ToolExecutor({ registry });
  const publish = (conversationId: string, taskId: string) =>
    executor.execute(
      { id: "p", name: "publish_task", input: { taskId } },
      { conversationId, turnId: "t", signal: new AbortController().signal, log: logger },
    );
  return { tasks, publish, remoteDir, repositories, workspacesDir, logger };
}

test("publishes a completed task's branch, and only that branch", async () => {
  const { tasks, publish, remoteDir } = await setup();
  const task = await tasks.start("c1", "Add a feature", { repository: "project" });
  await eventually(async () => (await tasks.get("c1", task.id)).status === "completed");

  const result = await publish("c1", task.id);

  assert.equal(result.isError, false, result.content);
  assert.deepEqual(JSON.parse(result.content), { repository: "project", branch: `agent/${task.id}` });
  assert.match(await git(["log", "--format=%s", `agent/${task.id}`], { gitDir: remoteDir }), /Add a feature/);
  assert.equal((await git(["rev-list", "--count", "main"], { gitDir: remoteDir })).trim(), "1");
});

test("refuses other conversations' tasks, unfinished tasks, and tasks without a repository", async () => {
  const { tasks, publish, repositories, workspacesDir, logger } = await setup();
  const done = await tasks.start("c1", "Add a feature", { repository: "project" });
  await eventually(async () => (await tasks.get("c1", done.id)).status === "completed");
  assert.match((await publish("c2", done.id)).content, /No task/);

  // A task that is still running (a worker we never finish).
  const running = new TaskManager({ store: new InMemoryTaskStore(), worker: new ControlledWorker(), logger });
  const registry = new ToolRegistry();
  registry.register(createPublishTaskTool({ tasks: running, repositories, workspacesDir, logger }));
  const executor = new ToolExecutor({ registry });
  const runningTask = await running.start("c1", "Slow work", { repository: "project" });
  const result = await executor.execute(
    { id: "p", name: "publish_task", input: { taskId: runningTask.id } },
    { conversationId: "c1", turnId: "t", signal: new AbortController().signal, log: logger },
  );
  assert.match(result.content, /is running; it can be published once it has completed/);
  await running.shutdown();

  const noRepo = await tasks.start("c1", "Scratch work");
  await eventually(async () => (await tasks.get("c1", noRepo.id)).status !== "running");
  assert.match((await publish("c1", noRepo.id)).content, /nothing to publish/);
});

test("links to GitHub's compare page for GitHub repositories", () => {
  assert.equal(
    compareUrl("https://github.com/aheua10/playground.git", "master", "agent/task_1"),
    "https://github.com/aheua10/playground/compare/master...agent/task_1?expand=1",
  );
  assert.equal(compareUrl("file:///srv/repo.git", "main", "agent/task_1"), undefined);
});
