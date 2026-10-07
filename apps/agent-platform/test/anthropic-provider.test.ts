import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "../src/core/messages.ts";
import { AnthropicProvider, toAnthropicMessages } from "../src/llm/anthropic-provider.ts";
import { createGetCurrentTimeTool } from "../src/tools/get-current-time.ts";

// No network: these tests check the translation between our neutral types and
// the Anthropic wire format, using a fake `createMessage`.

const thinkingBlock = { type: "thinking", thinking: "", signature: "sig-abc" };
const toolUseBlock = { type: "tool_use", id: "toolu_1", name: "get_current_time", input: { timeZone: "UTC" } };

function fakeResponse(overrides: Partial<Anthropic.Beta.BetaMessage>): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
    ...overrides,
  } as Anthropic.Beta.BetaMessage;
}

test("generate: sends a well-formed request and maps the response back", async () => {
  let sent: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming | undefined;
  let sentSignal: AbortSignal | undefined;
  const provider = new AnthropicProvider({
    model: "claude-opus-5-5",
    effort: "medium",
    createMessage: async (params, options) => {
      sent = params;
      sentSignal = options.signal;
      return fakeResponse({ content: [thinkingBlock, toolUseBlock] as Anthropic.Beta.BetaContentBlock[], stop_reason: "tool_use" });
    },
  });
  const signal = new AbortController().signal;

  const response = await provider.generate({
    systemPrompt: "Be brief.",
    messages: [{ role: "user", content: "What time is it?" }],
    tools: [createGetCurrentTimeTool().definition],
    signal,
  });

  assert.equal(sent?.model, "claude-opus-5-5");
  assert.equal(sent?.system, "Be brief.");
  assert.deepEqual(sent?.output_config, { effort: "medium" });
  assert.equal(sent?.fallbacks, "default");
  assert.deepEqual(sent?.tools?.map((tool) => "name" in tool && tool.name), ["get_current_time"]);
  assert.equal((sent?.tools?.[0] as Anthropic.Beta.BetaTool).input_schema.type, "object");
  assert.deepEqual(sent?.messages, [{ role: "user", content: [{ type: "text", text: "What time is it?" }] }]);
  assert.equal(sentSignal, signal);

  assert.equal(response.stopReason, "tool_use");
  assert.deepEqual(response.message.toolCalls, [{ id: "toolu_1", name: "get_current_time", input: { timeZone: "UTC" } }]);
  assert.equal(response.message.content, "");
  assert.deepEqual(response.message.raw, { provider: "anthropic", data: [thinkingBlock, toolUseBlock] });
  assert.deepEqual(response.usage, { inputTokens: 100, outputTokens: 5, cachedInputTokens: 90 });
});

test("generate: maps refusals and truncation to neutral stop reasons", async () => {
  for (const [apiReason, expected] of [
    ["refusal", "refusal"],
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "end_turn"],
    ["pause_turn", "other"],
  ] as const) {
    const provider = new AnthropicProvider({
      model: "m",
      effort: "low",
      createMessage: async () => fakeResponse({ stop_reason: apiReason }),
    });
    const response = await provider.generate({ systemPrompt: "", messages: [{ role: "user", content: "x" }], tools: [] });
    assert.equal(response.stopReason, expected, apiReason);
  }
});

test("toAnthropicMessages: replays raw assistant blocks verbatim and groups tool results", () => {
  const history: Message[] = [
    { role: "user", content: "Time in Tokyo and Berlin?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [],
      raw: { provider: "anthropic", data: [thinkingBlock, toolUseBlock, { ...toolUseBlock, id: "toolu_2" }] },
    },
    { role: "tool", toolCallId: "toolu_1", toolName: "get_current_time", content: "tokyo", isError: false },
    { role: "tool", toolCallId: "toolu_2", toolName: "get_current_time", content: "bad zone", isError: true },
  ];

  assert.deepEqual(toAnthropicMessages(history), [
    { role: "user", content: [{ type: "text", text: "Time in Tokyo and Berlin?" }] },
    { role: "assistant", content: [thinkingBlock, toolUseBlock, { ...toolUseBlock, id: "toolu_2" }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "tokyo", is_error: false },
        { type: "tool_result", tool_use_id: "toolu_2", content: "bad zone", is_error: true },
      ],
    },
  ]);
});

test("toAnthropicMessages: rebuilds assistant turns that came from another provider", () => {
  const history: Message[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "Checking.", toolCalls: [{ id: "c1", name: "get_current_time", input: {} }] },
  ];

  assert.deepEqual(toAnthropicMessages(history)[1], {
    role: "assistant",
    content: [
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "c1", name: "get_current_time", input: {} },
    ],
  });
});
