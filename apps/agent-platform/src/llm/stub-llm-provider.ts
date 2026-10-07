import type { AssistantMessage, Message } from "../core/messages.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "./llm-provider.ts";

// A deterministic, rule-based fake LLM for local development and tests. It
// speaks the same protocol as a real model, including tool calls, so the whole
// agent loop and task lifecycle can be exercised without an API key.
//
// If the last message is a tool result, it replies by quoting that result.
// Otherwise the first matching rule below picks a tool call (only tools that
// are actually offered count); "the task" means the most recent taskId seen in
// the conversation. With no match it echoes the message.

type Rule = {
  tool: string;
  pattern: RegExp;
  /** Returns the tool input, or undefined if the rule can't apply (e.g. no task yet). */
  input: (text: string, latestTaskId: string | undefined) => object | undefined;
};

const RULES: Rule[] = [
  { tool: "cancel_task", pattern: /\b(cancel|stop|abort)\b/i, input: (_, taskId) => (taskId ? { taskId } : undefined) },
  { tool: "list_tasks", pattern: /\b(status|progress|done|ready|finished)\b/i, input: () => ({}) },
  {
    tool: "revise_task",
    pattern: /\b(instead|also|change|add)\b/i,
    input: (text, taskId) => (taskId ? { taskId, change: text } : undefined),
  },
  {
    tool: "start_coding_task",
    pattern: /^(create|build|write|implement|make)\b/i,
    input: (text) => ({ instruction: text }),
  },
  {
    tool: "get_current_time",
    pattern: /\btime\b/i,
    input: (text) => {
      const timeZone = text.match(/\b[A-Z][A-Za-z_]+\/[A-Za-z_]+\b/)?.[0];
      return timeZone ? { timeZone } : {};
    },
  },
];

export class StubLLMProvider implements LLMProvider {
  readonly name = "stub";
  #callCount = 0;

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      const outcome = last.isError ? "failed" : "returned";
      return respond({ role: "assistant", content: `[stub] ${last.toolName} ${outcome}: ${last.content}`, toolCalls: [] });
    }

    const text = request.messages.findLast((m) => m.role === "user")?.content ?? "";
    const offered = new Set(request.tools.map((tool) => tool.name));
    const latestTaskId = findLatestTaskId(request.messages);

    for (const rule of RULES) {
      if (!offered.has(rule.tool) || !rule.pattern.test(text)) continue;
      const input = rule.input(text, latestTaskId);
      if (input === undefined) continue;
      return respond({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `stub_call_${++this.#callCount}`, name: rule.tool, input }],
      });
    }

    return respond({
      role: "assistant",
      content: `[stub] You said: "${text}" (context: ${request.messages.length} messages)`,
      toolCalls: [],
    });
  }
}

function findLatestTaskId(messages: Message[]): string | undefined {
  const ids = messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => [...m.content.matchAll(/"taskId":"(task_[a-z0-9]+)"/g)].map((match) => match[1]!));
  return ids.at(-1);
}

function respond(message: AssistantMessage): LLMResponse {
  return {
    message,
    stopReason: message.toolCalls.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "stub",
  };
}
