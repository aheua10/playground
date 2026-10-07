// The thing that actually does a task's work. The TaskManager owns the
// lifecycle; a worker only turns requirements into a result.

export interface TaskWorkerInput {
  taskId: string;
  conversationId: string;
  attempt: number;
  /** The full current requirements: the original instruction, then each revision. */
  requirements: string[];
  /** Repository name from the allowlist, if the task works on one. */
  repository?: string;
}

export interface TaskWorkerContext {
  /** Aborted when the attempt is cancelled or superseded by a revision. Must be honoured. */
  signal: AbortSignal;
  reportProgress(note: string): void;
}

export interface TaskWorker {
  /** Resolves with a result summary. */
  run(input: TaskWorkerInput, context: TaskWorkerContext): Promise<string>;
}

/**
 * Throw for expected failures; the message is shown to the model. Any other
 * error is reported generically, with details only in the logs (as with tools).
 */
export class TaskFailedError extends Error {
  override name = "TaskFailedError";
}
