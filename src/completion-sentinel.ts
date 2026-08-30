import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256 } from "./canonical-document.js";
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
  | { unavailable: "recording-disabled" | "manifest-unsealed" };

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
   * Derives and returns the sentinel path. Called before workers spawn so
   * the announcement precedes any work; returns null (and reports) when the
   * store path cannot be derived.
   */
  async prepare(options: CompletionSentinelOptions, onError: (error: unknown) => void): Promise<string | null> {
    try {
      const runDir = await resolveRunDirectory(options.storeDir, options.cwd, options.runUuid);
      this.#path = path.join(runDir, SENTINEL_FILENAME);
      return this.#path;
    } catch (error) {
      onError(error);
      return null;
    }
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
      // the same canonical form (sorted keys, two-space indent) the run
      // manifest uses, so one verification recipe covers both files. Like
      // the manifest's, it catches an edited field, not a forger.
      integrity: { algorithm: "sha256" as const, sentinel_sha256: null as string | null }
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
      onError(error);
    }
  }
}

