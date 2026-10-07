import type { LLMProvider } from "../llm/llm-provider.ts";
import type { Logger } from "../logger.ts";
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
// Fastify instead") builds on what the previous attempt wrote.

const DEFAULT_MAX_STEPS = 40;
// Longer than the sandbox's own command timeout, so a slow command is stopped
// by the sandbox (which removes the container) rather than abandoned here.
const TOOL_TIMEOUT_MS = 180_000;

export interface CodingWorkerDeps {
  llm: LLMProvider;
  workspacesDir: string;
  /** Without a sandbox the worker can edit files but not run anything. */
  sandbox?: CommandSandbox;
  logger: Logger;
  maxSteps?: number;
}

export class CodingWorker implements TaskWorker {
  readonly #llm: LLMProvider;
  readonly #workspacesDir: string;
  readonly #sandbox: CommandSandbox | undefined;
  readonly #logger: Logger;
  readonly #maxSteps: number;
  readonly #systemPrompt: string;

  constructor(deps: CodingWorkerDeps) {
    this.#llm = deps.llm;
    this.#workspacesDir = deps.workspacesDir;
    this.#sandbox = deps.sandbox;
    this.#logger = deps.logger;
    this.#maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
    this.#systemPrompt = codingWorkerPrompt(deps.sandbox !== undefined);
  }

  async run(input: TaskWorkerInput, { signal, reportProgress }: TaskWorkerContext): Promise<string> {
    const workspace = await Workspace.open(this.#workspacesDir, input.taskId);

    // Tools are built per attempt, with this task's workspace bound in.
    const registry = new ToolRegistry();
    for (const tool of createWorkspaceTools(workspace, reportProgress)) registry.register(tool);
    if (this.#sandbox) registry.register(createRunCommandTool(this.#sandbox, workspace, reportProgress));

    const log = this.#logger.child({
      conversationId: input.conversationId,
      taskId: input.taskId,
      attempt: input.attempt,
      agent: "coding-worker",
    });
    log.info("worker.started", { workspace: workspace.root, canRunCommands: this.#sandbox !== undefined });

    let reply: string;
    try {
      ({ reply } = await runAgentLoop({
        llm: this.#llm,
        systemPrompt: this.#systemPrompt,
        toolExecutor: new ToolExecutor({ registry, timeoutMs: TOOL_TIMEOUT_MS }),
        history: [],
        userMessage: { role: "user", content: formatRequirements(input.requirements) },
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

    const { files } = await workspace.listFiles();
    return [reply, "", `Workspace: ${workspace.root}`, ...files.map((file) => `- ${file.path}`)].join("\n");
  }
}

// Static per process (it only depends on whether commands can run), which
// keeps it cacheable like the conversation agent's prompt.
function codingWorkerPrompt(canRunCommands: boolean): string {
  return [
    "You are a coding agent completing one task inside an isolated workspace directory.",
    "Use the file tools to create and change files; paths are relative to the workspace root.",
    canRunCommands
      ? "Use run_command to install dependencies, build and run tests in the sandbox, and check your work by running it when that is practical."
      : "You cannot run commands, so write the code carefully and explain how to run it.",
    "The workspace may hold files from an earlier attempt at this task: start with list_files, keep what still fits the requirements and change the rest.",
    "Nobody can answer questions while you work. Make reasonable assumptions and state them.",
    "When you are done, reply with a short summary: what you built, how to run it, and any assumptions.",
  ].join("\n");
}

function formatRequirements(requirements: string[]): string {
  return [
    "Requirements, in the order they were given (later ones win where they conflict):",
    ...requirements.map((requirement, index) => `${index + 1}. ${requirement}`),
  ].join("\n");
}
