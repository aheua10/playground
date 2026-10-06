import type { LogFormat, LogLevel } from "./logger.ts";

// All configuration comes from environment variables, so the same image runs
// unchanged under docker compose locally and under a container orchestrator
// in AWS. Invalid values fail fast at startup.

export interface Config {
  port: number;
  logLevel: LogLevel;
  logFormat: LogFormat;
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
