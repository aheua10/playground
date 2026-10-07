import type { Task } from "./task.ts";

// Persistence boundary for tasks, like ConversationStore for messages. The
// TaskManager is the only writer and serializes updates per task, so `save`
// can be a plain upsert (a database version would add optimistic locking).
export interface TaskStore {
  get(taskId: string): Promise<Task | undefined>;
  listByConversation(conversationId: string): Promise<Task[]>;
  /** Insert or replace. */
  save(task: Task): Promise<void>;
}

export class InMemoryTaskStore implements TaskStore {
  readonly #tasks = new Map<string, Task>();

  // Copies in and out, so nobody mutates stored state without calling save().
  async get(taskId: string): Promise<Task | undefined> {
    const task = this.#tasks.get(taskId);
    return task && structuredClone(task);
  }

  async listByConversation(conversationId: string): Promise<Task[]> {
    return [...this.#tasks.values()]
      .filter((task) => task.conversationId === conversationId)
      .map((task) => structuredClone(task));
  }

  async save(task: Task): Promise<void> {
    this.#tasks.set(task.id, structuredClone(task));
  }
}
