import type { Task, TaskStatus } from "./task.ts";

// Persistence boundary for tasks, like ConversationStore for messages. The
// TaskManager is the only writer and serializes updates per task, so `save`
// can be a plain upsert (several writers would need optimistic locking).
// Implementations: InMemoryTaskStore below, SqliteTaskStore (persistence/).
export interface TaskStore {
  get(taskId: string): Promise<Task | undefined>;
  listByConversation(conversationId: string): Promise<Task[]>;
  /** E.g. at startup: tasks still "running" were interrupted by a crash. */
  listByStatus(status: TaskStatus): Promise<Task[]>;
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

  async listByStatus(status: TaskStatus): Promise<Task[]> {
    return [...this.#tasks.values()].filter((task) => task.status === status).map((task) => structuredClone(task));
  }

  async save(task: Task): Promise<void> {
    this.#tasks.set(task.id, structuredClone(task));
  }
}
