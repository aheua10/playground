import path from "node:path";
import type { Effort } from "./llm/anthropic-provider.ts";
import { parseRepositories, type Repository } from "./repositories/repository-catalog.ts";
import type { LogFormat, LogLevel } from "./logger.ts";

// All configuration comes from environment variables, so the same image runs
// unchanged under docker compose locally and under a container orchestrator
// in AWS. Invalid values fail fast at startup.
//
// Secrets are deliberately NOT part of this object: the Anthropic SDK reads
// ANTHROPIC_API_KEY from the environment itself, so the key never sits in a
// value that could end up in a log line.

export type LLMConfig =
  | { provider: "stub" }
  | { provider: "anthropic"; model: string; effort: Effort };

export type SandboxConfig = { kind: "none" } | { kind: "docker"; image: string; network: "none" | "bridge" };

export type TaskWorkerConfig =
  | { kind: "simulated" }
  | {
      kind: "coding";
      workspacesDir: string;
      sandbox: SandboxConfig;
      repositories: Repository[];
      /** Whether publish_task may push task branches to their remotes. */
      allowGitPush: boolean;
    };

export interface Config {
  port: number;
  logLevel: LogLevel;
  logFormat: LogFormat;
  llm: LLMConfig;
  worker: TaskWorkerConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parsePort(env.PORT ?? "3000"),
    logLevel: parseOneOf("LOG_LEVEL", env.LOG_LEVEL ?? "info", ["debug", "info", "warn", "error"]),
    // Default to readable logs in a terminal, JSON everywhere else.
    logFormat: parseOneOf("LOG_FORMAT", env.LOG_FORMAT ?? (process.stdout.isTTY ? "pretty" : "json"), [
      "json",
      "pretty",
    ]),
    llm: loadLLMConfig(env),
    worker: loadWorkerConfig(env),
  };
}

// Defaults: the real coding worker, editing files only (no sandbox), which
// runs anywhere. SANDBOX=docker additionally lets it run commands.
function loadWorkerConfig(env: NodeJS.ProcessEnv): TaskWorkerConfig {
  const kind = parseOneOf("TASK_WORKER", env.TASK_WORKER ?? "coding", ["coding", "simulated"]);
  if (kind === "simulated") return { kind };

  const sandbox = parseOneOf("SANDBOX", env.SANDBOX ?? "none", ["none", "docker"]);
  return {
    kind,
    workspacesDir: path.resolve(env.WORKSPACES_DIR ?? "./workspaces"),
    repositories: parseRepositories(env.REPOSITORIES),
    allowGitPush: parseOneOf("ALLOW_GIT_PUSH", env.ALLOW_GIT_PUSH ?? "false", ["true", "false"]) === "true",
    sandbox:
      sandbox === "none"
        ? { kind: "none" }
        : {
            kind: "docker",
            image: env.SANDBOX_IMAGE ?? "node:24-slim",
            network: parseOneOf("SANDBOX_NETWORK", env.SANDBOX_NETWORK ?? "none", ["none", "bridge"]),
          },
  };
}

function loadLLMConfig(env: NodeJS.ProcessEnv): LLMConfig {
  const provider = parseOneOf("LLM_PROVIDER", env.LLM_PROVIDER ?? "stub", ["stub", "anthropic"]);
  if (provider === "stub") return { provider };

  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set");
  }
  return {
    provider,
    model: env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    effort: parseOneOf("ANTHROPIC_EFFORT", env.ANTHROPIC_EFFORT ?? "medium", [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
  };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: "${raw}" (expected an integer 1-65535)`);
  }
  return port;
}

function parseOneOf<T extends string>(name: string, raw: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`Invalid ${name}: "${raw}" (expected one of: ${allowed.join(", ")})`);
  }
  return raw as T;
}
