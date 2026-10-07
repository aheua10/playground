// Runs async functions one at a time per key, in arrival order; different keys
// run concurrently. Used to serialize turns per conversation and updates per task.
//
// In-process only. With several instances this becomes a distributed lock or,
// simpler, routing each conversation to one instance.
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  isLocked(key: string): boolean {
    return this.#tails.has(key);
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => done);
    this.#tails.set(key, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Last in line: nothing queued behind us, so drop the key.
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
