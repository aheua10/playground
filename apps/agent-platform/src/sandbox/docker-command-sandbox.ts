import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CommandResult, CommandSandbox } from "./command-sandbox.ts";
import type { Workspace } from "./workspace.ts";

// Runs every command in a fresh, locked-down container. The container, not
// the command string, is the security boundary: inside it the model may run
// anything (sh, node, npm), but it only sees the task's workspace, and:
//
//   --network none                    nothing to exfiltrate to, nothing to attack
//                                     (configurable, e.g. to allow npm install)
//   --read-only, --tmpfs /tmp         immutable image; scratch space in memory
//   --cap-drop ALL,
//   --security-opt no-new-privileges  no kernel capabilities, no setuid escalation
//   --user <agent uid>                files it writes stay owned by the agent's user
//   --memory/--cpus/--pids-limit      bounded resources (no fork bombs)
//   no host environment               API keys and other secrets never get in
//   --rm, and `docker rm -f` on timeout or cancel
//
// The host never involves a shell: `docker` is spawned with an argument array,
// and the command string only reaches `sh -c` INSIDE the container.
//
// The workspace is bind-mounted by its path, which the Docker daemon resolves
// on ITS host. If the agent itself runs in a container, mount the workspaces
// directory at the same path inside and out (see docker-compose.sandbox.yml).

const MAX_OUTPUT_CHARS = 8_000; // stays under the executor's result limit once JSON-encoded

export interface DockerSandboxOptions {
  image: string;
  network: "none" | "bridge";
  timeoutMs?: number;
  memory?: string;
  cpus?: string;
  dockerBinary?: string;
}

export class DockerCommandSandbox implements CommandSandbox {
  readonly description: string;
  readonly #options: Required<DockerSandboxOptions>;

  constructor(options: DockerSandboxOptions) {
    this.#options = { timeoutMs: 120_000, memory: "1g", cpus: "1", dockerBinary: "docker", ...options };
    const network = options.network === "none" ? "no network access" : "network access";
    this.description = `a Docker container (${options.image}, Node.js and npm available, ${network}, ${
      this.#options.timeoutMs / 1000
    } s time limit)`;
  }

  /** Fails fast at startup if Docker is unreachable or the image isn't pulled. */
  async verify(): Promise<void> {
    const { exitCode, output } = await this.#docker(["image", "inspect", "--format", "{{.Id}}", this.#options.image]);
    if (exitCode !== 0) {
      throw new Error(
        `Docker sandbox unavailable: ${output.trim() || "docker failed"}. ` +
          `Is the Docker daemon reachable, and has the image been pulled (docker pull ${this.#options.image})?`,
      );
    }
  }

  async run(workspace: Workspace, command: string, { signal }: { signal: AbortSignal }): Promise<CommandResult> {
    signal.throwIfAborted();
    const { image, network, memory, cpus, timeoutMs } = this.#options;
    const name = `agent-sandbox-${randomUUID()}`;
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    const args = [
      "run", "--rm", "--name", name,
      "--network", network,
      "--read-only", "--tmpfs", "/tmp:rw,exec,size=512m",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", `${uid}:${gid}`,
      "--memory", memory, "--memory-swap", memory, "--cpus", cpus, "--pids-limit", "256",
      "--env", "HOME=/tmp", "--env", "npm_config_update_notifier=false",
      "--mount", `type=bind,source=${workspace.root},target=/workspace`,
      "--workdir", "/workspace",
      image, "sh", "-c", command,
    ];

    // Removing the container is what actually stops it; killing the `docker run`
    // client alone can leave the container running.
    const remove = () => void this.#docker(["rm", "-f", name]);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      remove();
    }, timeoutMs);
    signal.addEventListener("abort", remove, { once: true });

    try {
      const { exitCode, output } = await this.#docker(args);
      signal.throwIfAborted();
      return { exitCode: timedOut ? null : exitCode, timedOut, output };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", remove);
    }
  }

  // Spawns the docker CLI (no shell) and collects interleaved output, keeping the tail.
  #docker(args: string[]): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#options.dockerBinary, args, { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let truncated = false;
      const collect = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(-MAX_OUTPUT_CHARS);
          truncated = true;
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", reject); // e.g. the docker binary is missing
      child.on("close", (exitCode) => {
        resolve({ exitCode, output: (truncated ? "[earlier output omitted]\n" : "") + output });
      });
    });
  }
}
