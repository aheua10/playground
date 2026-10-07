import type { ToolDefinition } from "../core/tool-definition.ts";

/** What the runtime hands to every tool execution. */
export interface ToolContext {
  conversationId: string;
  turnId: string;
  toolCallId: string;
  /** Aborted on timeout or when the turn is cancelled. Long-running tools must honour it. */
  signal: AbortSignal;
}

/**
 * A capability the runtime can execute on the model's behalf.
 *
 * `definition` is everything the model sees. `execute` only ever receives input
 * that the runtime has already validated against `definition.inputSchema`;
 * keeping the `Input` type in sync with that schema is the tool author's job.
 *
 * Return a string, or any JSON-serializable value (it is JSON-encoded for the model).
 */
export interface Tool<Input = unknown> {
  definition: ToolDefinition;
  execute(input: Input, context: ToolContext): Promise<unknown>;
}

/**
 * Throw for expected failures (bad time zone, file not found, ...). The message
 * is shown to the model so it can correct itself. Any other error is reported to
 * the model generically, and its details only go to the logs.
 */
export class ToolError extends Error {
  override name = "ToolError";
}
