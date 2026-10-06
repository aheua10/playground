import type { AssistantMessage, Message } from "../core/messages.ts";

// The boundary between our agent runtime and any LLM vendor.
//
// PLACEHOLDER CONTRACT. This is just enough for the skeleton to run end to end
// (messages in, one assistant message out). Before we integrate a real
// provider, this interface gets designed properly: system prompt, tool
// definitions, tool-call requests, stop reason, token usage, cancellation.
// That design is Review Checkpoint #2.
//
// Rule that will not change: the runtime only ever talks to this interface.
// Vendor SDKs and wire formats stay inside provider implementations.

export interface LLMRequest {
  messages: Message[];
}

export interface LLMResponse {
  message: AssistantMessage;
}

export interface LLMProvider {
  /** Identifies the provider in logs, e.g. "stub", "anthropic", "openai". */
  readonly name: string;
  generate(request: LLMRequest): Promise<LLMResponse>;
}
