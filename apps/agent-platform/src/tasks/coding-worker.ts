import type { LLMProvider } from "../llm/llm-provider.ts";
import type { Logger } from "../logger.ts";
import type { RepositoryCatalog } from "../repositories/repository-catalog.ts";
import { TaskCheckout } from "../repositories/task-checkout.ts";
import { runAgentLoop, StepLimitExceededError } from "../runtime/agent-loop.ts";
import { createRunCommandTool, type CommandSandbox } from "../sandbox/command-sandbox.ts";
import { Workspace } from "../sandbox/workspace.ts";
import { createWorkspaceTools } from "../sandbox/workspace-tools.ts";
import { ToolExecutor } from "../tools/tool-executor.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { TaskFailedError, type TaskWorker, type TaskWorkerContext, type TaskWorkerInput } from "./task-worker.ts";

// A second agent: the coding worker. It runs the same agent loop as the
// conversation agent, with its own system prompt and its own, much narrower
// set of tools:
//
//   conversation agent ─ start_coding_task ─► TaskManager ─► CodingWorker (agent loop)
//                                                              ├─ list/read/write/delete_file ─► Workspace
//                                                              └─ run_command ─────────────────► CommandSandbox
//
// The trust boundary is the same ToolExecutor as before. What changes is what
// exists behind it: this agent can only touch its task's workspace and run
// commands in a sandbox. It has no task tools, no network tools, no secrets.
//
// Each task has one workspace, kept across attempts, so a revision ("use
// Fastify instead") builds on what the previous attempt wrote. If the task
// names a repository, the workspace is a checkout of it on branch
// agent/<taskId> (see TaskCheckout), and each successful attempt is committed.

const DEFAULT_MAX_STEPS = 40;
// Longer than the sandbox's own command timeout, so a slow command is stopped
// by the sandbox (which removes the container) rather than abandoned here.
const TOOL_TIMEOUT_MS = 180_000;

export interface CodingWorkerDeps {
  llm: LLMProvider;
  workspacesDir: string;
  /** Without a sandbox the worker can edit files but not run anything. */
  sandbox?: CommandSandbox;
  /** Repositories tasks may check out. */
  repositories?: RepositoryCatalog;
  /** Per-command git config that authenticates clone/push (see tokenAuth). */
  gitAuth?: Record<string, string>;
  logger: Logger;
  maxSteps?: number;
}

export class CodingWorker implements TaskWorker {
  readonly #deps: CodingWorkerDeps;
  readonly #maxSteps: number;
  readonly #systemPrompt: string;

  constructor(deps: CodingWorkerDeps) {
    this.#deps = deps;
    this.#maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
    this.#systemPrompt = codingWorkerPrompt(deps.sandbox !== undefined);
  }

  async run(input: TaskWorkerInput, { signal, reportProgress }: TaskWorkerContext): Promise<string> {
    const { llm, workspacesDir, sandbox } = this.#deps;
    const workspace = await Workspace.open(workspacesDir, input.taskId);
    const log = this.#deps.logger.child({
      conversationId: input.conversationId,
      taskId: input.taskId,
      attempt: input.attempt,
      agent: "coding-worker",
    });
    const checkout = input.repository ? await this.#checkout(input, workspace, signal, reportProgress, log) : undefined;

    // Tools are built per attempt, with this task's workspace bound in.
    const registry = new ToolRegistry();
    for (const tool of createWorkspaceTools(workspace, reportProgress)) registry.register(tool);
    if (sandbox) registry.register(createRunCommandTool(sandbox, workspace, reportProgress));

    log.info("worker.started", { workspace: workspace.root, canRunCommands: sandbox !== undefined });

    let reply: string;
    try {
      ({ reply } = await runAgentLoop({
        llm,
        systemPrompt: this.#systemPrompt,
        toolExecutor: new ToolExecutor({ registry, timeoutMs: TOOL_TIMEOUT_MS }),
        history: [],
        userMessage: { role: "user", content: await taskBrief(input, checkout) },
        maxSteps: this.#maxSteps,
        signal,
        log,
        conversationId: input.conversationId,
        turnId: `${input.taskId}#${input.attempt}`,
      }));
    } catch (error) {
      if (error instanceof StepLimitExceededError) {
        throw new TaskFailedError(`The coding agent did not finish within ${this.#maxSteps} steps.`);
      }
      throw error;
    }

    if (!checkout) {
      const { files } = await workspace.listFiles();
      return [reply, "", `Workspace: ${workspace.root}`, ...files.map((file) => `- ${file.path}`)].join("\n");
    }

    // The platform commits on the worker's behalf: the worker never runs git.
    const commit = await checkout.commitAll(commitMessage(input));
    log.info("git.committed", { repository: checkout.repository.name, branch: checkout.branch, commit });
    reportProgress(commit ? `Committed ${commit} on ${checkout.branch}` : "No changes to commit");
    const summary = await checkout.changeSummary();
    return [reply, "", `Branch ${checkout.branch} of ${checkout.repository.name}:`, summary || "(no changes yet)"].join("\n");
  }

  async #checkout(
    input: TaskWorkerInput,
    workspace: Workspace,
    signal: AbortSignal,
    reportProgress: (note: string) => void,
    log: Logger,
  ): Promise<TaskCheckout> {
    // The tool schema already limits the model to allowlisted names; this
    // check is the second line of defense.
    const repository = this.#deps.repositories?.get(input.repository!);
    if (!repository) throw new TaskFailedError(`Unknown repository "${input.repository}".`);
    try {
      const { checkout, cloned } = await TaskCheckout.prepare({
        repository,
        workspace,
        workspacesDir: this.#deps.workspacesDir,
        taskId: input.taskId,
        auth: this.#deps.gitAuth,
        signal,
      });
      if (cloned) {
        log.info("git.cloned", { repository: repository.name, branch: checkout.branch });
        reportProgress(`Checked out ${repository.name} on branch ${checkout.branch}`);
      }
      return checkout;
    } catch (error) {
      if (signal.aborted) throw error;
      log.error("git.clone_failed", { repository: repository.name, error });
      throw new TaskFailedError(`Could not check out ${repository.name}.`);
    }
  }
}

// Static per process (it only depends on whether commands can run), which
// keeps it cacheable like the conversation agent's prompt. Task-specific
// context goes in the first user message instead.
function codingWorkerPrompt(canRunCommands: boolean): string {
  return [
    "You are a coding agent completing one task inside an isolated workspace directory.",
    "Use the file tools to create and change files; paths are relative to the workspace root.",
    canRunCommands
      ? "Use run_command to install dependencies, build and run tests in the sandbox, and check your work by running it when that is practical."
      : "You cannot run commands, so write the code carefully and explain how to run it.",
    "If the workspace is a repository checkout, read the relevant existing code and any README or contributor docs before changing it, and follow the project's conventions.",
    "The workspace may hold work from an earlier attempt at this task: start with list_files, keep what still fits the requirements and change the rest.",
    "Nobody can answer questions while you work. Make reasonable assumptions and state them.",
    "When you are done, reply with a short summary: what you changed, how to run it, and any assumptions.",
  ].join("\n");
}

async function taskBrief(input: TaskWorkerInput, checkout: TaskCheckout | undefined): Promise<string> {
  const context = checkout
    ? [
        `The workspace is a checkout of the repository "${checkout.repository.name}", started from its ` +
          `${await checkout.baseBranch()} branch. You are on branch ${checkout.branch}. Your changes are ` +
          `committed for you when you finish; git is not available to you.`,
        "",
      ]
    : [];
  return [
    ...context,
    "Requirements, in the order they were given (later ones win where they conflict):",
    ...input.requirements.map((requirement, index) => `${index + 1}. ${requirement}`),
  ].join("\n");
}

function commitMessage(input: TaskWorkerInput): string {
  const [first = "Agent task"] = input.requirements;
  const subject = first.length > 72 ? `${first.slice(0, 69)}...` : first;
  return [
    subject,
    "",
    ...input.requirements.map((requirement, index) => `${index + 1}. ${requirement}`),
    "",
    `Task: ${input.taskId}, attempt ${input.attempt}`,
  ].join("\n");
}
