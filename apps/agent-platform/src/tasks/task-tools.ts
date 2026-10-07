import { ToolError, type Tool } from "../tools/tool.ts";
import { describeTask, type Task } from "./task.ts";
import { TaskError, type TaskManager } from "./task-manager.ts";

// The tools that let the conversation agent drive background tasks.
//
// Security note: none of these take a conversation id as input. The id comes
// from ToolContext, which the runtime fills in. A model (or a prompt
// injection) can only ever reach tasks of the conversation it is running in,
// and `additionalProperties: false` rejects any attempt to pass one anyway.

export const TASK_ID_SCHEMA = { type: "string", pattern: "^task_[a-z0-9]+$", description: "The task id, e.g. task_3f2a9c01b4" };

export interface TaskToolOptions {
  /** Names of the repositories tasks may work on (the operator's allowlist). */
  repositories?: string[];
}

export function createTaskTools(tasks: TaskManager, options: TaskToolOptions = {}): Tool<never>[] {
  const repositories = options.repositories ?? [];
  // The repository parameter only exists when repositories are configured,
  // and its enum IS the allowlist: the executor rejects any other value
  // before the task is created.
  const repositoryProperty =
    repositories.length > 0
      ? {
          repository: {
            type: "string",
            enum: repositories,
            description:
              `Work on this repository (a checkout on a new branch) instead of an empty workspace. ` +
              `Available: ${repositories.join(", ")}. Use it when the user refers to their project or repository.`,
          },
        }
      : {};

  const startCodingTask: Tool<{ instruction: string; repository?: string }> = {
    definition: {
      name: "start_coding_task",
      description:
        "Starts a background coding task and returns immediately with its taskId while the task keeps " +
        "running. Use this whenever the user asks to write, create, build or change code or a project. " +
        "Don't wait for the task or check on it unprompted; tell the user it has started.",
      inputSchema: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "What to build, with every requirement the user has given so far.",
          },
          ...repositoryProperty,
        },
        required: ["instruction"],
        additionalProperties: false,
      },
    },
    execute: ({ instruction, repository }, context) =>
      handle(async () => {
        const task = await tasks.start(context.conversationId, instruction, { repository });
        return { taskId: task.id, status: task.status, repository: task.repository };
      }),
  };

  const getTask: Tool<{ taskId: string }> = {
    readOnly: true,
    definition: {
      name: "get_task",
      description:
        "Returns a task's status, progress and, once finished, its result or error. Use when the user " +
        "asks how a task is going or what it produced.",
      inputSchema: {
        type: "object",
        properties: { taskId: TASK_ID_SCHEMA },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
    execute: ({ taskId }, context) => handle(async () => describeTask(await tasks.get(context.conversationId, taskId))),
  };

  const listTasks: Tool<Record<string, never>> = {
    readOnly: true,
    definition: {
      name: "list_tasks",
      description:
        "Lists every task in this conversation with its status. Use when the user refers to tasks " +
        "without giving an id, or asks what is running.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    execute: (_input, context) =>
      handle(async () => (await tasks.list(context.conversationId)).map(summarize)),
  };

  const reviseTask: Tool<{ taskId: string; change: string }> = {
    definition: {
      name: "revise_task",
      description:
        "Adds or changes a requirement of an existing task. A running task restarts with the updated " +
        "requirements; a finished one runs again. Use this, rather than starting a new task, when the " +
        'user adds requirements or changes their mind (e.g. "use Fastify instead of Express").',
      inputSchema: {
        type: "object",
        properties: {
          taskId: TASK_ID_SCHEMA,
          change: { type: "string", minLength: 1, maxLength: 4000, description: "The new or changed requirement." },
        },
        required: ["taskId", "change"],
        additionalProperties: false,
      },
    },
    execute: ({ taskId, change }, context) =>
      handle(async () => summarize(await tasks.revise(context.conversationId, taskId, change))),
  };

  const cancelTask: Tool<{ taskId: string }> = {
    definition: {
      name: "cancel_task",
      description: "Stops a running task for good. Use when the user asks to stop or cancel work.",
      inputSchema: {
        type: "object",
        properties: { taskId: TASK_ID_SCHEMA },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
    execute: ({ taskId }, context) =>
      handle(async () => summarize(await tasks.cancel(context.conversationId, taskId))),
  };

  return [startCodingTask, getTask, listTasks, reviseTask, cancelTask];
}

function summarize(task: Task) {
  return { taskId: task.id, status: task.status, attempt: task.attempt, instruction: task.instruction };
}

// TaskErrors are the manager saying no (unknown task, illegal transition,
// limit reached): pass the reason to the model so it can react.
async function handle<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TaskError) throw new ToolError(error.message);
    throw error;
  }
}

