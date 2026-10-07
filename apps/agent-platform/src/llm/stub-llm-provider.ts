import type { AssistantMessage } from "../core/messages.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "./llm-provider.ts";

// A deterministic, rule-based fake LLM for local development and tests. It
// speaks the same protocol as a real model, including tool calls, so the whole
// agent loop can be exercised without an API key:
//
//   - last message is a tool result    -> final reply quoting that result
//   - user mentions "time" and the
//     get_current_time tool is offered -> request that tool (an IANA zone such
//                                         as "Asia/Tokyo" in the text becomes input)
//   - anything else                    -> echo, with the size of the context
export class StubLLMProvider implements LLMProvider {
  readonly name = "stub";
  #callCount = 0;

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const last = request.messages.at(-1);

    if (last?.role === "tool") {
      const outcome = last.isError ? "failed" : "returned";
      return respond({ role: "assistant", content: `[stub] ${last.toolName} ${outcome}: ${last.content}`, toolCalls: [] });
    }

    const lastUser = request.messages.findLast((m) => m.role === "user");
    const wantsTime = lastUser !== undefined && /\btime\b/i.test(lastUser.content);
    if (wantsTime && request.tools.some((tool) => tool.name === "get_current_time")) {
      const timeZone = lastUser.content.match(/\b[A-Z][A-Za-z_]+\/[A-Za-z_]+\b/)?.[0];
      return respond({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: `stub_call_${++this.#callCount}`, name: "get_current_time", input: timeZone ? { timeZone } : {} },
        ],
      });
    }

    return respond({
      role: "assistant",
      content: `[stub] You said: "${lastUser?.content ?? ""}" (context: ${request.messages.length} messages)`,
      toolCalls: [],
    });
  }
}

function respond(message: AssistantMessage): LLMResponse {
  return {
    message,
    stopReason: message.toolCalls.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "stub",
  };
}
