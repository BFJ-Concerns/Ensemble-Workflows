import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProgressSnapshot, RunProgress } from "./progress.js";

/** Filename the writer publishes for external status consumers. */
export const STATUS_FILENAME = "ensemble.local.json";

/**
 * Consumers treat a snapshot as stale after 30s. Claude and
 * opencode report usage once per turn, so a long quiet turn would otherwise
 * blank the line mid-run; the heartbeat re-stamps well inside that window.
 */
const DEFAULT_HEARTBEAT_MS = 10_000;

export interface StatusFileWriterOptions {
  progress: RunProgress;
  /** Directory to publish the snapshot into; created on first write. */
  dir: string;
  /** Notified on write failure. Defaults to swallowing — status never breaks a run. */
  onError?: (error: unknown) => void;
  /** Interval for re-stamping a quiet run's snapshot. Tests inject a tiny value. */
  heartbeatMs?: number;
}

/**
 * Serialises a {@link RunProgress} model to a single `ensemble.local.json` on every
 * change, so external consumers can render what the run is doing.
 *
 * Two guarantees matter:
 *
 * - **Atomic.** Each publish writes a temp file and renames it over the target,
 *   so a reader never sees a half-written snapshot.
 * - **Coalesced.** At most one write is ever in flight; changes that land
 *   during a write collapse into a single trailing write of the latest state.
 *   The file write itself is the throttle — no timer, no unbounded queue.
 *
 * Write failures are routed to `onError` and otherwise swallowed: observability
 * must never take a run down with it.
 */
export class StatusFileWriter {
  #progress: RunProgress;
  #dir: string;
  #onError: ((error: unknown) => void) | undefined;
  #unsubscribe: () => void;

  #writing: Promise<void> | null = null;
  #dirty = false;
  #closed = false;
  #ensuredDir = false;
  #tmpSeq = 0;
  #heartbeat: NodeJS.Timeout;

  constructor(options: StatusFileWriterOptions) {
    this.#progress = options.progress;
    this.#dir = options.dir;
    this.#onError = options.onError;
    this.#unsubscribe = this.#progress.onChange(() => this.#request());
    // markChanged() re-stamps updatedAt and notifies subscribers (i.e. this
    // writer), so a run with long quiet turns never reads as stale/absent.
    this.#heartbeat = setInterval(() => this.#progress.markChanged(), options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.#heartbeat.unref();
    // Publish an initial snapshot so the run shows up before its first agent.
    this.#request();
  }

  /** Flushes any in-flight write, removes the live snapshot, and stops listening. */
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#heartbeat);
    this.#unsubscribe();
    while (this.#writing !== null) {
      await this.#writing;
    }
    await this.#removeSnapshot();
  }

  #request(): void {
    // Once closed, only close()'s own final flush may publish.
    if (this.#closed) {
      return;
    }
    this.#dirty = true;
    this.#drain();
  }

  #drain(): void {
    if (this.#writing !== null || !this.#dirty) {
      return;
    }
    this.#dirty = false;
    this.#writing = this.#write().finally(() => {
      this.#writing = null;
      // A change that arrived mid-write left `#dirty` set; publish the latest.
      this.#drain();
    });
  }

  async #write(): Promise<void> {
    try {
      await this.#writeAtomic(this.#progress.snapshot());
    } catch (error) {
      this.#onError?.(error);
    }
  }

  async #writeAtomic(snapshot: ProgressSnapshot): Promise<void> {
    if (!this.#ensuredDir) {
      await mkdir(this.#dir, { recursive: true });
      this.#ensuredDir = true;
    }
    const target = path.join(this.#dir, STATUS_FILENAME);
    // pid + sequence keep concurrent runs' temp files from colliding.
    const tmp = `${target}.${process.pid}.${(this.#tmpSeq += 1)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, "utf8");
    await rename(tmp, target);
  }

  async #removeSnapshot(): Promise<void> {
    const target = path.join(this.#dir, STATUS_FILENAME);
    try {
      // Two runs sharing a cwd share one snapshot path; whoever finishes first
      // must not delete the other's live file. An unreadable file is removed.
      const current = JSON.parse(await readFile(target, "utf8")) as { runId?: unknown };
      if (typeof current.runId === "string" && current.runId !== this.#progress.runId) {
        return;
      }
    } catch {
      // Missing or corrupt → fall through; unlink handles ENOENT below.
    }
    try {
      await unlink(target);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      this.#onError?.(error);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
