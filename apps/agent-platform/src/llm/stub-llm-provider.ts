import { setTimeout as sleep } from "node:timers/promises";
import type { AssistantMessage, Message } from "../core/messages.ts";
import type { ToolDefinition } from "../core/tool-definition.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "./llm-provider.ts";

// A deterministic, rule-based fake LLM for local development and tests. It
// speaks the same protocol as a real model, including tool calls, so the whole
// agent loop and task lifecycle can be exercised without an API key.
//
// As the conversation agent: if the last message is a tool result, it replies
// by quoting that result; if it is a platform notice, it passes on the notice's
// first line. Otherwise the first matching rule below picks a tool
// call (only tools that are actually offered count); "the task" means the most
// recent taskId seen in the conversation, and "this project" means the first
// repository start_coding_task offers. With no match it echoes the message.
//
// As the coding worker (recognised by being offered write_file): it writes a
// NOTES.md with the requirements, runs one command if run_command is offered,
// then summarizes. Enough to exercise the worker, workspace and sandbox.
//
// Reply text is streamed word by word through onTextDelta, like a real model,
// optionally with a delay between words so streaming is visible in a demo.

type RuleContext = { latestTaskId: string | undefined; tools: ToolDefinition[] };

type Rule = {
  tool: string;
  pattern: RegExp;
  /** Returns the tool input, or undefined if the rule can't apply (e.g. no task yet). */
  input: (text: string, context: RuleContext) => object | undefined;
};

const RULES: Rule[] = [
  {
    tool: "cancel_task",
    pattern: /\b(cancel|stop|abort)\b/i,
    input: (_, { latestTaskId }) => (latestTaskId ? { taskId: latestTaskId } : undefined),
  },
  {
    tool: "publish_task",
    pattern: /\b(publish|push)\b/i,
    input: (_, { latestTaskId }) => (latestTaskId ? { taskId: latestTaskId } : undefined),
  },
  { tool: "list_tasks", pattern: /\b(status|progress|done|ready|finished)\b/i, input: () => ({}) },
  {
    tool: "revise_task",
    pattern: /\b(instead|also|change|add)\b/i,
    input: (text, { latestTaskId }) => (latestTaskId ? { taskId: latestTaskId, change: text } : undefined),
  },
  {
    tool: "start_coding_task",
    pattern: /^(create|build|write|implement|make)\b/i,
    input: (text, { tools }) => {
      const [repository] = offeredRepositories(tools);
      const meansProject = /\b(this|the|my|our) (project|repo|repository)\b/i.test(text);
      return repository && meansProject ? { instruction: text, repository } : { instruction: text };
    },
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

function offeredRepositories(tools: ToolDefinition[]): string[] {
  const start = tools.find((tool) => tool.name === "start_coding_task");
  const properties = start?.inputSchema.properties as { repository?: { enum?: string[] } } | undefined;
  return properties?.repository?.enum ?? [];
}

export class StubLLMProvider implements LLMProvider {
  readonly name = "stub";
  readonly #wordDelayMs: number;
  #callCount = 0;

  constructor(options: { wordDelayMs?: number } = {}) {
    this.#wordDelayMs = options.wordDelayMs ?? 0;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const response = this.#decide(request);
    const { content } = response.message;
    if (request.onTextDelta && content) {
      for (const word of content.split(/(?<=\s)/)) {
        if (this.#wordDelayMs > 0) await sleep(this.#wordDelayMs, undefined, { signal: request.signal });
        request.onTextDelta(word);
      }
    }
    return response;
  }

  #decide(request: LLMRequest): LLMResponse {
    const offered = new Set(request.tools.map((tool) => tool.name));
    if (offered.has("write_file")) return this.#actAsCodingWorker(request, offered);

    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      const outcome = last.isError ? "failed" : "returned";
      return reply(`[stub] ${last.toolName} ${outcome}: ${last.content}`);
    }
    if (last?.role === "notice") {
      return reply(`[stub] Heads-up: ${last.content.split("\n")[0]}`);
    }

    const text = request.messages.findLast((m) => m.role === "user")?.content ?? "";
    const latestTaskId = findLatestTaskId(request.messages);
    for (const rule of RULES) {
      if (!offered.has(rule.tool) || !rule.pattern.test(text)) continue;
      const input = rule.input(text, { latestTaskId, tools: request.tools });
      if (input === undefined) continue;
      return this.#callTool(rule.tool, input);
    }

    return reply(`[stub] You said: "${text}" (context: ${request.messages.length} messages)`);
  }

  #actAsCodingWorker(request: LLMRequest, offered: Set<string>): LLMResponse {
    const results = request.messages.filter((m) => m.role === "tool");
    const requirements = request.messages.find((m) => m.role === "user")?.content ?? "";
    if (results.length === 0) {
      return this.#callTool("write_file", {
        path: "NOTES.md",
        content: `# Task notes (written by the stub LLM)\n\n${requirements}\n`,
      });
    }
    if (results.length === 1 && offered.has("run_command")) {
      return this.#callTool("run_command", { command: "ls -la && node --version" });
    }
    const steps = results.map((r) => `${r.toolName} ${r.isError ? "failed" : "ok"}`).join(", ");
    return reply(`[stub] Done: ${steps}. A real model would have written the code.`);
  }

  #callTool(name: string, input: object): LLMResponse {
    return respond({
      role: "assistant",
      content: "",
      toolCalls: [{ id: `stub_call_${++this.#callCount}`, name, input }],
    });
  }
}

function reply(content: string): LLMResponse {
  return respond({ role: "assistant", content, toolCalls: [] });
}

function findLatestTaskId(messages: Message[]): string | undefined {
  const ids = messages
    .filter((m) => m.role === "tool" || m.role === "notice")
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
