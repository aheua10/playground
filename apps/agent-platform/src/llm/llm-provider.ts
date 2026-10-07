import type { AssistantMessage, Message } from "../core/messages.ts";
import type { ToolDefinition } from "../core/tool-definition.ts";

// The boundary between our agent runtime and any LLM vendor.
//
// What crosses it, and why:
//
//   request   systemPrompt  the agent's standing instructions
//             messages      the full neutral history (the API is stateless)
//             tools         what the model MAY ask for; offering is not authorizing
//             signal        cancellation (client gone, timeout, later: task cancelled)
//
//   response  message       reply text and/or tool-call REQUESTS (never executed here)
//             stopReason    why generation ended; the runtime branches on it
//             usage         token counts, for cost and observability
//             model         which model actually answered (fallbacks can change it)
//
// A provider translates one request into one API call and back. It never
// executes tools, loops, retries turns, or touches storage: that is the
// runtime's job, which is what keeps the agent loop provider-independent.

export interface LLMRequest {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export type StopReason =
  | "end_turn" // the model finished its reply
  | "tool_use" // the model is waiting for the results of its tool calls
  | "max_tokens" // output was cut off by a token limit
  | "refusal" // the provider's safety system declined to answer
  | "other"; // provider-specific reasons we don't model yet

export interface LLMUsage {
  /** All input tokens, including those served from the provider's prompt cache. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface LLMResponse {
  message: AssistantMessage;
  stopReason: StopReason;
  usage: LLMUsage;
  model: string;
}

export interface LLMProvider {
  /** Identifies the provider in logs, e.g. "stub", "anthropic". */
  readonly name: string;
  generate(request: LLMRequest): Promise<LLMResponse>;
}
