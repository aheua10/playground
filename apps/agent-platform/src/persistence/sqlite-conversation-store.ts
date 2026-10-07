import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { ConversationStore } from "../conversation/conversation-store.ts";
import type { Message } from "../core/messages.ts";
import { transaction } from "./database.ts";

// Conversation history in SQLite: one row per message, numbered within its
// conversation. Messages are stored as JSON exactly as the runtime produced
// them, so provider data that must be replayed unchanged (Anthropic's signed
// thinking blocks) comes back byte for byte.
export class SqliteConversationStore implements ConversationStore {
  readonly #db: DatabaseSync;
  readonly #select: StatementSync;
  readonly #nextSeq: StatementSync;
  readonly #insert: StatementSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#select = db.prepare("SELECT message FROM messages WHERE conversation_id = ? ORDER BY seq");
    this.#nextSeq = db.prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM messages WHERE conversation_id = ?");
    this.#insert = db.prepare(
      "INSERT INTO messages (conversation_id, seq, message, created_at) VALUES (?, ?, ?, ?)",
    );
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    return this.#select.all(conversationId).map((row) => JSON.parse(row.message as string) as Message);
  }

  // A turn's messages are appended together or not at all.
  async appendMessages(conversationId: string, messages: Message[]): Promise<void> {
    const now = new Date().toISOString();
    transaction(this.#db, () => {
      const { next } = this.#nextSeq.get(conversationId) as { next: number };
      messages.forEach((message, i) => this.#insert.run(conversationId, next + i, JSON.stringify(message), now));
    });
  }
}
