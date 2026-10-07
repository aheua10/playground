import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { InMemoryConversationStore } from "../src/conversation/in-memory-conversation-store.ts";
import { createHttpServer } from "../src/http/server.ts";
import { StubLLMProvider } from "../src/llm/stub-llm-provider.ts";
import { createLogger } from "../src/logger.ts";
import { AgentRuntime } from "../src/runtime/agent-runtime.ts";
import { SimulatedCodingWorker } from "../src/tasks/simulated-coding-worker.ts";
import { TaskManager } from "../src/tasks/task-manager.ts";
import { InMemoryTaskStore } from "../src/tasks/task-store.ts";
import { createTaskTools } from "../src/tasks/task-tools.ts";
import { createGetCurrentTimeTool } from "../src/tools/get-current-time.ts";
import { ToolExecutor } from "../src/tools/tool-executor.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { bearer, eventually, FIXED_NOW, testAuthenticator } from "./helpers.ts";

const logger = createLogger({ level: "error", format: "json", write: () => {} });
const tasks = new TaskManager({
  store: new InMemoryTaskStore(),
  worker: new SimulatedCodingWorker({ stepDelayMs: 50 }),
  logger,
});
const registry = new ToolRegistry();
registry.register(createGetCurrentTimeTool(() => FIXED_NOW));
for (const tool of createTaskTools(tasks)) registry.register(tool);
const runtime = new AgentRuntime({
  llm: new StubLLMProvider(),
  store: new InMemoryConversationStore(),
  toolExecutor: new ToolExecutor({ registry }),
  logger,
});
const server = createHttpServer({
  runtime,
  tasks,
  logger,
  authenticator: testAuthenticator(),
  allowedHosts: ["agent.internal"],
});
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await tasks.shutdown();
  await new Promise((resolve) => server.close(resolve));
});

/** A request as alice (or another user). */
function api(path: string, init: RequestInit = {}, user: "alice" | "bob" = "alice") {
  return fetch(baseUrl + path, { ...init, headers: { ...bearer(user), ...init.headers } });
}

/** A response's JSON body, untyped: the assertions check its shape. */
async function json(response: Response | Promise<Response>): Promise<any> {
  return (await response).json();
}

function postJson(path: string, body: unknown, user: "alice" | "bob" = "alice") {
  return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, user);
}

test("POST /messages returns the assistant reply", async () => {
  const res = await postJson("/messages", { conversationId: "test-1", message: "Hello" });

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.conversationId, "test-1");
  assert.equal(typeof body.turnId, "string");
  assert.match(body.reply, /You said: "Hello"/);
});

test("POST /messages runs a tool when the (stub) model asks for one", async () => {
  const res = await postJson("/messages", { conversationId: "time-1", message: "What time is it in Asia/Tokyo?" });

  assert.equal(res.status, 200);
  const { reply } = await json(res);
  assert.match(reply, /get_current_time returned: .*"local":"Wednesday, October 7, 2026 at 9:00:00 PM GMT\+9"/);
});

test("GET /conversations/:id returns the stored turn, including the tool call and result", async () => {
  await postJson("/messages", { conversationId: "time-2", message: "What time is it?" });

  const res = await api("/conversations/time-2");

  assert.equal(res.status, 200);
  const { messages } = await json(res);
  assert.deepEqual(
    messages.map((m: { role: string }) => m.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.equal(messages[1].toolCalls[0].name, "get_current_time");
  assert.equal((await api("/conversations/unknown")).status, 404);
  assert.equal((await api("/conversations/bad%20id")).status, 400);
});

test("a coding task runs in the background while the conversation continues", async () => {
  const say = async (message: string) =>
    (await json(postJson("/messages", { conversationId: "task-1", message }))).reply as string;
  const listTasks = async () => (await json(api("/conversations/task-1/tasks"))).tasks;

  // The turn returns as soon as the task has started.
  assert.match(await say("Create a TypeScript server"), /start_coding_task returned: .*"status":"running"/);
  // While it runs, a later message revises it: attempt 2 with both requirements.
  assert.match(await say("Use Fastify instead of Express"), /revise_task returned: .*"attempt":2/);
  const [running] = await listTasks();
  assert.equal(running.status, "running");
  assert.deepEqual(running.requirements, ["Create a TypeScript server", "Use Fastify instead of Express"]);

  await eventually(async () => (await listTasks())[0].status === "completed");
  assert.match((await listTasks())[0].result, /Use Fastify instead of Express/);
  assert.match(await say("Is it done?"), /list_tasks returned: .*"status":"completed"/);
  assert.match(await say("Cancel it"), /cancel_task failed: .*already completed/);
});

test("POST /messages rejects invalid input with 400", async () => {
  const invalidBodies = [
    [],
    { message: "Hello" },
    { conversationId: "has spaces", message: "Hello" },
    { conversationId: "test-1", message: "   " },
    { conversationId: "test-1", message: 42 },
  ];
  for (const body of invalidBodies) {
    const res = await postJson("/messages", body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test("POST /messages requires a JSON content type", async () => {
  const res = await api("/messages", { method: "POST", body: "conversationId=x" });
  assert.equal(res.status, 415);
});

test("unknown paths and wrong methods are rejected", async () => {
  assert.equal((await api("/nope")).status, 404);
  assert.equal((await api("/messages")).status, 405);
});

test("GET /health reports ok", async () => {
  const res = await api("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { status: "ok" });
});

/** GET /health with a chosen Host header (fetch doesn't let us set one). */
function healthWithHost(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/health`, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
}

test("requests must be addressed to localhost, an IP address, or an allowed host name", async () => {
  for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "10.0.0.5", "agent.internal", "AGENT.INTERNAL:8080"]) {
    assert.equal(await healthWithHost(host), 200, host);
  }
  // What a DNS-rebinding page sends: its own name, now pointing at us.
  for (const host of ["evil.example:3000", "localhost.evil.example", "agent.internal.evil.example", "evil.example/x"]) {
    assert.equal(await healthWithHost(host), 403, host);
  }
});

test("every route but /health needs a valid bearer token", async () => {
  for (const authorization of [undefined, "Bearer ap_not-a-token", "Basic YWxpY2U6c2VjcmV0", "ap_test-token-alice"]) {
    const res = await fetch(baseUrl + "/conversations/test-1", authorization ? { headers: { authorization } } : {});
    assert.equal(res.status, 401, String(authorization));
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
  }
  const unauthenticatedPost = await fetch(baseUrl + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "x", message: "hi" }),
  });
  assert.equal(unauthenticatedPost.status, 401);
  assert.equal((await fetch(baseUrl + "/nope")).status, 401, "unauthenticated callers can't probe routes");
  assert.equal((await fetch(baseUrl + "/health")).status, 200);
});

test("users can't see or reach each other's conversations, even with the same id", async () => {
  await postJson("/messages", { conversationId: "shared", message: "alice's secret plan" });
  const alicesTask = await postJson("/messages", { conversationId: "shared", message: "Create a TypeScript server" });
  assert.match((await json(alicesTask)).reply, /start_coding_task returned/);

  // Bob, same id: nothing there for him.
  assert.equal((await api("/conversations/shared", {}, "bob")).status, 404);
  assert.deepEqual((await json(api("/conversations/shared/tasks", {}, "bob"))).tasks, []);
  // His messages start his own conversation: the model sees only his message,
  // and "status" can't find alice's task.
  const first = await json(postJson("/messages", { conversationId: "shared", message: "hi" }, "bob"));
  assert.deepEqual([first.conversationId, first.reply], ["shared", '[stub] You said: "hi" (context: 1 messages)']);
  const status = await json(postJson("/messages", { conversationId: "shared", message: "status?" }, "bob"));
  assert.match(status.reply, /list_tasks returned: \[\]/);

  // Alice's conversation is untouched.
  const { messages } = await json(api("/conversations/shared"));
  assert.equal(messages[0].content, "alice's secret plan");
  assert.ok(!JSON.stringify(messages).includes("status?"));
  await eventually(async () => (await json(api("/conversations/shared/tasks"))).tasks[0].status === "completed");
});
