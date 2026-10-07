import { randomUUID } from "node:crypto";
import type { ConversationStore } from "../conversation/conversation-store.ts";
import { KeyedMutex } from "../core/keyed-mutex.ts";
import type { Message } from "../core/messages.ts";
import type { LLMProvider, StopReason } from "../llm/llm-provider.ts";
import type { Logger } from "../logger.ts";
import type { ToolExecutor } from "../tools/tool-executor.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";

// The agent runtime: transport-agnostic orchestration of one conversational
// turn. It knows nothing about HTTP. REST today, and later a CLI, WebSocket or
// voice layer, all call runTurn() with the same plain input.
//
// A "turn" = one user message in, one final reply out. In between runs the
// agent loop:
//
//   ┌─► LLM call (history + tool definitions)
//   │     │
//   │     ├─ no tool calls ──────────────► final reply, persist turn, return
//   │     │
//   │     └─ tool calls ─► ToolExecutor (exists? permitted? valid? bounded)
//   │                        │
//   └──── append results ◄───┘
//
// The LLM DECIDES which actions it wants. The runtime CONTROLS whether and how
// they run (ToolExecutor), how many steps a turn may take, and what is saved.
//
// Long-running work never happens inside a turn: tools like start_coding_task
// hand it to the TaskManager and return at once, so turns stay short.

const DEFAULT_MAX_STEPS = 8;

export interface TurnInput {
  conversationId: string;
  text: string;
}

export interface TurnResult {
  conversationId: string;
  turnId: string;
  reply: string;
}

export interface AgentRuntimeDeps {
  llm: LLMProvider;
  store: ConversationStore;
  toolExecutor: ToolExecutor;
  logger: Logger;
  /** Upper bound on LLM calls per turn, so a looping model can't run forever. */
  maxSteps?: number;
}

export class AgentRuntime {
  readonly #llm: LLMProvider;
  readonly #store: ConversationStore;
  readonly #toolExecutor: ToolExecutor;
  readonly #logger: Logger;
  readonly #maxSteps: number;
  readonly #turnLocks = new KeyedMutex();

  constructor(deps: AgentRuntimeDeps) {
    this.#llm = deps.llm;
    this.#store = deps.store;
    this.#toolExecutor = deps.toolExecutor;
    this.#logger = deps.logger;
    this.#maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  async runTurn(input: TurnInput, signal: AbortSignal = new AbortController().signal): Promise<TurnResult> {
    const { conversationId } = input;
    const turnId = randomUUID();
    // Every log line in this turn carries conversationId + turnId, so
    // concurrent turns can be told apart in interleaved logs.
    const log = this.#logger.child({ conversationId, turnId });
    const turnStartedAt = performance.now();

    log.info("user.message", { text: input.text });

    // One turn at a time per conversation. A second message waits until the
    // first turn is finished and saved, so it sees that turn's messages.
    // Other conversations are unaffected.
    if (this.#turnLocks.isLocked(conversationId)) log.info("turn.waiting");

    try {
      const result = await this.#turnLocks.run(conversationId, () => this.#runLoop(input, turnId, signal, log));
      log.info("final.response", { reply: result.reply, durationMs: elapsed(turnStartedAt) });
      return result;
    } catch (error) {
      if (signal.aborted) {
        log.warn("turn.cancelled", { durationMs: elapsed(turnStartedAt) });
      } else {
        log.error("turn.failed", { error, durationMs: elapsed(turnStartedAt) });
      }
      throw error;
    }
  }

  async #runLoop(input: TurnInput, turnId: string, signal: AbortSignal, log: Logger): Promise<TurnResult> {
    const { conversationId } = input;
    const history = await this.#store.getMessages(conversationId);
    // Messages produced during this turn. Persisted together only when the
    // turn completes, so a failed or cancelled turn leaves history untouched.
    const turnMessages: Message[] = [{ role: "user", content: input.text }];

    for (let step = 1; step <= this.#maxSteps; step++) {
      signal.throwIfAborted(); // cancelled (or gone while waiting): don't start another LLM call
      const stepLog = log.child({ step });
      const messages = [...history, ...turnMessages];
      const tools = this.#toolExecutor.definitions();

      stepLog.info("llm.request", {
        provider: this.#llm.name,
        messageCount: messages.length,
        tools: tools.map((tool) => tool.name),
      });
      stepLog.debug("llm.request.payload", { systemPrompt: SYSTEM_PROMPT, tools, messages });

      const llmStartedAt = performance.now();
      const response = await this.#llm.generate({ systemPrompt: SYSTEM_PROMPT, messages, tools, signal });
      const { message, stopReason } = response;
      stepLog.info("llm.response", {
        model: response.model,
        stopReason,
        content: message.content,
        toolCalls: message.toolCalls.map(({ id, name, input }) => ({ id, name, input })),
        usage: response.usage,
        durationMs: elapsed(llmStartedAt),
      });
      turnMessages.push(message);

      // No tool calls: the model has given its final answer.
      if (message.toolCalls.length === 0) {
        await this.#store.appendMessages(conversationId, turnMessages);
        return { conversationId, turnId, reply: message.content || fallbackReply(stopReason) };
      }

      // Tool calls in a truncated or refused response may be incomplete, so
      // never run them.
      if (stopReason !== "tool_use") {
        throw new Error(`Model requested tools but stopped with "${stopReason}"`);
      }

      // Run the requested tools one at a time, in order. Sequential is the
      // safe default once tools have side effects; parallelism can come later.
      for (const call of message.toolCalls) {
        turnMessages.push(await this.#toolExecutor.execute(call, { conversationId, turnId, signal, log: stepLog }));
      }
    }

    throw new Error(`Turn exceeded the limit of ${this.#maxSteps} LLM calls`);
  }

  /** Read-only view of a conversation, for inspection/debugging endpoints. */
  async getHistory(conversationId: string): Promise<Message[]> {
    return this.#store.getMessages(conversationId);
  }
}

function fallbackReply(stopReason: StopReason): string {
  if (stopReason === "refusal") return "I can't help with that request.";
  if (stopReason === "max_tokens") return "My reply was cut off before I could finish.";
  return "";
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
