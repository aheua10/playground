import Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, Message } from "../core/messages.ts";
import type { ToolDefinition } from "../core/tool-definition.ts";
import type { LLMProvider, LLMRequest, LLMResponse, StopReason } from "./llm-provider.ts";

// LLMProvider backed by the Anthropic Messages API (Claude).
//
// The only file that knows the Anthropic wire format. It translates our neutral
// request into exactly one `messages.create` call and the response back. The
// SDK is used purely as a typed HTTP client (with retries on 429/5xx); its
// tool runner is deliberately NOT used, since the agent loop is ours.

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

type CreateMessage = (
  params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
  options: { signal?: AbortSignal },
) => Promise<Anthropic.Beta.BetaMessage>;

export interface AnthropicProviderOptions {
  model: string;
  /** How hard the model thinks before answering; trades quality for latency and cost. */
  effort: Effort;
  maxOutputTokens?: number;
  /** Test seam. Defaults to the SDK client, which reads ANTHROPIC_API_KEY from the environment. */
  createMessage?: CreateMessage;
}

const PROVIDER = "anthropic";

export class AnthropicProvider implements LLMProvider {
  readonly name = PROVIDER;
  readonly #model: string;
  readonly #effort: Effort;
  readonly #maxOutputTokens: number;
  readonly #createMessage: CreateMessage;

  constructor(options: AnthropicProviderOptions) {
    this.#model = options.model;
    this.#effort = options.effort;
    // Non-streaming request: ~16k keeps the call well inside HTTP timeouts.
    this.#maxOutputTokens = options.maxOutputTokens ?? 16_000;
    if (options.createMessage) {
      this.#createMessage = options.createMessage;
    } else {
      const client = new Anthropic();
      this.#createMessage = (params, requestOptions) => client.beta.messages.create(params, requestOptions);
    }
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.#createMessage(
      {
        model: this.#model,
        max_tokens: this.#maxOutputTokens,
        output_config: { effort: this.#effort },
        // If a safety classifier declines, re-run the request server-side on the
        // fallback model Anthropic recommends for that category instead of
        // returning a refusal. A refusal only comes back if the fallback declines too.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // Cache the stable prefix (tools, system prompt, earlier messages) so each
        // loop step and turn only pays full price for what is new.
        cache_control: { type: "ephemeral" },
        system: request.systemPrompt,
        ...(request.tools.length > 0 && { tools: request.tools.map(toAnthropicTool) }),
        messages: toAnthropicMessages(request.messages),
      },
      { signal: request.signal },
    );
    return fromAnthropicResponse(response);
  }
}

export function toAnthropicTool(tool: ToolDefinition): Anthropic.Beta.BetaTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  };
}

// Neutral history -> Anthropic messages. Must be deterministic: Anthropic
// checks that everything before a replayed thinking block is byte-identical to
// when the block was produced, so the same history must always map to the same
// JSON.
export function toAnthropicMessages(messages: Message[]): Anthropic.Beta.BetaMessageParam[] {
  const result: Anthropic.Beta.BetaMessageParam[] = [];

  // Anthropic has no "tool" role: tool results travel in a user message, and all
  // results for one assistant turn must share a single user message.
  const appendUserBlocks = (blocks: Anthropic.Beta.BetaContentBlockParam[]) => {
    const previous = result.at(-1);
    if (previous?.role === "user" && Array.isArray(previous.content)) {
      previous.content.push(...blocks);
    } else {
      result.push({ role: "user", content: blocks });
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case "user":
        appendUserBlocks([{ type: "text", text: message.content }]);
        break;
      case "tool":
        appendUserBlocks([
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
            is_error: message.isError,
          },
        ]);
        break;
      case "assistant": {
        const content = toAssistantContent(message);
        if (content.length > 0) result.push({ role: "assistant", content });
        break;
      }
    }
  }
  return result;
}

function toAssistantContent(message: AssistantMessage): Anthropic.Beta.BetaContentBlockParam[] {
  // Produced by this provider: replay the original blocks verbatim. They may
  // include signed thinking blocks that must come back unchanged.
  if (message.raw?.provider === PROVIDER) {
    return message.raw.data as Anthropic.Beta.BetaContentBlockParam[];
  }
  // Produced elsewhere (another provider, or the stub): rebuild from neutral fields.
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (message.content) blocks.push({ type: "text", text: message.content });
  for (const call of message.toolCalls) {
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
  }
  return blocks;
}

export function fromAnthropicResponse(response: Anthropic.Beta.BetaMessage): LLMResponse {
  const content: string[] = [];
  const toolCalls: AssistantMessage["toolCalls"] = [];
  // Thinking blocks, fallback markers etc. are not part of the visible reply,
  // but they stay in `raw` for replay.
  for (const block of response.content) {
    if (block.type === "text") content.push(block.text);
    if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }

  const { usage } = response;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
  return {
    message: {
      role: "assistant",
      content: content.join(""),
      toolCalls,
      raw: { provider: PROVIDER, data: response.content },
    },
    stopReason: toStopReason(response.stop_reason),
    usage: {
      inputTokens: usage.input_tokens + cachedInputTokens + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      cachedInputTokens,
    },
    model: response.model,
  };
}

function toStopReason(reason: Anthropic.Beta.BetaStopReason | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other"; // pause_turn (server tools, unused), compaction, null
  }
}
