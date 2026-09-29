import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DIGEST_RECIPE, canonicalJson, sha256 } from "./canonical-document.js";
import { resolveRunDirectory } from "./run-record.js";

/** Fixed name under the run's directory in the durable-record store. */
export const SENTINEL_FILENAME = "completion-sentinel.json";
export const SENTINEL_SCHEMA_VERSION = 3;

export type SentinelOutcome = "complete" | "failed" | "timed-out" | "interrupted";

/**
 * How the run's workers ended, as the launcher itself observed them. The
 * outcome answers "how did the run end"; this answers "and did its work
 * succeed", which the outcome alone cannot: worker failures collapse to
 * `null` for the script by design, so a script that handles them
 * returns cleanly and the run is genuinely `complete` — but a supervisor
 * reading `complete` over a fan-out whose every worker failed has been
 * answered wrongly. Null when the launcher had no progress model to read.
 */
export interface SentinelWorkerOutcomes {
  /** Settled on their own account, successfully. */
  done: number;
  /** Settled on their own account, with a failure. */
  failed: number;
  /**
   * Workers the run's end cut short: teardown reached them, and each carries
   * a durable record naming the run's own shutdown status.
   */
  cutShort: number;
  /**
   * Workers the run abandoned: dispatched, then left with no outcome ever
   * observed, so their record says exactly that and nothing more.
   */
  unsettled: number;
}

/**
 * The sealed manifest's self-digest, or why this run has none. The sentinel
 * is the run's terminal statement and lands after the archive seals, so it
 * is the one artefact that can attest the manifest from outside it — which
 * is what makes the manifest's own digest checkable against a second file
 * rather than only against itself. The attestation is one-directional and
 * stays that way: the sentinel resolves independently of the record switch,
 * so a run with recording off publishes the reason there is no digest and
 * writes exactly as before.
 */
export type SentinelManifestAttestation =
  | { sha256: string }
  | { unavailable: "recording-disabled" | "recording-start-failed" | "manifest-unsealed" };

export interface SentinelTerminalDetail {
  workers?: SentinelWorkerOutcomes | null;
  /** What ended the run, when it ended badly; null on a clean end. */
  error?: { kind: string; message: string } | null;
  manifest?: SentinelManifestAttestation;
}

export interface CompletionSentinelOptions {
  /** The durable-record store directory (resolved even when recording is off). */
  storeDir: string;
  cwd: string;
  runUuid: string;
}

/**
 * The launcher-written completion sentinel: the CLI announces this file's
 * path on stderr at startup and writes it on every terminal transition it
 * can handle — success, failure, timeout, interruption, salvage — carrying
 * the outcome and exit status, so a supervisor woken by the file knows
 * which case it woke to. It is written even when durable recording is
 * disabled: the sentinel is supervision surface, not archive, so the run
 * directory is created for it alone. An uncatchable kill of the launcher
 * leaves no sentinel, which is why the documented consumer pattern keeps a
 * scheduled fallback timer behind the filesystem watch.
 *
 * Nothing here may fail the run: preparation and the terminal write degrade
 * to a reported error, never a throw — a supervision aid must not become the
 * thing that kills the run it supervises.
 */
export class CompletionSentinel {
  #path: string | null = null;
  #written = false;

  /**
   * Derives the sentinel path, creates its directory, and returns the path.
   * Called before workers spawn so the announcement precedes any work. The
   * directory is created here, not at the terminal write: a path is
   * announced only once it can be written, so a supervisor never arms on a
   * path under a store the launcher cannot create (a regular file where the
   * store should be, a read-only parent). Returns null — and reports why,
   * in one line — when the store cannot be derived or created; the run then
   * has no sentinel and says so where the path would have been.
   */
  async prepare(options: CompletionSentinelOptions, onError: (error: unknown) => void): Promise<string | null> {
    let runDir: string;
    try {
      runDir = await resolveRunDirectory(options.storeDir, options.cwd, options.runUuid);
      await mkdir(runDir, { recursive: true });
    } catch (error) {
      onError(new SentinelUnavailableError(`no sentinel will be written for this run — cannot create ${sentinelDirectory(options, error)}: ${causeMessage(error)}`, { cause: error }));
      return null;
    }
    this.#path = path.join(runDir, SENTINEL_FILENAME);
    return this.#path;
  }

  /**
   * Writes the terminal sentinel (atomic temp-then-rename). First write
   * wins: the terminal transition that ends the run is the one a supervisor
   * must see, and a later bookkeeping path must not rewrite it.
   */
  async writeTerminal(
    outcome: SentinelOutcome,
    exitCode: number,
    onError: (error: unknown) => void,
    detail: SentinelTerminalDetail = {}
  ): Promise<void> {
    if (this.#path === null || this.#written) {
      return;
    }
    this.#written = true;
    const workers = detail.workers ?? null;
    const payload = {
      schema_version: SENTINEL_SCHEMA_VERSION,
      kind: "completion_sentinel",
      outcome,
      exit_code: exitCode,
      // Read from the launcher's own progress model, not the archive: the
      // sentinel resolves independently of the record switch, so recording
      // being off must degrade nothing here.
      workers:
        workers === null
          ? null
          : {
              done: workers.done,
              failed: workers.failed,
              cut_short: workers.cutShort,
              unsettled: workers.unsettled
            },
      error: detail.error ?? null,
      manifest: detail.manifest ?? { unavailable: "recording-disabled" as const },
      ended_at: new Date().toISOString(),
      // Self-attestation, computed last over everything above it: the
      // digest of this payload with `integrity.sentinel_sha256` null, in
      // the same canonical form the run manifest uses, so one verification
      // recipe covers both files — and the recipe rides the file itself,
      // as the manifest's does. Like the manifest's, it catches an edited
      // field, not a forger.
      integrity: { algorithm: "sha256" as const, recipe: DIGEST_RECIPE, sentinel_sha256: null as string | null }
    };
    payload.integrity.sentinel_sha256 = sha256(canonicalJson(payload));
    try {
      await mkdir(path.dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, `${canonicalJson(payload)}\n`, "utf8");
        await rename(temporary, this.#path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    } catch (error) {
      onError(new SentinelUnavailableError(`the sentinel could not be written at ${this.#path}: ${causeMessage(error)}`, { cause: error }));
    }
  }
}

/**
 * A sentinel the launcher could not prepare or write. Reported, never
 * thrown past the sentinel: the message is the whole operator surface (one
 * line, cause named), and the filesystem error rides `cause` for a reader
 * who wants the code.
 */
export class SentinelUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The directory the sentinel would have lived in, as far as it could be named. */
function sentinelDirectory(options: CompletionSentinelOptions, error: unknown): string {
  const named = (error as { path?: unknown }).path;
  return typeof named === "string" ? named : options.storeDir;
}

