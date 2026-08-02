export class Scheduler {
  readonly concurrency: number;

  #active = 0;
  #queue: Array<() => void> = [];

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

      this.#queue.push(run);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.concurrency) {
      const next = this.#queue.shift();
      if (next === undefined) {
        return;
      }
      next();
    }
  }
}
