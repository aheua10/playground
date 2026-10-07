import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TokenAuthenticator } from "../src/auth/authenticator.ts";
import { hashToken } from "../src/auth/tokens.ts";
import type { ToolCall } from "../src/core/messages.ts";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/llm/llm-provider.ts";
import { createLogger, type LogFields } from "../src/logger.ts";
import { git } from "../src/repositories/git.ts";
import type { Repository } from "../src/repositories/repository-catalog.ts";
import type { TaskWorker, TaskWorkerContext, TaskWorkerInput } from "../src/tasks/task-worker.ts";

/** Plays back pre-scripted responses and records every request it receives. */
export class ScriptedLLMProvider implements LLMProvider {
  readonly name = "scripted";
  readonly requests: LLMRequest[] = [];
  readonly #responses: LLMResponse[];

  constructor(responses: LLMResponse[]) {
    this.#responses = [...responses];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.#responses.shift();
    if (!next) throw new Error("ScriptedLLMProvider has no responses left");
    return next;
  }
}

export function textResponse(text: string): LLMResponse {
  return {
    message: { role: "assistant", content: text, toolCalls: [] },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "scripted",
  };
}

export function toolCallResponse(...toolCalls: ToolCall[]): LLMResponse {
  return {
    message: { role: "assistant", content: "", toolCalls },
    stopReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "scripted",
  };
}

/** A logger that records parsed JSON lines instead of printing them. */
export function captureLogger() {
  const lines: LogFields[] = [];
  const logger = createLogger({ level: "debug", format: "json", write: (line) => lines.push(JSON.parse(line)) });
  return { logger, lines, events: () => lines.map((line) => line.event) };
}

export const FIXED_NOW = new Date("2026-10-07T12:00:00.000Z");

/** Polls until `check` passes; for effects that happen in the background. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type ControlledRun = {
  input: TaskWorkerInput;
  context: TaskWorkerContext;
  resolve: (result: string) => void;
  reject: (error: unknown) => void;
};

/** A TaskWorker whose attempts the test finishes by hand. */
export class ControlledWorker implements TaskWorker {
  readonly runs: ControlledRun[] = [];
  readonly #honourAbort: boolean;

  /** honourAbort: false simulates a worker that ignores cancellation and finishes anyway. */
  constructor(options: { honourAbort?: boolean } = {}) {
    this.#honourAbort = options.honourAbort ?? true;
  }

  run(input: TaskWorkerInput, context: TaskWorkerContext): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.#honourAbort) {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      }
      this.runs.push({ input, context, resolve, reject });
    });
  }
}

export const AUTHOR = { "user.name": "Test", "user.email": "test@localhost" };

/** A local bare repository standing in for GitHub, with one commit on main. */
export async function createRemote(): Promise<{ repository: Repository; remoteDir: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "remote-"));
  const remoteDir = path.join(base, "project.git");
  const seed = path.join(base, "seed");
  await git(["init", "--quiet", "--bare", "--initial-branch=main", remoteDir]);
  await git(["init", "--quiet", "--initial-branch=main", seed]);
  await writeFile(path.join(seed, "README.md"), "# Project\n");
  await writeFile(path.join(seed, "package.json"), '{ "name": "project" }\n');
  await git(["add", "--all"], { cwd: seed });
  await git(["commit", "--quiet", "-m", "Initial commit"], { cwd: seed, config: AUTHOR });
  await git(["push", "--quiet", remoteDir, "main"], { cwd: seed });
  return { repository: { name: "project", url: `file://${remoteDir}` }, remoteDir };
}

/** Two users with one token each, for transport tests. */
export const TOKENS = { alice: "ap_test-token-alice", bob: "ap_test-token-bob" } as const;

export function testAuthenticator(): TokenAuthenticator {
  return new TokenAuthenticator(
    Object.entries(TOKENS).map(([principal, token]) => ({ principal, tokenHash: hashToken(token) })),
  );
}

export function bearer(user: keyof typeof TOKENS): { authorization: string } {
  return { authorization: `Bearer ${TOKENS[user]}` };
}
