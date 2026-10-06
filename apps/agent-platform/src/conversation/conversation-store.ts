import type { Message } from "../core/messages.ts";

// Persistence boundary for conversation history.
//
// The runtime depends only on this interface, so swapping the in-memory
// implementation for Postgres/DynamoDB/etc. later does not touch the runtime.
//
// Two design choices worth noting:
//   - Async from day one, even though the in-memory version is synchronous.
//     A sync interface would force every call site to change once real I/O
//     shows up.
//   - Append-only. There is no "save whole conversation" method, which avoids
//     read-modify-write lost updates and maps directly onto an INSERT into a
//     messages table or an event log.
export interface ConversationStore {
  /** Full history in order. Unknown conversationId => empty array. */
  getMessages(conversationId: string): Promise<Message[]>;

  /** Append messages to the end of the conversation, creating it if needed. */
  appendMessages(conversationId: string, messages: Message[]): Promise<void>;
}
