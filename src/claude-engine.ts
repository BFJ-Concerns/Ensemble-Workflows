import { createHash, randomUUID } from "node:crypto";

import {
  CapabilityStripUnsupportedError,
  ClaudeBlockedError,
  InvalidAgentOptionValueError,
  ClaudeCollectionError,
  ClaudeDeliveryError,
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
  enteredWorktrees,
  endsInSyntheticReply,
  finalAssistantText,
  outstandingBackgroundTasks,
  parseTranscriptText,
  readTranscriptFile,
  resolvedModelSince,
  submissionReceipt,
  turnComplete,
  usageSince
} from "./claude-transcript.js";
import { isPreparedClaudeStrip } from "./claude-tool-surface.js";
import { subtractUsage } from "./usage-summary.js";
import { CANONICAL_EFFORT_DOMAIN } from "./engine-option-validation.js";
import { CLAUDE_ROSTER_ABSENCE_BOUND, CLAUDE_ROSTER_LOSS_REASON } from "./claude-control-plane.js";

import type { CanonicalEffort } from "./engine-option-validation.js";
import type { ClaudeControlPlane, ClaudeDispatchOptions, ClaudeSessionHandle } from "./claude-control-plane.js";
import type { SubmissionReceipt, TranscriptApiError, TranscriptEntry, TranscriptFile } from "./claude-transcript.js";
import type {
  EngineAttemptContext,
  EngineAttemptFailure,
  PreviousAttemptFailure,
  EngineAttemptResult,
  EngineInvocation,
  EngineSessionTurn,
  EngineSessionObserver,
  EngineSessionLoss,
  EngineTurnOptions,
  EngineWorkerSession
} from "./engines.js";
import type {
  BackgroundTaskWaitSnapshot,
  BackgroundTaskWait, JsonSchema, RuntimeEvent, TokenUsageBreakdown, TokenUsageEvent, TurnResult } from "./types.js";

/**
 * The strip settings a dispatch applies: none unstripped, otherwise exactly
 * the prepared strip's deny rules and removal variables. A stripped dispatch
 * with no Claude preparation for this strip refuses before spawn rather than
 * guess at the tool surface.
 */
export function stripSettingsFor(
  options: Pick<EngineTurnOptions, "strip" | "preparedStrip">
): Pick<ClaudeDispatchOptions, "permissionDenyRules" | "settingsEnv"> {
  const strip = options.strip ?? [];
  if (strip.length === 0) return {};
  const prepared = options.preparedStrip;
  const covered = isPreparedClaudeStrip(prepared) && strip.every((capability) => prepared.requested.includes(capability));
  if (!covered) {
    throw new CapabilityStripUnsupportedError("claude", strip.join(", "), "no live tool-surface preparation reached this dispatch");
  }
  return {
    permissionDenyRules: prepared.permissionDenyRules,
    ...(Object.keys(prepared.settingsEnv).length > 0 ? { settingsEnv: prepared.settingsEnv } : {})
  };
}

/**
 * Tunables for the Claude worker lifecycle. All have defaults; tests inject tiny
 * intervals (and a fake control plane) to stay deterministic and fast.
 */
export interface ClaudeEngineConfig {
  /** Gap between roster polls while waiting for a worker to finish. */
  pollIntervalMs?: number;
  /** How long a submitted message's receipt may stay missing from the transcript before the delivery fails. */
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
   */
  multiTurn?: boolean;
  sessionObserver?: EngineSessionObserver;
  onEvent?: (event: RuntimeEvent) => void;
  /** Invalidate prepared surfaces when native evidence reports a different served CLI. */
  onVersion?: (version: string) => void;
  config?: ClaudeEngineConfig;
  /** Adapter deregistration: called exactly once, when close() completes. */
  onClose?: (invocation: ClaudeEngineInvocation) => void;
}

/**
 * The clamp from the canonical effort vocabulary to the Claude CLI's
 * native levels (effort is one canonical vocabulary, converted per engine,
 * clamping to the nearest level the engine offers). The native domain —
 * `low | medium | high | xhigh | max` — is a dated measured judgement
 * against Claude Code 2.1.283 (its `--effort` help and the `effort` values
 * its transcripts report serving, 2026-09-27); `max` is native but outside
 * the canonical set, so nothing maps to it, and `minimal` is the one
 * canonical level the CLI lacks. The CLI silently
 * accepts an unknown `--effort` value and runs at its default (witnessed
 * 2026-08-30: `--effort definitely-invalid` reached a healthy worker at
 * exit 0), so conversion is the only loud boundary: nothing non-native may
 * reach the CLI. What the run record reports as `resolved_effort` is not
 * this table's output but the level the CLI's transcript says it served
 * (`effortSince`), so a clamp — or a stale row here, served at a coarser
 * level — is visible in the record as what ran, never a silent drop. If a
 * CLI release grows a native level, re-point that canonical level at
 * itself here.
 */
export const CLAUDE_NATIVE_EFFORT: Readonly<Record<CanonicalEffort, string>> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh"
};

/**
 * Converts a canonical effort level to the value the Claude CLI is
 * dispatched with. Rejects anything outside the canonical vocabulary with
 * the same pre-spawn error the harness-side validation throws, so the
 * adapter stays a loud boundary even for a caller that bypassed it.
 */
export function claudeNativeEffort(effort: string | undefined): string | undefined {
  if (effort === undefined) {
    return undefined;
  }
  const native = (CLAUDE_NATIVE_EFFORT as Record<string, string | undefined>)[effort];
  if (native === undefined) {
    throw new InvalidAgentOptionValueError(
      "effort",
      effort,
      `one of ${CANONICAL_EFFORT_DOMAIN.join(" | ")} (the canonical effort vocabulary)`
    );
  }
  return native;
}

let dispatchCounter = 0;

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
 * How far the current turn's prompt has got into the session.
 *
 * - `unsent` — no submission of it has been accepted. The next attempt
 *   sends the prompt itself; after a valve refusal that is still true.
 * - `accepted` — a submission of it was accepted and no receipt has
 *   verified it. The session may hold an altered copy, or none. The next
 *   attempt sends the redelivery, which says it replaces an earlier copy;
 *   the bare prompt is never sent twice.
 * - `verified` — a receipt showed the session holding the prompt exactly as
 *   sent. A retry is a correction.
 */
type TurnDelivery = "unsent" | "accepted" | "verified";

/**
 * One message submitted to a session, with what the engine must know to
 * judge and account for it. Two things submit: the launch, which carries a
 * new session's opening prompt (`ClaudeControlPlane.dispatch`), and the
 * valve, which carries every later message (`steer`).
 */
interface Submission {
  message: string;
  /** The transcript's length before the submission: where its receipt is read from. 0 for an opening. */
  mark: number;
  /** What the message is, for the failure account: "the opening prompt", "the follow-up turn", "the correction". */
  what: string;
  /** Whether the message carries the turn's prompt, so that its receipt moves `TurnDelivery`. */
  carriesTurn: boolean;
}

/**
 * A submission the session accepted whose receipt has not verified. While
 * one is pending nothing else is sent into the session: it is accounted for
 * first (`#accountForPending`).
 */
interface PendingSubmission extends Submission {
  /**
   * Whether the reply to this submission would answer the turn in progress.
   * False once a later turn has begun: its reply then answers no `send()`.
   */
  answersTurn: boolean;
}

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
 * - **Every message is a submission and a receipt**: the launch attests only
 *   that it submitted the opening prompt, the valve only that it submitted a
 *   later message (`#deliver`), and either is delivered when the transcript
 *   shows the session holding it exactly (`#requireReceipt`). A receipt that
 *   differs or is missing fails the attempt as `claude-delivery-error` under
 *   the ordinary retry rule, and never as a launch that failed: the session
 *   took something, so the call stays on its target instead of moving down
 *   its fallback chain. A one-shot call's failure stops its session before
 *   the retry launches another. In a held session the retry never sends on top
 *   of the failed submission: a turn the session took on altered text is
 *   followed to its end first, a missing receipt is read again before
 *   anything else is sent, and a turn prompt that was accepted without a
 *   verified receipt is sent again only as a redelivery that says it
 *   replaces the earlier copy.
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
  /** Cumulative native usage already covered by settled attempts in each session. */
  #settledUsage = new Map<string, TokenUsageBreakdown>();
  #usageAtSettlement: { sessionId: string; total: TokenUsageBreakdown } | null = null;
  /** The background tasks this attempt's turn waited on, in the order observed; reset per attempt. */
  #waits: BackgroundTaskWait[] = [];
  /**
   * Blocked-worker nudges sent this attempt; reset per attempt. One count
   * for the attempt, however many turns it follows, so recovery stays
   * bounded when a nudge's own delivery fails and its turn is followed.
   */
  #nudges = 0;

  #multiTurn: boolean;
  #sessionObserver: EngineSessionObserver | undefined;
  #lost: EngineSessionLoss | null = null;
  #lossController = new AbortController();
  /** The current turn's prompt: the constructor's for a one-shot call, `beginTurn`'s thereafter. */
  #turnPrompt: string;
  /** The current turn's schema — the one thing a session varies per turn. */
  #turnSchema: JsonSchema | undefined;
  /** How far the current turn's prompt has got into the session; it decides what a retry sends. */
  #turn: TurnDelivery = "unsent";
  /**
   * The turn's prompt as the session first accepted it: the opening prompt
   * its launch carried, preamble included, or the turn message the valve
   * carried. A redelivery repeats this copy. Read only while `#turn` is
   * `accepted`.
   */
  #acceptedTurnCopy = "";
  /** The submission the session accepted whose receipt has not verified, if any. Outlives the turn that made it. */
  #pending: PendingSubmission | null = null;
  /** A message the valve refused before submission; the next attempt sends this exact copy. */
  #refused: Submission | null = null;
  /** A differing receipt survives nudges until a fresh answer is requested. */
  #deliveryFailure: ClaudeDeliveryError | null = null;
  /** Start of the current answer's work; recovery-nudge receipts never move it. */
  #collectionMark = 0;

  #pollIntervalMs: number;
  #receiptTimeoutMs: number;
  #firstLifeTimeoutMs: number;
  #blockedRecoveryBound: number;
  #namePrefix: string;

  #handle: ClaudeSessionHandle | null = null;
  #resolvedModel: string | null = null;
  #resolvedEffort: string | null = null;
  #budgetEventCounter = 0;
  #abortController = new AbortController();
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #settlement: Promise<EngineAttemptResult> | null = null;
  #onClose: ((invocation: ClaudeEngineInvocation) => void) | undefined;
  #onVersion: ((version: string) => void) | undefined;
  #reportedVersion: string | null = null;

  constructor(options: ClaudeEngineInvocationOptions) {
    this.#turnPrompt = options.prompt;
    this.#turnSchema = options.options.schema;
    this.#multiTurn = options.multiTurn ?? false;
    this.#sessionObserver = options.sessionObserver;
    this.#cwd = options.cwd;
    this.#options = options.options;
    this.#controlPlane = options.controlPlane;
    this.#onEvent = options.onEvent;
    this.#onClose = options.onClose;
    this.#onVersion = options.onVersion;

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
    this.#turn = "unsent";
    this.#deliveryFailure = null;
    this.#refused = null;
    if (this.#pending !== null) {
      // The turn that made it has settled without it: whatever reply it
      // still draws answers nothing the script is waiting on.
      this.#pending = { ...this.#pending, answersTurn: false };
    }
    return {
      runAttempt: (context) => this.runAttempt(context)
    };
  }

  runAttempt(context: EngineAttemptContext): Promise<EngineAttemptResult> {
    // close() must be able to await a live attempt so cancellation is not
    // "torn down under a caller still running": track the settlement.
    const settlement = this.#runAttempt(context).then((result) => this.#withObservedIdentity(result));
    this.#settlement = settlement;
    return settlement.finally(() => {
      if (this.#usageAtSettlement !== null) {
        this.#settledUsage.set(this.#usageAtSettlement.sessionId, this.#usageAtSettlement.total);
        this.#usageAtSettlement = null;
      }
      if (this.#settlement === settlement) {
        this.#settlement = null;
      }
    });
  }

  #withObservedIdentity(result: EngineAttemptResult): EngineAttemptResult {
    return {
      ...result,
      ...(result.resolvedModel === undefined && this.#resolvedModel !== null ? { resolvedModel: this.#resolvedModel } : {}),
      ...(result.resolvedEffort === undefined && this.#resolvedEffort !== null ? { resolvedEffort: this.#resolvedEffort } : {})
    };
  }

  async #runAttempt(context: EngineAttemptContext): Promise<EngineAttemptResult> {
    this.#assertOpen();
    if (this.#lost !== null) return this.#lostResult();
    this.#reportedUsage = null;
    this.#usageAtSettlement = null;
    this.#waits = [];
    this.#nudges = 0;
    let fromIndex = 0;
    try {
      if (this.#multiTurn && this.#handle !== null && this.#pending === null) {
        // A send can beat the watch to a disappearance. Confirm the same
        // three successful absences before touching the valve or transcript.
        for (let misses = 0; misses < CLAUDE_ROSTER_ABSENCE_BOUND; misses++) {
          const status = await this.#controlPlane.poll(this.#handle);
          this.#assertOpen();
          if (this.#lost !== null) return this.#lostResult();
          if (status.present) break;
          if (misses === CLAUDE_ROSTER_ABSENCE_BOUND - 1) {
            this.#noteLost({ nativeSession: this.#handle.sessionId,
              reason: CLAUDE_ROSTER_LOSS_REASON, observedAt: Date.now() });
            return this.#lostResult();
          }
          await this.#pollDelay();
        }
      }
      const previousFailure = context.previousFailure;

      if (this.#refused !== null && this.#handle !== null) {
        const handle = this.#handle;
        const pending = this.#pending;
        // A refusal can span native input cancellation. Judge the retry's
        // receipt after those rows while retaining the task's earlier work.
        const latest = await this.#readTranscript(handle, context);
        const submission = { ...this.#refused, mark: latest.entries.length };
        fromIndex = submission.carriesTurn ? submission.mark : this.#collectionMark;
        // A turn can settle while the valve is refusing its recovery nudge.
        // Collect that answer or diagnostic before attempting more input.
        const settled = !submission.carriesTurn && (endsInSyntheticReply(latest.entries, fromIndex) ||
          (turnComplete(latest.entries, fromIndex) && outstandingBackgroundTasks(latest.entries, fromIndex).length === 0));
        if (settled) this.#refused = null;
        else await this.#deliver(handle, submission, context);
        if (pending !== null) {
          // The nudge's receipt says nothing about the submission whose work
          // it resumed, particularly one belonging to an earlier held turn.
          this.#pending = pending;
          const answered = await this.#accountForPending(handle, pending, context);
          if (answered !== null) return answered;
        } else {
          const transcript = await this.#runToCompletion(handle, fromIndex, context);
          if (this.#deliveryFailure !== null) throw this.#deliveryFailure;
          if (this.#turn === "verified") return this.#buildResult(handle, transcript, fromIndex);
        }
      }

      const held = this.#multiTurn ? this.#handle : null;
      if (held !== null) {
        const pending = this.#pending;
        if (pending !== null) {
          // An earlier submission is still unaccounted for, and nothing is
          // sent on top of it. Keep the answer's collection window while
          // judging the receipt, including work started before a nudge.
          fromIndex = this.#collectionMark;
          const answered = await this.#accountForPending(held, pending, context);
          if (answered !== null) {
            return answered;
          }
        }
        if (this.#turn !== "verified") {
          // The session does not hold this turn's prompt, so the prompt
          // itself rides the valve: a correction would ask the worker to
          // fix an answer to a question it was never asked. The high-water
          // mark is read first so a failure past this point attaches only
          // *this* turn's text, never the previous turn's.
          fromIndex = (await this.#readTranscript(held, context)).entries.length;
          this.#requireValve(await this.#controlPlane.tmuxAvailable());
          return await this.#sendTurnInSession(held, fromIndex, context);
        }
      }

      const correcting = previousFailure !== undefined && this.#handle !== null;
      if (correcting && (await this.#controlPlane.tmuxAvailable())) {
        const handle = this.#handle as ClaudeSessionHandle;
        fromIndex = (await this.#readTranscript(handle, context)).entries.length;
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
      if (error instanceof Error && this.#handle?.launchFailure !== undefined) {
        attachFailedTurnResult(error, {
          text: "", deltaText: "", durationMs: null, firstDeltaMs: null, items: {}, tokenUsageEvents: [],
          diagnostics: this.#handle.launchFailure.diagnostics
        });
      }
      const preparedInterruption = error instanceof EngineShutdownError && failedTurnResultOf(error) !== null;
      const evidence = error instanceof Error && !preparedInterruption ? await this.#tryFailureEvidence(fromIndex, error) : null;
      if (error instanceof Error && evidence !== null) {
        this.#attachWorkerText(error, evidence, fromIndex);
      }
      if (this.#lost !== null && !(error instanceof EngineShutdownError)) {
        return this.#lostResult(evidence, fromIndex);
      }
      if (error instanceof EngineShutdownError && evidence !== null) {
        // Interruption remains a rejection — it must neither settle as an
        // operational failure nor enter the retry loop — but its record must
        // retain the same fields an already-built failed result would carry.
        attachFailedTurnResult(error, this.#withObservedIdentity(failedTurnResult(error, evidence, this.#failureUsageEvent(evidence))));
      }
      if (error instanceof ClaudeWorkerError) {
        // Preserve the operational cause and current-turn text on the failed
        // result while retaining the shared loop's bounded retry governance.
        // A served model or effort the transcript already named is evidence
        // too, and so is the usage it recorded: a result-less failure must
        // not un-learn spend the run has already paid for (failures carry
        // their evidence).
        // A refused message can retry unchanged while its session and valve
        // remain available.
        // Other one-shot operational failures end their session. Held-session
        // teardown belongs to close(): redispatch would lose continuity.
        if (!this.#multiTurn) {
          const keepSession = error instanceof ClaudeValveError && this.#refused !== null && this.#handle !== null &&
            (await this.#controlPlane.poll(this.#handle)).present && await this.#controlPlane.tmuxAvailable();
          if (!keepSession) await this.#teardown();
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
        // Dispatch owns a worker before it returns its handle. Keep the
        // invocation registered, and its shared scopes open, until that
        // attempt has observed cancellation and reclaimed the worker.
        await this.#settlement?.catch(() => undefined);
        await this.#teardown();
      } finally {
        this.#onClose?.(this);
      }
    })();
    await this.#closePromise;
  }

  #noteLost(loss: EngineSessionLoss): void {
    if (!this.#multiTurn || this.#closed || this.#lost !== null) return;
    this.#lost = loss;
    this.#lossController.abort();
    try { this.#sessionObserver?.onLost(loss); }
    catch { /* Observability cannot fail a turn or stop the roster watch. */ }
  }

  #lostResult(evidence: FailureEvidence | null = null, fromIndex = 0): EngineAttemptResult {
    const message = this.#lost?.reason ?? "the held Claude worker is gone";
    const error = new ClaudePollTimeoutError(message);
    if (evidence !== null) this.#attachWorkerText(error, evidence, fromIndex);
    return {
      ...failedTurnResult(error, evidence, this.#failureUsageEvent(evidence)),
      attemptFailure: { kind: "session-lost", message }
    };
  }

  async #dispatchAndCollect(
    previousFailure: PreviousAttemptFailure | undefined,
    observers: AttemptObservers
  ): Promise<TurnResult> {
    this.#resolvedModel = null;
    this.#resolvedEffort = null;
    try { observers.onIdentity?.({ resolvedModel: null, resolvedEffort: null }); }
    catch { /* Observability cannot fail dispatch. */ }
    const stripSettings = stripSettingsFor(this.#options);
    const prompt = this.#buildDispatchPrompt(previousFailure);
    // A rejection here is the launch's word that no session holds the
    // prompt, which is what lets the same prompt go to this target again or
    // to the next entry of the call's fallback chain.
    const handle = await this.#controlPlane.dispatch({
      prompt,
      name: this.#nextName(),
      cwd: this.#cwd,
      ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
      ...(this.#options.effort !== undefined ? { effort: this.#options.effort } : {}),
      ...(this.#multiTurn ? { keepAlive: true, onLost: (loss: EngineSessionLoss) => this.#noteLost(loss) } : {}),
      ...stripSettings,
      ...(this.#options.lean === true ? { lean: true } : {})
    });
    this.#handle = handle;
    // The launch submitted the opening prompt, and like the valve it attests
    // no more than that. From here every failure is this session's own.
    const opening: Submission = { message: prompt, mark: 0, what: "the opening prompt", carriesTurn: true };
    this.#accept(opening);
    if (this.#closed) {
      // close() is waiting for this in-flight dispatch to settle. The new
      // session is ours to stop before releasing that wait, but first take
      // the one best-effort evidence read while its
      // transcript is still reachable. The prepared result marks this error
      // as already read, so #runAttempt's catch will not race a second read
      // against teardown.
      const error = new EngineShutdownError("claude");
      const evidence = await this.#tryFailureEvidence(0);
      if (evidence !== null) {
        this.#attachWorkerText(error, evidence, 0);
      }
      attachFailedTurnResult(error, this.#withObservedIdentity(failedTurnResult(error, evidence, this.#failureUsageEvent(evidence))));
      await this.#teardown();
      throw error;
    }

    const transcript = await this.#runToCompletion(handle, 0, observers, opening);
    return this.#buildResult(handle, transcript, 0);
  }

  /**
   * Put the turn's prompt into the held session and collect its reply. The
   * first submission is the prompt itself; once a submission of it has been
   * accepted without a verified receipt, what goes is the redelivery.
   */
  async #sendTurnInSession(
    handle: ClaudeSessionHandle,
    fromIndex: number,
    observers: AttemptObservers
  ): Promise<TurnResult> {
    const message = this.#turn === "accepted" ? this.#redeliveryMessage() : this.#buildTurnMessage();
    await this.#deliver(handle, { message, mark: fromIndex, what: "the follow-up turn", carriesTurn: true }, observers);
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
    this.#collectionMark = fromIndex;
    this.#deliveryFailure = null;
    const message = this.#correctionMessage(previousFailure);
    await this.#deliver(handle, { message, mark: fromIndex, what: "the correction", carriesTurn: false }, observers);
    const transcript = await this.#runToCompletion(handle, fromIndex, observers);
    return this.#buildResult(handle, transcript, fromIndex);
  }

  /**
   * The one way a message enters a live session: submit it through the
   * valve, then require its receipt. Returns only when the transcript shows
   * the session holding the message exactly as sent. The valve did not
   * submit → `ClaudeValveError`: nothing reached the session and nothing is
   * pending.
   */
  async #deliver(handle: ClaudeSessionHandle, submission: Submission, observers: AttemptObservers): Promise<void> {
    if (this.#lost !== null) throw new ClaudePollTimeoutError(this.#lost.reason);
    if (submission.carriesTurn) this.#collectionMark = submission.mark;
    const outcome = await this.#controlPlane.steer(handle, submission.message);
    if (!outcome.submitted) {
      this.#refused = submission;
      throw new ClaudeValveError(`reply valve failed to inject ${submission.what}: ${outcome.reason}`);
    }
    this.#refused = null;
    this.#accept(submission);
    await this.#requireReceipt(handle, submission, observers);
  }

  /**
   * Record that the session accepted a submission, the moment the launch or
   * the valve says so and before anything can fail: from here the session
   * may be running a turn on it, and nothing else is sent until its receipt
   * has been judged.
   */
  #accept(submission: Submission): void {
    this.#pending = { ...submission, answersTurn: true };
    if (submission.carriesTurn) {
      if (this.#turn === "unsent") {
        this.#acceptedTurnCopy = submission.message;
      }
      this.#turn = "accepted";
      this.#deliveryFailure = null;
      this.#collectionMark = submission.mark;
    }
  }

  /**
   * Require an accepted submission's receipt, whichever of the launch and
   * the valve submitted it. Returns only when the transcript shows the
   * session holding the message exactly as sent.
   *
   * - The receipt differs → `ClaudeDeliveryError`. The session took a turn
   *   on text nobody sent. In a held session that turn is followed to its
   *   end before the failure is raised: the session must be at a turn
   *   boundary before anything else is sent, and the turn's text and spend
   *   belong on the attempt that started it. A one-shot call is torn down
   *   by its failure, which ends the turn with it.
   * - The receipt is missing at the deadline → `ClaudeDeliveryError`, with
   *   the submission left pending: it may yet land, so the next attempt
   *   reads its receipt again before sending (`#accountForPending`).
   */
  async #requireReceipt(handle: ClaudeSessionHandle, submission: Submission, observers: AttemptObservers): Promise<void> {
    const receipt = await this.#awaitReceipt(handle, submission, observers);
    if (receipt.state === "verified") {
      this.#pending = null;
      if (submission.carriesTurn) {
        this.#turn = "verified";
        this.#deliveryFailure = null;
      }
      return;
    }
    const failure = new ClaudeDeliveryError(
      receipt.state === "differing"
        ? `${submission.what} was submitted, but the session received different text: ${differenceAccount(submission.message, receipt.received)}`
        : `${submission.what} was submitted, but no receipt for it appeared in the transcript within ${this.#receiptTimeoutMs}ms: sent ${textIdentity(submission.message)}`
    );
    if (receipt.state === "differing" && this.#deliveryFailure === null) this.#deliveryFailure = failure;
    if (receipt.state === "differing" && this.#multiTurn) {
      await this.#runToCompletion(handle, this.#collectionMark, observers);
      this.#pending = null;
    }
    throw failure;
  }

  /** Read the submission's receipt until the transcript shows one, or the receipt deadline passes with it still missing. */
  async #awaitReceipt(
    handle: ClaudeSessionHandle,
    submission: Submission,
    observers: AttemptObservers
  ): Promise<SubmissionReceipt> {
    const deadline = Date.now() + this.#receiptTimeoutMs;
    for (;;) {
      this.#assertOpen();
      const transcript = await this.#tryReadTranscript(handle, observers);
      const receipt: SubmissionReceipt =
        transcript === null
          ? { state: "missing" }
          : submissionReceipt(transcript.entries, submission.mark, submission.message);
      if (receipt.state !== "missing" || Date.now() >= deadline) {
        return receipt;
      }
      await this.#pollDelay();
    }
  }

  /**
   * Account for a submission an earlier attempt left pending, before this
   * attempt sends anything: read its receipt again from its own mark.
   *
   * - Still missing → the session took no turn on it. It is dropped, and
   *   the attempt goes on to send (returns null).
   * - Verified, and it answers the turn in progress → it was delivered
   *   after all, only late. Its reply is this attempt's result, and nothing
   *   is sent.
   * - Anything else — it arrived as different text, or it belongs to a turn
   *   that has already settled — is a turn nobody is waiting on. It is
   *   followed to its end and the attempt fails with its text and spend, so
   *   that one attempt covers one stretch of the transcript.
   *
   * The submission stays pending if following its turn fails, so the next
   * attempt accounts for it again instead of sending on top of it.
   */
  async #accountForPending(
    handle: ClaudeSessionHandle,
    pending: PendingSubmission,
    observers: AttemptObservers
  ): Promise<TurnResult | null> {
    const seen = await this.#readTranscript(handle, observers);
    const receipt = submissionReceipt(seen.entries, pending.mark, pending.message);
    if (receipt.state === "missing") {
      this.#pending = null;
      return null;
    }
    if (pending.answersTurn) {
      if (pending.carriesTurn && receipt.state === "verified") {
        // Preserve this task receipt before following work that may itself
        // submit a recovery nudge whose receipt arrives only on a retry.
        this.#turn = "verified";
        this.#deliveryFailure = null;
      } else if (receipt.state === "differing" && this.#deliveryFailure === null) {
        this.#deliveryFailure = new ClaudeDeliveryError(
          `${pending.what} was submitted, but the session received different text: ${differenceAccount(pending.message, receipt.received)}`
        );
      }
    }
    const transcript = await this.#runToCompletion(handle, this.#collectionMark, observers);
    this.#pending = null;
    if (receipt.state === "verified" && pending.answersTurn && this.#turn === "verified" && this.#deliveryFailure === null) {
      return this.#buildResult(handle, transcript, this.#collectionMark);
    }
    if (pending.answersTurn && this.#deliveryFailure !== null) throw this.#deliveryFailure;
    throw new ClaudeDeliveryError(
      receipt.state === "differing"
        ? `${pending.what} submitted earlier reached the session late and as different text: ${differenceAccount(pending.message, receipt.received)}`
        : `${pending.what} submitted for an earlier turn reached the session after that turn had settled, so its reply answers no turn`
    );
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
   * `CLAUDE_ROSTER_ABSENCE_BOUND`, so a parking/respawning blip does not kill a
   * live worker.
   */
  async #runToCompletion(
    handle: ClaudeSessionHandle,
    fromIndex: number,
    observers: AttemptObservers,
    /** For a new session: the submission its launch made, whose receipt is required at the session's first life. */
    opening?: Submission
  ): Promise<TranscriptFile> {
    // No timeoutMs → no poll deadline; wait indefinitely for the worker to settle.
    const deadline = this.#options.timeoutMs === undefined ? Infinity : Date.now() + this.#options.timeoutMs;
    const firstLifeDeadline = Date.now() + this.#firstLifeTimeoutMs;
    // Corrections necessarily operate on an existing transcript. The guard is
    // only for a newly dispatched child that never starts writing one.
    let sawLife = fromIndex > 0;
    let absences = 0;
    let settledPolls = 0;
    let evidenceReported = false;
    let assistantEvidence = "";
    let waitingOn: string | null = null;
    // Read from the transcript, and held across a poll whose read failed: a
    // transiently unreadable transcript must not turn a waiting session
    // into a settled-but-unproven one for the collection error to catch.
    let awaitingTask = false;

    for (;;) {
      this.#assertOpen();
      const transcript = await this.#tryReadTranscript(handle, observers);
      if (transcript !== null) {
        if (!sawLife && opening !== undefined) {
          // A new session's first life, and the first moment its opening
          // prompt's receipt can be read: nothing the session writes is
          // collected as this turn's until the prompt is shown to have
          // arrived as sent. A session that never writes a transcript has
          // no receipt to fail — it never held the prompt, and that stays
          // the first-life guard's diagnosis below.
          await this.#requireReceipt(handle, opening, observers);
        }
        sawLife = true;
        const version = transcript.entries.findLast((entry) => typeof entry.version === "string")?.version;
        if (typeof version === "string" && version !== this.#reportedVersion) {
          this.#reportedVersion = version;
          this.#onVersion?.(version);
        }
        this.#reportUsage(handle, transcript.entries, observers);
        try {
          this.#resolvedModel = resolvedModelSince(transcript.entries, 0) ?? this.#resolvedModel;
          this.#resolvedEffort = effortSince(transcript.entries, 0) ?? this.#resolvedEffort;
          observers.onIdentity?.({ resolvedModel: this.#resolvedModel, resolvedEffort: this.#resolvedEffort });
          // Compare assistant rows only: polling an unchanged transcript or a
          // newly persisted user prompt is not continuing worker output.
          const evidence = JSON.stringify(transcript.entries.slice(fromIndex).filter((entry) => entry.type === "assistant"));
          if (evidence !== assistantEvidence && hasAssistantEntrySince(transcript.entries, fromIndex)) {
            assistantEvidence = evidence;
            observers.onOutput?.();
          }
        } catch { /* Observability cannot fail a turn. */ }
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
        // A client rejection ends this request even if background work is
        // still listed. Its diagnostic is collected by #buildResult.
        if (endsInSyntheticReply(transcript.entries, fromIndex)) return transcript;
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
        throw this.#firstLifeFailure(handle,
          `Claude worker showed no sign of life within ${this.#firstLifeTimeoutMs}ms (no transcript appeared)`);

      }

      const status = await this.#controlPlane.poll(handle);
      this.#assertOpen();

      if (!status.present) {
        absences += 1;
        if (absences >= CLAUDE_ROSTER_ABSENCE_BOUND) {
          this.#noteLost({ nativeSession: handle.sessionId,
            reason: CLAUDE_ROSTER_LOSS_REASON, observedAt: Date.now() });
          if (!sawLife && opening !== undefined) {
            throw this.#firstLifeFailure(handle, "worker left the roster before writing an opening transcript");
          }
          throw new ClaudePollTimeoutError("worker left the roster before completing");
        }
        await this.#pollDelay();
        continue;
      }
      absences = 0;

      if (status.state === "blocked") {
        // The native roster can report a question before the opening's
        // transcript is flushed. Its receipt must verify before a nudge
        // can take a later boundary; otherwise the opening acknowledges it.
        if (!sawLife && opening !== undefined) {
          await this.#pollDelay();
          if (Date.now() >= deadline) {
            throw new ClaudePollTimeoutError(`worker did not complete within ${this.#options.timeoutMs}ms`);
          }
          continue;
        }
        // The request can settle while the roster poll is in flight. Read
        // again before recovery so a rejection never receives a nudge. A
        // readable transcript is also required to anchor this submission:
        // falling back to the turn's old mark would compare an earlier
        // user row with the nudge.
        const canNudge = this.#nudges < this.#blockedRecoveryBound && (await this.#controlPlane.tmuxAvailable());
        const latest = await this.#readTranscript(handle, observers);
        if (!sawLife && opening !== undefined) {
          await this.#requireReceipt(handle, opening, observers);
        }
        sawLife = true;
        if (endsInSyntheticReply(latest.entries, fromIndex) ||
          (turnComplete(latest.entries, fromIndex) && outstandingBackgroundTasks(latest.entries, fromIndex).length === 0)) {
          return latest;
        }
        if (!canNudge) {
          throw new ClaudeBlockedError("worker blocked awaiting input beyond the recovery bound");
        }
        this.#nudges += 1;
        const mark = latest.entries.length;
        const message = this.#blockedNudge(status.waitingFor);
        await this.#deliver(handle, { message, mark, what: "the blocked-worker nudge", carriesTurn: false }, observers);
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
  #noteWaits(outstanding: readonly { id: string; description: string }[]): BackgroundTaskWaitSnapshot | null {
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
    return delay(this.#pollIntervalMs, AbortSignal.any([this.#abortController.signal, this.#lossController.signal]),
      () => this.#closed || this.#lost === null ? new EngineShutdownError("claude") : new ClaudePollTimeoutError(this.#lost.reason));
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new EngineShutdownError("claude");
    }
  }

  #firstLifeFailure(handle: ClaudeSessionHandle, message: string): ClaudeWorkerError {
    return handle.launchFailure === undefined
      ? new ClaudeFirstLifeTimeoutError(message)
      : new ClaudeDeliveryError(`${message}; launch cleanup remains unconfirmed: ${handle.launchFailure.message}`);
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
    const usage = this.#unaccountedUsage(handle, entries);
    this.#reportUsage(handle, entries);
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
      diagnostics: { ...handle.launchFailure?.diagnostics, worktrees: enteredWorktrees(entries) },
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

  async #readTranscript(handle: ClaudeSessionHandle, observers?: AttemptObservers): Promise<TranscriptFile> {
    const path = await this.#controlPlane.transcriptPath(handle);
    if (path === null) {
      throw new ClaudeTranscriptError(`no transcript found for session ${handle.sessionId}`);
    }
    const transcript = await readTranscriptFile(path);
    try {
      observers?.onTranscriptPath?.(path);
    } catch {
      // Observability must never change the turn's outcome.
    }
    return transcript;
  }

  /** Like #readTranscript, but a not-yet-present transcript is `null` (still working), not an error. */
  async #tryReadTranscript(handle: ClaudeSessionHandle, observers?: AttemptObservers): Promise<TranscriptFile | null> {
    try {
      return await this.#readTranscript(handle, observers);
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
  async #tryFailureEvidence(fromIndex: number, error?: Error): Promise<FailureEvidence | null> {
    let handle: Pick<ClaudeSessionHandle, "sessionId"> | null = this.#handle;
    let transcript: Pick<TranscriptFile, "text" | "entries"> | null;
    if (this.#handle === null) {
      // A rejected opening can already have native output. The control plane
      // snapshots it before teardown, even though dispatch returned no handle.
      const retained = failedTurnResultOf(error)?.transcripts?.find(item => item.source === "claude-session-jsonl");
      if (retained?.sessionId === undefined) return null;
      handle = { sessionId: retained.sessionId };
      transcript = { text: retained.content, entries: parseTranscriptText(retained.content) };
    } else {
      transcript = await this.#tryReadTranscript(this.#handle);
    }
    if (handle === null || transcript === null) return null;
    return {
      handle,
      transcript,
      completed: turnComplete(transcript.entries, fromIndex) &&
        outstandingBackgroundTasks(transcript.entries, fromIndex).length === 0,
      resolvedModel: resolvedModelSince(transcript.entries, fromIndex),
      resolvedEffort: effortSince(transcript.entries, fromIndex),
      usage: this.#unaccountedUsage(handle, transcript.entries),
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
   * A pending submission may be read again from an older entry mark after a
   * failed attempt. Count only growth beyond the session total that earlier
   * attempts already covered, while retaining new API calls in the same work.
   */
  #unaccountedUsage(handle: Pick<ClaudeSessionHandle, "sessionId">, entries: TranscriptEntry[]): TokenUsageBreakdown {
    const total = usageSince(entries);
    this.#usageAtSettlement = { sessionId: handle.sessionId, total };
    return subtractUsage(total, this.#settledUsage.get(handle.sessionId) ?? null);
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
  #reportUsage(handle: ClaudeSessionHandle, entries: TranscriptEntry[], observers?: AttemptObservers): void {
    const total = this.#unaccountedUsage(handle, entries);
    const last = subtractUsage(total, this.#reportedUsage);
    if (last.totalTokens === 0) {
      return;
    }
    this.#reportedUsage = total;
    const event = this.#usageEvent(handle, last, total);
    if (event === null) {
      return;
    }
    try { observers?.onUsage?.(event); } catch { /* Observability cannot fail a turn. */ }
    this.#onEvent?.({
      method: "thread/tokenUsage/updated",
      params: event.raw,
      receivedAt: Date.now()
    });
  }

  #usageEvent(
    handle: Pick<ClaudeSessionHandle, "sessionId">,
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
    // A stopped session runs nothing, so nothing submitted to it is pending,
    // and the turn's prompt is in no session: the next launch submits it anew.
    this.#pending = null;
    this.#refused = null;
    this.#turn = "unsent";
    this.#deliveryFailure = null;
    this.#collectionMark = 0;
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
    lines.push("", this.#framedTask());
    return lines.join("\n");
  }

  #framedTask(): string {
    // The closing tag keeps the caller's trailing whitespace inside the
    // message: native submission trims the message's end. Choose a tag name
    // absent from the task so even literal boundary examples remain intact.
    let tagIndex = 0;
    while (this.#turnPrompt.includes(`ensemble_task_${tagIndex}`)) tagIndex += 1;
    const taskTag = `ensemble_task_${tagIndex}`;
    return [
      `Carry out the task enclosed by <${taskTag}> and </${taskTag}>. The tags mark its boundaries.`,
      `<${taskTag}>${this.#turnPrompt}</${taskTag}>`
    ].join("\n");
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
    // Keep native command handling for tasks with no boundary whitespace.
    // Otherwise use the opening's literal boundary so native trimming is inert.
    lines.push(this.#turnPrompt.trim() === this.#turnPrompt ? this.#turnPrompt : this.#framedTask());
    return lines.join("\n");
  }

  /**
   * The turn's prompt again, for a session that accepted a submission of it
   * no receipt verified. It says what happened first, so a worker that
   * acted on an altered copy knows which copy stands, and one that received
   * nothing loses nothing. What it repeats is the copy the session first
   * accepted, so a session whose opening prompt never arrived still receives
   * everything its launch carried. The preface makes it a correction like
   * every other retry message: a leading `/command` in the prompt is not
   * expanded a second time.
   */
  #redeliveryMessage(): string {
    return [
      "An earlier copy of the message below was submitted to you but did not arrive as sent: it reached you altered, or not at all. " +
        "This copy replaces it. Treat the earlier copy as void, keep any work you have already done that this message also asks for, and answer this message.",
      "",
      this.#acceptedTurnCopy
    ].join("\n");
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
    ...failedTurnResultOf(error),
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
    ...(evidence !== null ? { diagnostics: {
      ...failedTurnResultOf(error)?.diagnostics,
      ...(evidence.apiError !== null ? { apiError: evidence.apiError } : {}),
      worktrees: enteredWorktrees(evidence.transcript.entries)
    } } : {}),
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
              partial: !evidence.completed
            }
          ]
        })
  };
}

/** What one best-effort pre-teardown transcript read yields a dying turn. */
interface FailureEvidence {
  handle: Pick<ClaudeSessionHandle, "sessionId">;
  transcript: Pick<TranscriptFile, "text" | "entries">;
  completed: boolean;
  resolvedModel: string | null;
  resolvedEffort: string | null;
  usage: TokenUsageBreakdown;
  /** The API refusal the synthetic reply annotated, when it did; evidence for classifying the failure. */
  apiError: TranscriptApiError | null;
  /** The background tasks the dying attempt waited on — an open wait names the task that never woke it. */
  backgroundWaits: BackgroundTaskWait[];
}

/** The per-attempt observers the runtime hands an attempt (`EngineAttemptContext`'s callbacks). */
type AttemptObservers = Pick<EngineAttemptContext, "onLiveEvidence" | "onWaiting" | "onTranscriptPath" | "onOutput" | "onIdentity" | "onUsage">;


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
  if (error instanceof ClaudeDeliveryError) {
    return { kind: "claude-delivery-error", message: error.message };
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

/**
 * A text named by size and digest, for a failure account: enough to tell
 * two texts apart and to match one against a transcript, without copying a
 * prompt of any length into an error message.
 */
function textIdentity(text: string): string {
  return `${Buffer.byteLength(text, "utf8")} UTF-8 bytes, sha256 ${createHash("sha256").update(text).digest("hex")}`;
}

function differenceAccount(sent: string, received: string): string {
  return `sent ${textIdentity(sent)}; received ${textIdentity(received)}`;
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
