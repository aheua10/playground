import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "../src/core/messages.ts";
import { AnthropicProvider, toAnthropicMessages } from "../src/llm/anthropic-provider.ts";
import { createGetCurrentTimeTool } from "../src/tools/get-current-time.ts";

// No network: these tests check the translation between our neutral types and
// the Anthropic wire format. The provider uses a real SDK client whose fetch
// is faked, answering with the server-sent events the API would stream.

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

type SentRequest = { body: Anthropic.Beta.Messages.MessageCreateParamsStreaming; headers: Headers };

/** A provider whose API calls are answered by `respond` instead of the network. */
function providerWith(respond: (sent: SentRequest, signal: AbortSignal) => Response, model = "claude-opus-5-5") {
  const sent: SentRequest[] = [];
  const client = new Anthropic({
    apiKey: "test-key",
    baseURL: "http://anthropic.test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const request = { body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) };
      sent.push(request);
      return respond(request, init?.signal ?? new AbortController().signal);
    },
  });
  return { provider: new AnthropicProvider({ model, effort: "medium", client }), sent };
}

/** The event stream the API sends for `message`: text arrives word by word, tool input as JSON fragments. */
function streamOf(message: Anthropic.Beta.BetaMessage): Response {
  const events: object[] = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } },
  ];
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const word of block.text.split(/(?<= )/)) {
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: word } });
      }
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      const json = JSON.stringify(block.input);
      for (const part of [json.slice(0, 5), json.slice(5)]) {
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: part } });
      }
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } },
    { type: "message_stop" },
  );
  return sse(events.map(toSseFrame).join(""));
}

function toSseFrame(event: object): string {
  return `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function sse(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("generate: sends a well-formed request and maps the response back", async () => {
  const { provider, sent } = providerWith(() =>
    streamOf(fakeResponse({ content: [thinkingBlock, toolUseBlock] as Anthropic.Beta.BetaContentBlock[], stop_reason: "tool_use" })),
  );

  const response = await provider.generate({
    systemPrompt: "Be brief.",
    messages: [{ role: "user", content: "What time is it?" }],
    tools: [createGetCurrentTimeTool().definition],
  });

  const [{ body, headers }] = sent as [SentRequest];
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.stream, true);
  assert.equal(body.system, "Be brief.");
  assert.deepEqual(body.output_config, { effort: "medium" });
  assert.equal(body.fallbacks, "default");
  assert.match(headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  assert.deepEqual(body.tools?.map((tool) => "name" in tool && tool.name), ["get_current_time"]);
  assert.equal((body.tools?.[0] as Anthropic.Beta.BetaTool).input_schema.type, "object");
  assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "What time is it?" }] }]);

  assert.equal(response.stopReason, "tool_use");
  assert.deepEqual(response.message.toolCalls, [{ id: "toolu_1", name: "get_current_time", input: { timeZone: "UTC" } }]);
  assert.equal(response.message.content, "");
  assert.deepEqual(response.message.raw, { provider: "anthropic", data: [thinkingBlock, toolUseBlock] });
  assert.deepEqual(response.usage, { inputTokens: 100, outputTokens: 5, cachedInputTokens: 90 });
});

test("generate: streams reply text as it arrives; the final message is authoritative", async () => {
  const text = "It is noon in Tokyo.";
  const { provider } = providerWith(() => streamOf(fakeResponse({ content: [{ type: "text", text }] as Anthropic.Beta.BetaContentBlock[] })));
  const deltas: string[] = [];

  const response = await provider.generate({
    systemPrompt: "",
    messages: [{ role: "user", content: "x" }],
    tools: [],
    onTextDelta: (delta) => deltas.push(delta),
  });

  assert.deepEqual(deltas, ["It ", "is ", "noon ", "in ", "Tokyo."]);
  assert.equal(response.message.content, text);
});

test("generate: aborting the signal stops a stream in progress", async () => {
  const encoder = new TextEncoder();
  const { provider } = providerWith((_sent, signal) =>
    sse(
      new ReadableStream({
        start(controller) {
          // The first word arrives, then the server goes quiet until we hang up.
          const message = fakeResponse({ stop_reason: null });
          controller.enqueue(encoder.encode(toSseFrame({ type: "message_start", message: { ...message, content: [] } })));
          controller.enqueue(encoder.encode(toSseFrame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })));
          controller.enqueue(encoder.encode(toSseFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Thinking " } })));
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }),
    ),
  );
  const controller = new AbortController();
  const deltas: string[] = [];

  const generating = provider.generate({
    systemPrompt: "",
    messages: [{ role: "user", content: "x" }],
    tools: [],
    signal: controller.signal,
    onTextDelta: (delta) => {
      deltas.push(delta);
      controller.abort();
    },
  });

  await assert.rejects(generating, Anthropic.APIUserAbortError);
  assert.deepEqual(deltas, ["Thinking "]);
});

test("generate: maps refusals and truncation to neutral stop reasons", async () => {
  for (const [apiReason, expected] of [
    ["refusal", "refusal"],
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "end_turn"],
    ["pause_turn", "other"],
  ] as const) {
    const { provider } = providerWith(() => streamOf(fakeResponse({ stop_reason: apiReason })));
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
