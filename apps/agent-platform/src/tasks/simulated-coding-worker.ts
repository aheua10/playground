import { setTimeout as sleep } from "node:timers/promises";
import type { TaskWorker, TaskWorkerContext, TaskWorkerInput } from "./task-worker.ts";

// A stand-in coding worker: it walks through a few steps with delays and
// reports progress, but writes no code and runs no commands. It exists to
// exercise the task lifecycle (status, revise, cancel) for real, with time to
// talk to the agent while it runs.
//
// A real coding worker executes model-written code, so it needs the sandbox
// and permission design first (filesystem boundaries, command limits,
// isolation). That is its own checkpoint.

const STEPS = ["Planning the work", "Writing code", "Running checks"];

export class SimulatedCodingWorker implements TaskWorker {
  readonly #stepDelayMs: number;

  constructor(options: { stepDelayMs?: number } = {}) {
    this.#stepDelayMs = options.stepDelayMs ?? 4_000;
  }

  async run(input: TaskWorkerInput, { signal, reportProgress }: TaskWorkerContext): Promise<string> {
    for (const step of STEPS) {
      reportProgress(step);
      // Rejects as soon as the attempt is cancelled or superseded.
      await sleep(this.#stepDelayMs, undefined, { signal });
    }
    return `[simulated] Attempt ${input.attempt} finished. Would have implemented: ${input.requirements.join(" + ")}`;
  }
}
