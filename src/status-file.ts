import { randomUUID } from "node:crypto";
import { link, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
const STATUS_ARTIFACT_SUFFIX_PATTERN =
  /^([1-9]\d*)\.(?:[1-9]\d*\.tmp|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.remove)$/;

export interface StatusFileWriterOptions {
  progress: RunProgress;
  /** Existing opted-in directory to publish the snapshot into. Never created by the writer. */
  dir: string;
  /** Notified on write failure. Defaults to swallowing — status never breaks a run. */
  onError?: (error: unknown) => void;
  /** Interval for re-stamping a quiet run's snapshot. Tests inject a tiny value. */
  heartbeatMs?: number;
  /** Filesystem boundary. Tests replace individual operations to force lifecycle races. */
  fileOperations?: Partial<StatusFileOperations>;
}

export interface StatusFileOperations {
  link(existingPath: string, newPath: string): Promise<void>;
  readFile(file: string, encoding: "utf8"): Promise<string>;
  readdir(directory: string): Promise<string[]>;
  rename(source: string, destination: string): Promise<void>;
  unlink(file: string): Promise<void>;
  writeFile(file: string, contents: string, encoding: "utf8"): Promise<void>;
}

const DEFAULT_FILE_OPERATIONS: StatusFileOperations = { link, readFile, readdir, rename, unlink, writeFile };

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
  #fileOperations: StatusFileOperations;
  #unsubscribe: () => void;

  #writing: Promise<void> | null = null;
  #dirty = false;
  #closed = false;
  #tmpSeq = 0;
  #heartbeat: NodeJS.Timeout;
  #initialSweep: Promise<void>;

  constructor(options: StatusFileWriterOptions) {
    this.#progress = options.progress;
    this.#dir = options.dir;
    this.#onError = options.onError;
    this.#fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...options.fileOperations };
    this.#initialSweep = this.#sweepStaleArtifacts();
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
      // The opted-in namespace may disappear after configuration resolution.
      // Treat that race as publication being off, without recreating or reporting it.
      if (!isNodeError(error) || error.code !== "ENOENT") {
        this.#reportError(error);
      }
    }
  }

  async #writeAtomic(snapshot: ProgressSnapshot): Promise<void> {
    await this.#initialSweep;
    const target = path.join(this.#dir, STATUS_FILENAME);
    // pid + sequence keep concurrent runs' temp files from colliding.
    const tmp = `${target}.${process.pid}.${(this.#tmpSeq += 1)}.tmp`;
    await this.#fileOperations.writeFile(tmp, `${JSON.stringify(snapshot)}\n`, "utf8");
    await this.#fileOperations.rename(tmp, target);
  }

  async #removeSnapshot(): Promise<void> {
    const target = path.join(this.#dir, STATUS_FILENAME);
    const claim = `${target}.${process.pid}.${randomUUID()}.remove`;
    try {
      // Claim the exact inode before checking ownership. A concurrent publisher
      // can replace the public name without becoming the target of a stale unlink.
      await this.#fileOperations.rename(target, claim);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      this.#reportError(error);
      return;
    }

    let belongsToAnotherRun = false;
    try {
      const current = JSON.parse(await this.#fileOperations.readFile(claim, "utf8")) as { runId?: unknown };
      belongsToAnotherRun = typeof current.runId === "string" && current.runId !== this.#progress.runId;
    } catch {
      // An unreadable snapshot has no defensible owner and is removed below.
    }

    if (belongsToAnotherRun) {
      try {
        // link() is an atomic no-clobber restore. EEXIST means a newer
        // publication already owns the public name.
        await this.#fileOperations.link(claim, target);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          this.#reportError(error);
        }
      }
    }

    try {
      await this.#fileOperations.unlink(claim);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      this.#reportError(error);
    }
  }

  async #sweepStaleArtifacts(): Promise<void> {
    let entries: string[];
    try {
      entries = await this.#fileOperations.readdir(this.#dir);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        this.#reportError(error);
      }
      return;
    }

    for (const entry of entries) {
      const prefix = `${STATUS_FILENAME}.`;
      const match = entry.startsWith(prefix) ? STATUS_ARTIFACT_SUFFIX_PATTERN.exec(entry.slice(prefix.length)) : null;
      const ownerPid = Number(match?.[1]);
      if (!Number.isSafeInteger(ownerPid) || isProcessAlive(ownerPid)) {
        continue;
      }

      try {
        await this.#fileOperations.unlink(path.join(this.#dir, entry));
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          this.#reportError(error);
        }
      }
    }
  }

  #reportError(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // Error reporting is observability too; it cannot take down the run.
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}
