import type { Message, NoticeMessage, ToolCall, ToolResultMessage, UserMessage } from "../core/messages.ts";
import type { LLMProvider, StopReason } from "../llm/llm-provider.ts";
import type { Logger } from "../logger.ts";
import type { ToolExecutor } from "../tools/tool-executor.ts";
import type { ToolPolicy } from "../tools/tool-policy.ts";

// The agent loop, shared by every agent in the system. The conversation agent
// (AgentRuntime) and the coding worker run this same loop; they differ only in
// system prompt, tools, history and step limit.
//
//   ┌─► LLM call (history + tool definitions)
//   │     │
//   │     ├─ no tool calls ──────────────► done: return the reply + new messages
//   │     │
//   │     └─ tool calls ─► ToolExecutor (exists? permitted? valid? bounded)
//   │                        │
//   └──── append results ◄───┘
//
// The LLM DECIDES which actions it wants. The loop CONTROLS whether and how
// they run (ToolExecutor) and how many steps are allowed. It persists nothing;
// the caller decides what to keep.
//
// An optional observer sees the run as it happens (reply text, tool calls,
// tool results), which is how realtime clients follow a turn. It only watches.

/** Hooks for following a run live. They can't change what the loop does. */
export interface AgentLoopObserver {
  onTextDelta?: (text: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: ToolResultMessage) => void;
}

export interface AgentLoopInput {
  llm: LLMProvider;
  systemPrompt: string;
  toolExecutor: ToolExecutor;
  /** Earlier messages, sent as context. Not modified. */
  history: Message[];
  /** The message that starts this run: the user's, or a platform notice. */
  firstMessage: UserMessage | NoticeMessage;
  maxSteps: number;
  signal: AbortSignal;
  log: Logger;
  /** Passed through to tools (ToolContext). */
  conversationId: string;
  /** Identifies this run: a conversation turn, or a task attempt. */
  turnId: string;
  /** Limits which tools may run. Omitted: all of the executor's tools. */
  toolPolicy?: ToolPolicy;
  observer?: AgentLoopObserver;
}

export interface AgentLoopResult {
  reply: string;
  /** The first message followed by everything this run produced, in order. */
  messages: Message[];
}

export class StepLimitExceededError extends Error {
  override name = "StepLimitExceededError";
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { llm, systemPrompt, toolExecutor, maxSteps, signal, log, observer } = input;
  const messages: Message[] = [input.firstMessage];

  for (let step = 1; step <= maxSteps; step++) {
    signal.throwIfAborted(); // cancelled between steps: don't start another LLM call
    const stepLog = log.child({ step });
    const context = [...input.history, ...messages];
    const tools = toolExecutor.definitions();

    stepLog.info("llm.request", {
      provider: llm.name,
      messageCount: context.length,
      tools: tools.map((tool) => tool.name),
    });
    stepLog.debug("llm.request.payload", { systemPrompt, tools, messages: context });

    const llmStartedAt = performance.now();
    const response = await llm.generate({
      systemPrompt,
      messages: context,
      tools,
      signal,
      onTextDelta: observer?.onTextDelta,
    });
    const { message, stopReason } = response;
    stepLog.info("llm.response", {
      model: response.model,
      stopReason,
      content: message.content,
      toolCalls: message.toolCalls.map(({ id, name, input }) => ({ id, name, input })),
      usage: response.usage,
      durationMs: Math.round(performance.now() - llmStartedAt),
    });
    messages.push(message);

    // No tool calls: the model has given its final answer.
    if (message.toolCalls.length === 0) {
      return { reply: message.content || fallbackReply(stopReason), messages };
    }

    // Tool calls in a truncated or refused response may be incomplete, so
    // never run them.
    if (stopReason !== "tool_use") {
      throw new Error(`Model requested tools but stopped with "${stopReason}"`);
    }

    // Run the requested tools one at a time, in order. Sequential is the
    // safe default once tools have side effects; parallelism can come later.
    for (const call of message.toolCalls) {
      observer?.onToolCall?.(call);
      const result = await toolExecutor.execute(call, {
        conversationId: input.conversationId,
        turnId: input.turnId,
        signal,
        log: stepLog,
        policy: input.toolPolicy,
      });
      observer?.onToolResult?.(result);
      messages.push(result);
    }
  }

  throw new StepLimitExceededError(`Exceeded the limit of ${maxSteps} LLM calls`);
}

function fallbackReply(stopReason: StopReason): string {
  if (stopReason === "refusal") return "I can't help with that request.";
  if (stopReason === "max_tokens") return "My reply was cut off before I could finish.";
  return "";
}
