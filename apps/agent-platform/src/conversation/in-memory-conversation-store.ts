import type { Message } from "../core/messages.ts";
import type { ConversationStore } from "./conversation-store.ts";

// Process-local storage. Lost on restart, and not shared between instances,
// so the service must run as a single instance until a real store exists.
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
