import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCall } from "../src/core/messages.ts";
import { createPublishTaskTool } from "../src/repositories/publish-task-tool.ts";
import { createRunCommandTool } from "../src/sandbox/command-sandbox.ts";
import { createWorkspaceTools } from "../src/sandbox/workspace-tools.ts";
import { createTaskTools } from "../src/tasks/task-tools.ts";
import { createGetCurrentTimeTool } from "../src/tools/get-current-time.ts";
import { ToolError, type Tool } from "../src/tools/tool.ts";
import { ToolExecutor } from "../src/tools/tool-executor.ts";
import { READ_ONLY, type ToolPolicy } from "../src/tools/tool-policy.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { captureLogger, FIXED_NOW } from "./helpers.ts";

function fakeTool(name: string, execute: Tool["execute"]): Tool {
  return { definition: { name, description: "test tool", inputSchema: { type: "object" } }, execute };
}

function setup(tools: Tool<never>[], timeoutMs?: number) {
  const registry = new ToolRegistry();
  tools.forEach((tool) => registry.register(tool));
  const { logger, events } = captureLogger();
  const executor = new ToolExecutor({ registry, timeoutMs });
  const run = (call: Partial<ToolCall> & { name: string }, signal = new AbortController().signal, policy?: ToolPolicy) =>
    executor.execute({ id: "call_1", input: {}, ...call }, { conversationId: "c", turnId: "t", signal, log: logger, policy });
  return { run, events, executor };
}

test("registry: rejects duplicate names and broken schemas at registration time", () => {
  const registry = new ToolRegistry();
  registry.register(createGetCurrentTimeTool());
  assert.throws(() => registry.register(createGetCurrentTimeTool()), /already registered/);
  assert.throws(
    () => registry.register({ ...fakeTool("broken", async () => ""), definition: { name: "broken", description: "", inputSchema: { type: "object", properties: 5 } } }),
    /schema is invalid/,
  );
});

test("executor: runs a valid call and JSON-encodes the output", async () => {
  const { run, events } = setup([createGetCurrentTimeTool(() => FIXED_NOW)]);

  const result = await run({ name: "get_current_time", input: { timeZone: "Asia/Tokyo" } });

  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content), {
    timeZone: "Asia/Tokyo",
    iso: "2026-10-07T12:00:00.000Z",
    local: "Wednesday, October 7, 2026 at 9:00:00 PM GMT+9",
  });
  assert.deepEqual(events(), ["tool.request", "tool.execution", "tool.result"]);
});

test("executor: rejects unknown tools without executing anything", async () => {
  const { run, events } = setup([]);
  const result = await run({ name: "rm_rf" });
  assert.equal(result.isError, true);
  assert.match(result.content, /Unknown tool "rm_rf"/);
  assert.deepEqual(events(), ["tool.request", "tool.rejected"]);
});

test("executor: rejects input that does not match the schema", async () => {
  const { run } = setup([createGetCurrentTimeTool()]);
  for (const input of [{ timeZone: 42 }, { timeZone: "UTC", extra: true }, "not an object"]) {
    const result = await run({ name: "get_current_time", input });
    assert.equal(result.isError, true, JSON.stringify(input));
    assert.match(result.content, /^Invalid input: input/);
  }
});

test("executor: a policy decides which tools may run, whatever the model was offered", async () => {
  let wrote = false;
  const write = fakeTool("write_thing", async () => {
    wrote = true;
    return "written";
  });
  const read: Tool = { ...fakeTool("read_thing", async () => "read"), readOnly: true };
  const { run, events, executor } = setup([write, read]);
  const signal = new AbortController().signal;

  // Both are offered, so the request to the model is the same under any policy.
  assert.deepEqual(executor.definitions().map((d) => d.name), ["read_thing", "write_thing"]);
  const refused = await run({ name: "write_thing" }, signal, READ_ONLY);
  const allowed = await run({ name: "read_thing" }, signal, READ_ONLY);

  assert.equal(wrote, false);
  assert.equal(refused.isError, true);
  assert.match(refused.content, /Tool "write_thing" is not permitted here\. This turn was started by the platform/);
  assert.deepEqual([allowed.isError, allowed.content], [false, "read"]);
  assert.deepEqual(events().slice(0, 2), ["tool.request", "tool.rejected"]);
});

test("executor: ToolError messages reach the model, other errors do not", async () => {
  const { run } = setup([
    fakeTool("expected", async () => {
      throw new ToolError("File not found");
    }),
    fakeTool("unexpected", async () => {
      throw new Error("db password is hunter2");
    }),
  ]);

  assert.equal((await run({ name: "expected" })).content, "File not found");
  const unexpected = await run({ name: "unexpected" });
  assert.equal(unexpected.isError, true);
  assert.doesNotMatch(unexpected.content, /hunter2/);
});

test("executor: a slow tool times out", async () => {
  const { run } = setup([fakeTool("slow", () => new Promise(() => {}))], 20);
  const result = await run({ name: "slow" });
  assert.equal(result.isError, true);
  assert.match(result.content, /timed out after 20 ms/);
});

test("executor: cancelling the turn propagates instead of producing a result", async () => {
  const controller = new AbortController();
  const { run } = setup([fakeTool("slow", () => new Promise(() => {}))]);
  const pending = run({ name: "slow" }, controller.signal);
  controller.abort(new Error("turn cancelled"));
  await assert.rejects(pending, /turn cancelled/);
});

test("get_current_time: defaults to UTC and rejects unknown zones", async () => {
  const tool = createGetCurrentTimeTool(() => FIXED_NOW);
  const context = { conversationId: "c", turnId: "t", toolCallId: "x", signal: new AbortController().signal };

  assert.deepEqual(await tool.execute({}, context), {
    timeZone: "UTC",
    iso: "2026-10-07T12:00:00.000Z",
    local: "Wednesday, October 7, 2026 at 12:00:00 PM UTC",
  });
  await assert.rejects(tool.execute({ timeZone: "Mars/Olympus" }, context), ToolError);
});

test("read-only tools are exactly the ones without side effects", () => {
  // Factories only build definitions here; nothing is executed.
  const unused = {} as never;
  const tools = [
    createGetCurrentTimeTool(),
    ...createTaskTools(unused),
    createPublishTaskTool(unused),
    ...createWorkspaceTools(unused, () => {}),
    createRunCommandTool(unused, unused, () => {}),
  ];

  const readOnly = tools.filter((tool) => tool.readOnly).map((tool) => tool.definition.name);
  assert.deepEqual(readOnly.sort(), ["get_current_time", "get_task", "list_files", "list_tasks", "read_file"]);
});
