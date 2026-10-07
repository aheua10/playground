import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationStore } from "../src/conversation/in-memory-conversation-store.ts";
import type { LLMProvider } from "../src/llm/llm-provider.ts";
import { StubLLMProvider } from "../src/llm/stub-llm-provider.ts";
import { AgentRuntime } from "../src/runtime/agent-runtime.ts";
import { createGetCurrentTimeTool } from "../src/tools/get-current-time.ts";
import { ToolExecutor } from "../src/tools/tool-executor.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { captureLogger, FIXED_NOW, ScriptedLLMProvider, textResponse, toolCallResponse } from "./helpers.ts";

function setup(llm: LLMProvider, maxSteps?: number) {
  const { logger, lines, events } = captureLogger();
  const registry = new ToolRegistry();
  registry.register(createGetCurrentTimeTool(() => FIXED_NOW));
  const store = new InMemoryConversationStore();
  const runtime = new AgentRuntime({ llm, store, toolExecutor: new ToolExecutor({ registry }), logger, maxSteps });
  return { runtime, store, lines, events };
}

test("keeps history per conversation and isolates conversations", async () => {
  const { runtime, store } = setup(new StubLLMProvider());

  await runtime.runTurn({ conversationId: "a", text: "first" });
  const second = await runtime.runTurn({ conversationId: "a", text: "second" });
  const other = await runtime.runTurn({ conversationId: "b", text: "hello" });

  assert.match(second.reply, /You said: "second" \(context: 3 messages\)/);
  assert.match(other.reply, /context: 1 messages/);
  assert.equal((await store.getMessages("a")).length, 4);
});

test("runs the agent loop: LLM -> tool -> LLM -> final reply", async () => {
  const llm = new ScriptedLLMProvider([
    toolCallResponse({ id: "call_1", name: "get_current_time", input: { timeZone: "UTC" } }),
    textResponse("It is noon UTC."),
  ]);
  const { runtime, store, events } = setup(llm);

  const result = await runtime.runTurn({ conversationId: "a", text: "What time is it?" });

  assert.equal(result.reply, "It is noon UTC.");

  // 1. The runtime told the LLM the tool exists.
  assert.deepEqual(llm.requests[0]!.tools.map((tool) => tool.name), ["get_current_time"]);
  // 2-6. The tool ran and its result was appended before the second LLM call.
  const toolResult = llm.requests[1]!.messages.at(-1);
  assert.equal(toolResult?.role, "tool");
  assert.ok(toolResult?.role === "tool" && toolResult.toolCallId === "call_1" && !toolResult.isError);
  assert.match(toolResult.content, /2026-10-07T12:00:00.000Z/);
  // 7-8. The whole turn is persisted, and observable as an ordered event sequence.
  assert.deepEqual(
    (await store.getMessages("a")).map((m) => m.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.deepEqual(
    events().filter((e) => e !== "llm.request.payload"),
    [
      "user.message",
      "llm.request",
      "llm.response",
      "tool.request",
      "tool.execution",
      "tool.result",
      "llm.request",
      "llm.response",
      "final.response",
    ],
  );
});

test("a rejected tool call is fed back to the model instead of failing the turn", async () => {
  const llm = new ScriptedLLMProvider([
    toolCallResponse({ id: "call_1", name: "delete_everything", input: {} }),
    textResponse("I can't do that."),
  ]);
  const { runtime, events } = setup(llm);

  const result = await runtime.runTurn({ conversationId: "a", text: "Delete everything" });

  assert.equal(result.reply, "I can't do that.");
  const toolResult = llm.requests[1]!.messages.at(-1);
  assert.ok(toolResult?.role === "tool" && toolResult.isError);
  assert.match(toolResult.content, /Unknown tool/);
  assert.ok(events().includes("tool.rejected"));
  assert.ok(!events().includes("tool.execution"));
});

test("a failed LLM call leaves history unchanged", async () => {
  const failing: LLMProvider = {
    name: "failing",
    generate: async () => {
      throw new Error("provider down");
    },
  };
  const { runtime, store, events } = setup(failing);

  await assert.rejects(runtime.runTurn({ conversationId: "a", text: "hi" }), /provider down/);

  assert.deepEqual(await store.getMessages("a"), []);
  assert.equal(events().at(-1), "turn.failed");
});

test("a turn that keeps calling tools is stopped at the step limit", async () => {
  const call = { id: "call", name: "get_current_time", input: {} };
  const llm = new ScriptedLLMProvider([toolCallResponse(call), toolCallResponse(call), toolCallResponse(call)]);
  const { runtime, store } = setup(llm, 2);

  await assert.rejects(runtime.runTurn({ conversationId: "a", text: "loop" }), /limit of 2 LLM calls/);

  assert.equal(llm.requests.length, 2);
  assert.deepEqual(await store.getMessages("a"), []);
});

test("tool calls in a truncated response are never executed", async () => {
  const truncated = toolCallResponse({ id: "call_1", name: "get_current_time", input: {} });
  truncated.stopReason = "max_tokens";
  const { runtime, events } = setup(new ScriptedLLMProvider([truncated]));

  await assert.rejects(runtime.runTurn({ conversationId: "a", text: "time?" }), /stopped with "max_tokens"/);

  assert.ok(!events().includes("tool.request"));
});

test("cancelling mid-LLM-call aborts the turn, logs it, and persists nothing", async () => {
  const controller = new AbortController();
  const { promise: llmCalled, resolve: markLlmCalled } = Promise.withResolvers<void>();
  const llm: LLMProvider = {
    name: "slow",
    generate: (request) =>
      new Promise((_, reject) => {
        markLlmCalled();
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason));
      }),
  };
  const { runtime, store, events } = setup(llm);

  const turn = runtime.runTurn({ conversationId: "a", text: "hi" }, controller.signal);
  await llmCalled;
  controller.abort(new Error("client disconnected"));

  await assert.rejects(turn, /client disconnected/);
  assert.equal(events().at(-1), "turn.cancelled");
  assert.deepEqual(await store.getMessages("a"), []);
});
