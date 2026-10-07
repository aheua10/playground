import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Task, TaskStatus } from "../tasks/task.ts";
import type { TaskStore } from "../tasks/task-store.ts";

// Tasks in SQLite: the whole Task as JSON, plus the columns lookups need.
// Adding a field to Task needs no migration; filtering on one would.
// Every read parses fresh objects, so callers can't change stored state
// without calling save().
export class SqliteTaskStore implements TaskStore {
  readonly #get: StatementSync;
  readonly #byConversation: StatementSync;
  readonly #byStatus: StatementSync;
  readonly #upsert: StatementSync;

  constructor(db: DatabaseSync) {
    this.#get = db.prepare("SELECT task FROM tasks WHERE id = ?");
    this.#byConversation = db.prepare("SELECT task FROM tasks WHERE conversation_id = ? ORDER BY created_at, id");
    this.#byStatus = db.prepare("SELECT task FROM tasks WHERE status = ? ORDER BY created_at, id");
    this.#upsert = db.prepare(`
      INSERT INTO tasks (id, conversation_id, status, task, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        status = excluded.status, task = excluded.task, updated_at = excluded.updated_at
    `);
  }

  async get(taskId: string): Promise<Task | undefined> {
    const row = this.#get.get(taskId);
    return row && parse(row);
  }

  async listByConversation(conversationId: string): Promise<Task[]> {
    return this.#byConversation.all(conversationId).map(parse);
  }

  async listByStatus(status: TaskStatus): Promise<Task[]> {
    return this.#byStatus.all(status).map(parse);
  }

  async save(task: Task): Promise<void> {
    this.#upsert.run(task.id, task.conversationId, task.status, JSON.stringify(task), task.createdAt, task.updatedAt);
  }
}

function parse(row: Record<string, unknown>): Task {
  return JSON.parse(row.task as string) as Task;
}
