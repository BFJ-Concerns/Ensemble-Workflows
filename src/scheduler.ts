interface QueuedTask {
  run: () => void;
  reject: (reason: unknown) => void;
}

export class Scheduler {
  readonly concurrency: number;

  #active = 0;
  #queue: QueuedTask[] = [];
  #shutdownError: Error | null = null;

  constructor(concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`Concurrency must be a positive integer, got ${concurrency}`);
    }
    this.concurrency = concurrency;
  }

  active(): number {
    return this.#active;
  }

  queued(): number {
    return this.#queue.length;
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    if (this.#shutdownError !== null) {
      return Promise.reject(this.#shutdownError);
    }
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        this.#active += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.#active -= 1;
            this.#drain();
          });
      };

      this.#queue.push({ run, reject });
      this.#drain();
    });
  }

  close(rejection: Error): void {
    if (this.#shutdownError !== null) {
      return;
    }
    this.#shutdownError = rejection;
    const queued = this.#queue.splice(0);
    for (const task of queued) {
      task.reject(rejection);
    }
  }

  #drain(): void {
    while (this.#active < this.concurrency) {
      const next = this.#queue.shift();
      if (next === undefined) {
        return;
      }
      next.run();
    }
  }
}
