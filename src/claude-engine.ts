import { randomUUID } from "node:crypto";

import {
  ClaudeBlockedError,
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
import type { RuntimeEvent, TurnResult } from "./types.js";

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
        return await this.#correctInSession(handle, previousFailure, fromIndex);
      }

      // First attempt, or a correction we cannot do in-session: (re)dispatch.
      // A degraded correction folds the prior failure into the fresh prompt.
      if (this.#handle !== null) {
        await this.#teardown();
      }
      return await this.#dispatchAndCollect(previousFailure);
    } catch (error) {
      if (error instanceof Error) {
        await this.#attachLatestWorkerText(error, fromIndex);
      }
      if (error instanceof ClaudeWorkerError) {
        // Preserve the operational cause and current-turn text on the failed
        // result while retaining the shared loop's bounded retry governance.
        await this.#teardown();
        return failedTurnResult(error);
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

  async #dispatchAndCollect(previousFailure: EngineAttemptFailure | undefined): Promise<TurnResult> {
    const handle = await this.#controlPlane.dispatch({
      prompt: this.#buildDispatchPrompt(previousFailure),
      name: this.#nextName(),
      cwd: this.#cwd,
      ...(this.#options.model !== undefined ? { model: this.#options.model } : {}),
      ...(this.#options.effort !== undefined ? { effort: this.#options.effort } : {}),
      ...(this.#options.fallbackModel !== undefined ? { fallbackModel: this.#options.fallbackModel } : {})
    });
    this.#handle = handle;
    if (this.#closed) {
      // close() ran while dispatch was in flight: its teardown saw no
      // handle, so the session just created is ours to stop — otherwise a
      // cancelled invocation leaks a live worker.
      await this.#teardown();
      throw new EngineShutdownError("claude");
    }

    const transcript = await this.#runToCompletion(handle, 0);
    return this.#buildResult(handle, transcript, 0);
  }

  async #correctInSession(
    handle: ClaudeSessionHandle,
    previousFailure: EngineAttemptFailure,
    fromIndex: number
  ): Promise<TurnResult> {
    const steered = await this.#controlPlane.steer(handle, this.#correctionMessage(previousFailure));
    if (!steered) {
      throw new ClaudeValveError("reply valve failed to inject the correction");
    }

    await this.#awaitReceipt(handle, fromIndex);
    const transcript = await this.#runToCompletion(handle, fromIndex);
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
   * point. Completion is read from the transcript (`turnComplete`), not the
   * daemon's unreliable `state` field; `state: blocked` still drives bounded
   * valve recovery. A transient roster-query failure reports `present: false`
   * only after `MAX_CONSECUTIVE_ABSENCES`, so a parking/respawning blip does not
   * kill a live worker.
   */
  async #runToCompletion(handle: ClaudeSessionHandle, fromIndex: number): Promise<TranscriptFile> {
    // No timeoutMs → no poll deadline; wait indefinitely for the worker to settle.
    const deadline = this.#options.timeoutMs === undefined ? Infinity : Date.now() + this.#options.timeoutMs;
    const firstLifeDeadline = Date.now() + this.#firstLifeTimeoutMs;
    // Corrections necessarily operate on an existing transcript. The guard is
    // only for a newly dispatched child that never starts writing one.
    let sawLife = fromIndex > 0;
    let nudges = 0;
    let absences = 0;

    for (;;) {
      this.#assertOpen();
      const status = await this.#controlPlane.poll(handle);
      this.#assertOpen();

      if (!sawLife) {
        sawLife = (await this.#tryReadTranscript(handle)) !== null;
        if (!sawLife && Date.now() >= firstLifeDeadline) {
          throw new ClaudeFirstLifeTimeoutError(
            `Claude worker showed no sign of life within ${this.#firstLifeTimeoutMs}ms (no transcript appeared)`
          );
        }
      }

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
        const mark = (await this.#tryReadTranscript(handle))?.entries.length ?? fromIndex;
        const steered = await this.#controlPlane.steer(handle, this.#blockedNudge(status.waitingFor));
        if (!steered) {
          throw new ClaudeValveError("reply valve failed to inject the blocked-worker nudge");
        }
        await this.#awaitReceipt(handle, mark);
        continue;
      }

      // Not actively generating: the turn may be complete. The transcript is the
      // authoritative signal — confirm the latest assistant message has settled.
      if (status.status !== "busy") {
        const transcript = await this.#tryReadTranscript(handle);
        if (transcript !== null && turnComplete(transcript.entries, fromIndex)) {
          return transcript;
        }
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

function failedTurnResult(error: ClaudeWorkerError): EngineAttemptResult {
  const text = partialWorkerTextOf(error) ?? "";
  return {
    text,
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
  return { kind: "claude-dispatch-error", message: error.message };
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
