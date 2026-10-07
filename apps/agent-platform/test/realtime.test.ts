import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { InMemoryConversationStore } from "../src/conversation/in-memory-conversation-store.ts";
import { ConversationEvents } from "../src/events/conversation-events.ts";
import { attachRealtime } from "../src/http/realtime.ts";
import { createHttpServer } from "../src/http/server.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/llm/llm-provider.ts";
import { StubLLMProvider } from "../src/llm/stub-llm-provider.ts";
import { AgentRuntime } from "../src/runtime/agent-runtime.ts";
import { ToolExecutor } from "../src/tools/tool-executor.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { captureLogger, eventually } from "./helpers.ts";

const ALLOWED_ORIGIN = "http://localhost:3000";

/** An LLM that never answers: the turn runs until it is cancelled. */
class HangingLLMProvider implements LLMProvider {
  readonly name = "hanging";
  readonly started: LLMRequest[] = [];

  generate(request: LLMRequest): Promise<LLMResponse> {
    this.started.push(request);
    return new Promise((_, reject) => {
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
    });
  }
}

async function startServer(t: TestContext, llm: LLMProvider = new StubLLMProvider()) {
  const { logger, lines } = captureLogger();
  const events = new ConversationEvents(logger);
  const toolExecutor = new ToolExecutor({ registry: new ToolRegistry() });
  const runtime = new AgentRuntime({ llm, store: new InMemoryConversationStore(), toolExecutor, logger, events });
  const server = createHttpServer({ runtime, tasks: { list: async () => [] }, logger });
  const realtime = attachRealtime(server, { runtime, events, logger, allowedOrigins: [ALLOWED_ORIGIN] });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    realtime.close();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { port, lines, base: `127.0.0.1:${port}` };
}

type Received = { type: string; [key: string]: unknown };

/** A WebSocket client (Node's built-in) that records what it receives. */
async function connect(t: TestContext, base: string, conversationId = "c1") {
  const ws = new WebSocket(`ws://${base}/realtime?conversationId=${conversationId}`);
  const received: Received[] = [];
  ws.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
  await once(ws, "open");
  t.after(() => ws.close());
  await eventually(() => received.some((m) => m.type === "ready"));
  const send = (message: unknown) => ws.send(typeof message === "string" ? message : JSON.stringify(message));
  const waitFor = async (type: string) => {
    await eventually(() => received.some((m) => m.type === type));
    return received.find((m) => m.type === type)!;
  };
  return { ws, received, send, waitFor };
}

/** The status the server answers a WebSocket handshake with (101 = accepted). */
function handshake(base: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`http://${base}${path}`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode!);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
}

test("a message over the socket streams the turn back, ending in the reply", async (t) => {
  const { base } = await startServer(t);
  const client = await connect(t, base);

  client.send({ type: "message", text: "hello there" });
  const completed = await client.waitFor("turn.completed");

  const types = client.received.map((m) => m.type).filter((type, i, all) => type !== all[i - 1]);
  assert.deepEqual(types, ["ready", "turn.started", "reply.delta", "turn.completed"]);
  const deltas = client.received.filter((m) => m.type === "reply.delta").map((m) => m.text);
  assert.equal(deltas.join(""), completed.reply);
  assert.match(String(completed.reply), /You said: "hello there"/);
});

test("turns started elsewhere (REST) reach every socket on the conversation, and only those", async (t) => {
  const { base } = await startServer(t);
  const watcher = await connect(t, base, "c1");
  const other = await connect(t, base, "c2");

  const response = await fetch(`http://${base}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "c1", message: "from curl" }),
  });
  const { turnId } = (await response.json()) as { turnId: string };

  assert.equal((await watcher.waitFor("turn.completed")).turnId, turnId);
  assert.deepEqual(other.received.map((m) => m.type), ["ready"]);
});

test("cancel_turn cancels the turn in progress", async (t) => {
  const llm = new HangingLLMProvider();
  const { base } = await startServer(t, llm);
  const client = await connect(t, base);

  client.send({ type: "message", text: "take your time" });
  await eventually(() => llm.started.length === 1);
  client.send({ type: "cancel_turn" });

  assert.equal((await client.waitFor("turn.failed")).reason, "cancelled");
});

test("closing the socket cancels its turns", async (t) => {
  const llm = new HangingLLMProvider();
  const { base, lines } = await startServer(t, llm);
  const client = await connect(t, base);

  client.send({ type: "message", text: "take your time" });
  await eventually(() => llm.started.length === 1);
  client.ws.close();

  await eventually(() => lines.some((line) => line.event === "turn.cancelled"));
  assert.ok(llm.started[0]!.signal?.aborted);
});

test("invalid client messages get an error, and the connection stays usable", async (t) => {
  const { base } = await startServer(t);
  const client = await connect(t, base);

  for (const bad of ["not json", "[1]", { type: "shout" }, { type: "message", text: "  " }, { type: "message", text: "x".repeat(32_001) }]) {
    client.send(bad);
  }
  client.ws.send(new Uint8Array([1, 2, 3]));
  await eventually(() => client.received.filter((m) => m.type === "error").length === 6);
  client.send({ type: "message", text: "still here?" });

  assert.match(String((await client.waitFor("turn.completed")).reply), /still here\?/);
});

test("a socket can't queue unlimited turns", async (t) => {
  const { base } = await startServer(t, new HangingLLMProvider());
  const client = await connect(t, base);

  for (let i = 0; i < 4; i++) client.send({ type: "message", text: `message ${i}` });

  assert.match(String((await client.waitFor("error")).message), /At most 3 messages/);
});

test("an oversized frame closes the connection", async (t) => {
  const { base } = await startServer(t);
  const client = await connect(t, base);

  client.send({ type: "message", text: "x".repeat(70_000) });
  const [event] = (await once(client.ws, "close")) as [CloseEvent];

  assert.equal(event.code, 1009); // message too big
});

test("the handshake checks path, Origin and conversationId", async (t) => {
  const { base, lines } = await startServer(t);

  assert.equal(await handshake(base, "/realtime?conversationId=c1", { origin: ALLOWED_ORIGIN }), 101);
  assert.equal(await handshake(base, "/realtime?conversationId=c1"), 101, "no Origin: not a browser");
  assert.equal(await handshake(base, "/realtime?conversationId=c1", { origin: "https://evil.example" }), 403);
  assert.equal(await handshake(base, "/realtime?conversationId=c1", { origin: "http://localhost:3001" }), 403);
  assert.equal(await handshake(base, "/realtime?conversationId=../x"), 400);
  assert.equal(await handshake(base, "/realtime"), 400);
  assert.equal(await handshake(base, "/elsewhere?conversationId=c1"), 404);
  assert.equal(lines.filter((line) => line.event === "realtime.rejected").length, 5);
});
