import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { readProcessStartTicks } from "./run-record.js";

import type { ProgressSnapshot, RunProgress } from "./progress.js";

/**
 * Every run in flight publishes its own file in the status directory, named
 * `ensemble.<run-uuid>.local.json`: a later run never overwrites an
 * earlier run's view, and one run ending never removes another's. The
 * `.local.json` tail keeps the files under the `*.local.*` ignore
 * convention of a committed `.claude/` directory.
 */
export const STATUS_FILE_PREFIX = "ensemble.";
export const STATUS_FILE_SUFFIX = ".local.json";
/** Published by runtimes before per-run files: one slot for every run. Read and swept, never written. */
export const LEGACY_STATUS_FILENAME = "ensemble.local.json";

export function statusFileName(runId: string): string {
  return `${STATUS_FILE_PREFIX}${runId}${STATUS_FILE_SUFFIX}`;
}

/** Whether a directory entry is a run's status file (the legacy slot included). */
export function isStatusFileName(name: string): boolean {
  if (name === LEGACY_STATUS_FILENAME) {
    return true;
  }
  return (
    name.startsWith(STATUS_FILE_PREFIX) &&
    name.endsWith(STATUS_FILE_SUFFIX) &&
    name.length > STATUS_FILE_PREFIX.length + STATUS_FILE_SUFFIX.length
  );
}

/**
 * Consumers treat a snapshot as stale after 30s. Claude and
 * opencode report usage once per turn, so a long quiet turn would otherwise
 * blank the line mid-run; the heartbeat re-stamps well inside that window.
 */
const DEFAULT_HEARTBEAT_MS = 10_000;
/** A writer's in-flight temp file: `<status file>.<pid>.<sequence>.tmp`. */
const STATUS_TEMP_SUFFIX_PATTERN = /\.([1-9]\d*)\.[1-9]\d*\.tmp$/;

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
  /** Proc filesystem root for owner liveness evidence; injectable for tests. */
  procDir?: string;
}

/**
 * The publishing process's liveness evidence, stamped onto every snapshot —
 * the same pid + start-ticks discipline the archive manifest's owner block
 * uses, so a poller can *refute* a snapshot a killed run left behind
 * instead of trusting cleanup-by-cooperation: an idle project must not
 * show an unrefutable stale snapshot. `start_ticks` null means no
 * readable proc filesystem: liveness is then unjudgeable, never assumed.
 */
export interface SnapshotOwnerEvidence {
  host: string;
  pid: number;
  start_ticks: string | null;
}

/**
 * A poller's (and the startup sweep's) refutation check: provably gone
 * when the recorded pid no longer runs with the recorded start ticks on
 * the recorded host. Mirrors the archive reaper's judgement rule —
 * evidence, never age: a different host, missing ticks, or an unreadable
 * proc filesystem on the judging side all return false (not provably
 * gone) rather than guess.
 */
export async function snapshotOwnerGone(
  owner: SnapshotOwnerEvidence | undefined,
  procDir = "/proc",
  host = hostname()
): Promise<boolean> {
  if (owner === undefined || typeof owner.pid !== "number" || owner.host !== host) {
    return false;
  }
  if (typeof owner.start_ticks !== "string") {
    return false;
  }
  const liveTicks = await readProcessStartTicks(procDir, owner.pid);
  if (liveTicks === owner.start_ticks) {
    return false;
  }
  // Distinguish "the pid is gone" from "proc unreadable here": absent stat
  // is death evidence only where this process can read its own.
  if (liveTicks === null && (await readProcessStartTicks(procDir, process.pid)) === null) {
    return false;
  }
  return true;
}

export interface StatusFileOperations {
  readFile(file: string, encoding: "utf8"): Promise<string>;
  readdir(directory: string): Promise<string[]>;
  rename(source: string, destination: string): Promise<void>;
  unlink(file: string): Promise<void>;
  writeFile(file: string, contents: string, encoding: "utf8"): Promise<void>;
}

const DEFAULT_FILE_OPERATIONS: StatusFileOperations = { readFile, readdir, rename, unlink, writeFile };

/**
 * Serialises a {@link RunProgress} model to this run's own status file on
 * every change, so external consumers can render what the run is doing.
 *
 * Three guarantees matter:
 *
 * - **Per run.** The file is named by the run's id, so concurrent runs in
 *   one directory are each visible for their own lifetime and never touch
 *   each other's file — not on publish, not on close.
 * - **Atomic.** Each publish writes a temp file and renames it over the
 *   target, so a reader never sees a half-written snapshot.
 * - **Coalesced.** At most one write is ever in flight; changes that land
 *   during a write collapse into a single trailing write of the latest state.
 *   The file write itself is the throttle — no timer, no unbounded queue.
 *
 * Write failures are routed to `onError` and otherwise swallowed: observability
 * must never take a run down with it.
 */
export class StatusFileWriter {
  #progress: RunProgress;
  #target: string;
  #onError: ((error: unknown) => void) | undefined;
  #fileOperations: StatusFileOperations;
  #unsubscribe: () => void;

  #writing: Promise<void> | null = null;
  #dirty = false;
  #closed = false;
  #tmpSeq = 0;
  #heartbeat: NodeJS.Timeout;
  #initialSweep: Promise<void>;
  #ownerEvidence: Promise<SnapshotOwnerEvidence>;
  #procDir: string;

  constructor(options: StatusFileWriterOptions) {
    this.#progress = options.progress;
    this.#target = path.join(options.dir, statusFileName(options.progress.runId));
    this.#onError = options.onError;
    this.#fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...options.fileOperations };
    const procDir = options.procDir ?? "/proc";
    this.#procDir = procDir;
    this.#ownerEvidence = (async () => ({
      host: hostname(),
      pid: process.pid,
      start_ticks: await readProcessStartTicks(procDir, process.pid)
    }))();
    this.#initialSweep = this.#sweepDeadRuns(options.dir);
    this.#unsubscribe = this.#progress.onChange(() => this.#request());
    // Progress transitions re-stamp updatedAt and notify subscribers (i.e. this
    // writer), so a run with long quiet turns never reads as stale/absent.
    this.#heartbeat = setInterval(() => this.#progress.markChanged(), options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.#heartbeat.unref();
    // Publish an initial snapshot so the run shows up before its first agent.
    this.#request();
  }

  /** The path this run publishes to. */
  get path(): string {
    return this.#target;
  }

  /** Flushes any in-flight write, removes this run's file, and stops listening. */
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#heartbeat);
    this.#unsubscribe();
    while (this.#writing !== null) {
      await this.#writing;
    }
    // The file is this run's alone, so removal needs no ownership check:
    // nothing else publishes under this name.
    try {
      await this.#fileOperations.unlink(this.#target);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        this.#reportError(error);
      }
    }
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
    // pid + sequence keep a killed writer's leftover temp file attributable
    // to it, so the next writer's sweep can remove it on evidence.
    const tmp = `${this.#target}.${process.pid}.${(this.#tmpSeq += 1)}.tmp`;
    // The published shape is the progress snapshot plus this process's own
    // liveness evidence, so a snapshot outliving its run is refutable.
    const published = { ...snapshot, owner: await this.#ownerEvidence };
    await this.#fileOperations.writeFile(tmp, `${JSON.stringify(published)}\n`, "utf8");
    await this.#fileOperations.rename(tmp, this.#target);
  }

  /**
   * The new-writer trigger for what a killed run left behind (the same
   * discipline as the archive reaper): every status file in the directory
   * whose owner is *provably* gone is removed, and a temp file whose writer
   * pid is dead with it. The judgement is the owner evidence, never age —
   * a slow run is not an orphan, an unparseable file is not this writer's
   * to destroy, and a file with no evidence is left for its owner.
   */
  async #sweepDeadRuns(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await this.#fileOperations.readdir(dir);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        this.#reportError(error);
      }
      return;
    }

    for (const entry of entries) {
      const file = path.join(dir, entry);
      const temp = STATUS_TEMP_SUFFIX_PATTERN.exec(entry);
      if (temp !== null) {
        const ownerPid = Number(temp[1]);
        if (
          isStatusFileName(entry.slice(0, -temp[0].length)) &&
          Number.isSafeInteger(ownerPid) &&
          (await this.#writerGone(ownerPid))
        ) {
          await this.#unlinkQuietly(file);
        }
        continue;
      }
      if (!isStatusFileName(entry)) {
        continue;
      }
      let ownerGone = false;
      try {
        const current = JSON.parse(await this.#fileOperations.readFile(file, "utf8")) as { owner?: SnapshotOwnerEvidence };
        ownerGone = await snapshotOwnerGone(current.owner, this.#procDir);
      } catch {
        // Unreadable or unparseable is not evidence of an orphan.
      }
      if (ownerGone) {
        await this.#unlinkQuietly(file);
      }
    }
  }

  /**
   * A temp file names only its writer's pid, so the judgement is the proc
   * filesystem's: the pid absent where this process can read its own stat
   * is death evidence; an unreadable proc filesystem decides nothing.
   */
  async #writerGone(pid: number): Promise<boolean> {
    if ((await readProcessStartTicks(this.#procDir, pid)) !== null) {
      return false;
    }
    return (await readProcessStartTicks(this.#procDir, process.pid)) !== null;
  }

  async #unlinkQuietly(file: string): Promise<void> {
    try {
      await this.#fileOperations.unlink(file);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        this.#reportError(error);
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
