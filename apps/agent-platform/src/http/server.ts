import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "../logger.ts";
import type { AgentRuntime, TurnInput } from "../runtime/agent-runtime.ts";
import { describeTask } from "../tasks/task.ts";
import type { TaskManager } from "../tasks/task-manager.ts";
import { CONVERSATION_ID_PATTERN, MAX_MESSAGE_CHARS } from "./input-rules.ts";

// HTTP transport adapter. Its whole job:
//   1. parse + validate the HTTP request (untrusted client input)
//   2. map it to a runtime TurnInput
//   3. call the runtime
//   4. map the result (or error) back to an HTTP response
// No conversation or agent logic lives here.
//
// Routes:
//   GET  /health              liveness check for Docker / load balancers
//   POST /messages            { conversationId, message } -> { conversationId, turnId, reply }
//   GET  /conversations/:id         stored history, including tool calls and results (debugging)
//   GET  /conversations/:id/tasks   the conversation's background tasks and their state
//
// The realtime channel (WebSocket, /realtime) shares this server; see realtime.ts.

const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpServerDeps {
  runtime: Pick<AgentRuntime, "runTurn" | "getHistory">;
  tasks: Pick<TaskManager, "list">;
  logger: Logger;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createHttpServer(deps: HttpServerDeps): Server {
  return createServer((req, res) => {
    void handleRequest(req, res, deps);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const startedAt = performance.now();
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  // If the client goes away before we respond, cancel the work done on its
  // behalf (the in-flight LLM call and tool executions).
  const clientGone = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) clientGone.abort(new Error("Client disconnected"));
  });
  let status: number;

  try {
    const body = await route(method, path, req, clientGone.signal, deps);
    status = 200;
    sendJson(res, status, body);
  } catch (error) {
    if (clientGone.signal.aborted) {
      status = 499; // nginx's "client closed request"; for the log only, nobody is listening
    } else if (error instanceof HttpError) {
      status = error.status;
      sendJson(res, status, { error: error.message });
      deps.logger.warn("http.rejected", { method, path, status, reason: error.message });
    } else {
      // Never leak internal error details to the client; they go to the logs.
      status = 500;
      sendJson(res, status, { error: "Internal server error" });
      deps.logger.error("http.error", { method, path, status, error });
    }
  }

  deps.logger.debug("http.request", { method, path, status, durationMs: Math.round(performance.now() - startedAt) });
}

async function route(
  method: string,
  path: string,
  req: IncomingMessage,
  signal: AbortSignal,
  deps: HttpServerDeps,
): Promise<unknown> {
  if (path === "/health") {
    requireMethod(method, "GET");
    return { status: "ok" };
  }

  if (path === "/messages") {
    requireMethod(method, "POST");
    const input = parseMessageRequest(await readJsonBody(req));
    return await deps.runtime.runTurn(input, signal);
  }

  const conversationPath = /^\/conversations\/([^/]+)(\/tasks)?$/.exec(path);
  if (conversationPath) {
    requireMethod(method, "GET");
    // The allowed charset needs no percent-decoding, so match the raw segment.
    const conversationId = conversationPath[1]!;
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) throw new HttpError(400, "Invalid conversationId");
    if (conversationPath[2]) {
      return { conversationId, tasks: (await deps.tasks.list(conversationId)).map(describeTask) };
    }
    const messages = await deps.runtime.getHistory(conversationId);
    if (messages.length === 0) throw new HttpError(404, "Conversation not found");
    // `raw` is opaque provider state (e.g. signed thinking blocks): omit it for readability.
    return { conversationId, messages: messages.map((m) => (m.role === "assistant" ? { ...m, raw: undefined } : m)) };
  }

  throw new HttpError(404, "Not found");
}

function requireMethod(actual: string, expected: string): void {
  if (actual !== expected) throw new HttpError(405, `Method ${actual} not allowed`);
}

// HTTP DTO -> runtime input. Note the field rename (message -> text): the
// HTTP shape and the runtime shape are allowed to evolve independently.
function parseMessageRequest(body: unknown): TurnInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  const { conversationId, message } = body as Record<string, unknown>;

  if (typeof conversationId !== "string" || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new HttpError(400, "conversationId must be 1-128 chars of [A-Za-z0-9._:-]");
  }
  if (typeof message !== "string" || message.trim() === "") {
    throw new HttpError(400, "message must be a non-empty string");
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, `message must be at most ${MAX_MESSAGE_CHARS} characters`);
  }
  return { conversationId, text: message };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }

  // Drain the whole body but only buffer up to the limit, so an oversized
  // request costs bandwidth, not memory, and the 413 can still be sent.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
