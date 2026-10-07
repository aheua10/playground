import { randomUUID } from "node:crypto";
import { KeyedMutex } from "../core/keyed-mutex.ts";
import type { ConversationEvents, TaskChange } from "../events/conversation-events.ts";
import type { Logger } from "../logger.ts";
import { canTransition, describeTask, requirementsOf, type Task, type TaskStatus } from "./task.ts";
import type { TaskStore } from "./task-store.ts";
import { TaskFailedError, type TaskWorker } from "./task-worker.ts";

// Owns the task lifecycle. Everything that changes a task goes through here:
//
//   start   create the task, launch attempt 1 in the background, return at once
//   revise  record the change, abort the current attempt, launch attempt N+1
//   cancel  abort the current attempt; final
//   worker  progress / result / failure, applied only if its attempt is current
//
// Two mechanisms keep this race-free:
//   - a per-task lock, so updates to one task never interleave
//   - attempt numbers, so a superseded attempt that finishes late is ignored
//     (revise to "use Fastify" while the Express attempt is still running)
//
// Ownership is checked on every call: a task is only visible to the
// conversation that started it.
//
// Every saved change is also published as a task.updated event, under the
// task's lock, so subscribers see one task's changes in the order they happened.
//
// Running attempts live in this process (AbortControllers in #running). In a
// multi-instance deployment this class keeps its interface but hands work to a
// queue and separate workers; cancel becomes a message to the worker.

/** A request that can't be honoured. The message is safe to show the model. */
export class TaskError extends Error {
  override name = "TaskError";
}

const DEFAULT_MAX_RUNNING_PER_CONVERSATION = 3;

export interface TaskManagerDeps {
  store: TaskStore;
  worker: TaskWorker;
  logger: Logger;
  events?: ConversationEvents;
  maxRunningPerConversation?: number;
}

export class TaskManager {
  readonly #store: TaskStore;
  readonly #worker: TaskWorker;
  readonly #logger: Logger;
  readonly #events: ConversationEvents | undefined;
  readonly #maxRunning: number;
  readonly #locks = new KeyedMutex();
  readonly #running = new Map<string, { attempt: number; controller: AbortController }>();

  constructor(deps: TaskManagerDeps) {
    this.#store = deps.store;
    this.#worker = deps.worker;
    this.#logger = deps.logger;
    this.#events = deps.events;
    this.#maxRunning = deps.maxRunningPerConversation ?? DEFAULT_MAX_RUNNING_PER_CONVERSATION;
  }

  async start(conversationId: string, instruction: string, options: { repository?: string } = {}): Promise<Task> {
    // Not atomic with the save below; fine because turns, the only callers,
    // are serialized per conversation.
    const running = (await this.#store.listByConversation(conversationId)).filter((t) => t.status === "running");
    if (running.length >= this.#maxRunning) {
      throw new TaskError(
        `This conversation already has ${running.length} running tasks. Cancel one or wait for one to finish.`,
      );
    }

    const now = new Date().toISOString();
    const task: Task = {
      id: `task_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      conversationId,
      instruction,
      ...(options.repository && { repository: options.repository }),
      revisions: [],
      status: "running",
      attempt: 1,
      progress: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.#locks.run(task.id, async () => {
      await this.#save(task, "started");
      this.#log(task).info("task.started", { instruction, repository: task.repository });
      this.#launch(task);
      return task;
    });
  }

  async revise(conversationId: string, taskId: string, change: string): Promise<Task> {
    return this.#locks.run(taskId, async () => {
      const task = await this.#getOwned(conversationId, taskId);
      if (task.status === "cancelled") {
        throw new TaskError(`Task ${taskId} was cancelled. Start a new task instead.`);
      }
      this.#abortAttempt(taskId);
      this.#transition(task, "running");
      task.revisions.push(change);
      task.attempt += 1;
      task.progress = [];
      delete task.result;
      delete task.error;
      await this.#save(task, "revised");
      this.#log(task).info("task.revised", { change });
      this.#launch(task);
      return task;
    });
  }

  async cancel(conversationId: string, taskId: string): Promise<Task> {
    return this.#locks.run(taskId, async () => {
      const task = await this.#getOwned(conversationId, taskId);
      if (task.status !== "running") throw new TaskError(`Task ${taskId} is already ${task.status}.`);
      this.#abortAttempt(taskId);
      this.#transition(task, "cancelled");
      await this.#save(task, "cancelled");
      this.#log(task).info("task.cancelled");
      return task;
    });
  }

  async get(conversationId: string, taskId: string): Promise<Task> {
    return this.#getOwned(conversationId, taskId);
  }

  async list(conversationId: string): Promise<Task[]> {
    const tasks = await this.#store.listByConversation(conversationId);
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** On SIGTERM: in-memory work can't survive a restart, so record it as interrupted. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#running.keys()].map((taskId) =>
        this.#locks.run(taskId, async () => {
          const task = await this.#store.get(taskId);
          if (!task || !this.#running.has(taskId)) return;
          this.#abortAttempt(taskId);
          this.#transition(task, "failed");
          task.error = "Interrupted: the server shut down.";
          await this.#save(task, "interrupted");
          this.#log(task).warn("task.failed", { error: task.error });
        }),
      ),
    );
  }

  // Runs one attempt in the background. Nothing awaits it: that is the point.
  #launch(task: Task): void {
    const { id: taskId, attempt } = task;
    const controller = new AbortController();
    this.#running.set(taskId, { attempt, controller });
    const log = this.#log(task);

    Promise.resolve()
      .then(() =>
        this.#worker.run(
          {
            taskId,
            conversationId: task.conversationId,
            attempt,
            requirements: requirementsOf(task),
            repository: task.repository,
          },
          {
            signal: controller.signal,
            reportProgress: (note) => {
              void this.#applyIfCurrent(taskId, attempt, "progress", (current) => {
                current.progress.push(note);
                log.info("task.progress", { note });
              });
            },
          },
        ),
      )
      .then(
        (result) =>
          this.#applyIfCurrent(taskId, attempt, "completed", (current) => {
            this.#transition(current, "completed");
            current.result = result;
            log.info("task.completed", { result });
          }),
        (error: unknown) =>
          this.#applyIfCurrent(taskId, attempt, "failed", (current) => {
            this.#transition(current, "failed");
            current.error =
              error instanceof TaskFailedError ? error.message : "The task failed with an internal error.";
            log.error("task.failed", { error });
          }),
      );
  }

  // Worker callbacks land here. If the attempt was cancelled or superseded in
  // the meantime, the update is dropped.
  async #applyIfCurrent(
    taskId: string,
    attempt: number,
    change: TaskChange,
    apply: (task: Task) => void,
  ): Promise<void> {
    try {
      await this.#locks.run(taskId, async () => {
        if (this.#running.get(taskId)?.attempt !== attempt) {
          this.#logger.debug("task.stale_update_dropped", { taskId, attempt });
          return;
        }
        const task = await this.#store.get(taskId);
        if (!task) return;
        apply(task);
        if (task.status !== "running") this.#running.delete(taskId);
        await this.#save(task, change);
      });
    } catch (error) {
      this.#logger.error("task.update_failed", { taskId, attempt, error });
    }
  }

  #abortAttempt(taskId: string): void {
    this.#running.get(taskId)?.controller.abort(new Error("Task attempt stopped"));
    this.#running.delete(taskId);
  }

  #transition(task: Task, to: TaskStatus): void {
    if (!canTransition(task.status, to)) {
      throw new TaskError(`Task ${task.id} is ${task.status} and can't become ${to}.`);
    }
    task.status = to;
  }

  async #getOwned(conversationId: string, taskId: string): Promise<Task> {
    const task = await this.#store.get(taskId);
    // Same answer for "doesn't exist" and "belongs to someone else": don't leak ids.
    if (!task || task.conversationId !== conversationId) {
      throw new TaskError(`No task ${taskId} in this conversation.`);
    }
    return task;
  }

  async #save(task: Task, change: TaskChange): Promise<void> {
    task.updatedAt = new Date().toISOString();
    await this.#store.save(task);
    this.#events?.publish({ type: "task.updated", conversationId: task.conversationId, change, task: describeTask(task) });
  }

  #log(task: Task): Logger {
    return this.#logger.child({ conversationId: task.conversationId, taskId: task.id, attempt: task.attempt });
  }
}
