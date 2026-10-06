import type { LLMProvider, LLMRequest, LLMResponse } from "./llm-provider.ts";

// Deterministic fake used until we choose a real provider (and kept afterwards
// for tests). It echoes the latest user message and reports how many messages
// it received, which makes conversation memory visible without a real model.
export class StubLLMProvider implements LLMProvider {
  readonly name = "stub";

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const lastUser = request.messages.findLast((m) => m.role === "user");
    return {
      message: {
        role: "assistant",
        content: `[stub] You said: "${lastUser?.content ?? ""}" (context: ${request.messages.length} messages)`,
      },
    };
  }
}
