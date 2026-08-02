import { EngineShutdownError } from "./errors.js";

import type { EngineName } from "./types.js";

export type AdmissionEventKind = "queued" | "admitted" | "released" | "skipped";
export type AdmissionSkipReason = "engine-cap";

export interface AdmissionEvent {
  seq: number;
  engine: EngineName;
  agentId: number;
  kind: AdmissionEventKind;
  ceilingHeld: number;
  engineHeld: number;
  /** Present only for `skipped`: a later engine was admitted past this waiter. */
  reason?: AdmissionSkipReason;
}

export interface AdmissionControllerOptions {
  ceiling: number | null;
  caps: ReadonlyMap<EngineName, number>;
  onAdmission?: (event: AdmissionEvent) => void;
}

interface WaitingAdmission {
  engine: EngineName;
  agentId: number;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  skipReported: boolean;
}

/**
 * Makes one run-scoped admission decision over the whole-workflow ceiling and
 * the selected engine's cap. Counters move together in one synchronous commit,
 * so a queued worker never holds either resource while waiting for the other.
 */
export class AdmissionController {
  readonly ceiling: number | null;

  #caps: ReadonlyMap<EngineName, number>;
  #ceilingActive = 0;
  #engineActive = new Map<EngineName, number>();
  #waiting: WaitingAdmission[] = [];
  #onAdmission: ((event: AdmissionEvent) => void) | undefined;
  #eventSeq = 0;
  #closed = false;

  constructor(options: AdmissionControllerOptions) {
    if (options.ceiling !== null && (!Number.isInteger(options.ceiling) || options.ceiling < 1)) {
      throw new Error(`Agent ceiling must be a positive integer, got ${options.ceiling}`);
    }
    for (const [engine, cap] of options.caps) {
      if (!Number.isInteger(cap) || cap < 1) {
        throw new Error(`Concurrency cap for ${engine} must be a positive integer, got ${cap}`);
      }
    }
    this.ceiling = options.ceiling;
    this.#caps = options.caps;
    this.#onAdmission = options.onAdmission;
  }

  admit<T>(engine: EngineName, agentId: number, task: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      throw new EngineShutdownError(engine);
    }
    if (!this.#caps.has(engine)) {
      throw new Error(`No concurrency cap registered for engine ${engine}`);
    }

    return new Promise<T>((resolve, reject) => {
      this.#waiting.push({
        engine,
        agentId,
        task: async () => task(),
        resolve: (value) => resolve(value as T),
        reject,
        skipReported: false
      });
      this.#emit("queued", engine, agentId);
      this.#drain();
    });
  }

  /**
   * Settles every promise already accepted by the runtime. Waiting tasks are
   * rejected without ever acquiring a slot — shutdown is a cancellation, not
   * a dispatch, and starting them with gates bypassed was observed pushing
   * the ceiling past its limit. Tasks already admitted keep their slots and
   * release them through #start's finally as they settle.
   */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const waiting = this.#waiting.splice(0);
    for (const entry of waiting) {
      entry.reject(new EngineShutdownError(entry.engine));
    }
  }

  snapshot(): {
    ceilingActive: number;
    engineActive: ReadonlyMap<EngineName, number>;
    waiting: number;
  } {
    return {
      ceilingActive: this.#ceilingActive,
      engineActive: new Map(this.#engineActive),
      waiting: this.#waiting.length
    };
  }

  #drain(): void {
    let index = 0;
    const bypassed: WaitingAdmission[] = [];
    while (index < this.#waiting.length) {
      if (this.ceiling !== null && this.#ceilingActive >= this.ceiling) {
        return;
      }
      const entry = this.#waiting[index];
      if (entry === undefined) {
        return;
      }
      if (this.#activeFor(entry.engine) >= this.#capFor(entry.engine)) {
        bypassed.push(entry);
        index += 1;
        continue;
      }

      for (const skipped of bypassed) {
        if (!skipped.skipReported) {
          skipped.skipReported = true;
          this.#emit("skipped", skipped.engine, skipped.agentId, "engine-cap");
        }
      }
      bypassed.length = 0;

      this.#waiting.splice(index, 1);
      this.#start(entry);
    }
  }

  #start(entry: WaitingAdmission): void {
    // This is the only counter-acquisition point: both counters move in the
    // same synchronous turn, with no await or callback between them.
    this.#ceilingActive += 1;
    this.#engineActive.set(entry.engine, this.#activeFor(entry.engine) + 1);
    this.#emit("admitted", entry.engine, entry.agentId);

    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.#ceilingActive -= 1;
        this.#engineActive.set(entry.engine, this.#activeFor(entry.engine) - 1);
        this.#emit("released", entry.engine, entry.agentId);
        if (!this.#closed) {
          this.#drain();
        }
      });
  }

  #capFor(engine: EngineName): number {
    const cap = this.#caps.get(engine);
    if (cap === undefined) {
      throw new Error(`No concurrency cap registered for engine ${engine}`);
    }
    return cap;
  }

  #activeFor(engine: EngineName): number {
    return this.#engineActive.get(engine) ?? 0;
  }

  #emit(
    kind: AdmissionEventKind,
    engine: EngineName,
    agentId: number,
    reason?: AdmissionSkipReason
  ): void {
    this.#eventSeq += 1;
    this.#onAdmission?.({
      seq: this.#eventSeq,
      engine,
      agentId,
      kind,
      ceilingHeld: this.#ceilingActive,
      engineHeld: this.#activeFor(engine),
      ...(reason === undefined ? {} : { reason })
    });
  }
}
