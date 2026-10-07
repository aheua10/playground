// A task is work that outlives the turn that started it. The conversation gets
// a taskId back immediately and keeps going; the task runs in the background.

export type TaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface Task {
  id: string;
  /** The conversation that owns the task. Only that conversation can see or change it. */
  conversationId: string;
  /** The requirement the task was started with. */
  instruction: string;
  /** Name of the repository (from the allowlist) the task works on; none = empty workspace. */
  repository?: string;
  /** Later changes ("use Fastify instead of Express"), in order. */
  revisions: string[];
  status: TaskStatus;
  /** Starts at 1; each revision restarts the work as a new attempt. */
  attempt: number;
  /** Progress notes from the current attempt. */
  progress: string[];
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// The lifecycle, explicitly. A revision moves a task back to "running" (a new
// attempt), including from "running" itself. "cancelled" is final.
const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  running: ["running", "completed", "failed", "cancelled"],
  completed: ["running"],
  failed: ["running"],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Requirements as the worker sees them: the instruction followed by every revision. */
export function requirementsOf(task: Task): string[] {
  return [task.instruction, ...task.revisions];
}

/** The view of a task shown to the model and to HTTP clients. */
export function describeTask(task: Task) {
  return {
    taskId: task.id,
    status: task.status,
    repository: task.repository,
    attempt: task.attempt,
    requirements: requirementsOf(task),
    progress: task.progress,
    result: task.result,
    error: task.error,
    updatedAt: task.updatedAt,
  };
}
