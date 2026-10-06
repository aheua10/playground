import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationStore } from "../src/conversation/in-memory-conversation-store.ts";
import type { LLMProvider } from "../src/llm/llm-provider.ts";
import { StubLLMProvider } from "../src/llm/stub-llm-provider.ts";
import { createLogger, type LogFields } from "../src/logger.ts";
import { AgentRuntime } from "../src/runtime/agent-runtime.ts";

function setup(llm: LLMProvider = new StubLLMProvider()) {
  const logLines: LogFields[] = [];
  const logger = createLogger({ level: "debug", format: "json", write: (line) => logLines.push(JSON.parse(line)) });
  const store = new InMemoryConversationStore();
  const runtime = new AgentRuntime({ llm, store, logger });
  return { runtime, store, logLines };
}

test("keeps history per conversation and isolates conversations", async () => {
  const { runtime, store } = setup();

  await runtime.runTurn({ conversationId: "a", text: "first" });
  const second = await runtime.runTurn({ conversationId: "a", text: "second" });
  const other = await runtime.runTurn({ conversationId: "b", text: "hello" });

  // The stub reports how many messages it was sent: prior user+assistant + new user.
  assert.match(second.reply, /You said: "second" \(context: 3 messages\)/);
  assert.match(other.reply, /context: 1 messages/);
  assert.deepEqual(
    (await store.getMessages("a")).map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
});

test("logs a turn as an ordered event sequence sharing one turnId", async () => {
  const { runtime, logLines } = setup();

  const result = await runtime.runTurn({ conversationId: "a", text: "hi" });

  assert.deepEqual(
    logLines.map((line) => line.event),
    ["user.message", "llm.request", "llm.response", "final.response"],
  );
  assert.ok(logLines.every((line) => line.turnId === result.turnId && line.conversationId === "a"));
});

test("a failed LLM call leaves history unchanged", async () => {
  const failing: LLMProvider = {
    name: "failing",
    generate: async () => {
      throw new Error("provider down");
    },
  };
  const { runtime, store, logLines } = setup(failing);

  await assert.rejects(runtime.runTurn({ conversationId: "a", text: "hi" }), /provider down/);

  assert.deepEqual(await store.getMessages("a"), []);
  assert.equal(logLines.at(-1)?.event, "turn.failed");
});
