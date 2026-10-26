import { randomUUID } from "node:crypto";

import {
  ClaudeBlockedError,
  ClaudeCollectionError,
  ClaudeFirstLifeTimeoutError,
  ClaudePollTimeoutError,
  ClaudeRegistrationTimeoutError,
  ClaudeTranscriptError,
  ClaudeValveError,
  ClaudeWorkerDiagnosticError,
  ClaudeWorkerError,
  EngineShutdownError,
  attachFailedTurnResult,
  attachPartialWorkerText,
  failedTurnResultOf,
  partialWorkerTextOf
} from "./errors.js";
import {
  apiErrorSince,
  effortSince,
  endsInSyntheticReply,
  finalAssistantText,
  outstandingBackgroundTasks,
  readTranscriptFile,
  resolvedModelSince,
  turnComplete,
  usageSince
} from "./claude-transcript.js";
import { subtractUsage } from "./usage-summary.js";

import type { ClaudeControlPlane, ClaudeSessionHandle } from "./claude-control-plane.js";
import type { TranscriptApiError, TranscriptEntry, TranscriptFile } from "./claude-transcript.js";
import type {
  EngineAttemptContext,
  EngineAttemptFailure,
  PreviousAttemptFailure,
  EngineAttemptResult,
  EngineInvocation,
  EngineSessionTurn,
  EngineTurnOptions,
  EngineWorkerSession
} from "./engines.js";
import type { StrippableCapability } from "./capability-stripping.js";
import type {
  AgentWaitSnapshot,
  BackgroundTaskWait, JsonSchema, RuntimeEvent, TokenUsageBreakdown, TokenUsageEvent, TurnResult } from "./types.js";

/**
 * The Claude rendering of each strippable capability: the permission deny
 * rules that remove it from the worker's tool surface. `agents` denies the
 * measured native spawn, discovery, and messaging tools: `Task`, `Agent`,
 * `ListAgents`, and `SendMessage`. Worker tool surface measured 2026-08-28 on
 * Claude Code 2.1.250 used `mcp__`-prefixed names; that session's skills pair
 * showed the bare `Skill` deny working (`Skill` absent under a skills strip,
 * present in the baseline). The agents deny set was witnessed 2026-08-30 on
 * Claude Code 2.1.251: `ListAgents` and `SendMessage` were absent at the
 * stripped worker, while the unstripped control demonstrated discovery and
 * messaging. `Agent` was also absent, but the witness cannot isolate it from
 * the machine-wide `Agent` deny. `Task` remains in the delivered deny set,
 * which the exact-set regression proves. Deny rules outrank every allow
 * layer and permission mode, so the operator's own settings cannot quietly
 * re-enable a stripped tool.
 */
const CAPABILITY_DENY_RULES: Record<StrippableCapability, readonly string[]> = {
  skills: ["Skill"],
  agents: ["Task", "Agent", "ListAgents", "SendMessage"]
};

export function permissionDenyRulesFor(strip: readonly StrippableCapability[] | undefined): string[] {
  return [...new Set((strip ?? []).flatMap((capability) => CAPABILITY_DENY_RULES[capability]))];
}

/**
 * Tunables for the Claude worker lifecycle. All have defaults; tests inject tiny
 * intervals (and a fake control plane) to stay deterministic and fast.
 */
export interface ClaudeEngineConfig {
  /** Gap between roster polls while waiting for a worker to finish. */
  pollIntervalMs?: number;
  /** How long to wait for a steered worker to acknowledge before treating the valve as failed. */
  receiptTimeoutMs?: number;
  /** How long a new session may exist without creating any transcript. */
  firstLifeTimeoutMs?: number;
  /** Max in-session nudges for a blocked worker before giving up — keeps recovery bounded, never a hang. */
  blockedRecoveryBound?: number;
  /** Prefix for the unique per-dispatch session name. */
  namePrefix?: string;
}

export interface ClaudeEngineInvocationOptions {
  prompt: string;
  cwd: string;
  options: EngineTurnOptions;
  controlPlane: ClaudeControlPlane;
  /**
   * Session mode: the invocation outlives its first turn, `beginTurn`
   * queues follow-up prompts through the valve into the *same* session, and
   * a correction that cannot ride the valve fails the turn rather than
   * degrade to a fresh dispatch — a redispatch would answer a follow-up
   * from a different session than the one created, a continuity failure.
   * Also rides the dispatch with the 1-hour prompt-cache TTL: a loitering
   * worker is the one case the write premium pays back.
   */
  multiTurn?: boolean;
  onEvent?: (event: RuntimeEvent) => void;
  config?: ClaudeEngineConfig;
  /** Adapter deregistration: called exactly once, when close() completes. */
  onClose?: (invocation: ClaudeEngineInvocation) => void;
}

/**
 * The prompt-cache TTL a multi-turn Claude worker is dispatched with,
 * in the value format Claude Code's settings accept. One-shot workers keep
 * the engine's 5-minute default — the premium is spent only where loitering
 * pays it back — and a machine-declared `worker_environment` value for the
 * same variable still wins (the operator's word outranks the harness
 * default; see the control plane's settings-file spread order).
 */
export const CLAUDE_MULTITURN_CACHE_TTL = "1h";

/**
 * Parse a Claude Code cache-TTL settings value ("30s", "5m", "1h", or bare
 * seconds) to milliseconds; null for anything unrecognised. Used to keep
 * the staleness cliff on the *effective* TTL when a machine-declared
 * worker-environment value overrides the injected default — two settings
 * that would otherwise silently desynchronise.
 */
export function claudeCacheTtlToMs(value: string): number | null {
  const match = /^(\d+)([smh]?)$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2];
  return amount * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000);
}

let dispatchCounter = 0;

// A worker can briefly drop out of the roster while parking/respawning; only a
// run of misses is treated as genuine absence (each poll is one roster query).
const MAX_CONSECUTIVE_ABSENCES = 3;

// How many consecutive polls the daemon must report the session settled
// (idle/done) while the transcript still fails to prove the turn complete
// before collection fails loudly. A handful of polls, not one: a single idle
// reading can race the daemon's own bookkeeping between the last delta and
// the transcript flush, and an in-session correction passes through idle
// between the steer's receipt and generation. Once the window is spent, the
// session will never say more — waiting longer is the silent stall this
// bound exists to remove.
const SETTLED_CONFIRMATION_POLLS = 5;

/**
 * One `agent({ engine: 'claude' })` call, as a stateful invocation across the
 * shared loop's bounded attempts.
 *
 * - **Attempt 1** dispatches a `claude --bg` worker, polls it to `done`, and
 *   reads its final message from the JSONL transcript.
 * - **Attempt > 1** is *in-session correction*: the worker is still alive, so the
 *   failure reason (carried by `previousFailure`) is steered back into the **same
 *   session** through the reply valve and the corrected final message is read —
 *   no redispatch, full context preserved. This is what makes Claude's schema
 *   enforcement as strong as Codex's despite the absent backend `outputSchema`.
 * - **Without the valve** (no tmux), correction degrades to a fresh re-dispatch
 *   whose prompt carries the prior failure; the engine never depends on the valve.
 * - **Operational failures** (dispatch died, poll timed out, blocked past the
 *   bound, valve refused, transcript unreadable) become failed turns carrying
 *   their typed diagnostic and current-turn transcript text. The session is
 *   torn down and the shared loop applies its normal bounded retry contract.
 *
 * `close()` (called by the shared loop in `finally`) stops and removes the session.
 */
export class ClaudeEngineInvocation implements EngineInvocation, EngineWorkerSession {
  #cwd: string;
  #options: EngineTurnOptions;
  #controlPlane: ClaudeControlPlane;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #reportedUsage: TokenUsageBreakdown | null = null;
  /** The background tasks this attempt's turn waited on, in the order observed; reset per attempt. */
  #waits: BackgroundTaskWait[] = [];

  #multiTurn: boolean;
  /** The current turn's prompt: the constructor's for a one-shot call, `beginTurn`'s thereafter. */
  #turnPrompt: string;
  /** The current turn's schema — the one thing a session varies per turn. */
  #turnSchema: JsonSchema | undefined;
  /**
   * Whether the current turn's prompt has reached the worker. A follow-up
   * turn is delivered by the valve, and a retry after a failed delivery
   * must re-send the prompt itself — a correction message would ask the
   * worker to fix an answer it was never asked for.
   */
  #turnDelivered = false;

  #pollIntervalMs: number;
  #receiptTimeoutMs: number;
  #firstLifeTimeoutMs: number;
  #blockedRecoveryBound: number;
  #namePrefix: string;

  #handle: ClaudeSessionHandle | null = null;
  #budgetEventCounter = 0;
  #abortController = new AbortController();
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #settlement: Promise<EngineAttemptResult> | null = null;
  #onClose: ((invocation: ClaudeEngineInvocation) => void) | undefined;

  constructor(options: ClaudeEngineInvocationOptions) {
    this.#turnPrompt = options.prompt;
    this.#turnSchema = options.options.schema;
    this.#multiTurn = options.multiTurn ?? false;
    this.#cwd = options.cwd;
    this.#options = options.options;
    this.#controlPlane = options.controlPlane;
    this.#onEvent = options.onEvent;
    this.#onClose = options.onClose;

    const config = options.config ?? {};
    this.#pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.#receiptTimeoutMs = config.receiptTimeoutMs ?? 30_000;
    this.#firstLifeTimeoutMs = config.firstLifeTimeoutMs ?? 60_000;
    this.#blockedRecoveryBound = config.blockedRecoveryBound ?? 2;
    this.#namePrefix = config.namePrefix ?? "ensemble";
  }

  /**
   * Session mode's turn boundary: the next `runAttempt` delivers this
   * prompt to the *held* session — by dispatch for the first turn, through
   * the valve thereafter — with this turn's schema governing validation and
   * correction. The returned invocation deliberately carries no `close`:
   * a turn ending must never tear down the session it rode.
   */
  beginTurn(prompt: string, turn: EngineSessionTurn): EngineInvocation {
    this.#turnPrompt = prompt;
    this.#turnSchema = turn.schema;
    this.#turnDelivered = false;
    return {
      runAttempt: (context) => this.runAttempt(context)
    };
  }

  runAttempt(context: EngineAttemptContext): Promise<EngineAttemptResult> {
    // close() must be able to await a live attempt so cancellation is not
    // "torn down under a caller still running": track the settlement.
    const settlement = this.#runAttempt(context);
    this.#settlement = settlement;
    return settlement.finally(() => {
      if (this.#settlement === settlement) {
        this.#settlement = null;
      }
    });
  }

  async #runAttempt(context: EngineAttemptContext): Promise<EngineAttemptResult> {
    this.#assertOpen();
    this.#reportedUsage = null;
    this.#waits = [];
    let fromIndex = 0;
    try {
      const previousFailure = context.previousFailure;

      if (this.#handle !== null && this.#multiTurn && !this.#turnDelivered) {
        // A follow-up turn (or a retry whose delivery never landed): the
        // prompt itself rides the valve into the held session. A correction
        // branch would be wrong here — the worker has not seen this turn.
        // The high-water mark is read first so a failure past this point
        // attaches only *this* turn's text, never the previous turn's.
        const handle = this.#handle;
        fromIndex = (await this.#readTranscript(handle)).entries.length;
        this.#requireValve(await this.#controlPlane.tmuxAvailable());
        return await this.#sendTurnInSession(handle, fromIndex, context);
      }

      const correcting = previousFailure !== undefined && this.#handle !== null;
      if (correcting && (await this.#controlPlane.tmuxAvailable())) {
        const handle = this.#handle as ClaudeSessionHandle;
        fromIndex = (await this.#readTranscript(handle)).entries.length;
        return await this.#correctInSession(handle, previousFailure, fromIndex, context);
      }
      if (correcting && this.#multiTurn) {
        // No valve, no degraded redispatch: a fresh session answering a held
        // worker's turn is a continuity failure, so the turn fails loudly
        // instead.
        this.#requireValve(false);
      }

      // First attempt, or a correction we cannot do in-session: (re)dispatch.
      // A degraded correction folds the prior failure into the fresh prompt.
      if (this.#handle !== null) {
        await this.#teardown();
      }
      return await this.#dispatchAndCollect(previousFailure, context);
    } catch (error) {
      // One best-effort read of what the engine already holds, before any
      // teardown, serving every evidence the failed turn can still carry:
      // partial worker text, the served model, the spend the transcript has
      // already proved, and the transcript itself.
      // The initial-dispatch interruption branch below has already captured
      // and attached its one evidence read before it tears the new handle
      // down. Every other failure keeps this existing catch-path read.
      const preparedInterruption = error instanceof EngineShutdownError && failedTurnResultOf(error) !== null;
      const evidence = error instanceof Error && !preparedInterruption ? await this.#tryFailureEvidence(fromIndex) : null;
      if (error instanceof Error && evidence !== null) {
        this.#attachWorkerText(error, evidence, fromIndex);
      }
      if (error instanceof EngineShutdownError && evidence !== null) {
        // Interruption remains a rejection — it must neither settle as an
        // operational failure nor enter the retry loop — but its record must
        // retain the same fields an already-built failed result would carry.
        attachFailedTurnResult(error, failedTurnResult(error, evidence, this.#failureUsageEvent(evidence)));
      }
      if (error instanceof ClaudeWorkerError) {
        // Preserve the operational cause and current-turn text on the failed
        // result while retaining the shared loop's bounded retry governance.
        // A served model or effort the transcript already named is evidence
        // too, and so is the usage it recorded: a result-less failure must
        // not un-learn spend the run has already paid for (failures carry
        // their evidence).
        if (!this.#multiTurn) {
          // One-shot only: a held session survives its turn's operational
          // failure — tearing it down would leave the retry with no handle
          // and a silent fresh dispatch as the only path, a continuity
          // failure. Session teardown belongs to close().
          await this.#teardown();
        }
        return failedTurnResult(error, evidence, this.#failureUsageEvent(evidence));
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#closed = true;
      this.#abortController.abort();
      try {
        if (this.#handle !== null) {
          await this.#settlement?.catch(() => undefined);
          await this.#teardown();
        }
      } finally {
        this.#onClose?.(this);
      }
    })();
    await this.#closePromise;
  }

  async #dispatchAndCollect(
    previousFailure: PreviousAttemptFailure | undefined,
    observers: AttemptObservers
  ): Promise<TurnResult> {
    const denyRules = permissionDenyRulesFor(this.#options.strip);
    const handle = await this.#controlPlane.dispatch({
      prompt: this.#buildDispatchPrompt(previousFailure),
      name: this.#nextName(),
      cwd: this.#cwd,
      ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
      ...(this.#options.effort !== undefined ? { effort: this.#options.effort } : {}),
      ...(denyRules.length > 0 ? { permissionDenyRules: denyRules } : {}),
      // Loiter pricing: only a session meant to be resumed pays the
      // 1-hour cache-write premium; one-shot workers keep the 5m default.
      ...(this.#multiTurn ? { cacheTtl: CLAUDE_MULTITURN_CACHE_TTL } : {})
    });
    this.#handle = handle;
    this.#turnDelivered = true;
    if (this.#closed) {
      // close() ran while dispatch was in flight and found no handle, so it
      // returned without waiting for this dispatch. The new session is ours
      // to stop, but first take the one best-effort evidence read while its
      // transcript is still reachable. The prepared result marks this error
      // as already read, so #runAttempt's catch will not race a second read
      // against teardown.
      const error = new EngineShutdownError("claude");
      const evidence = await this.#tryFailureEvidence(0);
      if (evidence !== null) {
        this.#attachWorkerText(error, evidence, 0);
      }
      attachFailedTurnResult(error, failedTurnResult(error, evidence, this.#failureUsageEvent(evidence)));
      await this.#teardown();
      throw error;
    }

    const transcript = await this.#runToCompletion(handle, 0, observers);
    return this.#buildResult(handle, transcript, 0);
  }

  /** Deliver a follow-up turn's prompt into the held session and collect its reply. */
  async #sendTurnInSession(
    handle: ClaudeSessionHandle,
    fromIndex: number,
    observers: AttemptObservers
  ): Promise<TurnResult> {
    const delivery = await this.#controlPlane.steer(handle, this.#buildTurnMessage());
    if (!delivery.delivered) {
      throw new ClaudeValveError(`reply valve failed to inject the follow-up turn: ${delivery.reason}`);
    }

    await this.#awaitReceipt(handle, fromIndex);
    this.#turnDelivered = true;
    const transcript = await this.#runToCompletion(handle, fromIndex, observers);
    return this.#buildResult(handle, transcript, fromIndex);
  }

  /**
   * Session mode has no degraded path: the valve is what keeps a follow-up
   * (or a correction) inside the created session, so its absence fails the
   * turn loudly instead of silently substituting a fresh worker.
   */
  #requireValve(available: boolean): void {
    if (!available) {
      throw new ClaudeValveError(
        "multi-turn worker sessions require the tmux reply valve, which is unavailable"
      );
    }
  }

  async #correctInSession(
    handle: ClaudeSessionHandle,
    previousFailure: PreviousAttemptFailure,
    fromIndex: number,
    observers: AttemptObservers
  ): Promise<TurnResult> {
    const delivery = await this.#controlPlane.steer(handle, this.#correctionMessage(previousFailure));
    if (!delivery.delivered) {
      throw new ClaudeValveError(`reply valve failed to inject the correction: ${delivery.reason}`);
    }

    await this.#awaitReceipt(handle, fromIndex);
    const transcript = await this.#runToCompletion(handle, fromIndex, observers);
    return this.#buildResult(handle, transcript, fromIndex);
  }

  /** Confirm the steered worker received the message (started generating, or the transcript grew). */
  async #awaitReceipt(handle: ClaudeSessionHandle, mark: number): Promise<void> {
    const deadline = Date.now() + this.#receiptTimeoutMs;
    for (;;) {
      this.#assertOpen();
      const status = await this.#controlPlane.poll(handle);
      this.#assertOpen();
      if (status.status === "busy") {
        return;
      }
      const transcript = await this.#tryReadTranscript(handle);
      if (transcript !== null && transcript.entries.length > mark) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new ClaudeValveError(`steer not acknowledged within ${this.#receiptTimeoutMs}ms`);
      }
      await this.#pollDelay();
    }
  }

  /**
   * Poll until the worker's turn is complete, returning the transcript at that
   * point. The transcript is the authoritative completion signal and is
   * checked on **every** poll, before the roster state is interpreted: the
   * daemon's `state` is unreliable, and a live process the worker itself
   * spawned can hold the roster at `busy` long after the answer is on disk —
   * gating the transcript read on "not busy" left a finished, schema-valid
   * answer uncollected for 22+ minutes behind a worker-spawned child.
   *
   * Two ways out, and no silent third:
   * - the transcript proves the turn complete (`turnComplete`) → collect;
   * - the daemon stably reports the session settled while the transcript
   *   never satisfies `turnComplete` → after `SETTLED_CONFIRMATION_POLLS`,
   *   throw `ClaudeCollectionError` rather than spin for ever. Deliberately
   *   *not* a collect-on-best-evidence path: a settled daemon beside an
   *   unproven transcript is exactly what a killed worker's partial answer
   *   looks like, and promoting that to a success would hand downstream
   *   stages a truncated answer as if it were the real one. The partial text
   *   rides the failure (the shared catch attaches it), and the bounded
   *   retry re-asks.
   *
   * A turn that ends while a background task the session started is still
   * outstanding (`outstandingBackgroundTasks`) is an interim message, not
   * the answer: Claude Code backgrounds a long command or a Monitor, lets
   * the model end its turn, and re-invokes it when the task ends. The wait
   * continues for the reply that follows the wake, reported through
   * `onWaiting` and recorded on the result, and it is bounded by the call's
   * deadline — the daemon's idle roster is expected while the session waits
   * for its own notification, so the settled window does not count against
   * it; the session leaving the roster still ends the turn, as it ends any
   * turn. A task that never wakes the session times the attempt out under
   * the ordinary retry rule.
   *
   * `state: blocked` still drives bounded valve recovery, and a transient
   * roster-query failure reports `present: false` only after
   * `MAX_CONSECUTIVE_ABSENCES`, so a parking/respawning blip does not kill a
   * live worker.
   */
  async #runToCompletion(
    handle: ClaudeSessionHandle,
    fromIndex: number,
    observers: AttemptObservers
  ): Promise<TranscriptFile> {
    // No timeoutMs → no poll deadline; wait indefinitely for the worker to settle.
    const deadline = this.#options.timeoutMs === undefined ? Infinity : Date.now() + this.#options.timeoutMs;
    const firstLifeDeadline = Date.now() + this.#firstLifeTimeoutMs;
    // Corrections necessarily operate on an existing transcript. The guard is
    // only for a newly dispatched child that never starts writing one.
    let sawLife = fromIndex > 0;
    let nudges = 0;
    let absences = 0;
    let settledPolls = 0;
    let evidenceReported = false;
    let waitingOn: string | null = null;
    // Read from the transcript, and held across a poll whose read failed: a
    // transiently unreadable transcript must not turn a waiting session
    // into a settled-but-unproven one for the collection error to catch.
    let awaitingTask = false;

    for (;;) {
      this.#assertOpen();
      const transcript = await this.#tryReadTranscript(handle);
      if (transcript !== null) {
        sawLife = true;
        this.#reportUsage(handle, transcript.entries, fromIndex);
        // Evidence means output *the worker produced this turn*: only an
        // assistant entry beyond the high-water mark counts. The transcript's
        // first entry is routinely the persisted user prompt (and a steer
        // injects another), so counting any entry would certify output that
        // never happened. The callback is observability — a throw inside it
        // must never affect the turn.
        if (!evidenceReported && hasAssistantEntrySince(transcript.entries, fromIndex)) {
          evidenceReported = true;
          try {
            observers.onLiveEvidence?.();
          } catch {
            // Liveness reporting must never take the turn down with it.
          }
        }
        const outstanding = outstandingBackgroundTasks(transcript.entries, fromIndex);
        const current = this.#noteWaits(outstanding);
        awaitingTask = current !== null;
        if ((current?.taskId ?? null) !== waitingOn) {
          waitingOn = current?.taskId ?? null;
          try {
            observers.onWaiting?.(current);
          } catch {
            // Same contract as liveness: reporting never affects the turn.
          }
        }
        if (turnComplete(transcript.entries, fromIndex) && !awaitingTask) {
          return transcript;
        }
      }
      if (!sawLife && Date.now() >= firstLifeDeadline) {
        throw new ClaudeFirstLifeTimeoutError(
          `Claude worker showed no sign of life within ${this.#firstLifeTimeoutMs}ms (no transcript appeared)`
        );
      }

      const status = await this.#controlPlane.poll(handle);
      this.#assertOpen();

      if (!status.present) {
        absences += 1;
        if (absences >= MAX_CONSECUTIVE_ABSENCES) {
          throw new ClaudePollTimeoutError("worker left the roster before completing");
        }
        await this.#pollDelay();
        continue;
      }
      absences = 0;

      if (status.state === "blocked") {
        const canNudge = nudges < this.#blockedRecoveryBound && (await this.#controlPlane.tmuxAvailable());
        if (!canNudge) {
          throw new ClaudeBlockedError("worker blocked awaiting input beyond the recovery bound");
        }
        nudges += 1;
        // Re-read at nudge time: entries written between the loop-top read
        // and the blocked observation would otherwise satisfy the receipt's
        // growth test immediately, acknowledging a nudge never received.
        const mark = (await this.#tryReadTranscript(handle))?.entries.length ?? fromIndex;
        const delivery = await this.#controlPlane.steer(handle, this.#blockedNudge(status.waitingFor));
        if (!delivery.delivered) {
          throw new ClaudeValveError(`reply valve failed to inject the blocked-worker nudge: ${delivery.reason}`);
        }
        await this.#awaitReceipt(handle, mark);
        continue;
      }

      // Settled means the daemon itself says generation is over ("idle", or a
      // `state` of done); a failed roster query ("unknown") and an active
      // "busy" both reset the window rather than feed it. A worker with no
      // transcript at all is the first-life guard's diagnosis, not this
      // one's — collection presumes there is something to collect from.
      if (sawLife && !awaitingTask && (status.state === "done" || status.status === "idle")) {
        settledPolls += 1;
        if (settledPolls >= SETTLED_CONFIRMATION_POLLS) {
          throw new ClaudeCollectionError(
            "session settled but its transcript never proved the turn complete"
          );
        }
      } else {
        settledPolls = 0;
      }

      if (Date.now() >= deadline) {
        throw new ClaudePollTimeoutError(`worker did not complete within ${this.#options.timeoutMs}ms`);
      }
      await this.#pollDelay();
    }
  }

  /**
   * Reconciles the attempt's wait ledger with the tasks currently
   * outstanding: a newly observed task opens a wait, a task no longer
   * outstanding closes its wait. Returns what the worker is waiting on now
   * (the earliest still-open wait), or null.
   */
  #noteWaits(outstanding: readonly { id: string; description: string }[]): AgentWaitSnapshot | null {
    const now = new Date();
    const open = new Set(outstanding.map((task) => task.id));
    for (const wait of this.#waits) {
      if (wait.endedAt === null && !open.has(wait.taskId)) {
        wait.endedAt = now.toISOString();
      }
    }
    for (const task of outstanding) {
      if (!this.#waits.some((wait) => wait.taskId === task.id && wait.endedAt === null)) {
        this.#waits.push({ taskId: task.id, description: task.description, observedAt: now.toISOString(), endedAt: null });
      }
    }
    const current = this.#waits.find((wait) => wait.endedAt === null);
    return current === undefined
      ? null
      : { kind: "background-task", taskId: current.taskId, description: current.description, sinceMs: Date.parse(current.observedAt) };
  }

  /** A poll gap that ends early — by rejecting — the moment close() aborts. */
  #pollDelay(): Promise<void> {
    return delay(this.#pollIntervalMs, this.#abortController.signal, () => new EngineShutdownError("claude"));
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new EngineShutdownError("claude");
    }
  }

  #buildResult(handle: ClaudeSessionHandle, transcript: TranscriptFile, fromIndex: number): TurnResult {
    const entries = transcript.entries;
    const text = finalAssistantText(entries, fromIndex) ?? "";
    if (endsInSyntheticReply(entries, fromIndex)) {
      // Claude Code answered in place of a model (an unknown model id, a
      // rejected request): the transcript satisfies `turnComplete`, but the
      // text is the client's diagnostic. Collecting it would archive the
      // error string as the worker's output under a placeholder model —
      // this is a failed turn, and the diagnostic is its cause.
      throw new ClaudeWorkerDiagnosticError(
        text.length > 0 ? text : "the session produced no model reply"
      );
    }
    const resolvedModel = resolvedModelSince(entries, fromIndex);
    // Served effort as the CLI's own transcript reports it, beside the
    // served model — evidence, never the dispatched flag, so a clamped or
    // silently defaulted dispatch is visible in the record as what ran.
    const resolvedEffort = effortSince(entries, fromIndex);
    const usage = usageSince(entries, fromIndex);
    this.#reportUsage(handle, entries, fromIndex);
    const usageEvent = this.#usageEvent(handle, usage, usage);
    return {
      text,
      ...(resolvedModel !== null ? { resolvedModel } : {}),
      ...(resolvedEffort !== null ? { resolvedEffort } : {}),
      ...(this.#waits.length > 0 ? { backgroundWaits: this.#waits.map((wait) => ({ ...wait })) } : {}),
      deltaText: text,
      durationMs: null,
      firstDeltaMs: null,
      items: {},
      tokenUsageEvents: usageEvent === null ? [] : [usageEvent],
      transcripts: [
        {
          filename: "transcript.claude.jsonl",
          format: "jsonl",
          source: "claude-session-jsonl",
          sessionId: handle.sessionId,
          content: transcript.text
        }
      ]
    };
  }

  async #readTranscript(handle: ClaudeSessionHandle): Promise<TranscriptFile> {
    const path = await this.#controlPlane.transcriptPath(handle);
    if (path === null) {
      throw new ClaudeTranscriptError(`no transcript found for session ${handle.sessionId}`);
    }
    return readTranscriptFile(path);
  }

  /** Like #readTranscript, but a not-yet-present transcript is `null` (still working), not an error. */
  async #tryReadTranscript(handle: ClaudeSessionHandle): Promise<TranscriptFile | null> {
    try {
      return await this.#readTranscript(handle);
    } catch (error) {
      if (error instanceof ClaudeTranscriptError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Everything a dying turn can still learn from the transcript the engine
   * already has, in one read: the served model, the usage accumulated up to
   * the failure, and the transcript itself. Best-effort — an unreadable or
   * absent transcript is `null`, and nothing here polls or retries.
   */
  async #tryFailureEvidence(fromIndex: number): Promise<FailureEvidence | null> {
    const handle = this.#handle;
    if (handle === null) {
      return null;
    }
    const transcript = await this.#tryReadTranscript(handle);
    if (transcript === null) {
      return null;
    }
    return {
      handle,
      transcript,
      resolvedModel: resolvedModelSince(transcript.entries, fromIndex),
      resolvedEffort: effortSince(transcript.entries, fromIndex),
      usage: usageSince(transcript.entries, fromIndex),
      apiError: apiErrorSince(transcript.entries, fromIndex),
      backgroundWaits: this.#waits.map((wait) => ({ ...wait }))
    };
  }

  /** The failed turn's spend, as the same event shape the success path emits. */
  #failureUsageEvent(evidence: FailureEvidence | null): TokenUsageEvent | null {
    if (evidence === null) {
      return null;
    }
    return this.#usageEvent(evidence.handle, evidence.usage, evidence.usage);
  }

  #attachWorkerText(error: Error, evidence: FailureEvidence, fromIndex: number): void {
    const transcript = evidence.transcript;
    if (endsInSyntheticReply(transcript.entries, fromIndex)) {
      // Claude Code composed the last reply itself, so the text on the
      // transcript is its diagnostic and not the worker's. It reaches the
      // record as the failure's message; carrying it here as well would put
      // an error string in the slot a consumer reads as model output.
      return;
    }
    const text = finalAssistantText(transcript.entries, fromIndex);
    if (text !== null) {
      attachPartialWorkerText(error, text);
    }
  }

  /**
   * Feed transcript-derived usage through the same event shape Codex emits.
   * The adapter registration labels it as Claude before the runtime records
   * it, so budget accounting never has to infer engine from the payload.
   *
   * `usageSince` counts each API call once and sums every figure across the
   * turn's calls, so the derived total only grows as the transcript grows;
   * the delta reported here is the plain difference from the last report,
   * and the archived event's `total` is the same figure the agent record's
   * usage summarises — budget and archive read one arithmetic.
   */
  #reportUsage(handle: ClaudeSessionHandle, entries: TranscriptEntry[], fromIndex: number): void {
    const total = usageSince(entries, fromIndex);
    const last = subtractUsage(total, this.#reportedUsage);
    if (last.totalTokens === 0) {
      return;
    }
    this.#reportedUsage = total;
    const event = this.#usageEvent(handle, last, total);
    if (event === null) {
      return;
    }
    this.#onEvent?.({
      method: "thread/tokenUsage/updated",
      params: event.raw,
      receivedAt: Date.now()
    });
  }

  #usageEvent(
    handle: ClaudeSessionHandle,
    last: TokenUsageBreakdown,
    total: TokenUsageBreakdown
  ): TokenUsageEvent | null {
    if (total.totalTokens === 0) {
      return null;
    }
    this.#budgetEventCounter += 1;
    const event = {
      threadId: handle.sessionId,
      turnId: `${handle.sessionId}:claude-${this.#budgetEventCounter}`,
      last,
      total,
      raw: {
        threadId: handle.sessionId,
        turnId: `${handle.sessionId}:claude-${this.#budgetEventCounter}`,
        tokenUsage: { last, total }
      }
    };
    return event;
  }

  async #teardown(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    if (handle === null) {
      return;
    }
    try {
      await this.#controlPlane.stop(handle);
    } catch {
      // Teardown is best-effort; never let it mask the turn's real outcome.
    }
  }

  #buildDispatchPrompt(previousFailure: PreviousAttemptFailure | undefined): string {
    const lines: string[] = [
      "You are an automated worker dispatched by the Ensemble orchestration harness.",
      "Work fully autonomously: never ask for confirmation or permission, and do not pause to ask questions — make a reasonable decision and finish the task."
    ];
    if (this.#turnSchema !== undefined) {
      lines.push(
        "When finished, include in your FINAL message a JSON value that conforms to this JSON Schema. You may surround the value with prose, explanation, or markdown code fences:",
        JSON.stringify(this.#turnSchema)
      );
    }
    if (previousFailure !== undefined) {
      lines.push(`A previous attempt failed (${previousFailure.kind}): ${previousFailure.message}. Correct it this time.`);
    }
    lines.push("", "Task:", this.#turnPrompt);
    return lines.join("\n");
  }

  /**
   * A follow-up turn's valve message: the session already holds the
   * autonomy preamble from its dispatch, so the message carries only what
   * this turn adds — its schema contract, when it has one, and its task.
   */
  #buildTurnMessage(): string {
    const lines: string[] = [];
    if (this.#turnSchema !== undefined) {
      lines.push(
        "For this reply, include in your FINAL message a JSON value that conforms to this JSON Schema. You may surround the value with prose, explanation, or markdown code fences:",
        JSON.stringify(this.#turnSchema),
        ""
      );
    }
    lines.push(this.#turnPrompt);
    return lines.join("\n");
  }

  #correctionMessage(previousFailure: PreviousAttemptFailure): string {
    switch (previousFailure.kind) {
      case "schema-validation":
        return (
          `Your final JSON did not satisfy the required schema. Validation errors: ${previousFailure.message}. ` +
          "Reply with a corrected JSON value that conforms to the schema. You may surround the value with prose or markdown fences."
        );
      case "invalid-json":
        return (
          "Your last final message was not valid JSON for the required schema. " +
          "Reply with a JSON value that conforms to the schema. You may surround the value with prose or markdown fences."
        );
      case "empty-output":
        return "Your last turn produced no final answer. Please complete the task and output your final answer now.";
      default:
        // An operational or thrown failure carried into the correction (the
        // one retry rule): the worker is told what the harness observed, as
        // a fresh dispatch's prompt would tell it.
        return (
          `Your last turn did not complete (${previousFailure.kind}: ${previousFailure.message}). ` +
          "Please complete the task and output your final answer now."
        );
    }
  }

  #blockedNudge(waitingFor: string | undefined): string {
    const context = waitingFor !== undefined ? ` (waiting for: ${waitingFor})` : "";
    return (
      `You appear to be waiting for input${context}. ` +
      "Proceed autonomously without asking — make a reasonable decision, complete the task, and output your final answer."
    );
  }

  #nextName(): string {
    dispatchCounter += 1;
    return `${this.#namePrefix}-${dispatchCounter}-${randomUUID().slice(0, 8)}`;
  }
}

/**
 * A failed turn carries the evidence the engine already held when it died:
 * the served model and effort, the spend the transcript proves, and the
 * transcript itself. All of it rides fields `TurnResult` already has — a
 * failure that published nothing would make the durable record contradict
 * the live run, which is the one place a budget or audit consumer reads.
 */
function failedTurnResult(
  error: ClaudeWorkerError,
  evidence: FailureEvidence | null,
  usageEvent: TokenUsageEvent | null
): EngineAttemptResult {
  const text = partialWorkerTextOf(error) ?? "";
  const resolvedModel = evidence?.resolvedModel ?? null;
  const resolvedEffort = evidence?.resolvedEffort ?? null;
  const backgroundWaits = evidence?.backgroundWaits ?? [];
  return {
    text,
    ...(resolvedModel !== null ? { resolvedModel } : {}),
    ...(resolvedEffort !== null ? { resolvedEffort } : {}),
    ...(backgroundWaits.length > 0 ? { backgroundWaits } : {}),
    attemptFailure: claudeAttemptFailure(error),
    deltaText: text,
    durationMs: null,
    firstDeltaMs: null,
    items: {},
    tokenUsageEvents: usageEvent === null ? [] : [usageEvent],
    // The refusal's structured account rides the attempt as diagnostics,
    // where the failure classifier reads it: a 429's status and code are
    // the engine's own word, which the diagnostic prose is not.
    ...(evidence !== null && evidence.apiError !== null ? { diagnostics: { apiError: evidence.apiError } } : {}),
    ...(evidence === null
      ? {}
      : {
          transcripts: [
            {
              filename: "transcript.claude.jsonl",
              format: "jsonl" as const,
              source: "claude-session-jsonl",
              sessionId: evidence.handle.sessionId,
              content: evidence.transcript.text,
              partial: true
            }
          ]
        })
  };
}

/** What one best-effort pre-teardown transcript read yields a dying turn. */
interface FailureEvidence {
  handle: ClaudeSessionHandle;
  transcript: TranscriptFile;
  resolvedModel: string | null;
  resolvedEffort: string | null;
  usage: TokenUsageBreakdown;
  /** The API refusal the synthetic reply annotated, when it did; evidence for classifying the failure. */
  apiError: TranscriptApiError | null;
  /** The background tasks the dying attempt waited on — an open wait names the task that never woke it. */
  backgroundWaits: BackgroundTaskWait[];
}

/** The per-attempt observers the runtime hands an attempt (`EngineAttemptContext`'s callbacks). */
type AttemptObservers = Pick<EngineAttemptContext, "onLiveEvidence" | "onWaiting">;


function claudeAttemptFailure(error: ClaudeWorkerError): EngineAttemptFailure {
  if (error instanceof ClaudeFirstLifeTimeoutError) {
    return { kind: "claude-first-life-timeout", message: error.message };
  }
  if (error instanceof ClaudeRegistrationTimeoutError) {
    return { kind: "claude-registration-timeout", message: error.message };
  }
  if (error instanceof ClaudeBlockedError) {
    return { kind: "claude-blocked", message: error.message };
  }
  if (error instanceof ClaudeValveError) {
    return { kind: "claude-valve-error", message: error.message };
  }
  if (error instanceof ClaudePollTimeoutError) {
    return { kind: "claude-poll-timeout", message: error.message };
  }
  if (error instanceof ClaudeTranscriptError) {
    return { kind: "claude-transcript-error", message: error.message };
  }
  if (error instanceof ClaudeCollectionError) {
    return { kind: "claude-collection-error", message: error.message };
  }
  if (error instanceof ClaudeWorkerDiagnosticError) {
    return { kind: "claude-worker-diagnostic", message: error.message };
  }
  // No concrete member reaches here today — a refused dispatch is
  // `ClaudeDispatchError`, on the pre-spawn side, rethrown rather than
  // degraded. The arm keeps the mapping total for a member added without
  // its own kind, and its `rule: null` classification says so in the archive.
  return { kind: "claude-worker-error", message: error.message };
}

function hasAssistantEntrySince(entries: TranscriptEntry[], fromIndex: number): boolean {
  for (let index = Math.max(0, fromIndex); index < entries.length; index += 1) {
    if (entries[index]?.type === "assistant") {
      return true;
    }
  }
  return false;
}

function delay(ms: number, signal: AbortSignal, abortError: () => Error): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(abortError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
