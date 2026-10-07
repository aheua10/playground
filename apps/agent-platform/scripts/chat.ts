// A terminal client for the realtime channel: type messages, watch replies
// stream in, see tool calls and background tasks as they happen.
//
//   npm run chat                     a new conversation
//   npm run chat -- my-conversation  join (or continue) a conversation
//   AGENT_URL=ws://host:port npm run chat
//
// Authenticates with the token in AGENT_TOKEN (npm run create-token). Not
// needed when the server runs with AUTH=none.
//
// Ctrl+C cancels the reply in progress (or quits when there is none), Ctrl+D quits.
// No dependencies: Node's built-in WebSocket client.

import { stdin, stdout } from "node:process";
import { clearLine, createInterface, cursorTo } from "node:readline";

type ServerMessage = { type: string; [key: string]: unknown };

const base = process.env.AGENT_URL ?? "ws://localhost:3000";
const conversationId = process.argv[2] ?? `chat-${Date.now().toString(36)}`;
const url = `${base}/realtime?conversationId=${encodeURIComponent(conversationId)}`;

const token = process.env.AGENT_TOKEN;
// Node's WebSocket can send headers on the handshake (browsers' can't).
const ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
const rl = createInterface({ input: stdin, output: stdout, prompt: "you> " });

const unconfirmed: string[] = []; // sent, but no turn.started for them yet
const ourTurns = new Set<string>(); // started from this client, not finished
const streamedTurns = new Set<string>(); // turns whose reply arrived as deltas
let opened = false; // the handshake succeeded
let closed = false; // the input side is done (Ctrl+D, Ctrl+C, end of piped input)
let streaming = false; // a reply is being written on the current line
const deferred: string[] = []; // background lines held back until that reply ends

/** Prints a whole line above the prompt, keeping whatever the user is typing. */
function print(text: string): void {
  endStreamedLine();
  clearLine(stdout, 0);
  cursorTo(stdout, 0);
  stdout.write(`${text}\n`);
  prompt();
}

function prompt(): void {
  if (!closed) rl.prompt(true);
}

/** For lines unrelated to the reply being streamed (tasks, other clients): don't split the reply. */
function printBackground(text: string): void {
  if (streaming) deferred.push(text);
  else print(text);
}

function endStreamedLine(): void {
  if (!streaming) return;
  stdout.write("\n");
  streaming = false;
}

function finishTurn(turnId: string): void {
  ourTurns.delete(turnId);
  streamedTurns.delete(turnId);
  endStreamedLine();
  for (const text of deferred.splice(0)) print(text);
  prompt();
}

function firstLine(text: unknown): string {
  return String(text).split("\n")[0]!;
}

ws.addEventListener("open", () => {
  opened = true;
});

ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as ServerMessage;
  const turnId = String(message.turnId ?? "");
  switch (message.type) {
    case "ready":
      print(`Connected to conversation "${conversationId}". Ctrl+C cancels a reply, Ctrl+D quits.`);
      break;
    case "turn.started":
      if (message.initiator === "platform") {
        printBackground(`[platform] ${firstLine(message.text)}`);
      } else if (message.text === unconfirmed[0]) {
        unconfirmed.shift();
        ourTurns.add(turnId);
      } else {
        printBackground(`[another client] you> ${message.text}`); // same conversation, sent from elsewhere
      }
      break;
    case "reply.delta":
      if (!streaming) {
        clearLine(stdout, 0);
        cursorTo(stdout, 0);
        stdout.write("agent> ");
        streaming = true;
      }
      streamedTurns.add(turnId);
      stdout.write(String(message.text));
      break;
    case "tool.called":
      print(`  [tool] ${message.name} ${JSON.stringify(message.input)}`);
      break;
    case "tool.finished":
      if (message.isError) print(`  [tool] ${message.name} failed`);
      break;
    case "turn.completed":
      if (!streamedTurns.has(turnId)) print(`agent> ${message.reply}`);
      finishTurn(turnId);
      break;
    case "turn.failed":
      print(message.reason === "cancelled" ? "  (reply cancelled)" : "  (the turn failed; see the server logs)");
      finishTurn(turnId);
      break;
    case "task.updated": {
      const task = message.task as { taskId: string; progress: string[]; error?: string };
      const detail =
        message.change === "progress" ? `: ${task.progress.at(-1)}` : task.error ? `: ${task.error}` : "";
      printBackground(`  [${task.taskId}] ${message.change}${detail}`);
      break;
    }
    case "error":
      print(`  (rejected: ${message.message})`);
      break;
  }
});

// A refused handshake (401, 403) or a dead server only fires "error", not
// "close", and doesn't say why. Either way the connection is gone.
ws.addEventListener("error", () => {
  if (ws.readyState === WebSocket.CLOSED && opened) {
    print("Connection lost.");
  } else {
    const hint = token
      ? "Is the agent running, and is AGENT_TOKEN valid?"
      : "Is the agent running? Set AGENT_TOKEN unless it runs with AUTH=none.";
    print(`Could not connect to ${url}. ${hint}`);
  }
  process.exit(1);
});

ws.addEventListener("close", (event) => {
  print(`Disconnected (${event.code}${event.reason ? `: ${event.reason}` : ""}).`);
  process.exit(event.code === 1000 ? 0 : 1);
});

rl.on("line", (input) => {
  const text = input.trim();
  if (text === "") return rl.prompt();
  if (ws.readyState !== WebSocket.OPEN) return print("  (not connected yet)");
  unconfirmed.push(text);
  ws.send(JSON.stringify({ type: "message", text }));
});

rl.on("SIGINT", () => {
  if (ourTurns.size + unconfirmed.length === 0) return rl.close();
  ws.send(JSON.stringify({ type: "cancel_turn" }));
});

rl.on("close", () => {
  closed = true;
  ws.close(1000);
});
