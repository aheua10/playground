import type { Logger } from "../logger.ts";
import type { TaskView } from "../tasks/task.ts";

// What happens in a conversation, as it happens. The runtime and the
// TaskManager PUBLISH; transports SUBSCRIBE. Publishers don't know who is
// listening, so a turn started over HTTP still streams to a WebSocket client
// watching the same conversation, and a future voice layer is just another
// subscriber.
//
// In-process only. Several instances would need a shared bus (e.g. Redis
// pub/sub), or routing each conversation to a single instance.

export type TaskChange = "started" | "progress" | "revised" | "completed" | "failed" | "cancelled";

export type ConversationEvent =
  | { type: "turn.started"; conversationId: string; turnId: string; text: string }
  | { type: "reply.delta"; conversationId: string; turnId: string; text: string }
  | { type: "tool.called"; conversationId: string; turnId: string; toolCallId: string; name: string; input: unknown }
  | { type: "tool.finished"; conversationId: string; turnId: string; toolCallId: string; name: string; isError: boolean }
  | { type: "turn.completed"; conversationId: string; turnId: string; reply: string }
  | { type: "turn.failed"; conversationId: string; turnId: string; reason: "cancelled" | "error" }
  | { type: "task.updated"; conversationId: string; change: TaskChange; task: TaskView };

export type ConversationEventListener = (event: ConversationEvent) => void;

export class ConversationEvents {
  readonly #byConversation = new Map<string, Set<ConversationEventListener>>();
  readonly #everything = new Set<ConversationEventListener>();
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /** Events of one conversation. Returns the unsubscribe function. */
  subscribe(conversationId: string, listener: ConversationEventListener): () => void {
    let listeners = this.#byConversation.get(conversationId);
    if (!listeners) this.#byConversation.set(conversationId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#byConversation.delete(conversationId);
    };
  }

  /** Events of every conversation, for platform components (e.g. the task notifier). */
  subscribeAll(listener: ConversationEventListener): () => void {
    this.#everything.add(listener);
    return () => this.#everything.delete(listener);
  }

  publish(event: ConversationEvent): void {
    const listeners = [...(this.#byConversation.get(event.conversationId) ?? []), ...this.#everything];
    for (const listener of listeners) {
      // A broken subscriber (say, a closed socket) must not break the turn or
      // task that published the event.
      try {
        listener(event);
      } catch (error) {
        this.#logger.error("events.listener_failed", { type: event.type, error });
      }
    }
  }
}
