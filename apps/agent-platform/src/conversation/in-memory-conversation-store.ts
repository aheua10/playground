import type { Message } from "../core/messages.ts";
import type { ConversationStore } from "./conversation-store.ts";

// Process-local storage, lost on restart: for tests and STORE=memory. The
// server's default is SqliteConversationStore (persistence/).
export class InMemoryConversationStore implements ConversationStore {
  readonly #conversations = new Map<string, Message[]>();

  async getMessages(conversationId: string): Promise<Message[]> {
    // Return a copy so callers cannot mutate stored history by accident.
    return [...(this.#conversations.get(conversationId) ?? [])];
  }

  async appendMessages(conversationId: string, messages: Message[]): Promise<void> {
    const existing = this.#conversations.get(conversationId) ?? [];
    this.#conversations.set(conversationId, [...existing, ...messages]);
  }
}
