import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { ConversationEvent, ConversationEvents } from "../events/conversation-events.ts";
import type { Logger } from "../logger.ts";
import type { AgentRuntime } from "../runtime/agent-runtime.ts";
import { CONVERSATION_ID_PATTERN, MAX_MESSAGE_CHARS } from "./input-rules.ts";

// The realtime channel: a WebSocket per client, on the same port as the REST
// API (GET /realtime?conversationId=... with an Upgrade header).
//
// Like the HTTP adapter, it only translates. Client messages become runtime
// calls; the conversation's events (from the bus) go out as they happen. It
// doesn't matter how a turn started: a REST message, this socket, another
// socket, or the platform (a finished task) all show up the same way.
//
//   client -> server   { "type": "message", "text": "..." }      start a turn
//                      { "type": "cancel_turn" }                 cancel this socket's turns
//   server -> client   { "type": "ready", "conversationId": "..." }
//                      every ConversationEvent of the conversation (turn.*, reply.delta, tool.*, task.updated)
//                      { "type": "error", "message": "..." }     a client message was rejected
//
// Who may connect: browsers don't apply CORS to WebSockets, so without a check
// any web page open in the user's browser could connect to localhost and drive
// the agent. The handshake's Origin header must therefore be on an allowlist.
// Clients that aren't browsers (the CLI) send no Origin and are let through:
// this check stops other websites, it is not authentication.

const PATH = "/realtime";
/** A client message is a small JSON object; anything bigger closes the socket (1009). */
const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Turns one socket may have queued or running at once. */
const MAX_TURNS_IN_FLIGHT = 3;
/** A client that reads this slowly is dropped rather than buffered for without limit. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 30_000;

export interface RealtimeDeps {
  runtime: Pick<AgentRuntime, "runTurn">;
  events: Pick<ConversationEvents, "subscribe">;
  logger: Logger;
  /** Origins (scheme://host:port) whose pages may connect. */
  allowedOrigins: readonly string[];
}

export interface Realtime {
  /** Closes every connection (for shutdown); server.close() doesn't touch upgraded sockets. */
  close(): void;
}

export function attachRealtime(server: Server, deps: RealtimeDeps): Realtime {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const allowedOrigins = new Set(deps.allowedOrigins);
  // Clients that answered the latest ping (see the heartbeat below).
  const alive = new WeakSet<WebSocket>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Until ws takes over the socket, errors on it (a client resetting mid-handshake) are ours.
    const onSocketError = () => socket.destroy();
    socket.on("error", onSocketError);
    const url = new URL(req.url ?? "/", "http://localhost");
    const conversationId = url.searchParams.get("conversationId") ?? "";
    const origin = req.headers.origin;

    let refusal: [status: number, reason: string] | undefined;
    if (url.pathname !== PATH) refusal = [404, "Not Found"];
    else if (origin !== undefined && !allowedOrigins.has(origin)) refusal = [403, "Forbidden"];
    else if (!CONVERSATION_ID_PATTERN.test(conversationId)) refusal = [400, "Bad Request"];
    if (refusal) {
      const [status, reason] = refusal;
      deps.logger.warn("realtime.rejected", { path: url.pathname, status, origin });
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      socket.removeListener("error", onSocketError);
      alive.add(ws);
      ws.on("pong", () => alive.add(ws));
      serve(ws, conversationId, deps);
    });
  });

  // Ping every client; one that hasn't answered the previous ping is gone
  // (laptop asleep, network dropped) and is cut off, which cancels its turns.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, "Server shutting down");
      wss.close();
    },
  };
}

function serve(ws: WebSocket, conversationId: string, deps: RealtimeDeps): void {
  const log = deps.logger.child({ conversationId, connectionId: randomUUID() });
  const inFlight = new Set<AbortController>();
  log.info("realtime.connected");

  const send = (message: ConversationEvent | { type: "ready"; conversationId: string } | { type: "error"; message: string }) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      log.warn("realtime.slow_client", { bufferedAmount: ws.bufferedAmount });
      ws.close(1013, "Too slow to keep up");
      return;
    }
    ws.send(JSON.stringify(message));
  };

  const unsubscribe = deps.events.subscribe(conversationId, send);
  send({ type: "ready", conversationId });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    const request = isBinary ? undefined : parseClientMessage(data.toString());
    if (!request || typeof request === "string") {
      const message = request ?? "Messages must be JSON text";
      log.warn("realtime.invalid_message", { reason: message });
      send({ type: "error", message });
      return;
    }

    if (request.type === "cancel_turn") {
      log.info("realtime.cancel_turn", { turns: inFlight.size });
      for (const controller of inFlight) controller.abort(new Error("Cancelled by the client"));
      return;
    }

    if (inFlight.size >= MAX_TURNS_IN_FLIGHT) {
      send({ type: "error", message: `At most ${MAX_TURNS_IN_FLIGHT} messages can be waiting for a reply` });
      return;
    }
    const controller = new AbortController();
    inFlight.add(controller);
    // The outcome reaches the client as events (turn.completed / turn.failed),
    // so nothing is sent here, and failures are already logged by the runtime.
    deps.runtime
      .runTurn({ conversationId, text: request.text }, controller.signal)
      .catch(() => {})
      .finally(() => inFlight.delete(controller));
  });

  ws.on("close", (code: number) => {
    unsubscribe();
    // Nobody is listening any more: stop the work done for this socket.
    for (const controller of inFlight) controller.abort(new Error("Client disconnected"));
    log.info("realtime.disconnected", { code, turnsCancelled: inFlight.size });
  });

  // Protocol errors (oversized or malformed frames). ws closes the socket itself.
  ws.on("error", (error) => log.warn("realtime.socket_error", { error }));
}

type ClientMessage = { type: "message"; text: string } | { type: "cancel_turn" };

/** Untrusted client input -> a ClientMessage, or the reason it was rejected. */
function parseClientMessage(raw: string): ClientMessage | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "Messages must be JSON text";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "A message must be a JSON object";
  const { type, text } = value as Record<string, unknown>;
  if (type === "cancel_turn") return { type };
  if (type !== "message") return 'Unknown message type; expected "message" or "cancel_turn"';
  if (typeof text !== "string" || text.trim() === "") return "text must be a non-empty string";
  if (text.length > MAX_MESSAGE_CHARS) return `text must be at most ${MAX_MESSAGE_CHARS} characters`;
  return { type, text };
}
