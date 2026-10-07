import type { ToolCall } from "../src/core/messages.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/llm/llm-provider.ts";
import { createLogger, type LogFields } from "../src/logger.ts";

/** Plays back pre-scripted responses and records every request it receives. */
export class ScriptedLLMProvider implements LLMProvider {
  readonly name = "scripted";
  readonly requests: LLMRequest[] = [];
  readonly #responses: LLMResponse[];

  constructor(responses: LLMResponse[]) {
    this.#responses = [...responses];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.#responses.shift();
    if (!next) throw new Error("ScriptedLLMProvider has no responses left");
    return next;
  }
}

export function textResponse(text: string): LLMResponse {
  return {
    message: { role: "assistant", content: text, toolCalls: [] },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "scripted",
  };
}

export function toolCallResponse(...toolCalls: ToolCall[]): LLMResponse {
  return {
    message: { role: "assistant", content: "", toolCalls },
    stopReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "scripted",
  };
}

/** A logger that records parsed JSON lines instead of printing them. */
export function captureLogger() {
  const lines: LogFields[] = [];
  const logger = createLogger({ level: "debug", format: "json", write: (line) => lines.push(JSON.parse(line)) });
  return { logger, lines, events: () => lines.map((line) => line.event) };
}

export const FIXED_NOW = new Date("2026-10-07T12:00:00.000Z");
