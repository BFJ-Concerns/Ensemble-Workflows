import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { HoldRejectedError, HoldTimeoutError } from "./errors.js";
import { MAX_TIMER_DELAY_MS } from "./engine-option-validation.js";

import type { RuntimeEvent } from "./types.js";

/**
 * Runtime holds: a script waiting on a human or orchestrator decision
 * raises a hold — its content and the verdicts it accepts — and awaits the
 * answer. The answer channel is a filesystem decision file, kept
 * deliberately: the decision writer need not be the process that launched
 * the run, nor exist when the hold was raised — an orchestrator sleeps
 * between holds, and a fresh session answers a predecessor's — with nonce
 * correlation keeping stale answers safe. Holds from every run share one
 * per-user directory so a watcher can enumerate them without knowing any
 * run's own directories.
 */

export interface RaiseHoldOptions {
  /** What the decider reads: the question, its context, what hangs on it. */
  content: string;
  /** The verdicts the hold accepts; an answer outside them never reaches the script. */
  verdicts: string[];
  /** Optional bound on an unanswered hold; expiry rejects with HoldTimeoutError. */
  timeoutMs?: number;
}

/** What the awaiting script resolves: the accepted verdict and the decider's note. */
export interface HoldDecision {
  verdict: string;
  note: string | null;
}

/** The on-disk hold record, as `ensemble holds` and deciders read it. */
export interface HoldFileRecord {
  schema_version: 1;
  kind: "ensemble_hold";
  run_id: string;
  hold_id: string;
  /** Correlates the answer to this raise: a decision bearing any other nonce is stale. */
  nonce: string;
  content: string;
  verdicts: string[];
  raised_at: string;
  timeout_at: string | null;
  cwd: string;
  /** The raising process — liveness evidence for the cross-run listing. */
  pid: number;
  /** Where the decider writes the answer: `{ "nonce", "verdict", "note"? }`. */
  decision_path: string;
}

/** One enumerated hold, with the listing's own liveness reading beside it. */
export interface EnumeratedHold {
  record: HoldFileRecord;
  /** Whether the raising process is still alive; false marks an orphaned hold. */
  live: boolean;
  path: string;
}

const DECISION_SUFFIX = ".decision.json";

/** The shared cross-run holds directory: `<XDG_DATA_HOME>/ensemble/holds`. */
export function defaultHoldsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome =
    env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : path.join(homedir(), ".local", "share");
  return path.join(dataHome, "ensemble", "holds");
}

export interface HoldManagerOptions {
  dir: string;
  runId: string;
  cwd: string;
  /** Gap between decision-file polls. Tests inject a tiny value. */
  pollIntervalMs?: number;
  now?: () => number;
  /** Raise/answer/timeout (and rejected-answer) events for the runtime's listeners. */
  onEvent?: (event: RuntimeEvent) => void;
  /** Live-status hooks: the snapshot shows open holds while they wait. */
  onOpen?: (hold: { id: string; content: string; verdicts: string[] }) => void;
  onSettled?: (id: string) => void;
}

export class HoldManager {
  #dir: string;
  #runId: string;
  #cwd: string;
  #pollIntervalMs: number;
  #now: () => number;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #onOpen: HoldManagerOptions["onOpen"];
  #onSettled: HoldManagerOptions["onSettled"];
  #sequence = 0;
  #closed = false;
  #abort = new AbortController();

  constructor(options: HoldManagerOptions) {
    this.#dir = options.dir;
    this.#runId = options.runId;
    this.#cwd = options.cwd;
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    this.#now = options.now ?? (() => Date.now());
    this.#onEvent = options.onEvent;
    this.#onOpen = options.onOpen;
    this.#onSettled = options.onSettled;
  }

  async raise(options: RaiseHoldOptions): Promise<HoldDecision> {
    assertValidRaiseHoldOptions(options);
    if (this.#closed) {
      throw new HoldRejectedError("the run is closing; no new holds can be raised");
    }
    this.#sequence += 1;
    const holdId = `${this.#runId}-${this.#sequence}`;
    const nonce = randomUUID();
    const holdPath = path.join(this.#dir, `${holdId}.json`);
    const decisionPath = path.join(this.#dir, `${holdId}${DECISION_SUFFIX}`);
    const raisedAt = this.#now();
    const deadline = options.timeoutMs === undefined ? null : raisedAt + options.timeoutMs;
    const record: HoldFileRecord = {
      schema_version: 1,
      kind: "ensemble_hold",
      run_id: this.#runId,
      hold_id: holdId,
      nonce,
      content: options.content,
      verdicts: [...options.verdicts],
      raised_at: new Date(raisedAt).toISOString(),
      timeout_at: deadline === null ? null : new Date(deadline).toISOString(),
      cwd: this.#cwd,
      pid: process.pid,
      decision_path: decisionPath
    };

    // The holds directory is coordination state, created on demand — unlike
    // the opt-in status directory, there is no configuration to validate.
    await mkdir(this.#dir, { recursive: true });
    // Atomic publish: a decider never reads a half-written hold.
    const tmp = `${holdPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
    await rename(tmp, holdPath);

    this.#onOpen?.({ id: holdId, content: options.content, verdicts: record.verdicts });
    this.#emit("hold/raised", {
      holdId,
      content: options.content,
      verdicts: record.verdicts,
      decisionPath,
      timeoutAt: record.timeout_at
    });

    try {
      return await this.#awaitDecision(record, holdPath, decisionPath, deadline);
    } finally {
      this.#onSettled?.(holdId);
      // The hold file's lifetime is the wait's: settled holds — answered,
      // timed out, or abandoned by close() — leave the listing.
      await rm(holdPath, { force: true }).catch(() => undefined);
    }
  }

  /** Reject the waits and stop polling; the finally blocks remove the files. */
  close(): void {
    this.#closed = true;
    this.#abort.abort();
  }

  async #awaitDecision(
    record: HoldFileRecord,
    holdPath: string,
    decisionPath: string,
    deadline: number | null
  ): Promise<HoldDecision> {
    // A decider writing with a plain (non-atomic) write can be caught
    // mid-write by this poller. An unparseable read is therefore given one
    // poll's grace before it is judged malformed: only the *same*
    // unparseable bytes seen twice are consumed and rejected — a file
    // still growing reads differently next poll and is left alone.
    const grace = { lastUnparseable: null as string | null };
    for (;;) {
      const decision = await this.#readDecision(record, decisionPath, grace);
      if (decision !== null) {
        this.#emit("hold/answered", { holdId: record.hold_id, verdict: decision.verdict });
        return decision;
      }
      if (deadline !== null && this.#now() >= deadline) {
        this.#emit("hold/timedOut", { holdId: record.hold_id });
        throw new HoldTimeoutError(record.hold_id, record.timeout_at ?? "");
      }
      await this.#delay();
    }
  }

  /**
   * One decision-file reading. A stale nonce or a verdict outside the
   * accepted set is *rejected*: the bad file is removed, an event says so,
   * and the hold keeps waiting — an invalid answer must never reach the
   * script as a decision. An unparseable file is rejected only once the
   * same bytes have survived a full poll (see the grace note above).
   */
  async #readDecision(
    record: HoldFileRecord,
    decisionPath: string,
    grace: { lastUnparseable: string | null }
  ): Promise<HoldDecision | null> {
    let raw: string;
    try {
      raw = await readFile(decisionPath, "utf8");
    } catch {
      grace.lastUnparseable = null;
      return null;
    }
    let rejection: string | null = null;
    let decision: HoldDecision | null = null;
    try {
      const parsed = JSON.parse(raw) as { nonce?: unknown; verdict?: unknown; note?: unknown };
      grace.lastUnparseable = null;
      if (parsed.nonce !== record.nonce) {
        rejection = "stale-nonce";
      } else if (typeof parsed.verdict !== "string" || !record.verdicts.includes(parsed.verdict)) {
        rejection = "invalid-verdict";
      } else {
        decision = { verdict: parsed.verdict, note: typeof parsed.note === "string" ? parsed.note : null };
      }
    } catch {
      if (grace.lastUnparseable !== raw) {
        // First sighting (or still changing): possibly a write in flight —
        // leave the file for the next poll rather than destroying a
        // decider's answer mid-write.
        grace.lastUnparseable = raw;
        return null;
      }
      grace.lastUnparseable = null;
      rejection = "malformed";
    }
    if (decision !== null || rejection !== null) {
      // Consumed on any judgement: a rejected file left in place would be
      // re-read for ever, and removing it lets a corrected answer land at
      // the same path.
      await rm(decisionPath, { force: true }).catch(() => undefined);
    }
    if (rejection !== null) {
      this.#emit("hold/answerRejected", { holdId: record.hold_id, reason: rejection });
      return null;
    }
    return decision;
  }

  #delay(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const signal = this.#abort.signal;
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.#pollIntervalMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new HoldRejectedError("the run ended while this hold was open"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  #emit(method: string, params: Record<string, unknown>): void {
    this.#onEvent?.({ method, params, receivedAt: Date.now() });
  }
}

/**
 * Enumerate open holds across runs — every hold file in the directory, with
 * a liveness reading of its raising process so a watcher can tell a waiting
 * run from an orphaned file a killed run left behind.
 */
export async function enumerateHolds(dir: string): Promise<EnumeratedHold[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      // No directory yet means no hold has ever been raised here: honestly
      // empty. Any other failure must NOT read as "no open holds" — an
      // unreadable inbox claiming emptiness would hide holds that may
      // exist — so it propagates for the caller to report.
      return [];
    }
    throw error;
  }
  const holds: EnumeratedHold[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json") || entry.endsWith(DECISION_SUFFIX)) {
      continue;
    }
    const holdPath = path.join(dir, entry);
    try {
      const record = JSON.parse(await readFile(holdPath, "utf8")) as HoldFileRecord;
      if (record.kind !== "ensemble_hold" || typeof record.hold_id !== "string") {
        continue;
      }
      holds.push({ record, live: isProcessAlive(record.pid), path: holdPath });
    } catch {
      // A half-removed or foreign file is not a hold; the listing skips it.
    }
  }
  return holds;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH");
  }
}

const RAISE_HOLD_OPTION_KEYS = ["content", "verdicts", "timeoutMs"];
const RAISE_HOLD_OPTION_KEY_SET = new Set<string>(RAISE_HOLD_OPTION_KEYS);

function assertValidRaiseHoldOptions(options: object): asserts options is RaiseHoldOptions {
  for (const key of Object.keys(options)) {
    if (!RAISE_HOLD_OPTION_KEY_SET.has(key)) {
      throw new HoldRejectedError(
        `unrecognised hold option '${key}' (known options: ${RAISE_HOLD_OPTION_KEYS.join(", ")})`
      );
    }
  }
  const values = options as Record<string, unknown>;
  if (typeof values.content !== "string" || values.content.trim().length === 0) {
    throw new HoldRejectedError("hold content must be a non-empty string");
  }
  if (
    !Array.isArray(values.verdicts) ||
    values.verdicts.length === 0 ||
    values.verdicts.some((verdict) => typeof verdict !== "string" || verdict.trim().length === 0)
  ) {
    throw new HoldRejectedError("hold verdicts must be a non-empty array of non-empty strings");
  }
  if (new Set(values.verdicts).size !== values.verdicts.length) {
    throw new HoldRejectedError("hold verdicts must be distinct");
  }
  if (
    values.timeoutMs !== undefined &&
    (typeof values.timeoutMs !== "number" ||
      !Number.isInteger(values.timeoutMs) ||
      values.timeoutMs <= 0 ||
      values.timeoutMs > MAX_TIMER_DELAY_MS)
  ) {
    throw new HoldRejectedError(`hold timeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`);
  }
}
