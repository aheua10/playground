import type { Logger } from "../logger.ts";
import { TaskError, type TaskManager } from "../tasks/task-manager.ts";
import { TASK_ID_SCHEMA } from "../tasks/task-tools.ts";
import { ToolError, type Tool } from "../tools/tool.ts";
import { GitError } from "./git.ts";
import type { RepositoryCatalog } from "./repository-catalog.ts";
import { TaskCheckout } from "./task-checkout.ts";

// Publishing is the one step with effects outside this machine: it pushes a
// task's branch to the real remote. So it is deliberately narrow:
//
//   - opt-in (ALLOW_GIT_PUSH), and a separate tool the model uses when the
//     user asks, not something that happens automatically
//   - only a COMPLETED task of the calling conversation (ownership is checked
//     by TaskManager.get, with the conversation id from the runtime)
//   - only the task's own branch agent/<taskId>: never the base branch,
//     never forced, so it can't overwrite anyone's work
//   - authenticated by GIT_TOKEN, which neither the model nor the sandbox
//     ever sees
//
// Opening the pull request stays with the user: the result links to GitHub's
// compare page, where one click opens it.

export interface PublishTaskToolDeps {
  tasks: TaskManager;
  repositories: RepositoryCatalog;
  workspacesDir: string;
  gitAuth?: Record<string, string>;
  logger: Logger;
}

export function createPublishTaskTool(deps: PublishTaskToolDeps): Tool<{ taskId: string }> {
  return {
    definition: {
      name: "publish_task",
      description:
        "Pushes a completed task's branch (agent/<taskId>) to its repository so the user can review it " +
        "and open a pull request. Use only when the user asks to publish, push or share the work.",
      inputSchema: {
        type: "object",
        properties: { taskId: TASK_ID_SCHEMA },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
    execute: async ({ taskId }, context) => {
      const task = await deps.tasks.get(context.conversationId, taskId).catch((error: unknown) => {
        throw error instanceof TaskError ? new ToolError(error.message) : error;
      });
      if (!task.repository) throw new ToolError(`Task ${taskId} didn't work on a repository; there is nothing to publish.`);
      if (task.status !== "completed") {
        throw new ToolError(`Task ${taskId} is ${task.status}; it can be published once it has completed.`);
      }
      const repository = deps.repositories.get(task.repository);
      if (!repository) throw new ToolError(`Repository "${task.repository}" is no longer configured.`);

      const checkout = await TaskCheckout.open({ repository, workspacesDir: deps.workspacesDir, taskId });
      const log = deps.logger.child({ conversationId: task.conversationId, taskId, repository: repository.name });
      try {
        await checkout.push({ auth: deps.gitAuth, signal: context.signal });
      } catch (error) {
        if (context.signal.aborted) throw error;
        log.warn("git.push_failed", { branch: checkout.branch, error });
        const reason = error instanceof GitError ? error.message : "unexpected error";
        throw new ToolError(`Pushing ${checkout.branch} failed (${reason}).`);
      }
      log.info("git.pushed", { branch: checkout.branch });
      return {
        repository: repository.name,
        branch: checkout.branch,
        compareUrl: compareUrl(repository.url, await checkout.baseBranch(), checkout.branch),
      };
    },
  };
}

/** GitHub's "open a pull request" page for a branch, when the repository is on github.com. */
export function compareUrl(url: string, baseBranch: string, branch: string): string | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) return undefined;
  return `https://github.com/${match[1]}/${match[2]}/compare/${baseBranch}...${branch}?expand=1`;
}
