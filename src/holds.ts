import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";

import { HoldRejectedError, HoldTimeoutError } from "./errors.js";
import { MAX_TIMER_DELAY_MS } from "./engine-option-validation.js";
import { readProcessStartTicks } from "./run-record.js";
import { snapshotOwnerGone } from "./status-file.js";

import type { SnapshotOwnerEvidence } from "./status-file.js";
import type { RuntimeEvent } from "./types.js";

/**
 * Runtime holds: a script waiting on a human or orchestrator decision
 * raises a hold — its content and the verdicts it accepts — and awaits the
 * answer. The answer channel is a filesystem decision file, kept
 * deliberately: the decision writer need not be the process that launched
 * the run, nor exist when the hold was raised — an orchestrator sleeps
 * between holds, and a fresh session answers a predecessor's — with nonce
 * correlation keeping stale answers safe, and answers staying hand-writable
 * plain JSON.
 *
 * Every hold publishes under a **scope** — an opaque key the launcher
 * supplies (a lead session's own id is a natural value), carried by the
 * inherited `ENSEMBLE_HOLD_SCOPE` environment variable a lead sets once so
 * every nested invocation inherits it, outranked by the `--hold-scope` flag
 * or the `holdScope` library option. The scope is per-lead coordination
 * state, never inferred from the raising process's cwd or ancestry, and it
 * takes no config-file layer. A run whose launcher supplied no key lands in
 * the default shared scope, which scoped listings never show and the
 * machine-wide listing always shows. Scoping is hygiene against accidental
 * cross-answering between cooperating local processes — the nonce remains
 * the correctness boundary.
 */

/** The inherited scope variable a lead sets once; flag and library option outrank it. */
export const HOLD_SCOPE_ENV = "ENSEMBLE_HOLD_SCOPE";

/**
 * Resolve the hold scope for a raise: an explicit value (flag or library
 * option) wins, the inherited environment variable applies otherwise, and
 * neither means the default shared scope (`null`).
 */
export function resolveHoldScope(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (explicit !== undefined) {
    return explicit;
  }
  const inherited = env[HOLD_SCOPE_ENV];
  return inherited !== undefined && inherited.trim().length > 0 ? inherited : null;
}

/**
 * The scope's directory segment under the holds root. Named scopes are
 * URI-component-encoded behind a fixed prefix, so an opaque key of any
 * spelling maps to exactly one directory and can never collide with the
 * shared scope's reserved segment.
 */
export function holdScopeSegment(scope: string | null): string {
  return scope === null ? "shared" : `scope-${encodeURIComponent(scope)}`;
}

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
  schema_version: 2;
  kind: "ensemble_hold";
  run_id: string;
  hold_id: string;
  /** Correlates the answer to this raise: a decision bearing any other nonce is stale. */
  nonce: string;
  /** The launcher-supplied scope this hold publishes under; null is the shared scope. */
  scope: string | null;
  content: string;
  verdicts: string[];
  raised_at: string;
  timeout_at: string | null;
  /** Display-only metadata: never the scope, never a liveness judgement. */
  cwd: string;
  /**
   * The raising process's liveness evidence — the same `{host, pid,
   * start_ticks}` block the archive and status snapshot carry, judged with
   * the same never-guess check when the machinery retires dead-raiser holds.
   */
  owner: SnapshotOwnerEvidence;
  /** The latest rejected answer, republished for the decider who made it. */
  answer_rejection?: HoldAnswerRejection;
  /** Where the decider writes the answer: `{ "nonce", "verdict", "note"? }`. */
  decision_path: string;
}

export interface HoldAnswerRejection {
  reason: "stale-nonce" | "invalid-verdict" | "malformed";
  /** The submitted verdict when the rejected file was parseable enough to carry one. */
  attempted_verdict: string | null;
  /** Explains a null attempted verdict instead of silently discarding what was knowable. */
  attempted_verdict_state: "submitted" | "missing-or-non-string" | "unparseable";
  rejected_at: string;
}

/** One enumerated open hold. */
export interface EnumeratedHold {
  record: HoldFileRecord;
  path: string;
}

/**
 * One enumeration's complete result: the answerable holds it found, and the
 * dead-raiser holds it retired while looking (the listing only ever shows
 * answerable holds, so observing a provably dead raiser removes its hold).
 */
export interface HoldEnumeration {
  holds: EnumeratedHold[];
  retired: HoldFileRecord[];
}

const DECISION_SUFFIX = ".decision.json";

/** The shared cross-run holds root: `<XDG_DATA_HOME>/ensemble/holds`. */
export function defaultHoldsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome =
    env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : path.join(homedir(), ".local", "share");
  return path.join(dataHome, "ensemble", "holds");
}

export interface HoldManagerOptions {
  /** The holds root; the manager publishes under its scope's segment within it. */
  dir: string;
  runId: string;
  cwd: string;
  /** The launcher-supplied scope; null publishes into the default shared scope. */
  scope: string | null;
  /** Gap between decision-file polls. Tests inject a tiny value. */
  pollIntervalMs?: number;
  now?: () => number;
  /** Raise/answer/timeout/rejection/retirement events for the runtime's listeners. */
  onEvent?: (event: RuntimeEvent) => void;
  /** Live-status hooks: the snapshot shows open holds while they wait. */
  onOpen?: (hold: { id: string; content: string; verdicts: string[] }) => void;
  onSettled?: (id: string) => void;
  /** Test seam for the retirement sweep's liveness evidence. */
  procDir?: string;
}

export class HoldManager {
  #dir: string;
  #runId: string;
  #cwd: string;
  #scope: string | null;
  #pollIntervalMs: number;
  #now: () => number;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #onOpen: HoldManagerOptions["onOpen"];
  #onSettled: HoldManagerOptions["onSettled"];
  #procDir: string;
  #sequence = 0;
  #closed = false;
  #abort = new AbortController();
  #sweepDone = false;

  constructor(options: HoldManagerOptions) {
    this.#dir = path.join(options.dir, holdScopeSegment(options.scope));
    this.#runId = options.runId;
    this.#cwd = options.cwd;
    this.#scope = options.scope;
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    this.#now = options.now ?? (() => Date.now());
    this.#onEvent = options.onEvent;
    this.#onOpen = options.onOpen;
    this.#onSettled = options.onSettled;
    this.#procDir = options.procDir ?? "/proc";
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
      schema_version: 2,
      kind: "ensemble_hold",
      run_id: this.#runId,
      hold_id: holdId,
      nonce,
      scope: this.#scope,
      content: options.content,
      verdicts: [...options.verdicts],
      raised_at: new Date(raisedAt).toISOString(),
      timeout_at: deadline === null ? null : new Date(deadline).toISOString(),
      cwd: this.#cwd,
      owner: {
        host: hostname(),
        pid: process.pid,
        start_ticks: await readProcessStartTicks(this.#procDir, process.pid)
      },
      decision_path: decisionPath
    };

    // The holds directory is coordination state, created on demand — unlike
    // the opt-in status directory, there is no configuration to validate.
    await mkdir(this.#dir, { recursive: true });
    // The first raise sweeps this scope for dead-raiser leftovers, so a
    // lead's own scope never accumulates holds nobody can answer.
    await this.#retireDeadSiblings();
    // Atomic publish: a decider never reads a half-written hold.
    await publishHoldRecord(holdPath, record);

    this.#onOpen?.({ id: holdId, content: options.content, verdicts: record.verdicts });
    this.#emit("hold/raised", {
      holdId,
      scope: this.#scope,
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

  /**
   * Retire this scope's dead-raiser holds, once per manager: the sweep that
   * observes a raiser provably gone removes its hold, observably — one
   * `hold/retired` event per removal. Judgement is the shared never-guess
   * owner check; anything undecidable stays.
   */
  async #retireDeadSiblings(): Promise<void> {
    if (this.#sweepDone) {
      return;
    }
    this.#sweepDone = true;
    try {
      const { retired } = await enumerateScopeDirectory(this.#dir, { procDir: this.#procDir });
      for (const record of retired) {
        this.#emit("hold/retired", { holdId: record.hold_id, scope: record.scope });
      }
    } catch {
      // The sweep is hygiene: its failure must never fail a raise.
    }
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
      const decision = await this.#readDecision(record, holdPath, decisionPath, grace);
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
    holdPath: string,
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
    let rejection: HoldAnswerRejection | null = null;
    let decision: HoldDecision | null = null;
    try {
      const parsed = JSON.parse(raw) as { nonce?: unknown; verdict?: unknown; note?: unknown };
      grace.lastUnparseable = null;
      if (parsed.nonce !== record.nonce) {
        rejection = rejectedAnswer("stale-nonce", parsed.verdict, this.#now());
      } else if (typeof parsed.verdict !== "string" || !record.verdicts.includes(parsed.verdict)) {
        rejection = rejectedAnswer("invalid-verdict", parsed.verdict, this.#now());
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
      rejection = {
        reason: "malformed",
        attempted_verdict: null,
        attempted_verdict_state: "unparseable",
        rejected_at: new Date(this.#now()).toISOString()
      };
    }
    if (decision !== null || rejection !== null) {
      // Consumed on any judgement: a rejected file left in place would be
      // re-read for ever, and removing it lets a corrected answer land at
      // the same path.
      await rm(decisionPath, { force: true }).catch(() => undefined);
    }
    if (rejection !== null) {
      record.answer_rejection = rejection;
      await publishHoldRecord(holdPath, record);
      this.#emit("hold/answerRejected", {
        holdId: record.hold_id,
        reason: rejection.reason,
        attemptedVerdict: rejection.attempted_verdict,
        attemptedVerdictState: rejection.attempted_verdict_state
      });
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

export interface EnumerateHoldsOptions {
  /**
   * A named scope confines the listing to that scope's directory — the
   * lead's own view. Omitted, the listing is machine-wide: every scope,
   * the default shared scope included.
   */
  scope?: string;
  /** Test seam for the retirement judgement's liveness evidence. */
  procDir?: string;
}

/**
 * Enumerate open holds — one scope's, or machine-wide across every scope.
 * Enumeration is also the retirement machinery: a hold whose raiser is
 * provably gone (the shared never-guess owner check) is removed and
 * reported in `retired` rather than listed, so the listing only ever shows
 * answerable holds. Anything undecidable — a foreign host, missing
 * evidence — stays listed.
 */
export async function enumerateHolds(dir: string, options: EnumerateHoldsOptions = {}): Promise<HoldEnumeration> {
  const procDir = options.procDir ?? "/proc";
  if (options.scope !== undefined) {
    return enumerateScopeDirectory(path.join(dir, holdScopeSegment(options.scope)), { procDir });
  }
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      // No root yet means no hold has ever been raised here: honestly
      // empty. Any other failure must NOT read as "no open holds" — an
      // unreadable inbox claiming emptiness would hide holds that may
      // exist — so it propagates for the caller to report.
      return { holds: [], retired: [] };
    }
    throw error;
  }
  const result: HoldEnumeration = { holds: [], retired: [] };
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const scoped = await enumerateScopeDirectory(path.join(dir, entry.name), { procDir });
    result.holds.push(...scoped.holds);
    result.retired.push(...scoped.retired);
  }
  return result;
}

async function enumerateScopeDirectory(scopeDir: string, options: { procDir: string }): Promise<HoldEnumeration> {
  let entries: string[];
  try {
    entries = await readdir(scopeDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { holds: [], retired: [] };
    }
    throw error;
  }
  const result: HoldEnumeration = { holds: [], retired: [] };
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json") || entry.endsWith(DECISION_SUFFIX)) {
      continue;
    }
    const holdPath = path.join(scopeDir, entry);
    try {
      const record = JSON.parse(await readFile(holdPath, "utf8")) as HoldFileRecord;
      if (record.kind !== "ensemble_hold" || typeof record.hold_id !== "string") {
        continue;
      }
      if (await snapshotOwnerGone(record.owner, options.procDir)) {
        // The raiser is provably dead: nothing can await this hold's
        // decision, so the machinery that observed the death retires it —
        // the hold file and any stale answer beside it.
        await rm(holdPath, { force: true }).catch(() => undefined);
        if (typeof record.decision_path === "string") {
          await rm(record.decision_path, { force: true }).catch(() => undefined);
        }
        result.retired.push(record);
        continue;
      }
      result.holds.push({ record, path: holdPath });
    } catch {
      // A half-removed or foreign file is not a hold; the listing skips it.
    }
  }
  return result;
}

async function publishHoldRecord(holdPath: string, record: HoldFileRecord): Promise<void> {
  const tmp = `${holdPath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
  await rename(tmp, holdPath);
}

function rejectedAnswer(
  reason: "stale-nonce" | "invalid-verdict",
  verdict: unknown,
  now: number
): HoldAnswerRejection {
  return {
    reason,
    attempted_verdict: typeof verdict === "string" ? verdict : null,
    attempted_verdict_state: typeof verdict === "string" ? "submitted" : "missing-or-non-string",
    rejected_at: new Date(now).toISOString()
  };
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
