import { randomUUID } from "node:crypto";

import {
  ClaudeBlockedError,
  ClaudeCollectionError,
  ClaudeFirstLifeTimeoutError,
  ClaudePollTimeoutError,
  ClaudeTranscriptError,
  ClaudeValveError,
  ClaudeWorkerError,
  EngineShutdownError,
  attachPartialWorkerText,
  partialWorkerTextOf
} from "./errors.js";
import { finalAssistantText, readTranscriptFile, resolvedModelSince, turnComplete, usageSince } from "./claude-transcript.js";

import type { ClaudeControlPlane, ClaudeSessionHandle } from "./claude-control-plane.js";
import type { TranscriptEntry, TranscriptFile } from "./claude-transcript.js";
import type {
  EngineAttemptContext,
  EngineAttemptFailure,
  EngineAttemptResult,
  EngineInvocation,
  EngineTurnOptions
} from "./engines.js";
import type { StrippableCapability } from "./capability-stripping.js";
import type { RuntimeEvent, TurnResult } from "./types.js";

/**
 * The Claude rendering of each strippable capability: the permission deny
 * rules that remove it from the worker's tool surface. `agents` denies the
 * measured native spawn, discovery, and messaging tools: `Task`, `Agent`,
 * `ListAgents`, and `SendMessage`. Worker tool surface measured 2026-08-28 on
 * Claude Code 2.1.250 used `mcp__`-prefixed names; that session's skills pair
 * showed the bare `Skill` deny working (`Skill` absent under a skills strip,
 * present in the baseline). The agents deny set was witnessed 2026-08-30 on
 * Claude Code 2.1.251: `Task`, `Agent`, `ListAgents`, and `SendMessage` were
 * absent at the stripped worker, while the unstripped control demonstrated
 * discovery and messaging; the witness cannot isolate `Task`/`Agent`
 * from the machine-wide `Agent` deny. Deny rules outrank every allow
 * layer and permission mode,
 * so the operator's own settings cannot quietly re-enable a stripped tool.
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
  onEvent?: (event: RuntimeEvent) => void;
  config?: ClaudeEngineConfig;
  /** Adapter deregistration: called exactly once, when close() completes. */
  onClose?: (invocation: ClaudeEngineInvocation) => void;
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
export class ClaudeEngineInvocation implements EngineInvocation {
  #prompt: string;
  #cwd: string;
  #options: EngineTurnOptions;
  #controlPlane: ClaudeControlPlane;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;

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
    this.#prompt = options.prompt;
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
    let fromIndex = 0;
    try {
      const previousFailure = context.previousFailure;
      const correcting = previousFailure !== undefined && this.#handle !== null;

      if (correcting && (await this.#controlPlane.tmuxAvailable())) {
        const handle = this.#handle as ClaudeSessionHandle;
        fromIndex = (await this.#readTranscript(handle)).entries.length;
        return await this.#correctInSession(handle, previousFailure, fromIndex, context.onLiveEvidence);
      }

      // First attempt, or a correction we cannot do in-session: (re)dispatch.
      // A degraded correction folds the prior failure into the fresh prompt.
      if (this.#handle !== null) {
        await this.#teardown();
      }
      return await this.#dispatchAndCollect(previousFailure, context.onLiveEvidence);
    } catch (error) {
      if (error instanceof Error) {
        await this.#attachLatestWorkerText(error, fromIndex);
      }
      if (error instanceof ClaudeWorkerError) {
        // Preserve the operational cause and current-turn text on the failed
        // result while retaining the shared loop's bounded retry governance.
        // A served model the transcript already named is evidence too: a
        // result-less failure must not un-learn it (failures carry their
        // evidence), so it is read before the session is torn down.
        const resolvedModel = await this.#tryResolveModel(fromIndex);
        await this.#teardown();
        return failedTurnResult(error, resolvedModel);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#closed = true;
      this.#abortController.abort();
      try {
        await this.#settlement?.catch(() => undefined);
        await this.#teardown();
      } finally {
        this.#onClose?.(this);
      }
    })();
    await this.#closePromise;
  }

  async #dispatchAndCollect(
    previousFailure: EngineAttemptFailure | undefined,
    onLiveEvidence: (() => void) | undefined
  ): Promise<TurnResult> {
    const denyRules = permissionDenyRulesFor(this.#options.strip);
    const handle = await this.#controlPlane.dispatch({
      prompt: this.#buildDispatchPrompt(previousFailure),
      name: this.#nextName(),
      cwd: this.#cwd,
      ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
      ...(this.#options.effort !== undefined ? { effort: this.#options.effort } : {}),
      ...(this.#options.fallbackModel !== undefined ? { fallbackModel: this.#options.fallbackModel } : {}),
      ...(denyRules.length > 0 ? { permissionDenyRules: denyRules } : {})
    });
    this.#handle = handle;
    if (this.#closed) {
      // close() ran while dispatch was in flight: its teardown saw no
      // handle, so the session just created is ours to stop — otherwise a
      // cancelled invocation leaks a live worker.
      await this.#teardown();
      throw new EngineShutdownError("claude");
    }

    const transcript = await this.#runToCompletion(handle, 0, onLiveEvidence);
    return this.#buildResult(handle, transcript, 0);
  }

  async #correctInSession(
    handle: ClaudeSessionHandle,
    previousFailure: EngineAttemptFailure,
    fromIndex: number,
    onLiveEvidence: (() => void) | undefined
  ): Promise<TurnResult> {
    const steered = await this.#controlPlane.steer(handle, this.#correctionMessage(previousFailure));
    if (!steered) {
      throw new ClaudeValveError("reply valve failed to inject the correction");
    }

    await this.#awaitReceipt(handle, fromIndex);
    const transcript = await this.#runToCompletion(handle, fromIndex, onLiveEvidence);
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
   * `state: blocked` still drives bounded valve recovery, and a transient
   * roster-query failure reports `present: false` only after
   * `MAX_CONSECUTIVE_ABSENCES`, so a parking/respawning blip does not kill a
   * live worker.
   */
  async #runToCompletion(
    handle: ClaudeSessionHandle,
    fromIndex: number,
    onLiveEvidence: (() => void) | undefined
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

    for (;;) {
      this.#assertOpen();
      const transcript = await this.#tryReadTranscript(handle);
      if (transcript !== null) {
        sawLife = true;
        // Evidence means output *the worker produced this turn*: only an
        // assistant entry beyond the high-water mark counts. The transcript's
        // first entry is routinely the persisted user prompt (and a steer
        // injects another), so counting any entry would certify output that
        // never happened. The callback is observability — a throw inside it
        // must never affect the turn.
        if (!evidenceReported && hasAssistantEntrySince(transcript.entries, fromIndex)) {
          evidenceReported = true;
          try {
            onLiveEvidence?.();
          } catch {
            // Liveness reporting must never take the turn down with it.
          }
        }
        if (turnComplete(transcript.entries, fromIndex)) {
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
        const steered = await this.#controlPlane.steer(handle, this.#blockedNudge(status.waitingFor));
        if (!steered) {
          throw new ClaudeValveError("reply valve failed to inject the blocked-worker nudge");
        }
        await this.#awaitReceipt(handle, mark);
        continue;
      }

      // Settled means the daemon itself says generation is over ("idle", or a
      // `state` of done); a failed roster query ("unknown") and an active
      // "busy" both reset the window rather than feed it. A worker with no
      // transcript at all is the first-life guard's diagnosis, not this
      // one's — collection presumes there is something to collect from.
      if (sawLife && (status.state === "done" || status.status === "idle")) {
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
    const resolvedModel = resolvedModelSince(entries, fromIndex);
    const usageEvent = this.#feedBudget(handle, entries, fromIndex);
    return {
      text,
      ...(resolvedModel !== null ? { resolvedModel } : {}),
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

  /** The served model the current turn's transcript names, or null when unreadable. */
  async #tryResolveModel(fromIndex: number): Promise<string | null> {
    const handle = this.#handle;
    if (handle === null) {
      return null;
    }
    const transcript = await this.#tryReadTranscript(handle);
    return transcript === null ? null : resolvedModelSince(transcript.entries, fromIndex);
  }

  async #attachLatestWorkerText(error: Error, fromIndex: number): Promise<void> {
    const handle = this.#handle;
    if (handle === null) {
      return;
    }
    const transcript = await this.#tryReadTranscript(handle);
    const text = transcript === null ? null : finalAssistantText(transcript.entries, fromIndex);
    if (text !== null) {
      attachPartialWorkerText(error, text);
    }
  }

  /**
   * Feed best-effort transcript-derived usage through the same event shape Codex
   * emits. The adapter registration labels it as Claude before the runtime records
   * it, so budget accounting never has to infer engine from the payload.
   */
  #feedBudget(handle: ClaudeSessionHandle, entries: TranscriptEntry[], fromIndex: number): TurnResult["tokenUsageEvents"][number] | null {
    if (this.#onEvent === undefined) {
      return null;
    }
    const breakdown = usageSince(entries, fromIndex);
    if (breakdown.totalTokens === 0) {
      return null;
    }
    this.#budgetEventCounter += 1;
    const event = {
      threadId: handle.sessionId,
      turnId: `${handle.sessionId}:claude-${this.#budgetEventCounter}`,
      last: breakdown,
      total: breakdown,
      raw: {
        threadId: handle.sessionId,
        turnId: `${handle.sessionId}:claude-${this.#budgetEventCounter}`,
        tokenUsage: { last: breakdown, total: breakdown }
      }
    };
    this.#onEvent({
      method: "thread/tokenUsage/updated",
      params: event.raw,
      receivedAt: Date.now()
    });
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

  #buildDispatchPrompt(previousFailure: EngineAttemptFailure | undefined): string {
    const lines: string[] = [
      "You are an automated worker dispatched by the Ensemble orchestration harness.",
      "Work fully autonomously: never ask for confirmation or permission, and do not pause to ask questions — make a reasonable decision and finish the task."
    ];
    if (this.#options.schema !== undefined) {
      lines.push(
        "When finished, include in your FINAL message a JSON value that conforms to this JSON Schema. You may surround the value with prose, explanation, or markdown code fences:",
        JSON.stringify(this.#options.schema)
      );
    }
    if (previousFailure !== undefined) {
      lines.push(`A previous attempt failed (${previousFailure.kind}): ${previousFailure.message}. Correct it this time.`);
    }
    lines.push("", "Task:", this.#prompt);
    return lines.join("\n");
  }

  #correctionMessage(previousFailure: EngineAttemptFailure): string {
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
      default:
        return "Your last turn produced no final answer. Please complete the task and output your final answer now.";
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

function failedTurnResult(error: ClaudeWorkerError, resolvedModel: string | null = null): EngineAttemptResult {
  const text = partialWorkerTextOf(error) ?? "";
  return {
    text,
    ...(resolvedModel !== null ? { resolvedModel } : {}),
    attemptFailure: claudeAttemptFailure(error),
    deltaText: text,
    durationMs: null,
    firstDeltaMs: null,
    items: {},
    tokenUsageEvents: []
  };
}

function claudeAttemptFailure(error: ClaudeWorkerError): EngineAttemptFailure {
  if (error instanceof ClaudeFirstLifeTimeoutError) {
    return { kind: "claude-first-life-timeout", message: error.message };
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
  return { kind: "claude-dispatch-error", message: error.message };
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
