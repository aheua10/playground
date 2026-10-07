import type { Tool } from "../tools/tool.ts";
import type { Workspace } from "./workspace.ts";

// Where model-written code actually runs. The worker only sees this interface;
// DockerCommandSandbox is the implementation (a VM- or service-based sandbox
// could replace it without touching the worker).

export interface CommandResult {
  /** null if the process was killed (e.g. timeout). */
  exitCode: number | null;
  timedOut: boolean;
  /** stdout and stderr interleaved, keeping only the end when long. */
  output: string;
}

export interface CommandSandbox {
  /** Shown to the model, e.g. "Docker container (node:24-slim), no network". */
  readonly description: string;
  run(workspace: Workspace, command: string, options: { signal: AbortSignal }): Promise<CommandResult>;
}

export function createRunCommandTool(
  sandbox: CommandSandbox,
  workspace: Workspace,
  reportProgress: (note: string) => void,
): Tool<{ command: string }> {
  return {
    definition: {
      name: "run_command",
      description:
        `Runs a shell command in an isolated sandbox: ${sandbox.description}. The workspace is the ` +
        "current directory. Use it to install dependencies, build and run tests. Every call starts " +
        "a fresh sandbox: only files in the workspace persist between calls, and background " +
        "processes don't survive. A non-zero exit code is reported, not raised.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            minLength: 1,
            maxLength: 2000,
            description: 'Shell command, run with sh -c, e.g. "npm test".',
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    execute: async ({ command }, context) => {
      const result = await sandbox.run(workspace, command, { signal: context.signal });
      const outcome = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
      reportProgress(`Ran \`${command}\` (${outcome})`);
      return result;
    },
  };
}
