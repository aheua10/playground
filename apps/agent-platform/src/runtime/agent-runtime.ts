import { randomUUID } from "node:crypto";
import type { ConversationStore } from "../conversation/conversation-store.ts";
import { KeyedMutex } from "../core/keyed-mutex.ts";
import type { Message } from "../core/messages.ts";
import type { ConversationEvent, ConversationEvents } from "../events/conversation-events.ts";
import type { LLMProvider } from "../llm/llm-provider.ts";
import type { Logger } from "../logger.ts";
import type { ToolExecutor } from "../tools/tool-executor.ts";
import { runAgentLoop } from "./agent-loop.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";

// The conversation agent: transport-agnostic orchestration of one
// conversational turn. It knows nothing about HTTP. REST today, and later a
// CLI, WebSocket or voice layer, all call runTurn() with the same plain input.
//
// A "turn" = one user message in, one final reply out. In between runs the
// shared agent loop (agent-loop.ts). What this class adds is conversation
// state: it loads the history, serializes turns per conversation, and saves
// the turn when it completes.
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
  /** Where the turn's progress is published, for realtime clients. Optional: REST alone doesn't need it. */
  events?: ConversationEvents;
  /** Upper bound on LLM calls per turn, so a looping model can't run forever. */
  maxSteps?: number;
}

export class AgentRuntime {
  readonly #llm: LLMProvider;
  readonly #store: ConversationStore;
  readonly #toolExecutor: ToolExecutor;
  readonly #logger: Logger;
  readonly #events: ConversationEvents | undefined;
  readonly #maxSteps: number;
  readonly #turnLocks = new KeyedMutex();

  constructor(deps: AgentRuntimeDeps) {
    this.#llm = deps.llm;
    this.#store = deps.store;
    this.#toolExecutor = deps.toolExecutor;
    this.#logger = deps.logger;
    this.#events = deps.events;
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

    // Everything below runs under the lock, including the events that open and
    // close the turn: subscribers see one turn's events at a time, never two
    // interleaved.
    return this.#turnLocks.run(conversationId, async () => {
      const publish = (event: TurnEvent) => this.#events?.publish({ ...event, conversationId, turnId });
      publish({ type: "turn.started", text: input.text });
      try {
        const history = await this.#store.getMessages(conversationId);
        const result = await runAgentLoop({
          llm: this.#llm,
          systemPrompt: SYSTEM_PROMPT,
          toolExecutor: this.#toolExecutor,
          history,
          userMessage: { role: "user", content: input.text },
          maxSteps: this.#maxSteps,
          signal,
          log,
          conversationId,
          turnId,
        });
        // Persisted only now, as a unit: a failed or cancelled turn leaves
        // history untouched.
        await this.#store.appendMessages(conversationId, result.messages);
        log.info("final.response", { reply: result.reply, durationMs: elapsed(turnStartedAt) });
        publish({ type: "turn.completed", reply: result.reply });
        return { conversationId, turnId, reply: result.reply };
      } catch (error) {
        if (signal.aborted) {
          log.warn("turn.cancelled", { durationMs: elapsed(turnStartedAt) });
        } else {
          log.error("turn.failed", { error, durationMs: elapsed(turnStartedAt) });
        }
        // The reason only: error details stay in the logs, not on the wire.
        publish({ type: "turn.failed", reason: signal.aborted ? "cancelled" : "error" });
        throw error;
      }
    });
  }

  /** Read-only view of a conversation, for inspection/debugging endpoints. */
  async getHistory(conversationId: string): Promise<Message[]> {
    return this.#store.getMessages(conversationId);
  }
}

/** A turn's events before the runtime stamps them with the conversation and turn ids. */
type TurnEvent = DistributiveOmit<Extract<ConversationEvent, { turnId: string }>, "conversationId" | "turnId">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
