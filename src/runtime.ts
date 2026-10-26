import { randomUUID } from "node:crypto";

import { AgentPlacementManager, resolveAgentCwd } from "./agent-placement.js";
import { AdmissionController } from "./admission.js";
import { TokenBudget, tokenUsageEventFromParams } from "./budget.js";
import { assertValidStripOption, effectiveStrip, resolveStripEnforcement } from "./capability-stripping.js";
import { classifyAttemptFailure } from "./failure-classification.js";
import { resolveEffort } from "./effort-resolution.js";

import type { DischargedEnforcement } from "./capability-stripping.js";
import type { CanonicalEffort, EffortResolution, EffortSettings } from "./effort-resolution.js";
import { harnessVersion } from "./harness-version.js";
import {
  assertValidAgentOptions,
  assertValidSessionTurnOptions,
  assertValidWorkerSessionOptions,
  snapshotAgentCwd
} from "./engine-option-validation.js";
import {
  AppServerExitedError,
  AgentPromptRejectedError,
  EngineShutdownError,
  FallbackTargetRejectedError,
  HoldRejectedError,
  MissingEngineError,
  MultiTurnUnsupportedError,
  CodexSchemaSubsetUnsupportedError,
  PreSpawnAuthorError,
  SessionBusyError,
  SessionClosedError,
  TallyRejectedError,
  appServerDiagnosticOf,
  attachAgentIdentity,
  describeError,
  failedTurnResultOf,
  firstDeltaMsOf,
  partialWorkerTextOf,
  partialTranscriptOf,
  SubstrateRefusedError,
  TurnTimeoutError,
  UnknownEngineError,
  workerExitStatusOf
} from "./errors.js";
import { CLAUDE_CACHE_TTL_VARIABLE } from "./claude-control-plane.js";
import { claudeCacheTtlToMs } from "./claude-engine.js";
import { HoldManager, defaultHoldsDirectory, resolveHoldScope } from "./holds.js";
import { presentOperationalError } from "./operator-diagnosis.js";
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
  FallbackTarget,
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
  PreviousAttemptFailure,
  EngineAttemptResult,
  EngineInvocation,
  EngineTurnOptions,
  EngineWorkerSession
} from "./engines.js";
import type { AgentPlacement } from "./agent-placement.js";
import type { StrippableCapability } from "./capability-stripping.js";
import type { FailureClassification } from "./failure-classification.js";
import type {
  ChainDecision,
  RunRecordWriter,
  RuntimeAgentAttemptRecord,
  RuntimeAgentRecord,
  TerminalErrorRecord
} from "./run-record.js";
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
  /**
   * The thrown error that spent the bound's last attempt, when the
   * exhausting failure was a throw rather than a bad answer: the
   * settlement reads its deadline kind and the notice renders its
   * diagnosis, exactly as for a single-attempt throw. Absent when the last
   * attempt answered badly.
   */
  cause?: unknown;
}

/**
 * What one target's bounded attempts settle to. Beside the two settled
 * outcomes, `refused` is the fallback chain's signal: the target failed for
 * availability while a chain entry remained, so the loop stopped without
 * consuming an attempt and the call moves to the next target.
 */
type AgentExecutionOutcome = AgentExecutionResult | { status: "refused" };

/**
 * Where a call's dispatch stands on its fallback chain: `entry` is -1 for
 * the call's own target and the chain index thereafter. Every attempt
 * record names the target it was dispatched to, and the agent record names
 * the one that answered.
 */
interface ChainTarget {
  entry: number;
  engine: EngineName;
  model: string | undefined;
  /** The canonical level this target was asked for (the entry's own, else the call's). */
  effort: string | undefined;
  /**
   * How `effort` was resolved for this target, written by the dispatch
   * that resolved it so every attempt record on the target carries it:
   * null until then, or where the target pinned no effort or its engine
   * is exempt (opencode, judged against its registry variants).
   */
  resolution: EffortResolution | null;
}

/**
 * The attempt bound shared across every target one call dispatches to:
 * `maxAttempts` counts *answered* attempts, so an availability refusal that
 * advances the chain consumes none, while `dispatched` numbers every
 * attempt record the call writes, refused ones included.
 */
interface AttemptLedger {
  readonly maxAttempts: number;
  dispatched: number;
  answered: number;
}

/** The chain position a target's attempt loop writes its records against. */
interface TargetAttempts {
  target: ChainTarget;
  ledger: AttemptLedger;
  /** Whether a later chain entry exists — the condition under which an availability failure is a refusal rather than a settled failure. */
  chainRemains: boolean;
}

/**
 * A cross-engine chain step crossing the admission boundary: the refused
 * target's admitted task ends (releasing its cap and ceiling slot) and the
 * leg is re-admitted afresh on `engine`. A class rather than a shape so a
 * worker's own output can never be mistaken for it.
 */
class ChainAdvance {
  constructor(readonly engine: EngineName) {}
}

/** The call's own target followed by its declared chain, an omitted entry effort taking the call's own. */
function chainTargets(
  engine: EngineName,
  options: { model?: string; effort?: string; fallback?: FallbackTarget[] }
): ChainTarget[] {
  return [
    { entry: -1, engine, model: options.model, effort: options.effort, resolution: null },
    ...(options.fallback ?? []).map((target, index) => ({
      entry: index,
      engine: target.engine,
      model: target.model,
      effort: target.effort ?? options.effort,
      resolution: null
    }))
  ];
}

/**
 * The same options with no chain declared: a held session's later turns run
 * their own target only. A view over the author's object, not a copy, for
 * the reason `optionsForTarget` gives.
 */
function withoutChain<T extends { fallback?: FallbackTarget[] }>(options: T): T {
  return new Proxy(options, {
    get(source, property, receiver) {
      return property === "fallback" ? undefined : Reflect.get(source, property, receiver);
    }
  });
}

/**
 * The call's options re-pointed at one chain target: engine, model, and
 * effort are the target's; everything else rides unchanged. The call's own
 * target is the options object itself, and a chain entry's view is a Proxy
 * over it rather than a copy — a copy would drop options an author's
 * accessor or Proxy trap supplies (the same discipline as
 * `snapshotAgentCwd`), and `in`/`ownKeys` keep answering as the author's
 * object does.
 */
function optionsForTarget<T extends { engine?: EngineName; model?: string; effort?: string }>(options: T, target: ChainTarget): T {
  if (target.entry === -1) {
    return options;
  }
  const overrides: Record<string, unknown> = { engine: target.engine, model: target.model, effort: target.effort };
  return new Proxy(options, {
    get(source, property, receiver) {
      return typeof property === "string" && property in overrides ? overrides[property] : Reflect.get(source, property, receiver);
    }
  });
}

interface UnsettledAgentRecord {
  record: RuntimeAgentRecord;
  stage: "dispatching" | "admitting";
}

/**
 * The promise `agent()` hands the script — the exact object, so marking it
 * handled reaches what the script holds. Null until the call is created:
 * `agent()` starts the leg's async settlement and only then has the
 * promise. Open from creation to settlement in `#openCalls`, which covers
 * the window before the leg registers (a per-call `cwd` check awaits before
 * registration) as well as after.
 */
interface AgentCall {
  outward: Promise<unknown> | null;
}

/**
 * The run's worker tally at shutdown, as a partition: every leg the run ever
 * dispatched lands in exactly one bucket, and each bucket names what the
 * leg's durable record says.
 */
export interface ShutdownTally {
  /** Settled on their own account, successfully. */
  done: number;
  /** Settled on their own account, with a failure. */
  failed: number;
  /**
   * Cut short by the run ending: teardown settled them with the run's own
   * shutdown status (`interrupted` after a clean body, `timed-out`,
   * `failed`) — whether their turn was on the wire at an engine or still
   * queued at admission when the run ended. A leg that outraces teardown
   * and settles on its own account while it runs lands in `done`/`failed`
   * instead: every bucket says what the leg's durable record says.
   */
  cutShort: number;
  /** The records close() abandons: dispatched, with no outcome ever observed. */
  unsettled: number;
}

/**
 * Why the run is closing. `run-ended`: the run itself ended — failed, timed
 * out, or interrupted — and its in-flight legs are torn down with it.
 * `body-returned`: the script body returned with legs still in flight, so
 * the run completed on its own account and the legs are torn down because
 * nothing awaited them. A leg keeps the `interrupted` status and
 * `run-interrupted` cause either way; the cause's message names which, so
 * the agent record read alone never says a run that the body ended was
 * interrupted. The message states the return, never the run's outcome —
 * the manifest says that, and a teardown failure after the return can
 * still seal it `failed`.
 */
export type RunCloseOccasion = "run-ended" | "body-returned";

/** How far a leg had got when the run's close settled it. */
type CloseStage = "in-flight" | "queued" | "dispatching";

/** The cause message's account of the leg, by how far it got, when the run itself ended. */
const RUN_ENDED_LEG: Record<CloseStage, string> = {
  "in-flight": "while this worker's turn was in flight",
  queued: "before this worker's queued turn was dispatched",
  dispatching: "before this worker's dispatch record landed, so no outcome was observed"
};

/** The same account when the body returned without awaiting the leg. */
const BODY_RETURNED_LEG: Record<CloseStage, string> = {
  "in-flight": "its turn was cut short in flight",
  queued: "its queued turn was never dispatched",
  dispatching: "its dispatch record was still landing, so no outcome was observed"
};
const BODY_RETURNED = "the script returned without awaiting this worker";

/** One leg the run's ending left unfinished, as `unfinishedLegs()` reports it. */
export interface UnfinishedLeg {
  id: number;
  label: string | null;
  disposition: "cut-short" | "abandoned";
}

type AgentExecutionCompletion =
  | { ok: true; execution: AgentExecutionOutcome }
  | { ok: false; error: unknown };

/** A worker session's runtime-internal state, owned by EnsembleRuntime. */
interface WorkerSessionState {
  id: number;
  options: WorkerSessionOptions;
  engine: EngineAdapter;
  /**
   * The served identity learned when this held session first reaches its
   * engine. Codex keeps one thread across turns, so later records inherit
   * this observed answer rather than pretending that a follow-up turn has
   * not resolved its already-created worker.
   */
  resolvedModel: string | null;
  resolvedEffort: string | null;
  /** The resolution the session's effort was dispatched under, fixed at its creation. */
  effortResolution: EffortResolution | null;
  stripRoutes: Partial<Record<StrippableCapability, DischargedEnforcement>> | null;
  stalenessThresholdMs: number;
  markStaleness: boolean;
  engineSession: EngineWorkerSession | null;
  placement: AgentPlacement | null;
  turnCount: number;
  lastTurnEndedAt: number | null;
  inFlight: boolean;
  /** The unsettled send, so close() can await it before finalising the placement. */
  pendingTurn: Promise<unknown> | null;
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
   * The idle gap at which this session reads stale: the resolved runtime
   * option, or — on Claude — the machine-declared cache TTL when one
   * overrides the injected default, so the mark and the cache expire on
   * one clock.
   */
  get staleAfterMs(): number {
    return this.#state.stalenessThresholdMs;
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
  send(prompt: string, turn?: SessionTurnOptions & { schema?: undefined }): Promise<string | null>;
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
  /** The machine's effort bounds and served-level maps, applied per dispatch. */
  #effortSettings: EffortSettings;
  #eventListeners = new Set<RuntimeEventListener>();
  #completed: CompletedAgentOutput[] = [];
  #runRecorder: RunRecordWriter | null = null;
  #executingAgentRecords = new Map<EngineName, Set<RuntimeAgentRecord>>();
  // Every dispatched record remains here until its own agent() call settles.
  // close() uses this to terminalise work a run ended before
  // the normal per-agent settlement path could run.
  #unsettledAgentRecords = new Map<number, UnsettledAgentRecord>();
  /** close()'s settlement barrier: per-leg waiters resolved by #noteAgentSettled. */
  #settlementWaiters = new Map<number, Array<() => void>>();
  // Once close() has made the only honest terminal transition for a record,
  // late shutdown rejections must not overwrite it with an invented outcome.
  #abandonedAgentIds = new Set<number>();
  #shutdownAgentStatus: "failed" | "timed-out" | "interrupted" = "interrupted";
  #closeOccasion: RunCloseOccasion = "run-ended";
  // The worker tally close() publishes once teardown has settled every
  // classified leg — derived from the records' final dispositions behind
  // the settlement barrier, so it is determinate without racing whichever
  // straggler lands first, and it never disagrees with the archive.
  #shutdownTally: ShutdownTally | null = null;
  #unfinishedLegs: readonly UnfinishedLeg[] = [];
  /**
   * Every `agent()` call from creation to settlement. close() marks each
   * one's promise handled before any teardown: a leg the run's own ending
   * cuts short rejects with that ending, and a script that returned without
   * awaiting the call is not listening — the rejection is the launcher's
   * teardown reaching an abandoned call, never an exception for the
   * launcher to report. A caller still awaiting the leg sees the rejection
   * exactly as before. After close every rejection of an abandoned call is
   * silent by design — the leg's record and the tally carry its settlement,
   * the launcher's process does not. A session turn needs no entry:
   * `sendTurn`'s own bookkeeping already attaches a handler to each turn's
   * promise.
   */
  #openCalls = new Set<AgentCall>();
  /** The first close() call's run, latched so later calls join it. */
  #closeRun: Promise<void> | null = null;
  #closed = false;
  #workerSessions = new Set<WorkerSession>();
  #sessionCounter = 0;
  /** Injectable clock (tests): drives the staleness mark's idle reading. */
  #now: () => number;
  #holdManager: HoldManager | null = null;
  #lastSettledAgentRecord: RuntimeAgentRecord | null = null;
  #holdsDir: string;
  #holdScope: string | null;
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
    effortSettings?: EffortSettings;
    claudeSessionStaleAfterMs?: number;
    codexSessionStaleAfterMs?: number;
    holdsDir?: string;
    holdScope?: string;
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
    this.#effortSettings = options.effortSettings ?? {};
    this.budget = new TokenBudget(options.budgetCeilings);
    this.progress = new RunProgress({
      runId: options.runId ?? randomUUID(),
      budget: this.budget,
      ...(options.now !== undefined ? { now: options.now } : {})
    });
    this.#defaultTurnTimeoutMs = options.defaultTurnTimeoutMs;
    this.#defaultMaxAttempts = options.defaultMaxAttempts;
    // 1 hour on both by default: Claude's is the injected cache TTL's
    // cliff, Codex's the measured 60-minute coin-flip point — numerically
    // equal, semantically distinct knobs.
    this.#claudeSessionStaleAfterMs = options.claudeSessionStaleAfterMs ?? 3_600_000;
    this.#codexSessionStaleAfterMs = options.codexSessionStaleAfterMs ?? 3_600_000;
    this.#now = options.now ?? (() => Date.now());
    this.#holdsDir = options.holdsDir ?? defaultHoldsDirectory();
    rejectBlankHoldScope(options.holdScope);
    // Library option outranks the inherited environment variable; neither
    // lands the run's holds in the default shared scope.
    this.#holdScope = resolveHoldScope(options.holdScope, process.env);
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
    // Judged before any engine substrate is built, and resolved here for
    // the Claude control plane that delivers the scope to worker sessions
    // (the constructor resolves the same option for its own hold manager —
    // one function, `resolveHoldScope`, at the runtime boundary). Resolving
    // inside the control plane would read the environment alone and lose
    // the explicit option's precedence.
    rejectBlankHoldScope(options.holdScope);
    const holdScope = resolveHoldScope(options.holdScope, process.env);
    const engines = await createDefaultEngineRegistry({
      cwd,
      codexBin: options.codexBin ?? "codex",
      holdScope,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      ...(options.retryPromiseSilenceTimeoutMs !== undefined
        ? { retryPromiseSilenceTimeoutMs: options.retryPromiseSilenceTimeoutMs }
        : {}),
      ...(options.firstOutputTimeoutMs !== undefined ? { firstOutputTimeoutMs: options.firstOutputTimeoutMs } : {}),
      ...(options.workerEnvironment !== undefined ? { workerEnvironment: options.workerEnvironment } : {}),
      ...(options.openCodeModels !== undefined ? { openCodeModels: options.openCodeModels } : {}),
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
      ...(options.holdScope !== undefined ? { holdScope: options.holdScope } : {}),
      ...(options.holdPollIntervalMs !== undefined ? { holdPollIntervalMs: options.holdPollIntervalMs } : {}),
      ...(options.strip !== undefined ? { strip: options.strip } : {}),
      ...(options.effortSettings !== undefined ? { effortSettings: options.effortSettings } : {}),
      // The staleness cliff tracks the *effective* TTL: an explicit option
      // wins, else a machine-declared TTL for the Claude workers (which
      // outranks the injected 1h in the settings file) sets the cliff, else
      // the injected default's hour — never two silently different clocks.
      ...(options.claudeSessionStaleAfterMs !== undefined
        ? { claudeSessionStaleAfterMs: options.claudeSessionStaleAfterMs }
        : declaredClaudeTtlMs(options.workerEnvironment) !== null
          ? { claudeSessionStaleAfterMs: declaredClaudeTtlMs(options.workerEnvironment) as number }
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

  /**
   * Record a named count from the script body into the run record.
   * The runtime validates the shape — a non-empty name, a finite number —
   * and stores the value verbatim beside the usage summary; a name
   * recorded again replaces its value. Meaning is the author's alone. A
   * recorder write failure is observability, never a script failure, on
   * the same contract as agent records.
   */
  async recordTally(name: string, value: number): Promise<void> {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TallyRejectedError(`the tally name must be a non-empty string, got ${JSON.stringify(name)}`);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TallyRejectedError(`the tally value for ${JSON.stringify(name)} must be a finite number, got ${String(value)}`);
    }
    try {
      await this.#runRecorder?.recordTally(name, value);
    } catch (error) {
      this.#emitEvent({
        method: "runRecord/writeFailed",
        params: { tally: name, message: error instanceof Error ? error.message : String(error) },
        receivedAt: Date.now()
      });
    }
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
  async agent(prompt: string, options: AgentOptions & { schema?: undefined }): Promise<string | null>;
  async agent(prompt: string, options: Partial<AgentOptions>): Promise<string | unknown | null>;
  agent(prompt: string, options: Partial<AgentOptions> = {}): Promise<string | unknown | null> {
    // The call's settlement runs as one async body, and the promise that
    // body returns is the one the script holds — recorded on the leg's
    // entry as the body creates it, so close() can mark it handled when the
    // run's ending cuts the leg short. Not an `async` method itself: an
    // async wrapper would hand the script a different promise from the one
    // the entry records.
    const call: AgentCall = { outward: null };
    this.#openCalls.add(call);
    call.outward = this.#agentCall(prompt, options).finally(() => {
      this.#openCalls.delete(call);
    });
    return call.outward;
  }

  async #agentCall(prompt: string, options: Partial<AgentOptions>): Promise<string | unknown | null> {
    if (this.#closed) {
      throw new Error("EnsembleRuntime is closed");
    }
    assertValidAgentPrompt(prompt);
    // `cwd` is read here and nowhere else on this path: what follows works
    // from the snapshot this returns, so the value the placement check
    // judges is the value the dispatch record and the opened placement use.
    options = snapshotAgentCwd(options);
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
    // author believes is in force but is not. A chain target is a
    // dispatch on its own engine, so the same judgement is made for each
    // entry now, before anything is paid for — a strip the fallback engine
    // cannot enforce must not surface on the day the chain first advances.
    const strip = effectiveStrip(this.#strip, options.strip);
    const stripRoutes = strip.length > 0 ? resolveStripEnforcement(engine.name, engine.capabilities, strip) : null;
    for (const target of options.fallback ?? []) {
      const targetEngine = this.#chainEngineFor(target);
      if (strip.length > 0) {
        resolveStripEnforcement(targetEngine.name, targetEngine.capabilities, strip);
      }
    }
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
    const unsettled: UnsettledAgentRecord = { record: agentRecord, stage: "dispatching" };
    this.#unsettledAgentRecords.set(agentId, unsettled);
    // Dispatch-time record: persisted in-progress before the engine is
    // called, so a worker that dies uncleanly still leaves evidence it was
    // asked. Settlement overwrites this same record (last write wins).
    try {
      await this.#recordAgentSafely(agentRecord);
      unsettled.stage = "admitting";
      const output = await this.#runAdmitted(engine, prompt, dispatchOptions, agentId, agentRecord, queuedAt);
      if (options.identity === true) {
        // Identified resolution (opt-in): the envelope wraps every
        // resolution, a schema call's null collapse included, so a fan-in
        // that keeps the envelope still knows which worker failed — and
        // `failure` discriminates: null exactly when the settlement
        // completed, so a worker's genuine null answer and an exhausted
        // collapse never read alike. The durable record is unchanged — it
        // already carries label and phase as first-class fields.
        const failure =
          agentRecord.status === "complete" ? null : { message: settledFailureMessage(agentRecord) };
        return { label: options.label ?? null, phase: options.phase ?? null, output, failure };
      }
      return output;
    } catch (error) {
      if (options.identity === true) {
        // An identified call keeps its identity through operational failure:
        // the combinators' collapse reads this carrier and resolves
        // the failure-bearing envelope instead of bare null. A non-Error
        // rejection cannot carry the property, so it is wrapped — losing
        // the discrimination to a rejection's spelling would re-open the
        // silent-empty-success case. The call's own contract is otherwise
        // unchanged — the error still propagates.
        const carrier = error instanceof Error ? error : new Error(String(error), { cause: error });
        attachAgentIdentity(carrier, { label: options.label ?? null, phase: options.phase ?? null });
        throw carrier;
      }
      throw error;
    } finally {
      this.#noteAgentSettled(agentId);
    }
  }

  /**
   * Raise a hold and await its decision: the hold's content and
   * accepted verdicts are published under the run's launcher-supplied scope
   * in the shared holds root, any process — the launcher or not, alive at
   * raise time or not — writes the decision file the record names, nonce
   * correlation rejects stale answers, and the resolved decision is always
   * one of the accepted verdicts. Open holds appear in the live status
   * snapshot and the `ensemble holds` listings (the run's own scope, or
   * machine-wide); raise, answer, rejection, timeout, and dead-raiser
   * retirement each emit an event and land in the archive's hold_events.
   */
  async raiseHold(options: { content: string; verdicts: string[]; timeoutMs?: number }): Promise<HoldDecision> {
    if (this.#closed) {
      throw new HoldRejectedError("the run is closing; no new holds can be raised");
    }
    this.#holdManager ??= new HoldManager({
      dir: this.#holdsDir,
      runId: this.progress.runId,
      cwd: this.#holdsCwd,
      scope: this.#holdScope,
      ...(this.#holdPollIntervalMs !== undefined ? { pollIntervalMs: this.#holdPollIntervalMs } : {}),
      onEvent: (event) => {
        this.#emitEvent(event);
        void this.#recordHoldEventSafely(event);
      },
      identity: () => {
        const snapshot = this.progress.snapshot();
        return {
          workflow: snapshot.workflow,
          phase: snapshot.currentPhase,
          archive_path: this.#runRecorder?.archiveDir ?? null,
          totals: { ...snapshot.totals }
        };
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
    // The creating turn's chain targets are dispatches of their own:
    // each must hold sessions and enforce the strip, judged now.
    for (const target of options.fallback ?? []) {
      const targetEngine = this.#chainEngineFor(target);
      if (targetEngine.createSession === undefined) {
        throw new MultiTurnUnsupportedError(targetEngine.name);
      }
      if (strip.length > 0) {
        resolveStripEnforcement(targetEngine.name, targetEngine.capabilities, strip);
      }
    }
    const sessionOptions = strip.length > 0 ? { ...options, strip } : options;

    this.#sessionCounter += 1;
    const state: WorkerSessionState = {
      id: this.#sessionCounter,
      options: sessionOptions,
      engine,
      resolvedModel: null,
      resolvedEffort: null,
      effortResolution: null,
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
      pendingTurn: null,
      closed: false
    };
    const session = new WorkerSession({
      state,
      now: this.#now,
      sendTurn: (prompt, turn) => {
        const pending = this.#runSessionTurn(state, prompt, turn);
        state.pendingTurn = pending;
        void pending.catch(() => undefined).finally(() => {
          if (state.pendingTurn === pending) {
            state.pendingTurn = null;
          }
        });
        return pending;
      },
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
        // The chain is the creating turn's alone: a later turn's
        // record declares none, because none applied to it.
        ...(options.fallback !== undefined && state.turnCount === 0 ? { fallback: options.fallback } : {}),
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
      // The engine exposes the served model and effort when its held worker
      // first starts. Every later turn is still on that worker, so carry the
      // observed session identity into its dispatch-time record rather than
      // making archive consumers infer it from turn one.
      agentRecord.resolvedModel = state.resolvedModel;
      agentRecord.resolvedEffort = state.resolvedEffort;
      agentRecord.session = { id: state.id, turn: turnNumber };
      const unsettled: UnsettledAgentRecord = { record: agentRecord, stage: "dispatching" };
      this.#unsettledAgentRecords.set(agentId, unsettled);
      try {
        await this.#recordAgentSafely(agentRecord);
        unsettled.stage = "admitting";
        try {
          // The engine-cap/ceiling slot spans this turn alone — from here to
          // its settlement — never the session's idle life: an idle held
          // worker costs the machine nothing, and charging it a slot would
          // let loitering fleets starve fresh dispatches. The
          // fallback chain applies to the creating turn alone: once a
          // target answers, the session's engine and model are fixed for
          // its life, so a later turn runs its own target only and an
          // availability failure there fails the turn.
          const targets = chainTargets(engine.name, state.turnCount === 0 ? options : withoutChain(options));
          const output = await this.#runChained(
            engine,
            targets,
            { label: options.label ?? null, phase: options.phase ?? null },
            options.maxAttempts,
            agentId,
            agentRecord,
            queuedAt,
            (target, targetEngine, ledger, chainRemains) =>
              this.#runSessionBody(state, prompt, turn, agentId, agentRecord, target, targetEngine, ledger, chainRemains)
          );
          // Record only what the engine actually reported. A requested pin
          // is not a served-model claim, and a missing response stays null.
          state.resolvedModel ??= agentRecord.resolvedModel;
          state.resolvedEffort ??= agentRecord.resolvedEffort;
          return output;
        } catch (error) {
          // A failed first turn can still have reached a live session and
          // reported its served identity. Preserve that evidence for the
          // next turn just as on the successful path.
          state.resolvedModel ??= agentRecord.resolvedModel;
          state.resolvedEffort ??= agentRecord.resolvedEffort;
          throw error;
        }
      } finally {
        this.#noteAgentSettled(agentId);
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
    agentRecord: RuntimeAgentRecord,
    target: ChainTarget,
    targetEngine: EngineAdapter,
    ledger: AttemptLedger,
    chainRemains: boolean
  ): Promise<AgentExecutionOutcome> {
    // The session takes the target's identity before its worker is
    // created, so the engine session, this turn's records, and every later
    // turn read one answer: a refused target's engine session is closed
    // below and the next target re-points the state afresh.
    state.engine = targetEngine;
    state.options = optionsForTarget(state.options, target);
    state.stalenessThresholdMs =
      targetEngine.name === "claude" ? this.#claudeSessionStaleAfterMs : this.#codexSessionStaleAfterMs;
    const options = state.options;
    state.stripRoutes = this.#recordStripRoutesFor(agentRecord, targetEngine, options.strip);
    // Placement is the session's, opened once at its first turn and closed
    // with the session — a worktree session works one tree for its life.
    state.placement ??= await this.#placement.open({
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.isolation !== undefined ? { isolation: options.isolation } : {})
    });
    if (state.closed || this.#closed) {
      // close() ran while placement was opening: it saw nothing to
      // finalise, so the placement just created is this path's to close —
      // and no engine session may be created for a session already closed
      // (an explicit close must never spawn the worker it promised to
      // stop).
      const placement = state.placement;
      state.placement = null;
      await this.#placement.close(placement).catch(() => undefined);
      throw new SessionClosedError();
    }
    agentRecord.resolvedCwd = state.placement.cwd;
    agentRecord.isolation = options.isolation ?? null;
    const createSession = state.engine.createSession;
    if (createSession === undefined) {
      throw new MultiTurnUnsupportedError(state.engine.name);
    }
    if (state.engineSession === null) {
      // Effort is fixed at the session's creation: resolved once, for the
      // target that creates the worker, and carried by every later turn's
      // record as the resolution its turn ran under.
      const effort = await this.#resolveTargetEffort(targetEngine, target, agentRecord);
      state.effortResolution = target.resolution;
      state.engineSession = createSession.call(
        state.engine,
        this.#engineTurnOptions(
          {
            engine: state.engine.name,
            ...(options.model !== undefined ? { model: options.model } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.strip !== undefined && options.strip.length > 0 ? { strip: options.strip } : {})
          },
          state.placement.cwd,
          effort
        )
      );
    } else {
      target.resolution = state.effortResolution;
      agentRecord.effortResolution = state.effortResolution;
    }
    const turnInvocation = state.engineSession.beginTurn(prompt, {
      ...(turn.schema !== undefined ? { schema: turn.schema } : {})
    });
    const invocation: EngineInvocation = {
      runAttempt: async (context) => {
        const result = await turnInvocation.runAttempt(context);
        // A held worker keeps its observed identity across turns. Some
        // transports report the model only when the worker first starts;
        // a later answer from that same worker still has that served model.
        if (
          result.resolvedModel === undefined &&
          state.resolvedModel !== null &&
          result.attemptFailure === undefined &&
          result.text.trim().length > 0
        ) {
          return { ...result, resolvedModel: state.resolvedModel };
        }
        return result;
      }
    };
    const sharedOptions: Partial<AgentOptions> = {
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.model !== undefined ? { model: options.model } : {})
    };
    const attempts = { target, ledger, chainRemains };
    let outcome: AgentExecutionOutcome;
    if (turn.schema !== undefined) {
      outcome = await this.#runSchemaAgent(
        state.engine.name,
        invocation,
        { ...sharedOptions, schema: turn.schema },
        agentId,
        agentRecord,
        attempts
      );
    } else {
      outcome = await this.#runTextAgent(state.engine.name, invocation, sharedOptions, agentId, agentRecord, attempts);
    }
    if (outcome.status === "refused") {
      // The refused target's held worker is not this session's: close it
      // so the next target creates its own, fresh — no session state
      // carries across a chain step.
      const refused = state.engineSession;
      state.engineSession = null;
      await refused.close().catch(() => undefined);
    } else if (outcome.status === "complete") {
      agentRecord.answeredBy = {
        entry: target.entry,
        engine: target.engine,
        model: agentRecord.attempts.at(-1)?.resolvedModel ?? null
      };
    }
    return outcome;
  }

  async #closeWorkerSession(state: WorkerSessionState): Promise<void> {
    if (state.closed) {
      return;
    }
    state.closed = true;
    try {
      // First, so an in-flight Claude turn is aborted rather than awaited
      // to natural completion; a server-held Codex turn ends only with its
      // transport, which the runtime's own close tears down concurrently.
      await state.engineSession?.close();
    } catch {
      // Session teardown is best-effort: a stop failure must not mask the
      // work the session already returned.
    }
    // The in-flight turn settles before the placement is finalised:
    // change-detecting a worktree a worker is still writing to would
    // misreport it.
    await state.pendingTurn?.catch(() => undefined);
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
    return this.#runChained(
      engine,
      chainTargets(engine.name, options),
      { label: options.label ?? null, phase: options.phase ?? null },
      options.maxAttempts,
      agentId,
      agentRecord,
      queuedAt,
      (target, targetEngine, ledger, chainRemains) =>
        this.#runAgent(targetEngine, prompt, optionsForTarget(options, target), agentId, agentRecord, target, ledger, chainRemains)
    );
  }

  /**
   * The chain loop: the call's own target, then each declared fallback
   * entry, each admitted on its own engine. A same-engine step keeps the
   * slot it holds — the target loop runs inside one admitted task — while a
   * cross-engine step ends that task, releasing the refused engine's cap
   * and ceiling slot, and re-admits the leg afresh on the next engine
   * against its own cap, the ceiling, and its budget. One agent record
   * spans the whole chain: every attempt names its target, and the record
   * names the entry that answered. The last target is never refused — with
   * no entry remaining an availability failure is the call's own failure,
   * exactly as with no chain — so the loop always ends in a settlement or a
   * throw. `runTarget` is one target's whole dispatch — placement,
   * invocation, bounded attempts — resolving `refused` to hand the chain
   * on.
   */
  async #runChained(
    engine: EngineAdapter,
    targets: ChainTarget[],
    identity: { label: string | null; phase: string | null },
    maxAttempts: number | undefined,
    agentId: number,
    agentRecord: RuntimeAgentRecord,
    initialQueuedAt: number,
    runTarget: (
      target: ChainTarget,
      engine: EngineAdapter,
      ledger: AttemptLedger,
      chainRemains: boolean
    ) => Promise<AgentExecutionOutcome>
  ): Promise<unknown> {
    let queuedAt = initialQueuedAt;
    const ledger: AttemptLedger = {
      maxAttempts: maxAttempts ?? this.#defaultMaxAttempts,
      dispatched: 0,
      answered: 0
    };
    const position = { next: 0 };
    let admittedEngine = engine;
    let readmitting = false;
    for (;;) {
      const outcome = await this.#admitChainStep(admittedEngine, readmitting, agentId, agentRecord, queuedAt, () =>
        this.#executeAgent(admittedEngine.name, identity, agentId, agentRecord, queuedAt, async () => {
          // Same-engine steps stay inside this admitted task; the loop
          // hands back a ChainAdvance the moment the next target's engine
          // differs, so the slot is released first.
          for (; position.next < targets.length; position.next += 1) {
            const target = targets[position.next]!;
            if (target.engine !== admittedEngine.name) {
              return new ChainAdvance(target.engine);
            }
            // The admitted leg runs under this engine's cap. Keep the
            // record's group with the last target that actually entered it.
            agentRecord.concurrencyGroup = admittedEngine.name;
            const settled = await runTarget(target, admittedEngine, ledger, position.next + 1 < targets.length);
            if (settled.status !== "refused") {
              return settled;
            }
          }
          throw new Error("fallback chain ended without a settlement");
        })
      );
      if (!(outcome instanceof ChainAdvance)) {
        return outcome;
      }
      // Re-admission on the next engine: the progress entry re-queued so
      // the live view shows the leg waiting on its new engine's cap, and
      // the budget judged afresh at that dispatch, as for any call.
      admittedEngine = this.#engineFor(outcome.engine);
      readmitting = true;
      this.progress.requeueAgent(agentId, admittedEngine.name);
      // The next step's queue time starts now; the execution time already
      // spent on the refused engine stays accumulated on the record.
      queuedAt = Date.now();
    }
  }

  /**
   * One admitted step of a chain: the engine's cap and the ceiling judged
   * by admission, the budget too on a re-admission. A rejection before the
   * task starts (budget, admission, or scheduler shutdown) bypasses
   * #executeAgent's own settlement, so the progress entry is settled and
   * the record persisted here — a cancelled queued worker must not be
   * left counted as queued for ever.
   */
  async #admitChainStep(
    engine: EngineAdapter,
    readmitting: boolean,
    agentId: number,
    agentRecord: RuntimeAgentRecord,
    queuedAt: number,
    task: () => Promise<unknown>
  ): Promise<unknown> {
    let started = false;
    try {
      if (readmitting) {
        this.budget.assertCanStart(engine.name);
      }
      return await this.#admission.admit(engine.name, agentId, () =>
        engine.schedule(async () => {
          started = true;
          return task();
        })
      );
    } catch (error) {
      if (!started) {
        this.progress.settleAgent(agentId, "failed");
        // The task never started, so this leg was still queued — its
        // termination record must not claim an in-flight turn. Times
        // accumulate: a chained leg refused on one engine and rejected at
        // re-admission on the next keeps the execution it already spent.
        this.#settleTerminalStatus(agentRecord, error, "queued");
        agentRecord.queuedMs += Math.max(0, Date.now() - queuedAt);
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
    run: () => Promise<AgentExecutionResult | ChainAdvance>
  ): Promise<unknown> {
    const executionStartedAt = Date.now();
    this.progress.startAgent(agentId);
    const executingRecords = this.#executingAgentRecords.get(engineName) ?? new Set<RuntimeAgentRecord>();
    this.#executingAgentRecords.set(engineName, executingRecords);
    executingRecords.add(agentRecord);
    try {
      const execution = await run();
      if (execution instanceof ChainAdvance) {
        // Not a settlement: the leg is leaving this engine for the next
        // target's. The record stays in progress, and both times spent so
        // far — this step's wait and its execution — accumulate.
        agentRecord.queuedMs += Math.max(0, executionStartedAt - queuedAt);
        agentRecord.executionMs += Math.max(0, Date.now() - executionStartedAt);
        return execution;
      }
      const outcome = execution.status === "complete" ? "done" : "failed";
      const executionEndedAt = Date.now();
      agentRecord.queuedMs += Math.max(0, executionStartedAt - queuedAt);
      agentRecord.executionMs += Math.max(0, executionEndedAt - executionStartedAt);
      this.progress.settleAgent(agentId, outcome);
      if (outcome === "done") {
        agentRecord.status = "complete";
      } else {
        this.#settleTerminalStatus(agentRecord, execution.cause ?? null);
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
      if (outcome === "failed") {
        return this.#failedValue(engineName, identity, agentId, agentRecord, execution.cause);
      }
      this.#announceChainAnswer(engineName, identity, agentId, agentRecord);
      return execution.value;
    } catch (error) {
      const executionEndedAt = Date.now();
      agentRecord.queuedMs += Math.max(0, executionStartedAt - queuedAt);
      agentRecord.executionMs += Math.max(0, executionEndedAt - executionStartedAt);
      this.progress.settleAgent(agentId, "failed");
      this.#settleTerminalStatus(agentRecord, error);
      agentRecord.rawOutput = lastRawOutput(agentRecord);
      agentRecord.validatedOutput = null;
      await this.#recordSettlementSafely(agentId, agentRecord);
      // The spawn boundary. Three throws cross it unchanged: a member
      // of the pre-spawn author family, judged at its raise site (an
      // unenforceable strip discovered as the thread is configured) and
      // required to fail loudly wherever it surfaces; a throw that
      // reached here with no attempt on the record, raised before any
      // worker existed (an engine refusing the dispatch itself, a
      // placement that never opened); and the run's own ending, which is
      // not the worker's failure — a leg the shutdown tore down rethrows
      // so the combinators' collapse and a bare await both see the run
      // stop, and the cut-short accounting keeps its evidence. Everything
      // else is a worker that was dispatched and failed on its own
      // account, which the record now states in full — so the call
      // resolves it as a value.
      if (this.#crossesSpawnBoundary(error) || agentRecord.attempts.length === 0) {
        // A chain whose last target refused before any worker existed
        // leaves as that refusal, thrown and whole; the notice still
        // tells the operator the chain behind it was spent.
        if (agentRecord.attempts.at(-1)?.chainDecision === "exhausted") {
          this.#announceFailure(engineName, identity, agentId, agentRecord, error);
        }
        throw error;
      }
      return this.#failedValue(engineName, identity, agentId, agentRecord, error);
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

  /**
   * The two throws the attempt loops never retry and `#executeAgent` never
   * resolves as a value, judged from the error alone: a member of the
   * pre-spawn author family (raised before any worker existed — a rejected
   * option, a strip found unenforceable as the thread is configured, a
   * substrate that refused the dispatch), and the run's own settlement (the
   * run ending is not the worker failing). Every other thrown failure is a
   * dispatched worker's, consumes an attempt, and retries within the bound
   * like an empty answer does — one rule on every engine. The third
   * boundary throw, a rejection that reached `#executeAgent` with no attempt
   * on the record, is the record's to judge, not the error's.
   */
  #crossesSpawnBoundary(error: unknown): boolean {
    return error instanceof PreSpawnAuthorError || this.#runSettlementCause(error) !== null;
  }

  /** The last settled agent record, or null before any settlement. */
  lastAgentRecord(): RuntimeAgentRecord | null {
    return this.#lastSettledAgentRecord;
  }

  /**
   * A dispatched worker's failure as the call's value: `null`, on the
   * text shape as on the schema shape, once its settlement is on the
   * record. The account the script no longer receives as a throw is
   * announced instead, on the engine-tagged notice channel the CLI
   * renders, so an operator watching stderr still sees each worker that
   * failed and why — the archive and the identity envelope carry the same
   * account for a reader arriving later. Where the failure was a thrown
   * error the operator-diagnosis seam already knows how to present (a
   * turn deadline and its lever, a dead app-server and how it died), the
   * notice carries that diagnosis rather than the class name.
   */
  #failedValue(
    engine: EngineName,
    identity: { label: string | null; phase: string | null },
    agentId: number,
    agentRecord: RuntimeAgentRecord,
    thrown?: unknown
  ): null {
    this.#announceFailure(engine, identity, agentId, agentRecord, thrown);
    return null;
  }

  /**
   * The failure notice. Under a declared chain it also carries how many
   * targets the call reached — the call's own target and one more per
   * advance, read from the attempts' own decisions — so an exhausted chain
   * reads as the last target's failure beside the count, never as a new
   * failure of its own. Null where no chain was declared.
   */
  #announceFailure(
    engine: EngineName,
    identity: { label: string | null; phase: string | null },
    agentId: number,
    agentRecord: RuntimeAgentRecord,
    thrown?: unknown
  ): void {
    const failure = settledFailureAccount(agentRecord);
    const diagnosis = thrown === undefined ? null : presentOperationalError(thrown);
    this.#emitEvent({
      method: `${engine}/agentFailed`,
      params: {
        agentId,
        label: identity.label,
        phase: identity.phase,
        status: agentRecord.status,
        attempts: agentRecord.attempts.length,
        targetsTried: agentRecord.fallback === null ? null : 1 + advancesOf(agentRecord).length,
        failure: { kind: failure.kind, message: failure.message },
        diagnosis
      },
      receivedAt: Date.now()
    });
  }

  /**
   * A successful failover, announced: an answer from a chain entry
   * names the declared target that was refused, its refusal, and the entry
   * that answered — each read from the record, which holds them all.
   */
  #announceChainAnswer(
    engine: EngineName,
    identity: { label: string | null; phase: string | null },
    agentId: number,
    agentRecord: RuntimeAgentRecord
  ): void {
    const answeredBy = agentRecord.answeredBy;
    const [declared] = advancesOf(agentRecord);
    if (answeredBy === null || answeredBy.entry === -1 || declared === undefined) {
      return;
    }
    this.#emitEvent({
      method: `${engine}/chainAdvanced`,
      params: {
        agentId,
        label: identity.label,
        phase: identity.phase,
        refused: declared.target,
        refusal: declared.failure,
        targetsRefused: advancesOf(agentRecord).length,
        answeredBy
      },
      receivedAt: Date.now()
    });
  }

  /**
   * A failed attempt joins the record; the first one whose failure left a
   * declared chain unconsulted is announced, so a declaration that
   * did nothing for this failure says so rather than sitting inert. Later
   * attempts under the same decision are on the record, not repeated.
   */
  #pushFailedAttempt(record: RuntimeAgentRecord, attempt: RuntimeAgentAttemptRecord): void {
    const alreadyAnnounced = record.attempts.some((earlier) => earlier.chainDecision === "chain-not-consulted");
    record.attempts.push(attempt);
    if (attempt.chainDecision !== "chain-not-consulted" || alreadyAnnounced) {
      return;
    }
    this.#emitEvent({
      method: `${attempt.target.engine}/chainNotConsulted`,
      params: {
        agentId: record.id,
        label: record.label,
        phase: record.phase,
        attempt: attempt.attempt,
        target: attempt.target,
        failure: attempt.failure,
        chainEntries: record.fallback?.length ?? 0
      },
      receivedAt: Date.now()
    });
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

  /**
   * The worker tally for the run's end, or null before close() completes
   * it. Legs close() abandons (no outcome ever observed) count `unsettled`
   * by its own decision; every other leg is counted from what its durable
   * record settled to during teardown — cut short where the run's ending
   * is the recorded cause, done/failed where the leg settled on its own
   * account — so the sentinel's figures and the archive's records state
   * the same thing, including for a leg that outraced teardown.
   */
  shutdownTally(): ShutdownTally | null {
    return this.#shutdownTally;
  }

  /**
   * The legs the run's ending left unfinished, by identity and disposition:
   * `cut-short` legs are the tally's `cutShort` bucket (torn down with a
   * `run-<status>` cause on the record); `abandoned` legs are its
   * `unsettled` bucket (the run ended before their dispatch record landed).
   * Empty before close(). The launcher names each on stderr after a body
   * that returned with it in flight.
   */
  unfinishedLegs(): readonly UnfinishedLeg[] {
    return this.#unfinishedLegs;
  }

  close(status: "failed" | "timed-out" | "interrupted" = "interrupted", occasion: RunCloseOccasion = "run-ended"): Promise<void> {
    // First close wins, whole: a second call must not re-run teardown or
    // rebuild the tally from post-teardown progress totals (which count
    // run-caused settlements as failures — exactly the
    // indistinguishability the record-derived tally exists to avoid).
    this.#closeRun ??= this.#closeOnce(status, occasion);
    return this.#closeRun;
  }

  async #closeOnce(status: "failed" | "timed-out" | "interrupted", occasion: RunCloseOccasion): Promise<void> {
    this.#shutdownAgentStatus = status;
    this.#closeOccasion = occasion;
    this.#closed = true;
    // Teardown rejects every open call's promise with the run's own
    // settlement. A script that returned without awaiting a call is not
    // listening, and Node would raise the unhandled rejection as an
    // uncaught exception — ending, as a failure, a run that has ended
    // cleanly. Marked handled here, before any teardown, so the rejection
    // stays the launcher's own; a caller still awaiting the leg is
    // unaffected. Every settlement teardown produces is then read from the
    // records below, not from what escaped.
    for (const call of this.#openCalls) {
      void call.outward?.catch(() => undefined);
    }
    // The in-flight legs are classified here, before the first await, and
    // the classification decides what teardown *does*: a leg whose
    // dispatch-time record write is still in flight — a call started in the
    // same tick as the body's return, say — has no outcome to observe and
    // is abandoned (a writer that never completes is exactly this shape, so
    // the write is never awaited here), while a leg past dispatch — queued
    // at admission or on the wire — is settled by teardown. The tally is not
    // taken from this classification: it is derived after teardown from
    // what each leg's record actually says, so a leg that settles on its
    // own account while teardown runs is counted as its record reads
    // (done, or failed) rather than as cut short.
    const inFlight = [...this.#unsettledAgentRecords.entries()].filter(
      ([, { record }]) => record.status === "in-progress"
    );
    const abandoning = inFlight.filter(([, { stage }]) => stage === "dispatching").map(([, { record }]) => record);
    const closing = inFlight.filter(([, { stage }]) => stage === "admitting");
    // Armed before any teardown so no settlement can slip between the
    // classification and the wait.
    const settlementBarrier = Promise.all(closing.map(([agentId]) => this.#settledSignal(agentId)));
    const totalsAtClose = this.progress.snapshot().totals;
    // Held workers start closing now, but the wait for them overlaps the
    // engines' teardown below: a session with a server-held turn in flight
    // settles only when its transport dies, so awaiting sessions strictly
    // first would deadlock the interrupt path. Every run end still leaves
    // no held session live — the wait completes before close returns.
    const sessionCloses = Promise.allSettled([...this.#workerSessions].map((session) => session.close()));
    // Open holds are abandoned with the run: the waits reject, and each
    // wait's own cleanup removes its published hold file.
    this.#holdManager?.close();
    this.#admission.close();
    await Promise.all(
      abandoning.map(async (record) => {
        // The harness knows only that this leg outlived the run. Keep the
        // dispatch evidence and name that absence of an observed outcome —
        // and why the run closed, since the record has no attempt to say.
        this.#abandonedAgentIds.add(record.id);
        // Keep the dispatch record's evidence (including its empty attempts)
        // and overwrite that one record through the normal writer path.
        record.status = "abandoned";
        record.terminationCause = this.#closeCause("dispatching");
        await this.#recordAgentSafely(record);
      })
    );
    // Teardown failures are collected, never thrown mid-cleanup: cleanup
    // runs to completion first, then close() rejects carrying every cause —
    // a silently discarded engine or session teardown failure would leave
    // a cancelled run's failure unattributable.
    const teardownFailures: unknown[] = [];
    try {
      await this.#engines.close();
    } catch (error) {
      teardownFailures.push(error);
    }
    for (const result of await sessionCloses) {
      if (result.status === "rejected") {
        teardownFailures.push(result.reason);
      }
    }
    this.#workerSessions.clear();
    // Teardown has now reached every classified leg (engine close cancels
    // active invocations; admission and scheduler close reject queued
    // ones), so this wait is bounded by the cancellation contract — and
    // once it resolves, each leg's record holds its final disposition.
    await settlementBarrier;
    let done = totalsAtClose.done;
    let failed = totalsAtClose.failed;
    let cutShort = 0;
    const unfinished: UnfinishedLeg[] = abandoning.map((record) => ({ id: record.id, label: record.label, disposition: "abandoned" }));
    for (const [, { record }] of closing) {
      if (record.status === "complete") {
        done += 1;
      } else if (record.terminationCause?.kind === `run-${status}`) {
        cutShort += 1;
        unfinished.push({ id: record.id, label: record.label, disposition: "cut-short" });
      } else {
        failed += 1;
      }
    }
    this.#shutdownTally = { done, failed, cutShort, unsettled: abandoning.length };
    this.#unfinishedLegs = unfinished;
    if (teardownFailures.length === 1) {
      throw teardownFailures[0];
    }
    if (teardownFailures.length > 1) {
      throw new AggregateError(teardownFailures, "run teardown failed to end cleanly");
    }
  }

  /**
   * Resolves when the identified leg's settlement bookkeeping has finished —
   * its record status, cause, and settlement write are all final. Already
   * settled resolves immediately.
   */
  #settledSignal(agentId: number): Promise<void> {
    if (!this.#unsettledAgentRecords.has(agentId)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters = this.#settlementWaiters.get(agentId) ?? [];
      waiters.push(resolve);
      this.#settlementWaiters.set(agentId, waiters);
    });
  }

  /** The one place a leg leaves the unsettled set; wakes any close() waiting on it. */
  #noteAgentSettled(agentId: number): void {
    this.#unsettledAgentRecords.delete(agentId);
    const waiters = this.#settlementWaiters.get(agentId);
    if (waiters !== undefined) {
      this.#settlementWaiters.delete(agentId);
      for (const waiter of waiters) {
        waiter();
      }
    }
  }

  /**
   * The run's own settlement, seen from inside a worker's turn, or null when
   * the engine failed on its own account. A run interrupt or whole-run
   * timeout reaches an in-flight turn as whatever its transport noticed
   * first — a closed app-server, an aborted poll — so that symptom names the
   * run's exit rather than the turn's cause. Agent and attempt both read
   * their cause from here, so a record cannot disagree with its own attempts.
   */
  #runSettlementCause(error: unknown, dispatch: "in-flight" | "queued" = "in-flight"): TerminalErrorRecord | null {
    // A substrate refusal wraps the transport's own error; a closed run's
    // latch is read through it, so a leg torn down mid-open settles as the
    // run's ending and not as the substrate refusing.
    const substrate = error instanceof SubstrateRefusedError ? error.cause : error;
    if (error instanceof EngineShutdownError || (substrate instanceof AppServerExitedError && this.#closed)) {
      return this.#closeCause(dispatch);
    }
    return null;
  }

  /**
   * The cause the run's close writes on a leg it settles: the kind carries
   * the run's status, the message says how far the leg got — a queued leg's
   * turn never reached an engine, so claiming it was in flight would claim
   * a dispatch that never happened — and why the run is closing. After a
   * body that returned, the message names the return, never "the run
   * ended", so a record read cold beside a `complete` manifest does not
   * contradict it; it does not claim the run completed, because the seal
   * comes after this and a failed teardown can still end the run `failed`.
   */
  #closeCause(stage: CloseStage): TerminalErrorRecord {
    return {
      kind: `run-${this.#shutdownAgentStatus}`,
      message:
        this.#closeOccasion === "body-returned"
          ? `${BODY_RETURNED}; ${BODY_RETURNED_LEG[stage]}`
          : `the run ended (${this.#shutdownAgentStatus}) ${RUN_ENDED_LEG[stage]}`
    };
  }

  /**
   * Settles a record's terminal status *and* the cause that produced it, so
   * the two can never disagree.
   */
  #settleTerminalStatus(record: RuntimeAgentRecord, error: unknown, dispatch: "in-flight" | "queued" = "in-flight"): void {
    const settlement = this.#runSettlementCause(error, dispatch);
    if (settlement !== null) {
      record.status = this.#shutdownAgentStatus;
      record.terminationCause = settlement;
      return;
    }
    if (error instanceof TurnTimeoutError) {
      record.status = "timed-out";
      record.terminationCause = {
        kind: error.deadline.kind === "request" ? "request-timeout" : "turn-timeout",
        message: error.message
      };
      return;
    }
    const lastFailure = record.attempts.at(-1)?.failure;
    if (lastFailure?.kind.endsWith("-timeout") === true) {
      record.status = "timed-out";
      record.terminationCause = { kind: lastFailure.kind, message: lastFailure.message };
      return;
    }
    record.status = "failed";
    // Where an attempt ran, its own failure is the engine's account and the
    // record's home for it; a cause here would only restate that entry, so
    // null keeps one home for one account and the two can never disagree.
    // An agent refused before any attempt was observed — an unknown model
    // rejected at dispatch, a placement that never opened — has no such
    // entry, and leaving this null there publishes a bare `failed` while
    // the engine's rejection is legible in the run's own output. The cause
    // is then taken from the account the runtime is holding, never
    // synthesised from the status.
    record.terminationCause = attemptedFailureAccount(record) !== null ? null : failedWithoutAttemptCause(error);
  }

  /**
   * One target's placement, invocation, and bounded attempts. Resolves to
   * the target's settled outcome, or `refused` when the target failed for
   * availability with a chain entry still to try (the chain loop then
   * moves on, the refused target's placement already closed here).
   */
  async #runAgent(
    engine: EngineAdapter,
    prompt: string,
    options: Partial<AgentOptions>,
    agentId: number,
    agentRecord: RuntimeAgentRecord,
    target: ChainTarget,
    ledger: AttemptLedger,
    chainRemains: boolean
  ): Promise<AgentExecutionOutcome> {
    const placement = await this.#placement.open(options);
    agentRecord.resolvedCwd = placement.cwd;
    agentRecord.isolation = options.isolation ?? null;
    this.#recordStripRoutesFor(agentRecord, engine, options.strip);
    let invocation: EngineInvocation | undefined;
    let completion: AgentExecutionCompletion | undefined;
    const attempts = { target, ledger, chainRemains };
    try {
      const effort = await this.#resolveTargetEffort(engine, target, agentRecord);
      invocation = engine.createInvocation(prompt, this.#engineTurnOptions(options, placement.cwd, effort));
      if (options.schema !== undefined) {
        completion = {
          ok: true,
          execution: await this.#runSchemaAgent(
            engine.name,
            invocation,
            { ...options, schema: options.schema },
            agentId,
            agentRecord,
            attempts
          )
        };
      } else {
        completion = {
          ok: true,
          execution: await this.#runTextAgent(engine.name, invocation, options, agentId, agentRecord, attempts)
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
    if (completion.execution.status === "complete") {
      agentRecord.answeredBy = {
        entry: target.entry,
        engine: target.engine,
        model: agentRecord.attempts.at(-1)?.resolvedModel ?? null
      };
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

  /**
   * The bounded-attempt loop for a text call on one target: the trimmed
   * answer, the exhausted collapse, or `refused` for the chain — the same
   * three settlements as the schema loop, so the two call shapes cannot
   * drift apart on how a worker's failure reaches the script. A
   * thrown transport error leaves the loop as a throw so the settlement
   * reads its evidence (a turn deadline settles `timed-out`, a run ending
   * settles as the run's own cause); whether it then resolves as a value
   * is `#executeAgent`'s one judgement, never the loop's.
   */
  async #runTextAgent(
    engine: EngineName,
    invocation: EngineInvocation,
    options: Partial<AgentOptions>,
    agentId: number,
    agentRecord: RuntimeAgentRecord,
    attempts: TargetAttempts
  ): Promise<AgentExecutionOutcome> {
    let previousFailure: PreviousAttemptFailure | undefined;
    let lastThrown: unknown;

    while (boundRemains(attempts.ledger)) {
      const attempt = ++attempts.ledger.dispatched;
      lastThrown = undefined;
      this.progress.noteAttempt(agentId, attempt);
      const startedAt = Date.now();
      try {
        const result = await invocation.runAttempt({
          attempt,
          onLiveEvidence: () => this.progress.noteAgentEvidence(agentId),
          onWaiting: (wait) => this.progress.noteAgentWaiting(agentId, wait),
          ...(previousFailure !== undefined ? { previousFailure } : {})
        });
        this.#recordResolvedUnpinnedModel(engine, options, agentId, agentRecord, result);
        recordTurnMetadata(agentRecord, result);
        const operationalFailure = this.#recordOperationalFailure(agentRecord, attempt, startedAt, result, attempts);
        if (operationalFailure !== undefined) {
          if (operationalFailure.refused) {
            return { status: "refused" };
          }
          previousFailure = operationalFailure.failure;
          continue;
        }
        const text = result.text.trim();
        if (text.length > 0) {
          attempts.ledger.answered += 1;
          agentRecord.attempts.push(
            attemptRecord(attempt, attempts.target, "complete", null, result.text, result.text, startedAt, result)
          );
          return { status: "complete", value: text };
        }
        const failure: EngineAttemptFailure = {
          kind: "empty-output",
          message: `agent returned empty text on attempt ${attempt}`
        };
        previousFailure = failure;
        this.#recordAnsweredFailure(agentRecord, attempt, failure, result.text, startedAt, result, attempts);
      } catch (error) {
        const thrown = this.#recordThrownFailure(agentRecord, attempt, error, startedAt, attempts);
        if (thrown.refused) {
          return { status: "refused" };
        }
        if (this.#crossesSpawnBoundary(error)) {
          throw error;
        }
        if (error instanceof CodexSchemaSubsetUnsupportedError) {
          // The backend judged the call's own schema, which no retry can
          // change: it costs one thread start with no generation, so the
          // call ends as a value with the one attempt it spent — the rule's
          // one exemption beside the availability refusal a chain entry
          // answers.
          return { status: "failed", value: null, cause: error };
        }
        // A dispatched worker's thrown failure — a deadline, a transport
        // error, a thread the app-server declared failed — is one more
        // spent attempt under the one retry rule: the next attempt carries
        // it as the worker's previous failure, and the last one carries it
        // out as the exhausted outcome's cause.
        previousFailure = thrown.failure;
        lastThrown = error;
      }
    }

    return {
      status: "failed",
      value: null,
      ...(lastThrown !== undefined ? { cause: lastThrown } : {})
    };
  }

  /**
   * The bounded-attempt loop for a schema call on one target: the
   * validated value, the exhausted collapse, or `refused` for the chain.
   */
  async #runSchemaAgent(
    engine: EngineName,
    invocation: EngineInvocation,
    options: Partial<AgentOptions> & { schema: JsonSchema },
    agentId: number,
    agentRecord: RuntimeAgentRecord,
    attempts: TargetAttempts
  ): Promise<AgentExecutionOutcome> {
    let previousFailure: PreviousAttemptFailure | undefined;
    let lastThrown: unknown;

    while (boundRemains(attempts.ledger)) {
      const attempt = ++attempts.ledger.dispatched;
      lastThrown = undefined;
      this.progress.noteAttempt(agentId, attempt);
      const startedAt = Date.now();
      try {
        const result = await invocation.runAttempt({
          attempt,
          onLiveEvidence: () => this.progress.noteAgentEvidence(agentId),
          onWaiting: (wait) => this.progress.noteAgentWaiting(agentId, wait),
          ...(previousFailure !== undefined ? { previousFailure } : {})
        });
        this.#recordResolvedUnpinnedModel(engine, options, agentId, agentRecord, result);
        recordTurnMetadata(agentRecord, result);
        const operationalFailure = this.#recordOperationalFailure(agentRecord, attempt, startedAt, result, attempts);
        if (operationalFailure !== undefined) {
          if (operationalFailure.refused) {
            return { status: "refused" };
          }
          previousFailure = operationalFailure.failure;
          continue;
        }
        // A silent worker (timeout, hang) is not a JSON problem: label it
        // empty-output so records and retry nudges point at the real failure.
        if (result.text.trim().length === 0) {
          const failure: EngineAttemptFailure = {
            kind: "empty-output",
            message: `agent returned empty text on attempt ${attempt}`
          };
          previousFailure = failure;
          this.#recordAnsweredFailure(agentRecord, attempt, failure, result.text, startedAt, result, attempts);
          continue;
        }
        const selection = selectLastValidJsonFromText(result.text, options.schema);
        if (selection.kind === "invalid-json") {
          const failure: EngineAttemptFailure = {
            kind: "invalid-json",
            message: "agent output did not contain parseable JSON"
          };
          previousFailure = failure;
          this.#recordAnsweredFailure(agentRecord, attempt, failure, result.text, startedAt, result, attempts);
          continue;
        }
        if (selection.kind === "valid") {
          attempts.ledger.answered += 1;
          agentRecord.parseRoute = selection.parsed.source;
          agentRecord.attempts.push(
            attemptRecord(attempt, attempts.target, "complete", null, result.text, selection.parsed.value, startedAt, result)
          );
          return {
            status: "complete",
            value: selection.parsed.value
          };
        }
        const failure: EngineAttemptFailure = {
          kind: "schema-validation",
          message: JSON.stringify(selection.validation.errors ?? [])
        };
        previousFailure = failure;
        this.#recordAnsweredFailure(agentRecord, attempt, failure, result.text, startedAt, result, attempts);
      } catch (error) {
        const thrown = this.#recordThrownFailure(agentRecord, attempt, error, startedAt, attempts);
        if (thrown.refused) {
          return { status: "refused" };
        }
        if (this.#crossesSpawnBoundary(error)) {
          throw error;
        }
        if (error instanceof CodexSchemaSubsetUnsupportedError) {
          // The backend judged the call's own schema, which no retry can
          // change: it costs one thread start with no generation, so the
          // call ends as a value with the one attempt it spent — the rule's
          // one exemption beside the availability refusal a chain entry
          // answers.
          return { status: "failed", value: null, cause: error };
        }
        // A dispatched worker's thrown failure — a deadline, a transport
        // error, a thread the app-server declared failed — is one more
        // spent attempt under the one retry rule: the next attempt carries
        // it as the worker's previous failure, and the last one carries it
        // out as the exhausted outcome's cause.
        previousFailure = thrown.failure;
        lastThrown = error;
      }
    }

    return {
      status: "failed",
      value: null,
      ...(lastThrown !== undefined ? { cause: lastThrown } : {})
    };
  }

  /**
   * An attempt the worker answered badly (empty, unparseable, off-schema):
   * an output failure, so it consumes an attempt and never advances the
   * chain.
   */
  #recordAnsweredFailure(
    record: RuntimeAgentRecord,
    attempt: number,
    failure: EngineAttemptFailure,
    rawOutput: string,
    startedAt: number,
    result: TurnResult,
    attempts: TargetAttempts
  ): void {
    attempts.ledger.answered += 1;
    const classification = this.#classify(attempts.target.engine, failure, null, result.diagnostics);
    this.#pushFailedAttempt(
      record,
      attemptRecord(
        attempt,
        attempts.target,
        "failed",
        failure,
        rawOutput,
        null,
        startedAt,
        result,
        null,
        null,
        null,
        classification,
        chainDecisionAfter(attempts, classification, boundRemains(attempts.ledger))
      )
    );
  }

  /**
   * An engine-classified operational failure riding a returned result (the
   * Claude and opencode adapters' shape). Recorded with its class; an
   * availability class with a chain entry remaining reports `refused` and
   * consumes no attempt — the worker never answered.
   */
  #recordOperationalFailure(
    record: RuntimeAgentRecord,
    attempt: number,
    startedAt: number,
    result: EngineAttemptResult,
    attempts: TargetAttempts
  ): { failure: EngineAttemptFailure; refused: boolean } | undefined {
    if (result.attemptFailure === undefined) {
      return undefined;
    }
    const classification = this.#classify(attempts.target.engine, result.attemptFailure, null, result.diagnostics);
    const refused = classification.class === "availability" && attempts.chainRemains;
    if (!refused) {
      attempts.ledger.answered += 1;
    }
    this.#pushFailedAttempt(
      record,
      attemptRecord(
        attempt,
        attempts.target,
        "failed",
        result.attemptFailure,
        // Returned operational failures use empty text when the worker
        // produced nothing; an answered empty string takes the output path.
        result.text === "" ? null : result.text,
        null,
        startedAt,
        result,
        result.workerExit ?? null,
        null,
        null,
        classification,
        chainDecisionAfter(attempts, classification, !refused && boundRemains(attempts.ledger))
      )
    );
    return { failure: result.attemptFailure, refused };
  }

  /**
   * A thrown failure (the Codex transport's shape, and any engine's
   * unexpected rejection): recorded with the terminalisation invariant's
   * evidence and its class. A run-settlement cause is never a refusal —
   * the run is ending, not the target.
   */
  #recordThrownFailure(
    record: RuntimeAgentRecord,
    attempt: number,
    error: unknown,
    startedAt: number,
    attempts: TargetAttempts
  ): { refused: boolean; failure: PreviousAttemptFailure } {
    const observed = failureFromError(error);
    const failedResult = failedTurnResultOf(error);
    if (failedResult !== null) {
      recordTurnMetadata(record, failedResult);
    }
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
    const failure = settlement ?? observed;
    const appServerDiagnostic = appServerDiagnosticOf(error);
    const classification = this.#classify(attempts.target.engine, failure, appServerDiagnostic, failedResult?.diagnostics);
    const refused = settlement === null && classification.class === "availability" && attempts.chainRemains;
    // A substrate that refused before the worker existed produced no
    // answer whether or not a chain entry remains: the dispatch is
    // numbered and recorded with its class, but the bound is not spent on
    // it — the call advances the chain or throws, never retries.
    if (!refused && !(error instanceof SubstrateRefusedError)) {
      attempts.ledger.answered += 1;
    }
    const partialTranscript = partialTranscriptOf(error);
    const firstDeltaMs = firstDeltaMsOf(error);
    const observedResult =
      failedResult ??
      (partialTranscript !== null || firstDeltaMs !== null
        ? {
            ...(partialTranscript !== null ? { transcripts: [partialTranscript] } : {}),
            ...(firstDeltaMs !== null ? { firstDeltaMs } : {})
          }
        : null);
    // The loop's own next step, read from the same facts it acts on: a
    // boundary throw leaves, a rejected schema settles, anything else
    // retries while the bound lasts. A run ending decides nothing.
    const retries =
      !refused &&
      !this.#crossesSpawnBoundary(error) &&
      !(error instanceof CodexSchemaSubsetUnsupportedError) &&
      boundRemains(attempts.ledger);
    this.#pushFailedAttempt(
      record,
      attemptRecord(
        attempt,
        attempts.target,
        "failed",
        failure,
        partialWorkerTextOf(error),
        null,
        startedAt,
        observedResult,
        workerExitStatusOf(error),
        appServerDiagnostic,
        settlement === null ? null : observed,
        classification,
        settlement === null ? chainDecisionAfter(attempts, classification, retries) : null
      )
    );
    return { refused, failure: observed };
  }

  /**
   * The strip enforcement routes the archive records are the *dispatching*
   * engine's: a chain step onto another engine re-resolves them against
   * that engine's table (every chain engine was judged enforceable
   * pre-spawn, so this cannot newly throw) and rewrites the record, so a
   * Claude worker is never archived under Codex's routes.
   */
  #recordStripRoutesFor(
    record: RuntimeAgentRecord,
    engine: EngineAdapter,
    strip: readonly StrippableCapability[] | undefined
  ): Partial<Record<StrippableCapability, DischargedEnforcement>> | null {
    if (strip === undefined || strip.length === 0) {
      return null;
    }
    const enforcement = resolveStripEnforcement(engine.name, engine.capabilities, strip);
    record.strip = { requested: [...strip], enforcement };
    return enforcement;
  }

  /** One classification call for every failed attempt, so the archive's class always came from the same table. */
  #classify(
    engine: EngineName,
    failure: { kind: string; message: string },
    appServerDiagnostic: { code: number | string | null } | null,
    diagnostics: JsonObject | undefined
  ): FailureClassification {
    return classifyAttemptFailure({ engine, failure, appServerDiagnostic, diagnostics });
  }


  #emitEvent(event: RuntimeEvent): void {
    for (const listener of this.#eventListeners) {
      listener(event);
    }
  }

  /**
   * An unpinned call's first resolved served model becomes a named notice —
   * on every engine that reports one, so the Claude notice names its model
   * exactly as the Codex line does (an unpinned worker's real identity is
   * operator-facing information, not a Codex privilege).
   */
  #recordResolvedUnpinnedModel(
    engine: EngineName,
    options: Partial<AgentOptions>,
    agentId: number,
    record: RuntimeAgentRecord,
    result: TurnResult
  ): void {
    if (options.model !== undefined || record.resolvedModel !== null || result.resolvedModel === undefined) {
      return;
    }
    this.#emitEvent({
      method: `${engine}/unpinnedModelResolved`,
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

  /**
   * A chain entry's engine, resolved pre-spawn: the validator has already
   * confined entries to Codex and Claude, so an entry naming an engine this
   * runtime does not carry (a registry built without it) is a declaration
   * the run cannot honour, rejected before anything is paid for.
   */
  #chainEngineFor(target: FallbackTarget): EngineAdapter {
    const adapter = this.#engines.get(target.engine);
    if (adapter === undefined) {
      throw new FallbackTargetRejectedError(`the ${target.engine} engine is not available to this run`);
    }
    return adapter;
  }

  /**
   * Resolves the target's canonical effort to the name its engine is
   * dispatched with (`resolveEffort`): the machine's bounds, then the clamp
   * to the nearest level the model serves, the served levels from the
   * machine map, else the engine's own report, else the built-in table.
   * Judged per target, so a chain entry or a remapped call takes its own
   * target's; written onto the target so every attempt record carries it,
   * and onto the agent record last-write-wins as `resolvedEffort` is.
   * opencode is exempt — its effort names a registry variant, judged by
   * its adapter — and a target with no effort has nothing to resolve.
   */
  async #resolveTargetEffort(
    engine: EngineAdapter,
    target: ChainTarget,
    agentRecord: RuntimeAgentRecord
  ): Promise<string | undefined> {
    if (target.effort === undefined || engine.name === "opencode") {
      return target.effort;
    }
    const engineReport = engine.servedEffortLevels === undefined ? null : await engine.servedEffortLevels(target.model);
    target.resolution = resolveEffort({
      // Validated pre-spawn: anything outside the canonical set was refused
      // before the call was admitted.
      requested: target.effort as CanonicalEffort,
      engine: engine.name,
      model: target.model,
      settings: this.#effortSettings,
      engineReport
    });
    agentRecord.effortResolution = target.resolution;
    return target.resolution.dispatched;
  }

  #engineTurnOptions(options: Partial<AgentOptions>, cwd: string, effort: string | undefined): EngineTurnOptions {
    const resolvedTimeoutMs = options.timeoutMs ?? this.#defaultTurnTimeoutMs;
    return {
      ...(resolvedTimeoutMs !== undefined ? { timeoutMs: resolvedTimeoutMs } : {}),
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(effort !== undefined ? { effort } : {}),
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
      headerIdentity: "original_request",
      prompt,
      options: {
        timeoutMs: options.timeoutMs ?? this.#defaultTurnTimeoutMs ?? null,
        maxAttempts: options.maxAttempts ?? this.#defaultMaxAttempts
      },
      model: typeof options.model === "string" ? options.model : null,
      effort: typeof options.effort === "string" ? options.effort : null,
      fallback: options.fallback === undefined ? null : options.fallback.map((target) => ({ ...target })),
      answeredBy: null,
      resolvedModel: null,
      resolvedEffort: null,
      effortResolution: null,
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
      transcriptCapture: null,
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

/** The machine-declared Claude cache TTL in ms, when one is declared and parseable. */
function declaredClaudeTtlMs(workerEnvironment: RuntimeOptions["workerEnvironment"]): number | null {
  const declared = workerEnvironment?.claude?.[CLAUDE_CACHE_TTL_VARIABLE];
  return declared === undefined ? null : claudeCacheTtlToMs(declared);
}

export function defaultConcurrency(): number {
  return defaultCodexConcurrency();
}

export type { Budget, TokenUsageEvent };

function requireTransport(transport: RuntimeTransport | undefined): RuntimeTransport {
  if (transport === undefined) {
    throw new Error("EnsembleRuntime requires either engines or a Codex transport");
  }
  return transport;
}

/** Whether the shared bound leaves the loop another attempt (one bound across the whole chain). */
function boundRemains(ledger: AttemptLedger): boolean {
  return ledger.answered < ledger.maxAttempts;
}

/**
 * The harness's decision after a failed attempt, stated from the
 * facts the attempt loop acts on: the attempt's class, whether a later
 * chain entry remains, and whether the loop runs another attempt on this
 * target. Null for a call that declared no chain — its own target with
 * nothing after it — which has no chain decision to state.
 */
function chainDecisionAfter(
  attempts: TargetAttempts,
  classification: FailureClassification,
  retries: boolean
): ChainDecision | null {
  if (attempts.target.entry === -1 && !attempts.chainRemains) {
    return null;
  }
  if (attempts.chainRemains && classification.class === "availability") {
    return "advanced";
  }
  if (attempts.chainRemains && classification.class === "unclassified" && classification.rule === null) {
    return "chain-not-consulted";
  }
  return retries ? "retried-in-place" : "exhausted";
}

function attemptRecord(
  attempt: number,
  target: ChainTarget,
  status: "complete" | "failed",
  failure: { kind: string; message: string } | null,
  rawOutput: string | null,
  validatedOutput: unknown,
  startedAtMs: number,
  result: Partial<Pick<
    TurnResult,
    | "durationMs"
    | "firstDeltaMs"
    | "tokenUsageEvents"
    | "transcripts"
    | "diagnostics"
    | "resolvedModel"
    | "resolvedEffort"
    | "backgroundWaits"
  >> | null,
  workerExit: { exitCode: number | null; signal: string | null } | null = null,
  appServerDiagnostic: RuntimeAgentAttemptRecord["appServerDiagnostic"] = null,
  observedFailure: { kind: string; message: string } | null = null,
  classification: FailureClassification | null = null,
  chainDecision: ChainDecision | null = null
): RuntimeAgentAttemptRecord {
  const endedAt = new Date();
  return {
    attempt,
    status,
    target: { engine: target.engine, model: target.model ?? null },
    effortResolution: target.resolution,
    failure,
    classification,
    chainDecision,
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
    diagnostics: result?.diagnostics ?? {},
    backgroundWaits: result?.backgroundWaits ?? []
  };
}

/** An explicit hold scope must name a scope: blank is neither a scope nor a request for the shared one. */
function rejectBlankHoldScope(holdScope: string | undefined): void {
  if (holdScope !== undefined && holdScope.trim().length === 0) {
    throw new HoldRejectedError("holdScope must be a non-empty string when given");
  }
}

function recordTurnMetadata(record: RuntimeAgentRecord, result: TurnResult): void {
  if (result.resolvedModel !== undefined) {
    record.resolvedModel = result.resolvedModel;
  }
  if (result.resolvedEffort !== undefined) {
    record.resolvedEffort = result.resolvedEffort;
  }
  if (result.transcriptCapture !== undefined) {
    record.transcriptCapture = result.transcriptCapture;
  }
}

function failureFromError(error: unknown): { kind: string; message: string } {
  return describeError(error);
}

/**
 * The engine's own account of why this agent failed, as the attempts array
 * recorded it: the last attempt that named a failure, or null when no
 * attempt did — either because none ran, or because none observed a fault.
 * This is the record's home for a diagnosed failure; `terminationCause`
 * speaks only where this is silent.
 */
function attemptedFailureAccount(record: RuntimeAgentRecord): { kind: string; message: string } | null {
  for (let index = record.attempts.length - 1; index >= 0; index -= 1) {
    const failure = record.attempts[index]?.failure;
    if (failure !== undefined && failure !== null) {
      return failure;
    }
  }
  return null;
}

/**
 * The cause a failed agent records when no attempt of its own named one.
 * The runtime publishes what it is actually holding — the rejection that
 * ended the call, in the engine's own words — and where it holds nothing it
 * says so with the reason, because a record that reads `failed` and nothing
 * else is indistinguishable from one whose diagnostic was lost.
 * Nothing here is inferred from the status.
 */
function failedWithoutAttemptCause(error: unknown): TerminalErrorRecord {
  if (error === null || error === undefined) {
    return unavailableCause("no error was reported to the runtime");
  }
  const described = describedRejection(error);
  if (described === null) {
    return unavailableCause(`the rejection the runtime holds (${rejectionShape(error)}) could not be described`);
  }
  if (described.message.trim() === "") {
    // A `failed` status beside an empty message is the bare status this
    // function exists to avoid: it reads as an engine that said nothing and
    // as a diagnostic lost in transit alike. Naming the silence, and the
    // shape that was silent, keeps the record honest without wording the
    // engine never produced.
    return unavailableCause(`the rejection the runtime holds (${rejectionShape(error)}) carried no message`);
  }
  return described;
}

/**
 * The record's account when the runtime genuinely holds none. The reason
 * travels with it so a consumer can tell an engine that said nothing from a
 * diagnostic that was lost — the honesty rule in its other direction, where
 * a generic "failed" would be the fabrication.
 */
function unavailableCause(reason: string): TerminalErrorRecord {
  return { kind: "unavailable", message: `the agent failed with no attempt recorded and ${reason}` };
}

/**
 * `describeError` for a value that reached the runtime as a rejection,
 * returning null rather than propagating when the value cannot be described
 * at all. A thrown object whose `toString` throws would otherwise take the
 * settlement path down with it, losing the whole record to report a failure.
 */
function describedRejection(error: unknown): { kind: string; message: string } | null {
  try {
    const described = failureFromError(error);
    // A non-Error's description is `String(value)`, which for a plain object
    // is the useless "[object Object]" — an account in form only. It is
    // reported as unavailable, with the shape, rather than published as if
    // the engine had spoken.
    return described.message === "[object Object]" ? null : described;
  } catch {
    return null;
  }
}

/** What was thrown, said without calling anything the thrower controls. */
function rejectionShape(error: unknown): string {
  try {
    if (error instanceof Error) {
      return String(error.name);
    }
  } catch {
    return "an undescribable value";
  }
  return `a value of type ${typeof error}`;
}

/**
 * The account a failed settlement left on the record, read from evidence
 * already there: the last attempt's own failure, else the runtime's
 * termination cause, else the bare fact — never synthesised from status.
 */
/** The attempts on which the chain advanced, in order — the first is always the declared target's refusal. */
function advancesOf(record: RuntimeAgentRecord): RuntimeAgentAttemptRecord[] {
  return record.attempts.filter((attempt) => attempt.chainDecision === "advanced");
}

function settledFailureAccount(record: RuntimeAgentRecord): { kind: string; message: string } {
  const attempted = attemptedFailureAccount(record);
  if (attempted !== null) {
    return attempted;
  }
  return record.terminationCause ?? { kind: "unavailable", message: "the agent failed without a recorded cause" };
}

/** The one-line rendering of that account an identified envelope's `failure` carries. */
function settledFailureMessage(record: RuntimeAgentRecord): string {
  const account = settledFailureAccount(record);
  return `${account.kind}: ${account.message}`;
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
