import { randomUUID } from "node:crypto";
import type { ConversationStore } from "../conversation/conversation-store.ts";
import type { Message, UserMessage } from "../core/messages.ts";
import type { LLMProvider } from "../llm/llm-provider.ts";
import type { Logger } from "../logger.ts";

// The agent runtime: transport-agnostic orchestration of one conversational
// turn. It knows nothing about HTTP. REST today, and later a CLI, WebSocket or
// voice layer, all call runTurn() with the same plain input.
//
// A "turn" = one user message in, one final assistant reply out. Today that
// is a single LLM call. Next, it becomes the agent loop:
//
//   LLM call -> tool calls requested? -> [authorize + validate + execute] -> LLM call -> ... -> final reply
//
// The bracketed step is the trust boundary. The LLM only *proposes* actions;
// this runtime decides whether and how they run.

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
  logger: Logger;
}

export class AgentRuntime {
  readonly #llm: LLMProvider;
  readonly #store: ConversationStore;
  readonly #logger: Logger;

  constructor(deps: AgentRuntimeDeps) {
    this.#llm = deps.llm;
    this.#store = deps.store;
    this.#logger = deps.logger;
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const turnId = randomUUID();
    // Every log line in this turn carries conversationId + turnId, so
    // concurrent turns can be told apart in interleaved logs.
    const log = this.#logger.child({ conversationId: input.conversationId, turnId });
    const turnStartedAt = performance.now();

    log.info("user.message", { text: input.text });

    try {
      const history = await this.#store.getMessages(input.conversationId);
      const userMessage: UserMessage = { role: "user", content: input.text };
      const messages: Message[] = [...history, userMessage];

      log.info("llm.request", { provider: this.#llm.name, messageCount: messages.length });
      const llmStartedAt = performance.now();
      const response = await this.#llm.generate({ messages });
      log.info("llm.response", {
        provider: this.#llm.name,
        content: response.message.content,
        durationMs: elapsedMs(llmStartedAt),
      });

      // Commit the turn as a unit: the user message is only persisted together
      // with its reply, so a failed LLM call leaves history unchanged.
      await this.#store.appendMessages(input.conversationId, [userMessage, response.message]);

      log.info("final.response", { reply: response.message.content, durationMs: elapsedMs(turnStartedAt) });
      return { conversationId: input.conversationId, turnId, reply: response.message.content };
    } catch (error) {
      log.error("turn.failed", { error, durationMs: elapsedMs(turnStartedAt) });
      throw error;
    }
  }
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
