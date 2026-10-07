import type { Effort } from "./llm/anthropic-provider.ts";
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

export interface Config {
  port: number;
  logLevel: LogLevel;
  logFormat: LogFormat;
  llm: LLMConfig;
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
