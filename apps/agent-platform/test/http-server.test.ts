import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { InMemoryConversationStore } from "../src/conversation/in-memory-conversation-store.ts";
import { createHttpServer } from "../src/http/server.ts";
import { StubLLMProvider } from "../src/llm/stub-llm-provider.ts";
import { createLogger } from "../src/logger.ts";
import { AgentRuntime } from "../src/runtime/agent-runtime.ts";

const logger = createLogger({ level: "error", format: "json", write: () => {} });
const runtime = new AgentRuntime({ llm: new StubLLMProvider(), store: new InMemoryConversationStore(), logger });
const server = createHttpServer({ runtime, logger });
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function postJson(path: string, body: unknown) {
  return fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /messages returns the assistant reply", async () => {
  const res = await postJson("/messages", { conversationId: "test-1", message: "Hello" });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.conversationId, "test-1");
  assert.equal(typeof body.turnId, "string");
  assert.match(body.reply, /You said: "Hello"/);
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
  const res = await fetch(baseUrl + "/messages", { method: "POST", body: "conversationId=x" });
  assert.equal(res.status, 415);
});

test("unknown paths and wrong methods are rejected", async () => {
  assert.equal((await fetch(baseUrl + "/nope")).status, 404);
  assert.equal((await fetch(baseUrl + "/messages")).status, 405);
});

test("GET /health reports ok", async () => {
  const res = await fetch(baseUrl + "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});
