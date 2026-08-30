import { randomUUID } from "node:crypto";

import { AgentPlacementManager, resolveAgentCwd } from "./agent-placement.js";
import { AdmissionController } from "./admission.js";
import { TokenBudget, tokenUsageEventFromParams } from "./budget.js";
import { assertValidStripOption, effectiveStrip, resolveStripEnforcement } from "./capability-stripping.js";

import type { DischargedEnforcement } from "./capability-stripping.js";
import { harnessVersion } from "./harness-version.js";
import {
  assertValidAgentOptions,
  assertValidSessionTurnOptions,
  assertValidWorkerSessionOptions
} from "./engine-option-validation.js";
import {
  AppServerBackpressureError,
  AppServerExitedError,
  AppServerOverloadedError,
  AppServerRetryPromiseBrokenError,
  AgentPromptRejectedError,
  EmptyAgentOutputError,
  EngineShutdownError,
  HoldRejectedError,
  MissingEngineError,
  MultiTurnUnsupportedError,
  SessionBusyError,
  SessionClosedError,
  appServerDiagnosticOf,
  attachAgentIdentity,
  describeError,
  partialWorkerTextOf,
  TurnTimeoutError,
  UnknownEngineError,
  workerExitStatusOf
} from "./errors.js";
import { HoldManager, defaultHoldsDirectory } from "./holds.js";
import { RunProgress } from "./progress.js";

import type { HoldDecision } from "./holds.js";
import {
  ClaudeEngineAdapter,
  CodexEngineAdapter,
  EngineRegistry,
  OpenCodeEngineAdapter,
  createDefaultEngineRegistry,
  defaultCodexConcurrency
} from "./engines.js";
import { assertCompilableSchema, selectLastValidJsonFromText } from "./schema.js";

import type { OpenCodeModelRegistry } from "./opencode-model-registry.js";

import type {
  AgentOptions,
  Budget,
  EngineBudgetCeilings,
  EngineConcurrencyCaps,
  EngineName,
  IdentifiedAgentResult,
  JsonObject,
  JsonSchema,
  RuntimeEvent,
  RuntimeOptions,
  RuntimeTransport,
  SessionTurnOptions,
  TurnResult,
  TokenUsageEvent,
  WorkerSessionOptions
} from "./types.js";
import type {
  EngineAdapter,
  EngineAttemptFailure,
  EngineAttemptResult,
  EngineInvocation,
  EngineTurnOptions,
  EngineWorkerSession
} from "./engines.js";
import type { AgentPlacement } from "./agent-placement.js";
import type { StrippableCapability } from "./capability-stripping.js";
import type { RunRecordWriter, RuntimeAgentAttemptRecord, RuntimeAgentRecord, TerminalErrorRecord } from "./run-record.js";
import type { IsolatedWorktreeRecord, WorktreeIsolationManager } from "./worktree-isolation.js";

function assertValidAgentPrompt(prompt: unknown): asserts prompt is string {
  if (typeof prompt !== "string") {
    throw new AgentPromptRejectedError(`agent() prompt must be a string, got ${typeof prompt}`);
  }
  if (prompt.trim().length === 0) {
    throw new AgentPromptRejectedError("agent() prompt must be a non-empty string");
  }
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * A worker that finished successfully, recorded in completion order. The CLI
 * emits these as a best-effort partial result when a stopped run exits before
 * the script returns — turning interruption from total loss into recovered work.
 */
export interface CompletedAgentOutput {
  id: number;
  engine: EngineName;
  label: string | null;
  phase: string | null;
  output: unknown;
}

interface AgentExecutionResult {
  status: "complete" | "failed";
  value: unknown;
}

interface UnsettledAgentRecord {
  record: RuntimeAgentRecord;
  stage: "dispatching" | "admitting";
}

type AgentExecutionCompletion =
  | { ok: true; execution: AgentExecutionResult }
  | { ok: false; error: unknown };

/** A worker session's runtime-internal state, owned by EnsembleRuntime. */
interface WorkerSessionState {
  id: number;
  options: WorkerSessionOptions;
  engine: EngineAdapter;
  stripRoutes: Partial<Record<StrippableCapability, DischargedEnforcement>> | null;
  stalenessThresholdMs: number;
  markStaleness: boolean;
  engineSession: EngineWorkerSession | null;
  placement: AgentPlacement | null;
  turnCount: number;
  lastTurnEndedAt: number | null;
  inFlight: boolean;
  closed: boolean;
}

/**
 * A held multi-turn worker, as the script surface sees it. Turns are
 * strictly sequential (`send()` while a turn is in flight throws), each turn
 * takes the one-shot call's validated-return and bounded-retry contract with
 * its own optional schema, and the advisory staleness mark is read
 * here — computed by the runtime, acted on only by the script: a send to a
 * stale-marked session still executes.
 */
export class WorkerSession {
  #state: WorkerSessionState;
  #now: () => number;
  #sendTurn: (prompt: string, turn: SessionTurnOptions) => Promise<unknown>;
  #close: () => Promise<void>;

  constructor(options: {
    state: WorkerSessionState;
    now: () => number;
    sendTurn: (prompt: string, turn: SessionTurnOptions) => Promise<unknown>;
    close: () => Promise<void>;
  }) {
    this.#state = options.state;
    this.#now = options.now;
    this.#sendTurn = options.sendTurn;
    this.#close = options.close;
  }

  /** Run-scoped session ordinal — the identity the archive's per-turn records carry. */
  get id(): number {
    return this.#state.id;
  }

  get engine(): EngineName {
    return this.#state.options.engine;
  }

  /** Completed turns so far (a settled send, whatever its outcome). */
  get turns(): number {
    return this.#state.turnCount;
  }

  /** Milliseconds since the last settled turn, or null before the first. */
  get idleMs(): number | null {
    const last = this.#state.lastTurnEndedAt;
    return last === null ? null : Math.max(0, this.#now() - last);
  }

  /**
   * The advisory staleness mark: true once the idle gap since the
   * last settled turn has outlived the session's cache economics — the
   * configured TTL cliff on Claude, the measured idle threshold on Codex.
   * Always false while marking is disabled, before the first turn, and
   * mid-turn. Advisory only: the runtime never blocks or reroutes a send
   * on it — a fresh session cannot inherit the old transcript, so only the
   * script can decide to re-brief.
   */
  get stale(): boolean {
    const state = this.#state;
    if (!state.markStaleness || state.lastTurnEndedAt === null || state.inFlight) {
      return false;
    }
    return this.#now() - state.lastTurnEndedAt >= state.stalenessThresholdMs;
  }

  send(prompt: string, turn: SessionTurnOptions & { schema: JsonSchema }): Promise<unknown | null>;
  send(prompt: string, turn?: SessionTurnOptions & { schema?: undefined }): Promise<string>;
  send(prompt: string, turn?: SessionTurnOptions): Promise<string | unknown | null>;
  send(prompt: string, turn: SessionTurnOptions = {}): Promise<string | unknown | null> {
    return this.#sendTurn(prompt, turn);
  }

  /** Idempotent: stops the held worker and finalises the session's placement. */
  close(): Promise<void> {
    return this.#close();
  }
}

export class EnsembleRuntime {
  readonly budget: TokenBudget;
  readonly worktrees: IsolatedWorktreeRecord[] = [];
  /** Live, in-memory view of what the run is doing. Always maintained; persisting it is opt-in at the CLI. */
  readonly progress: RunProgress;

  #engines: EngineRegistry;
  #admission: AdmissionController;
  #placement: AgentPlacementManager;
  #defaultTurnTimeoutMs: number | undefined;
  #defaultMaxAttempts: number;
  /** Run-wide capability strip, united with each call's own list. */
  #strip: StrippableCapability[];
  #eventListeners = new Set<RuntimeEventListener>();
  #completed: CompletedAgentOutput[] = [];
  #runRecorder: RunRecordWriter | null = null;
  #executingAgentRecords = new Map<EngineName, Set<RuntimeAgentRecord>>();
  // Every dispatched record remains here until its own agent() call settles.
  // close() uses this to terminalise work a run ended before
  // the normal per-agent settlement path could run.
  #unsettledAgentRecords = new Map<number, UnsettledAgentRecord>();
  // Once close() has made the only honest terminal transition for a record,
  // late shutdown rejections must not overwrite it with an invented outcome.
  #abandonedAgentIds = new Set<number>();
  #shutdownAgentStatus: "failed" | "timed-out" | "interrupted" = "interrupted";
  #closed = false;
  #workerSessions = new Set<WorkerSession>();
  #sessionCounter = 0;
  /** Injectable clock (tests): drives the staleness mark's idle reading. */
  #now: () => number;
  #holdManager: HoldManager | null = null;
  #lastSettledAgentRecord: RuntimeAgentRecord | null = null;
  #holdsDir: string;
  #holdPollIntervalMs: number | undefined;
  #holdsCwd: string;
  #claudeSessionStaleAfterMs: number;
  #codexSessionStaleAfterMs: number;

  constructor(options: {
    engines?: EngineRegistry;
    transport?: RuntimeTransport;
    cwd?: string;
    agentCeiling?: number | null;
    concurrencyCaps?: EngineConcurrencyCaps;
    budgetCeilings?: EngineBudgetCeilings;
    defaultTurnTimeoutMs?: number;
    defaultMaxAttempts: number;
    strip?: StrippableCapability[];
    claudeSessionStaleAfterMs?: number;
    codexSessionStaleAfterMs?: number;
    holdsDir?: string;
    holdPollIntervalMs?: number;
    worktreeManager?: WorktreeIsolationManager;
    runId?: string;
    now?: () => number;
  }) {
    if (options.strip !== undefined) {
      // A malformed run-wide strip fails at construction, before any call
      // pays for a worker — same boundary as a malformed per-call value.
      assertValidStripOption(options.strip);
    }
    this.#strip = options.strip ?? [];
    this.budget = new TokenBudget(options.budgetCeilings);
    this.progress = new RunProgress({
      runId: options.runId ?? randomUUID(),
      budget: this.budget,
      ...(options.now !== undefined ? { now: options.now } : {})
    });
    this.#defaultTurnTimeoutMs = options.defaultTurnTimeoutMs;
    this.#defaultMaxAttempts = options.defaultMaxAttempts;
    // 1 hour on both by default: Claude's is the injected cache TTL's
    // cliff, Codex's the measured 60-minute coin-flip point —
    // numerically equal, semantically distinct knobs.
    this.#claudeSessionStaleAfterMs = options.claudeSessionStaleAfterMs ?? 3_600_000;
    this.#codexSessionStaleAfterMs = options.codexSessionStaleAfterMs ?? 3_600_000;
    this.#now = options.now ?? (() => Date.now());
    this.#holdsDir = options.holdsDir ?? defaultHoldsDirectory();
    this.#holdPollIntervalMs = options.holdPollIntervalMs;
    this.#holdsCwd = options.cwd ?? process.cwd();
    this.#placement = new AgentPlacementManager({
      baseCwd: options.cwd ?? process.cwd(),
      ...(options.worktreeManager !== undefined ? { worktreeManager: options.worktreeManager } : {})
    });
    this.#engines =
      options.engines ??
      new EngineRegistry([
        new CodexEngineAdapter({
          transport: requireTransport(options.transport),
          concurrency: options.concurrencyCaps?.codex ?? defaultCodexConcurrency()
        }),
        new ClaudeEngineAdapter({
          ...(options.concurrencyCaps?.claude !== undefined ? { concurrency: options.concurrencyCaps.claude } : {})
        }),
        new OpenCodeEngineAdapter({
          ...(options.concurrencyCaps?.opencode !== undefined ? { concurrency: options.concurrencyCaps.opencode } : {})
        })
      ]);
    this.#admission = new AdmissionController({
      ceiling: options.agentCeiling ?? null,
      caps: this.#engineCaps()
    });
    this.#registerEngineCaps();
  }

  /**
   * The opencode registry dispatch will consult — the adapter's own, so
   * load-time validation and dispatch can never read different registries
   * (an injected registry previously made load time the stricter of the
   * two, rejecting models dispatch would run).
   */
  get openCodeModelRegistry(): OpenCodeModelRegistry | undefined {
    const adapter = this.#engines.get("opencode");
    return adapter instanceof OpenCodeEngineAdapter ? adapter.modelRegistry : undefined;
  }

  static async create(options: RuntimeOptions = {}): Promise<EnsembleRuntime> {
    let runtime: EnsembleRuntime | null = null;
    const cwd = options.cwd ?? process.cwd();
    const engines = await createDefaultEngineRegistry({
      cwd,
      codexBin: options.codexBin ?? "codex",
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      ...(options.retryPromiseSilenceTimeoutMs !== undefined
        ? { retryPromiseSilenceTimeoutMs: options.retryPromiseSilenceTimeoutMs }
        : {}),
      ...(options.firstOutputTimeoutMs !== undefined ? { firstOutputTimeoutMs: options.firstOutputTimeoutMs } : {}),
      ...(options.workerEnvironment !== undefined ? { workerEnvironment: options.workerEnvironment } : {}),
      startupHandshakeTimeoutMs: options.startupHandshakeTimeoutMs ?? 120_000,
      clientName: options.clientName ?? "ensemble-workflows",
      clientVersion: options.clientVersion ?? harnessVersion(),
      onEvent: (event) => {
        runtime?.handleEngineEvent("codex", event);
      },
      onClaudeEvent: (event) => {
        runtime?.handleEngineEvent("claude", event);
      },
      onOpenCodeEvent: (event) => {
        runtime?.handleEngineEvent("opencode", event);
      },
      ...(options.concurrencyCaps !== undefined ? { concurrencyCaps: options.concurrencyCaps } : {})
    });

    runtime = new EnsembleRuntime({
      engines,
      cwd,
      ...(options.budgetCeilings !== undefined ? { budgetCeilings: options.budgetCeilings } : {}),
      ...(options.defaultTurnTimeoutMs !== undefined ? { defaultTurnTimeoutMs: options.defaultTurnTimeoutMs } : {}),
      ...(options.agentCeiling !== undefined ? { agentCeiling: options.agentCeiling } : {}),
      defaultMaxAttempts: options.defaultMaxAttempts ?? 3,
      ...(options.holdsDir !== undefined ? { holdsDir: options.holdsDir } : {}),
      ...(options.holdPollIntervalMs !== undefined ? { holdPollIntervalMs: options.holdPollIntervalMs } : {}),
      ...(options.strip !== undefined ? { strip: options.strip } : {}),
      ...(options.claudeSessionStaleAfterMs !== undefined
        ? { claudeSessionStaleAfterMs: options.claudeSessionStaleAfterMs }
        : {}),
      ...(options.codexSessionStaleAfterMs !== undefined
        ? { codexSessionStaleAfterMs: options.codexSessionStaleAfterMs }
        : {})
    });

    return runtime;
  }

  onEvent(listener: RuntimeEventListener): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  setRunRecorder(recorder: RunRecordWriter | null): void {
    this.#runRecorder = recorder;
  }

  /** Sets the run's current phase. Driven by the script's `phase()` hook. */
  notePhase(title: string): void {
    this.progress.setPhase(title);
  }

  handleEngineEvent(engine: EngineName, event: RuntimeEvent): void {
    if (event.method === "thread/tokenUsage/updated") {
      const usageEvent = tokenUsageEventFromParams(event.params);
      if (usageEvent !== null) {
        this.budget.record(engine, usageEvent);
        // Refresh the live view so its spend figures track each turn's usage.
        this.progress.noteEngineSpend(engine);
      }
    }

    if (event.method === "transport/decodeFailed") {
      // An undecodable frame has no parseable thread id to correlate. Keep its
      // already-bounded evidence on the Codex records that were executing when
      // the shared transport received it; settlement writes it through the
      // existing transition path rather than creating a progress write.
      const diagnostic = decodeFailureDiagnosticFromParams(event.params);
      if (diagnostic !== null) {
        for (const record of this.#executingAgentRecords.get(engine) ?? []) {
          record.decodeFailure = diagnostic;
        }
      }
    }

    this.#emitEvent(event);
  }

  handleTransportEvent(event: RuntimeEvent): void {
    this.handleEngineEvent("codex", event);
  }

  // The declared set is the canonical AgentCallSignature (src/types.ts):
  // every dispatch surface presents these same signatures, and the general
  // final one is public on purpose — dynamically-composed options resolve
  // to the honest union instead of needing a cast at the caller.
  async agent(prompt: string, options: AgentOptions & { identity: true }): Promise<IdentifiedAgentResult>;
  async agent(prompt: string, options: AgentOptions & { schema: JsonSchema }): Promise<unknown | null>;
  async agent(prompt: string, options: AgentOptions & { schema?: undefined }): Promise<string>;
  async agent(prompt: string, options: Partial<AgentOptions>): Promise<string | unknown | null>;
  async agent(prompt: string, options: Partial<AgentOptions> = {}): Promise<string | unknown | null> {
    if (this.#closed) {
      throw new Error("EnsembleRuntime is closed");
    }
    assertValidAgentPrompt(prompt);
    assertValidAgentOptions(options);
    if (options.schema !== undefined) {
      // A malformed schema would otherwise surface only after the first paid turn.
      assertCompilableSchema(options.schema);
    }

    // The run cwd was already established by the caller. Only an explicit
    // per-call override needs validation here; keeping the ordinary path
    // synchronous preserves the dispatch-order admission boundary.
    if (options.cwd !== undefined) {
      await this.#placement.assertUsableCwd(options);
    }

    const engine = this.#engineFor(options.engine);
    // Capability stripping is judged pre-spawn, like any other rejected
    // option: the effective set is the run-wide list united with this
    // call's, and every member must resolve to a config or absent route on
    // the engine's declared table — an unenforceable strip throws before
    // admission, so no worker ever dispatches under a restriction the
    // author believes is in force but is not.
    const strip = effectiveStrip(this.#strip, options.strip);
    const stripRoutes = strip.length > 0 ? resolveStripEnforcement(engine.name, engine.capabilities, strip) : null;
    const dispatchOptions = strip.length > 0 ? { ...options, strip } : options;
    // The per-engine budget is an admission boundary, judged once per
    // agent() call, synchronously here — so the outcome depends only on
    // the script's dispatch order, never on how usage events interleave
    // with retries or queue starts. Both other placements were built and
    // rejected: re-checking per retry attempt let a concurrent sibling's
    // spend replace the failure that provoked a retry with
    // BudgetExceededError (blaming the budget for a transport death), and
    // checking at queue-start let a sibling's usage event race a
    // same-parallel thunk's start. The accepted cost is that the ceiling
    // bounds *new dispatches* only: everything already dispatched — queued
    // fan-out included, not just turns on the wire — runs its bounded
    // attempts to completion, so spend can overshoot by the whole dispatched
    // backlog. A blocked call is a pre-dispatch rejection, like a rejected
    // option: no engine invocation, no progress entry, no run record.
    this.budget.assertCanStart(engine.name);
    const queuedAt = Date.now();
    const agentId = this.progress.queueAgent({
      engine: engine.name,
      label: options.label ?? null,
      phase: options.phase ?? null
    });
    if (engine.name === "claude" && options.model === undefined) {
      // Unpinned Claude burns the ambient default model silently; make it visible.
      this.#emitEvent({
        method: "claude/unpinnedModel",
        params: { agentId, label: options.label ?? null },
        receivedAt: Date.now()
      });
    }
    const agentRecord = this.#newAgentRecord(agentId, engine.name, prompt, dispatchOptions, stripRoutes);
    this.#unsettledAgentRecords.set(agentId, { record: agentRecord, stage: "dispatching" });
    // Dispatch-time record: persisted in-progress before the engine is
    // called, so a worker that dies uncleanly still leaves evidence it was
    // asked. Settlement overwrites this same record (last write wins).
    try {
      await this.#recordAgentSafely(agentRecord);
      const unsettled = this.#unsettledAgentRecords.get(agentId);
      if (unsettled !== undefined) {
        unsettled.stage = "admitting";
      }
      const output = await this.#runAdmitted(engine, prompt, dispatchOptions, agentId, agentRecord, queuedAt);
      if (options.identity === true) {
        // Identified resolution (result identity is opt-in): the
        // envelope wraps every resolution, a schema call's null collapse
        // included, so a fan-in that keeps the envelope still knows which
        // worker failed. The durable record is unchanged — it already
        // carries label and phase as first-class fields.
        return { label: options.label ?? null, phase: options.phase ?? null, output };
      }
      return output;
    } catch (error) {
      if (options.identity === true && error instanceof Error) {
        // An identified call keeps its identity through operational failure:
        // the combinators' collapse reads this carrier and resolves
        // { label, phase, output: null } instead of bare null. The call's
        // own contract is unchanged — the error still propagates.
        attachAgentIdentity(error, { label: options.label ?? null, phase: options.phase ?? null });
      }
      throw error;
    } finally {
      this.#unsettledAgentRecords.delete(agentId);
    }
  }

  /**
   * Raise a hold and await its decision: the hold's content and
   * accepted verdicts are published to the shared holds directory, any
   * process — the launcher or not, alive at raise time or not — writes the
   * decision file the record names, nonce correlation rejects stale
   * answers, and the resolved decision is always one of the accepted
   * verdicts. Open holds appear in the live status snapshot and the
   * cross-run `ensemble holds` listing; raise, answer, rejection, and
   * timeout each emit an event and land in the archive's hold_events.
   */
  async raiseHold(options: { content: string; verdicts: string[]; timeoutMs?: number }): Promise<HoldDecision> {
    if (this.#closed) {
      throw new HoldRejectedError("the run is closing; no new holds can be raised");
    }
    this.#holdManager ??= new HoldManager({
      dir: this.#holdsDir,
      runId: this.progress.runId,
      cwd: this.#holdsCwd,
      ...(this.#holdPollIntervalMs !== undefined ? { pollIntervalMs: this.#holdPollIntervalMs } : {}),
      onEvent: (event) => {
        this.#emitEvent(event);
        void this.#recordHoldEventSafely(event);
      },
      onOpen: (hold) => this.progress.noteHoldRaised(hold),
      onSettled: (id) => this.progress.noteHoldSettled(id)
    });
    return this.#holdManager.raise(options);
  }

  /** Same observability contract as agent-record writes: failures surface as events, never as hold failures. */
  async #recordHoldEventSafely(event: RuntimeEvent): Promise<void> {
    try {
      await this.#runRecorder?.recordHoldEvent(event);
    } catch (error) {
      this.#emitEvent({
        method: "runRecord/writeFailed",
        params: { holdEvent: event.method, message: error instanceof Error ? error.message : String(error) },
        receivedAt: Date.now()
      });
    }
  }

  /**
   * Open a multi-turn worker session: one worker, held across turns,
   * with engine, model, and effort fixed for its life. Creation spawns
   * nothing — validation and strip enforcement run here, pre-spawn, and the
   * worker itself starts at the first `send()`. An engine that does not
   * hold sessions (opencode) throws before any worker exists.
   */
  createWorkerSession(options: WorkerSessionOptions): WorkerSession {
    if (this.#closed) {
      throw new SessionClosedError();
    }
    assertValidWorkerSessionOptions(options);
    const engine = this.#engineFor(options.engine);
    if (engine.createSession === undefined) {
      throw new MultiTurnUnsupportedError(engine.name);
    }
    const strip = effectiveStrip(this.#strip, options.strip);
    const stripRoutes = strip.length > 0 ? resolveStripEnforcement(engine.name, engine.capabilities, strip) : null;
    const sessionOptions = strip.length > 0 ? { ...options, strip } : options;

    this.#sessionCounter += 1;
    const state: WorkerSessionState = {
      id: this.#sessionCounter,
      options: sessionOptions,
      engine,
      stripRoutes,
      // The mark's threshold is per engine shape: Claude's is the cliff at
      // its configured (injected) cache TTL, Codex's the measured coin-flip
      // idle point — both overridable as library-level runtime options.
      stalenessThresholdMs:
        engine.name === "claude" ? this.#claudeSessionStaleAfterMs : this.#codexSessionStaleAfterMs,
      markStaleness: sessionOptions.stalenessMark ?? true,
      engineSession: null,
      placement: null,
      turnCount: 0,
      lastTurnEndedAt: null,
      inFlight: false,
      closed: false
    };
    const session = new WorkerSession({
      state,
      now: this.#now,
      sendTurn: (prompt, turn) => this.#runSessionTurn(state, prompt, turn),
      close: () => this.#closeWorkerSession(state)
    });
    this.#workerSessions.add(session);
    return session;
  }

  async #runSessionTurn(state: WorkerSessionState, prompt: string, turn: SessionTurnOptions): Promise<unknown> {
    if (this.#closed || state.closed) {
      throw new SessionClosedError();
    }
    if (state.inFlight) {
      throw new SessionBusyError();
    }
    assertValidAgentPrompt(prompt);
    assertValidSessionTurnOptions(turn);
    if (turn.schema !== undefined) {
      assertCompilableSchema(turn.schema);
    }
    const options = state.options;
    const engine = state.engine;
    state.inFlight = true;
    try {
      // Each turn is its own dispatch: budget admission is judged here, at
      // this send, exactly as for a one-shot call — a held session
      // buys no exemption from the ceiling.
      this.budget.assertCanStart(engine.name);
      const queuedAt = Date.now();
      const agentId = this.progress.queueAgent({
        engine: engine.name,
        label: options.label ?? null,
        phase: options.phase ?? null
      });
      if (engine.name === "claude" && options.model === undefined && state.turnCount === 0) {
        this.#emitEvent({
          method: "claude/unpinnedModel",
          params: { agentId, label: options.label ?? null },
          receivedAt: Date.now()
        });
      }
      const turnNumber = state.turnCount + 1;
      const recordOptions: Partial<AgentOptions> = {
        engine: engine.name,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
        ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.isolation !== undefined ? { isolation: options.isolation } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
        ...(options.phase !== undefined ? { phase: options.phase } : {}),
        ...(turn.schema !== undefined ? { schema: turn.schema } : {}),
        ...(options.strip !== undefined ? { strip: options.strip } : {})
      };
      const agentRecord = this.#newAgentRecord(agentId, engine.name, prompt, recordOptions, state.stripRoutes);
      agentRecord.session = { id: state.id, turn: turnNumber };
      this.#unsettledAgentRecords.set(agentId, { record: agentRecord, stage: "dispatching" });
      try {
        await this.#recordAgentSafely(agentRecord);
        const unsettled = this.#unsettledAgentRecords.get(agentId);
        if (unsettled !== undefined) {
          unsettled.stage = "admitting";
        }
        let started = false;
        try {
          // The engine-cap/ceiling slot spans this turn alone — from here to
          // its settlement — never the session's idle life: an idle held
          // worker costs the machine nothing, and charging it a slot would
          // let loitering fleets starve fresh dispatches.
          return await this.#admission.admit(engine.name, agentId, () =>
            engine.schedule(async () => {
              started = true;
              return this.#executeAgent(
                engine.name,
                { label: options.label ?? null, phase: options.phase ?? null },
                agentId,
                agentRecord,
                queuedAt,
                () => this.#runSessionBody(state, prompt, turn, agentId, agentRecord)
              );
            })
          );
        } catch (error) {
          if (!started) {
            this.progress.settleAgent(agentId, "failed");
            this.#settleTerminalStatus(agentRecord, error);
            agentRecord.queuedMs = Math.max(0, Date.now() - queuedAt);
            agentRecord.executionMs = 0;
            await this.#recordSettlementSafely(agentId, agentRecord);
          }
          throw error;
        }
      } finally {
        this.#unsettledAgentRecords.delete(agentId);
        state.turnCount = turnNumber;
        state.lastTurnEndedAt = this.#now();
      }
    } finally {
      state.inFlight = false;
    }
  }

  async #runSessionBody(
    state: WorkerSessionState,
    prompt: string,
    turn: SessionTurnOptions,
    agentId: number,
    agentRecord: RuntimeAgentRecord
  ): Promise<AgentExecutionResult> {
    const options = state.options;
    // Placement is the session's, opened once at its first turn and closed
    // with the session — a worktree session works one tree for its life.
    state.placement ??= await this.#placement.open({
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.isolation !== undefined ? { isolation: options.isolation } : {})
    });
    agentRecord.resolvedCwd = state.placement.cwd;
    agentRecord.isolation = options.isolation ?? null;
    const createSession = state.engine.createSession;
    if (createSession === undefined) {
      throw new MultiTurnUnsupportedError(state.engine.name);
    }
    state.engineSession ??= createSession.call(
      state.engine,
      this.#engineTurnOptions(
        {
          engine: state.engine.name,
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.effort !== undefined ? { effort: options.effort } : {}),
          ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.strip !== undefined && options.strip.length > 0 ? { strip: options.strip } : {})
        },
        state.placement.cwd
      )
    );
    const invocation = state.engineSession.beginTurn(prompt, {
      ...(turn.schema !== undefined ? { schema: turn.schema } : {})
    });
    const sharedOptions: Partial<AgentOptions> = {
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.model !== undefined ? { model: options.model } : {})
    };
    if (turn.schema !== undefined) {
      return this.#runSchemaAgent(
        state.engine.name,
        invocation,
        { ...sharedOptions, schema: turn.schema },
        agentId,
        agentRecord
      );
    }
    return {
      status: "complete",
      value: await this.#runTextAgent(state.engine.name, invocation, sharedOptions, agentId, agentRecord)
    };
  }

  async #closeWorkerSession(state: WorkerSessionState): Promise<void> {
    if (state.closed) {
      return;
    }
    state.closed = true;
    try {
      await state.engineSession?.close();
    } catch {
      // Session teardown is best-effort: a stop failure must not mask the
      // work the session already returned.
    }
    const placement = state.placement;
    state.placement = null;
    if (placement !== null) {
      try {
        const worktree = await this.#placement.close(placement);
        if (worktree !== null) {
          this.worktrees.push(worktree);
          this.#emitEvent({
            method: "worktree/finished",
            params: {
              path: worktree.path,
              branch: worktree.branch,
              changed: worktree.changed,
              removed: worktree.removed
            },
            receivedAt: Date.now()
          });
        }
      } catch (error) {
        if (placement.worktree !== undefined) {
          // Finalisation did not prove the branch unchanged or removed:
          // retain the recoverable identity conservatively, as agent
          // placement does.
          this.worktrees.push({ ...placement.worktree, tipCommit: null, changed: true, removed: false });
          this.#emitEvent({
            method: "worktree/finalisationFailed",
            params: {
              sessionId: state.id,
              path: placement.worktree.path,
              branch: placement.worktree.branch,
              message: failureFromError(error).message
            },
            receivedAt: Date.now()
          });
        }
      }
    }
  }

  async #runAdmitted(
    engine: EngineAdapter,
    prompt: string,
    options: Partial<AgentOptions>,
    agentId: number,
    agentRecord: RuntimeAgentRecord,
    queuedAt: number
  ): Promise<unknown> {
    let started = false;
    try {
      return await this.#admission.admit(engine.name, agentId, () =>
        engine.schedule(async () => {
          started = true;
          return this.#executeAgent(
            engine.name,
            { label: options.label ?? null, phase: options.phase ?? null },
            agentId,
            agentRecord,
            queuedAt,
            () => this.#runAgent(engine, prompt, options, agentId, agentRecord)
          );
        })
      );
    } catch (error) {
      // A rejection before the task started (admission or scheduler shutdown)
      // bypasses #executeAgent's own settlement: settle the progress entry and
      // persist the record here so a cancelled queued worker is not left
      // counted as queued for ever.
      if (!started) {
        this.progress.settleAgent(agentId, "failed");
        this.#settleTerminalStatus(agentRecord, error);
        agentRecord.queuedMs = Math.max(0, Date.now() - queuedAt);
        agentRecord.executionMs = 0;
        await this.#recordSettlementSafely(agentId, agentRecord);
      }
      throw error;
    }
  }

  async #executeAgent(
    engineName: EngineName,
    identity: { label: string | null; phase: string | null },
    agentId: number,
    agentRecord: RuntimeAgentRecord,
    queuedAt: number,
    run: () => Promise<AgentExecutionResult>
  ): Promise<unknown> {
    const executionStartedAt = Date.now();
    this.progress.startAgent(agentId);
    const executingRecords = this.#executingAgentRecords.get(engineName) ?? new Set<RuntimeAgentRecord>();
    this.#executingAgentRecords.set(engineName, executingRecords);
    executingRecords.add(agentRecord);
    try {
      const execution = await run();
      const outcome = execution.status === "complete" ? "done" : "failed";
      const executionEndedAt = Date.now();
      agentRecord.queuedMs = Math.max(0, executionStartedAt - queuedAt);
      agentRecord.executionMs = Math.max(0, executionEndedAt - executionStartedAt);
      this.progress.settleAgent(agentId, outcome);
      if (outcome === "done") {
        agentRecord.status = "complete";
      } else {
        this.#settleTerminalStatus(agentRecord, null);
      }
      agentRecord.rawOutput = lastRawOutput(agentRecord);
      agentRecord.validatedOutput = execution.value;
      // Retain successful outputs so a timeout can surface completed work.
      // This includes schema-valid JSON null; failure is carried separately
      // by the execution status rather than inferred from the returned value.
      if (outcome === "done") {
        this.#completed.push({
          id: agentId,
          engine: engineName,
          label: identity.label,
          phase: identity.phase,
          output: execution.value
        });
      }
      await this.#recordSettlementSafely(agentId, agentRecord);
      return execution.value;
    } catch (error) {
      const executionEndedAt = Date.now();
      agentRecord.queuedMs = Math.max(0, executionStartedAt - queuedAt);
      agentRecord.executionMs = Math.max(0, executionEndedAt - executionStartedAt);
      this.progress.settleAgent(agentId, "failed");
      this.#settleTerminalStatus(agentRecord, error);
      agentRecord.rawOutput = lastRawOutput(agentRecord);
      agentRecord.validatedOutput = null;
      await this.#recordSettlementSafely(agentId, agentRecord);
      throw error;
    } finally {
      // The most recent settled record, kept for operator diagnosis: an
      // exhausted direct agent's per-attempt evidence is here whether or
      // not a recorder was attached.
      this.#lastSettledAgentRecord = agentRecord;
      executingRecords.delete(agentRecord);
      if (executingRecords.size === 0) {
        this.#executingAgentRecords.delete(engineName);
      }
    }
  }

  /** The last settled agent record, or null before any settlement. */
  lastAgentRecord(): RuntimeAgentRecord | null {
    return this.#lastSettledAgentRecord;
  }

  /**
   * The archive is observability: a bookkeeping failure must not reject (or,
   * on the success path, falsify) the agent whose work it records. Failures
   * surface as an event the CLI logs to stderr.
   */
  async #recordAgentSafely(record: RuntimeAgentRecord): Promise<void> {
    try {
      await this.#runRecorder?.recordAgent(record);
    } catch (error) {
      this.#emitEvent({
        method: "runRecord/writeFailed",
        params: {
          agentId: record.id,
          message: error instanceof Error ? error.message : String(error)
        },
        receivedAt: Date.now()
      });
    }
  }

  async #recordSettlementSafely(agentId: number, record: RuntimeAgentRecord): Promise<void> {
    if (this.#abandonedAgentIds.has(agentId)) {
      return;
    }
    await this.#recordAgentSafely(record);
  }

  /**
   * Outputs of every worker that finished successfully, in completion order.
   * The CLI reads this to assemble a partial result if the whole-workflow
   * timeout fires before the script returns.
   */
  completedOutputs(): readonly CompletedAgentOutput[] {
    return this.#completed;
  }

  async close(status: "failed" | "timed-out" | "interrupted" = "interrupted"): Promise<void> {
    this.#shutdownAgentStatus = status;
    this.#closed = true;
    // Held workers close before the engines: every run end — clean return,
    // failure, timeout, interrupt — must leave no held session live,
    // and the engines' own teardown below is the backstop, not the plan.
    await Promise.allSettled([...this.#workerSessions].map((session) => session.close()));
    this.#workerSessions.clear();
    // Open holds are abandoned with the run: the waits reject, and each
    // wait's own cleanup removes its published hold file.
    this.#holdManager?.close();
    this.#admission.close();
    await Promise.all(
      [...this.#unsettledAgentRecords.values()]
        .filter(({ record, stage }) => stage === "dispatching" && record.status === "in-progress")
        .map(async ({ record }) => {
          // The harness knows only that this leg outlived the run. Keep the
          // dispatch evidence and name that absence of an observed outcome.
          this.#abandonedAgentIds.add(record.id);
          // Keep the dispatch record's evidence (including its empty attempts)
          // and overwrite that one record through the normal writer path.
          record.status = "abandoned";
          await this.#recordAgentSafely(record);
        })
    );
    await this.#engines.close();
  }

  /**
   * The run's own settlement, seen from inside a worker's turn, or null when
   * the engine failed on its own account. A run interrupt or whole-run
   * timeout reaches an in-flight turn as whatever its transport noticed
   * first — a closed app-server, an aborted poll — so that symptom names the
   * run's exit rather than the turn's cause. Agent and attempt both read
   * their cause from here, so a record cannot disagree with its own attempts.
   */
  #runSettlementCause(error: unknown): TerminalErrorRecord | null {
    if (error instanceof EngineShutdownError || (error instanceof AppServerExitedError && this.#closed)) {
      return {
        kind: `run-${this.#shutdownAgentStatus}`,
        message: `the run ended (${this.#shutdownAgentStatus}) while this worker's turn was in flight`
      };
    }
    return null;
  }

  /**
   * Settles a record's terminal status *and* the cause that produced it, so
   * the two can never disagree.
   */
  #settleTerminalStatus(record: RuntimeAgentRecord, error: unknown): void {
    const settlement = this.#runSettlementCause(error);
    if (settlement !== null) {
      record.status = this.#shutdownAgentStatus;
      record.terminationCause = settlement;
      return;
    }
    if (error instanceof TurnTimeoutError) {
      record.status = "timed-out";
      record.terminationCause = { kind: "turn-timeout", message: error.message };
      return;
    }
    const lastFailure = record.attempts.at(-1)?.failure;
    if (lastFailure?.kind.endsWith("-timeout") === true) {
      record.status = "timed-out";
      record.terminationCause = { kind: lastFailure.kind, message: lastFailure.message };
      return;
    }
    record.status = "failed";
    // The attempts array already names an engine failure; a cause here
    // would only restate it, and inventing one where no attempt ran would
    // claim knowledge the runtime does not have.
    record.terminationCause = null;
  }

  async #runAgent(
    engine: EngineAdapter,
    prompt: string,
    options: Partial<AgentOptions>,
    agentId: number,
    agentRecord: RuntimeAgentRecord
  ): Promise<AgentExecutionResult> {
    const placement = await this.#placement.open(options);
    agentRecord.resolvedCwd = placement.cwd;
    agentRecord.isolation = options.isolation ?? null;
    let invocation: EngineInvocation | undefined;
    let completion: AgentExecutionCompletion | undefined;
    try {
      invocation = engine.createInvocation(prompt, this.#engineTurnOptions(options, placement.cwd));
      if (options.schema !== undefined) {
        completion = {
          ok: true,
          execution: await this.#runSchemaAgent(
            engine.name,
            invocation,
            { ...options, schema: options.schema },
            agentId,
            agentRecord
          )
        };
      } else {
        completion = {
          ok: true,
          execution: {
            status: "complete",
            value: await this.#runTextAgent(engine.name, invocation, options, agentId, agentRecord)
          }
        };
      }
    } catch (error) {
      completion = { ok: false, error };
    } finally {
      try {
        try {
          await invocation?.close?.();
        } catch (error) {
          // Preserve the established rule that invocation shutdown replaces
          // the worker completion; finalisation must not replace either one.
          completion = { ok: false, error };
        }
      } finally {
        try {
          const worktree = await this.#placement.close(placement);
          if (worktree !== null) {
            this.#publishWorktree(agentRecord, worktree);
            this.#emitEvent({
              method: "worktree/finished",
              params: {
                path: worktree.path,
                branch: worktree.branch,
                changed: worktree.changed,
                removed: worktree.removed
              },
              receivedAt: Date.now()
            });
          }
        } catch (error) {
          if (placement.worktree !== undefined) {
            // Finalisation did not prove that the branch was unchanged or
            // removed. Retain the recoverable identity conservatively.
            const worktree = {
              ...placement.worktree,
              tipCommit: null,
              changed: true,
              removed: false
            };
            this.#publishWorktree(agentRecord, worktree);
            this.#emitEvent({
              method: "worktree/finalisationFailed",
              params: {
                agentId,
                path: worktree.path,
                branch: worktree.branch,
                message: failureFromError(error).message
              },
              receivedAt: Date.now()
            });
          }
          if (completion?.ok !== false) {
            completion = { ok: false, error };
          }
        }
      }
    }

    if (completion === undefined) {
      throw new Error("agent execution ended without a result");
    }
    if (!completion.ok) {
      throw completion.error;
    }
    return completion.execution;
  }

  #publishWorktree(agentRecord: RuntimeAgentRecord, worktree: IsolatedWorktreeRecord): void {
    this.worktrees.push(worktree);
    agentRecord.worktree = {
      branch: worktree.branch,
      baseCommit: worktree.baseCommit,
      tipCommit: worktree.tipCommit,
      changed: worktree.changed,
      removed: worktree.removed
    };
  }

  async #runTextAgent(
    engine: EngineName,
    invocation: EngineInvocation,
    options: Partial<AgentOptions>,
    agentId: number,
    agentRecord: RuntimeAgentRecord
  ): Promise<string> {
    const maxAttempts = options.maxAttempts ?? this.#defaultMaxAttempts;
    let lastError: Error | null = null;
    let previousFailure: EngineAttemptFailure | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.progress.noteAttempt(agentId, attempt);
      const startedAt = Date.now();
      try {
        const result = await invocation.runAttempt({
          attempt,
          onLiveEvidence: () => this.progress.noteAgentEvidence(agentId),
          ...(previousFailure !== undefined ? { previousFailure } : {})
        });
        this.#recordResolvedCodexDefault(engine, options, agentId, agentRecord, result);
        recordTurnMetadata(agentRecord, result);
        const operationalFailure = recordOperationalFailure(agentRecord, attempt, startedAt, result);
        if (operationalFailure !== undefined) {
          previousFailure = operationalFailure;
          lastError = new EmptyAgentOutputError(previousFailure.message);
          continue;
        }
        const text = result.text.trim();
        if (text.length > 0) {
          agentRecord.attempts.push(attemptRecord(attempt, "complete", null, result.text, result.text, startedAt, result));
          return text;
        }
        previousFailure = {
          kind: "empty-output",
          message: `agent returned empty text on attempt ${attempt}`
        };
        agentRecord.attempts.push(attemptRecord(attempt, "failed", previousFailure, result.text, null, startedAt, result));
        lastError = new EmptyAgentOutputError(previousFailure.message);
      } catch (error) {
        const observed = failureFromError(error);
        // Terminalisation invariant: a failed turn's attempt record carries
        // whatever the worker had said before it died, not a bare null —
        // and how the process died, when the engine observed it.
        //
        // A run that ends under an in-flight turn tears the transport down
        // itself, so the symptom the turn observed ("app-server closed")
        // describes the run's exit and not the attempt's cause. The cause
        // the runtime knows is named as the failure, and the observation is
        // kept beside it rather than published as the reason.
        const settlement = this.#runSettlementCause(error);
        agentRecord.attempts.push(
          attemptRecord(
            attempt,
            "failed",
            settlement ?? observed,
            partialWorkerTextOf(error),
            null,
            startedAt,
            null,
            workerExitStatusOf(error),
            appServerDiagnosticOf(error),
            settlement === null ? null : observed
          )
        );
        if (!isRetryableError(error) || attempt === maxAttempts) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new EmptyAgentOutputError("agent returned empty text");
  }

  async #runSchemaAgent(
    engine: EngineName,
    invocation: EngineInvocation,
    options: Partial<AgentOptions> & { schema: JsonSchema },
    agentId: number,
    agentRecord: RuntimeAgentRecord
  ): Promise<AgentExecutionResult> {
    const maxAttempts = options.maxAttempts ?? this.#defaultMaxAttempts;
    let previousFailure: EngineAttemptFailure | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.progress.noteAttempt(agentId, attempt);
      const startedAt = Date.now();
      try {
        const result = await invocation.runAttempt({
          attempt,
          onLiveEvidence: () => this.progress.noteAgentEvidence(agentId),
          ...(previousFailure !== undefined ? { previousFailure } : {})
        });
        this.#recordResolvedCodexDefault(engine, options, agentId, agentRecord, result);
        recordTurnMetadata(agentRecord, result);
        const operationalFailure = recordOperationalFailure(agentRecord, attempt, startedAt, result);
        if (operationalFailure !== undefined) {
          previousFailure = operationalFailure;
          continue;
        }
        // A silent worker (timeout, hang) is not a JSON problem: label it
        // empty-output so records and retry nudges point at the real failure.
        if (result.text.trim().length === 0) {
          previousFailure = {
            kind: "empty-output",
            message: `agent returned empty text on attempt ${attempt}`
          };
          agentRecord.attempts.push(attemptRecord(attempt, "failed", previousFailure, result.text, null, startedAt, result));
          continue;
        }
        const selection = selectLastValidJsonFromText(result.text, options.schema);
        if (selection.kind === "invalid-json") {
          previousFailure = {
            kind: "invalid-json",
            message: "agent output did not contain parseable JSON"
          };
          agentRecord.attempts.push(attemptRecord(attempt, "failed", previousFailure, result.text, null, startedAt, result));
          continue;
        }
        if (selection.kind === "valid") {
          agentRecord.parseRoute = selection.parsed.source;
          agentRecord.attempts.push(
            attemptRecord(attempt, "complete", null, result.text, selection.parsed.value, startedAt, result)
          );
          return {
            status: "complete",
            value: selection.parsed.value
          };
        }
        previousFailure = {
          kind: "schema-validation",
          message: JSON.stringify(selection.validation.errors ?? [])
        };
        agentRecord.attempts.push(attemptRecord(attempt, "failed", previousFailure, result.text, null, startedAt, result));
      } catch (error) {
        const observed = failureFromError(error);
        // Terminalisation invariant: a failed turn's attempt record carries
        // whatever the worker had said before it died, not a bare null —
        // and how the process died, when the engine observed it.
        //
        // A run that ends under an in-flight turn tears the transport down
        // itself, so the symptom the turn observed ("app-server closed")
        // describes the run's exit and not the attempt's cause. The cause
        // the runtime knows is named as the failure, and the observation is
        // kept beside it rather than published as the reason.
        const settlement = this.#runSettlementCause(error);
        agentRecord.attempts.push(
          attemptRecord(
            attempt,
            "failed",
            settlement ?? observed,
            partialWorkerTextOf(error),
            null,
            startedAt,
            null,
            workerExitStatusOf(error),
            appServerDiagnosticOf(error),
            settlement === null ? null : observed
          )
        );
        if (!isRetryableError(error) || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    return {
      status: "failed",
      value: null
    };
  }

  #emitEvent(event: RuntimeEvent): void {
    for (const listener of this.#eventListeners) {
      listener(event);
    }
  }

  #recordResolvedCodexDefault(
    engine: EngineName,
    options: Partial<AgentOptions>,
    agentId: number,
    record: RuntimeAgentRecord,
    result: TurnResult
  ): void {
    if (engine !== "codex" || options.model !== undefined || record.resolvedModel !== null || result.resolvedModel === undefined) {
      return;
    }
    this.#emitEvent({
      method: "codex/unpinnedModelResolved",
      params: {
        agentId,
        label: options.label ?? null,
        model: result.resolvedModel,
        effort: result.resolvedEffort ?? null
      },
      receivedAt: Date.now()
    });
  }

  #registerEngineCaps(): void {
    for (const name of this.#engines.names()) {
      const adapter = this.#engines.get(name);
      if (adapter !== undefined) {
        this.progress.registerEngine(name, adapter.concurrency);
      }
    }
  }

  #engineCaps(): ReadonlyMap<EngineName, number> {
    const caps = new Map<EngineName, number>();
    for (const name of this.#engines.names()) {
      const adapter = this.#engines.get(name);
      if (adapter !== undefined) {
        caps.set(name, adapter.concurrency);
      }
    }
    return caps;
  }

  #engineFor(engine: unknown): EngineAdapter {
    if (engine === undefined) {
      throw new MissingEngineError();
    }
    if (typeof engine !== "string") {
      throw new UnknownEngineError(engine);
    }
    const adapter = this.#engines.get(engine as EngineName);
    if (adapter === undefined) {
      throw new UnknownEngineError(engine);
    }
    return adapter;
  }

  #engineTurnOptions(options: Partial<AgentOptions>, cwd: string): EngineTurnOptions {
    const resolvedTimeoutMs = options.timeoutMs ?? this.#defaultTurnTimeoutMs;
    return {
      ...(resolvedTimeoutMs !== undefined ? { timeoutMs: resolvedTimeoutMs } : {}),
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
      ...(options.strip !== undefined && options.strip.length > 0 ? { strip: options.strip } : {}),
      cwd
    };
  }

  #newAgentRecord(
    id: number,
    engine: EngineName,
    prompt: string,
    options: Partial<AgentOptions>,
    stripRoutes: Partial<Record<StrippableCapability, DischargedEnforcement>> | null = null
  ): RuntimeAgentRecord {
    return {
      id,
      engine,
      prompt,
      options: {
        timeoutMs: options.timeoutMs ?? this.#defaultTurnTimeoutMs ?? null,
        maxAttempts: options.maxAttempts ?? this.#defaultMaxAttempts
      },
      model: typeof options.model === "string" ? options.model : null,
      effort: typeof options.effort === "string" ? options.effort : null,
      fallbackModel: typeof options.fallbackModel === "string" ? options.fallbackModel : null,
      resolvedModel: null,
      resolvedEffort: null,
      resolvedCwd: resolveAgentCwd(this.#placement.baseCwd, options.cwd),
      isolation: options.isolation ?? null,
      worktree: null,
      label: options.label ?? null,
      phase: options.phase ?? null,
      status: "in-progress",
      terminationCause: null,
      creationOrder: id,
      concurrencyGroup: engine,
      schema: options.schema ?? null,
      strip:
        stripRoutes === null || options.strip === undefined
          ? null
          : { requested: [...options.strip], enforcement: stripRoutes },
      session: null,
      parseRoute: null,
      decodeFailure: null,
      rawOutput: null,
      validatedOutput: null,
      queuedMs: 0,
      executionMs: 0,
      attempts: []
    };
  }
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<EnsembleRuntime> {
  return EnsembleRuntime.create(options);
}

export function defaultConcurrency(): number {
  return defaultCodexConcurrency();
}

export type { Budget, TokenUsageEvent };

function isRetryableError(error: unknown): boolean {
  return (
    error instanceof AppServerBackpressureError ||
    error instanceof AppServerOverloadedError ||
    error instanceof AppServerRetryPromiseBrokenError
  );
}

function requireTransport(transport: RuntimeTransport | undefined): RuntimeTransport {
  if (transport === undefined) {
    throw new Error("EnsembleRuntime requires either engines or a Codex transport");
  }
  return transport;
}

function attemptRecord(
  attempt: number,
  status: "complete" | "failed",
  failure: { kind: string; message: string } | null,
  rawOutput: string | null,
  validatedOutput: unknown,
  startedAtMs: number,
  result: Pick<
    TurnResult,
    | "durationMs"
    | "firstDeltaMs"
    | "tokenUsageEvents"
    | "transcripts"
    | "diagnostics"
    | "resolvedModel"
    | "resolvedEffort"
  > | null,
  workerExit: { exitCode: number | null; signal: string | null } | null = null,
  appServerDiagnostic: RuntimeAgentAttemptRecord["appServerDiagnostic"] = null,
  observedFailure: { kind: string; message: string } | null = null
): RuntimeAgentAttemptRecord {
  const endedAt = new Date();
  return {
    attempt,
    status,
    failure,
    observedFailure,
    workerExit,
    appServerDiagnostic,
    rawOutput,
    validatedOutput,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: endedAt.toISOString(),
    // Per-attempt served-model identity: retries can open fresh threads that
    // resolve differently, so each attempt keeps its own answer rather than
    // inheriting the agent-level last-write-wins field.
    resolvedModel: result?.resolvedModel ?? null,
    resolvedEffort: result?.resolvedEffort ?? null,
    // Engines that time their own turn say so; for the rest the attempt
    // already holds both endpoints, and a null beside them would be the
    // record discarding a figure it holds.
    durationMs: result?.durationMs ?? Math.max(0, endedAt.getTime() - startedAtMs),
    firstDeltaMs: result?.firstDeltaMs ?? null,
    tokenUsageEvents: result?.tokenUsageEvents ?? [],
    transcripts: result?.transcripts ?? [],
    diagnostics: result?.diagnostics ?? {}
  };
}

function recordTurnMetadata(record: RuntimeAgentRecord, result: TurnResult): void {
  if (result.resolvedModel !== undefined) {
    record.resolvedModel = result.resolvedModel;
  }
  if (result.resolvedEffort !== undefined) {
    record.resolvedEffort = result.resolvedEffort;
  }
}

function recordOperationalFailure(
  record: RuntimeAgentRecord,
  attempt: number,
  startedAtMs: number,
  result: EngineAttemptResult
): EngineAttemptFailure | undefined {
  if (result.attemptFailure === undefined) {
    return undefined;
  }
  record.attempts.push(
    attemptRecord(
      attempt,
      "failed",
      result.attemptFailure,
      result.text,
      null,
      startedAtMs,
      result,
      result.workerExit ?? null
    )
  );
  return result.attemptFailure;
}

function failureFromError(error: unknown): { kind: string; message: string } {
  return describeError(error);
}

function lastRawOutput(record: RuntimeAgentRecord): string | null {
  for (let index = record.attempts.length - 1; index >= 0; index -= 1) {
    const rawOutput = record.attempts[index]?.rawOutput;
    if (rawOutput !== undefined && rawOutput !== null) {
      return rawOutput;
    }
  }
  return null;
}

function decodeFailureDiagnosticFromParams(params: JsonObject): { byteLength: number; linePrefix: string } | null {
  return typeof params.byteLength === "number" && typeof params.linePrefix === "string"
    ? { byteLength: params.byteLength, linePrefix: params.linePrefix }
    : null;
}
