import { randomUUID } from "node:crypto";
import { link, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { readProcessStartTicks } from "./run-record.js";

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
  #ownerEvidence: Promise<SnapshotOwnerEvidence>;
  #procDir: string;

  constructor(options: StatusFileWriterOptions) {
    this.#progress = options.progress;
    this.#dir = options.dir;
    this.#onError = options.onError;
    this.#fileOperations = { ...DEFAULT_FILE_OPERATIONS, ...options.fileOperations };
    const procDir = options.procDir ?? "/proc";
    this.#procDir = procDir;
    this.#ownerEvidence = (async () => ({
      host: hostname(),
      pid: process.pid,
      start_ticks: await readProcessStartTicks(procDir, process.pid)
    }))();
    this.#initialSweep = this.#sweepStaleArtifacts();
    this.#unsubscribe = this.#progress.onChange(() => this.#request());
    // Progress transitions re-stamp updatedAt and notify subscribers (i.e. this
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
    // The published shape is the progress snapshot plus this process's own
    // liveness evidence, so a snapshot outliving its run is refutable.
    const published = { ...snapshot, owner: await this.#ownerEvidence };
    await this.#fileOperations.writeFile(tmp, `${JSON.stringify(published)}\n`, "utf8");
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
          // Any other link failure must not fall through to the unlink
          // below — that would destroy the foreign snapshot outright.
          // Restore by rename instead: atomic, and the clobber it risks (a
          // publication racing in after the failed link) is confined to
          // this already-failing path.
          try {
            await this.#fileOperations.rename(claim, target);
          } catch (renameError) {
            // Both restore routes failed: leave the claim in place — the
            // content is preserved for the next run's stale-artefact sweep,
            // which beats deleting the only copy.
            this.#reportError(renameError);
          }
          return;
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

    // A snapshot a killed run left behind: the new writer starting in the
    // namespace is the cleanup trigger (the same discipline as the archive
    // reaper), and the judgement is the owner evidence, never age. The
    // exact inode is claimed by rename *before* judging — a read-judge-
    // unlink-by-name sequence would let a concurrent publication replace
    // the dead snapshot between the read and the unlink and be destroyed
    // in its place (the same race close()'s removal already guards).
    const target = path.join(this.#dir, STATUS_FILENAME);
    const claim = `${target}.${process.pid}.${randomUUID()}.remove`;
    try {
      await this.#fileOperations.rename(target, claim);
    } catch {
      // Absent, or contended: nothing to judge.
      return;
    }
    let ownerGone = false;
    try {
      const current = JSON.parse(await this.#fileOperations.readFile(claim, "utf8")) as {
        owner?: SnapshotOwnerEvidence;
      };
      ownerGone = await snapshotOwnerGone(current.owner, this.#procDir);
    } catch {
      // Unparseable is not evidence of an orphan; restore below — a
      // foreign file is not this writer's to destroy on a parse error.
    }
    if (ownerGone) {
      await this.#fileOperations.unlink(claim).catch(() => undefined);
      return;
    }
    try {
      // Not provably orphaned: put it back. link() is the atomic
      // no-clobber restore; EEXIST means a newer publication already owns
      // the public name and the claimed copy is redundant.
      await this.#fileOperations.link(claim, target);
      await this.#fileOperations.unlink(claim);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        await this.#fileOperations.unlink(claim).catch(() => undefined);
        return;
      }
      try {
        await this.#fileOperations.rename(claim, target);
      } catch (renameError) {
        // Both restore routes failed: leave the claim for a later sweep —
        // that beats deleting the only copy.
        this.#reportError(renameError);
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
