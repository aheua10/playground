import type { ToolCall, ToolResultMessage } from "../core/messages.ts";
import type { ToolDefinition } from "../core/tool-definition.ts";
import type { Logger } from "../logger.ts";
import { ToolError } from "./tool.ts";
import type { ToolRegistry } from "./tool-registry.ts";

// THE TRUST BOUNDARY.
//
// Everything the model asks for arrives here as an untrusted ToolCall. Nothing
// runs unless it passes these gates, in order:
//
//   1. exists      only registered tools can run; the model can't invent capabilities
//   2. permitted   policy check. None yet: the only side effects so far are task
//                  start/revise/cancel, which TaskManager scopes to the calling
//                  conversation. Permissions, approvals and filesystem/command
//                  limits plug in here once tools can touch files or run commands.
//   3. valid       input must match the tool's JSON Schema
//   4. bounded     runs with a timeout and the turn's cancellation signal
//
// Every outcome, including rejection and failure, becomes a ToolResultMessage
// the model can read, so a bad call is a recoverable conversation event rather
// than a crashed turn. Only cancellation of the turn itself propagates.
//
// Each step is logged; together the tool.* events are the audit trail.

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESULT_CHARS = 16_000;

export interface ToolExecutionContext {
  conversationId: string;
  turnId: string;
  signal: AbortSignal;
  log: Logger;
}

export class ToolExecutor {
  readonly #registry: ToolRegistry;
  readonly #timeoutMs: number;

  constructor(deps: { registry: ToolRegistry; timeoutMs?: number }) {
    this.#registry = deps.registry;
    this.#timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The tools offered to the model: exactly the ones this executor will accept. */
  definitions(): ToolDefinition[] {
    return this.#registry.definitions();
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResultMessage> {
    const log = context.log.child({ toolCallId: call.id, tool: call.name });
    const result = (content: string, isError: boolean): ToolResultMessage => ({
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content,
      isError,
    });
    const reject = (reason: string, message: string) => {
      log.warn("tool.rejected", { reason, message });
      return result(message, true);
    };

    log.info("tool.request", { input: call.input });

    // 1. exists
    const registered = this.#registry.get(call.name);
    if (!registered) return reject("unknown_tool", `Unknown tool "${call.name}".`);

    // 2. permitted: no policy yet (see header comment).

    // 3. valid
    const validationError = registered.validateInput(call.input);
    if (validationError) return reject("invalid_input", `Invalid input: ${validationError}`);

    // 4. bounded
    log.info("tool.execution", { timeoutMs: this.#timeoutMs });
    const startedAt = performance.now();
    // A plain setTimeout rather than AbortSignal.timeout(): the latter's timer
    // doesn't keep the process alive, so a hung tool could end the process
    // mid-turn instead of timing out.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("Tool timed out")), this.#timeoutMs);
    const signal = AbortSignal.any([context.signal, timeout.signal]);
    let content: string;
    let isError = false;
    try {
      const output = await abortable(
        registered.tool.execute(call.input, {
          conversationId: context.conversationId,
          turnId: context.turnId,
          toolCallId: call.id,
          signal,
        }),
        signal,
      );
      content = serializeOutput(output);
    } catch (error) {
      if (context.signal.aborted) throw error; // the turn was cancelled: stop everything
      isError = true;
      if (timeout.signal.aborted) {
        content = `Tool timed out after ${this.#timeoutMs} ms.`;
      } else if (error instanceof ToolError) {
        content = error.message;
      } else {
        // Unexpected failure: details stay in our logs, not in the model's context.
        log.error("tool.error", { error });
        content = "The tool failed with an internal error.";
      }
    } finally {
      clearTimeout(timer);
    }

    log.info("tool.result", { isError, content, durationMs: Math.round(performance.now() - startedAt) });
    return result(content, isError);
  }
}

// Stop waiting when the signal fires. A tool that ignores its signal keeps
// running in the background; truly stopping untrusted work (e.g. code
// execution) will need process/container isolation, not just a promise race.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function serializeOutput(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…[truncated]` : text;
}
