import path from "node:path";
import type { TokenEntry } from "./auth/authenticator.ts";
import { PRINCIPAL_ID_PATTERN, TOKEN_HASH_PATTERN } from "./auth/tokens.ts";
import { hostnameOf } from "./http/host-check.ts";
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

/** "tokens": every request needs a bearer token listed (as a hash) in AUTH_TOKENS. "none": no authentication. */
export type AuthConfig = { kind: "tokens"; tokens: TokenEntry[] } | { kind: "none" };

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
  auth: AuthConfig;
  /** Host names, besides localhost and IP addresses, that requests may be addressed to. */
  allowedHosts: string[];
  /** Web origins whose pages may open the realtime WebSocket. */
  allowedOrigins: string[];
  logLevel: LogLevel;
  logFormat: LogFormat;
  llm: LLMConfig;
  worker: TaskWorkerConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = parsePort(env.PORT ?? "3000");
  return {
    port,
    auth: loadAuthConfig(env),
    allowedHosts: parseHostnames(env.ALLOWED_HOSTS),
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS, port),
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

// Secure by default: without tokens the server refuses to start, unless
// authentication is switched off explicitly.
function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const kind = parseOneOf("AUTH", env.AUTH ?? "tokens", ["tokens", "none"]);
  if (kind === "none") return { kind };

  const tokens = (env.AUTH_TOKENS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [principal = "", tokenHash = "", ...rest] = entry.split(":");
      if (!PRINCIPAL_ID_PATTERN.test(principal) || !TOKEN_HASH_PATTERN.test(tokenHash) || rest.length > 0) {
        // Never echo the entry: it might be a token pasted in by mistake.
        throw new Error("Invalid AUTH_TOKENS entry (expected name:sha256hex, as printed by `npm run create-token`)");
      }
      return { principal, tokenHash };
    });
  if (tokens.length === 0) {
    throw new Error(
      "AUTH_TOKENS is empty. Create a token with `npm run create-token -- <name>` and add the printed entry, " +
        "or set AUTH=none on a machine only you can reach.",
    );
  }
  return { kind, tokens };
}

// Names only: the port is never part of the check (see http/host-check.ts).
function parseHostnames(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((entry) => {
    const name = entry.trim().toLowerCase();
    if (hostnameOf(name) !== name || name.includes(":")) {
      throw new Error(`Invalid ALLOWED_HOSTS entry: "${entry.trim()}" (expected a host name like agent.example.com, without a port)`);
    }
    return name;
  });
}

// Default: pages served from this port on localhost, i.e. a web UI served by
// the agent itself, or reached through an SSM tunnel on the same port.
function parseOrigins(raw: string | undefined, port: number): string[] {
  if (!raw?.trim()) return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  return raw.split(",").map((entry) => {
    const origin = entry.trim();
    if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
      throw new Error(`Invalid ALLOWED_ORIGINS entry: "${origin}" (expected an origin like https://example.com)`);
    }
    return origin;
  });
}

function parseOneOf<T extends string>(name: string, raw: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`Invalid ${name}: "${raw}" (expected one of: ${allowed.join(", ")})`);
  }
  return raw as T;
}
