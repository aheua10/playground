// Minimal structured logger.
//
// Every log line has a stable `event` name (e.g. "llm.request") plus fields.
// Event names are the contract: they are what you grep for today and what
// becomes span/event names when OpenTelemetry is added later.
//
// Two output formats:
//   json   - one JSON object per line; for containers / CloudWatch
//   pretty - human-readable single line; for local development

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "pretty";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` to every line (e.g. conversationId, turnId). */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  format: LogFormat;
  /** Output sink. Defaults to stdout; tests pass their own to capture lines. */
  write?: (line: string) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: LoggerOptions, bindings: LogFields = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));

  const log = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[options.level]) return;
    const record = { time: new Date().toISOString(), level, event, ...bindings, ...fields };
    write(options.format === "json" ? JSON.stringify(record, serializeErrors) : formatPretty(record));
  };

  return {
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
    child: (more) => createLogger(options, { ...bindings, ...more }),
  };
}

// JSON.stringify(new Error()) is "{}", so expand errors explicitly.
function serializeErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

// 14:23:01.123 INFO  llm.request         conversationId=test-1 messageCount=1
function formatPretty(record: { time: string; level: LogLevel; event: string } & LogFields): string {
  const { time, level, event, ...fields } = record;
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined) // match JSON output, which drops them
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  return `${time.slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${event.padEnd(18)} ${parts.join(" ")}`;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return /^[\w.:/-]+$/.test(value) ? value : JSON.stringify(value);
  if (value instanceof Error) return JSON.stringify(value.stack ?? value.message);
  return JSON.stringify(value, serializeErrors);
}
