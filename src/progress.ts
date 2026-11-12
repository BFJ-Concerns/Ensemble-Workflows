import type {
  AdmissionWaitSnapshot,
  AgentWaitSnapshot,
  BackgroundTaskWaitSnapshot,
  EngineName
} from "./types.js";

/**
 * How a worker left the run. The four values partition every worker the run
 * dispatched, the same partition the completion sentinel's worker tally
 * draws:
 *
 * - `done` — settled on its own account, successfully.
 * - `failed` — settled on its own account, with a failure.
 * - `cut-short` — the run's ending tore it down: its record carries the
 *   `run-<status>` cause naming the run's own shutdown status.
 * - `unsettled` — the run ended before any outcome was observed; its record
 *   reads `abandoned`.
 *
 * A worker that settles on its own account while the run is shutting down
 * keeps that account: `done` or `failed`, never `cut-short`.
 */
export type WorkerDisposition = "done" | "failed" | "cut-short" | "unsettled";

/** A worker's lifecycle state as the progress model sees it: live, or finished with its disposition. */
export type AgentState = "queued" | "running" | WorkerDisposition;

/** The run statuses a shutdown settles cut-short workers with. */
export type ShutdownStatus = "failed" | "timed-out" | "interrupted";

/** What a worker's agent record says, as far as its disposition depends on it. */
export interface DispositionEvidence {
  status: "in-progress" | "complete" | "failed" | "timed-out" | "interrupted" | "abandoned";
  terminationCause: { kind: string } | null;
}

/**
 * The one mapping from a worker's agent record to its disposition, shared by
 * live settlement and the shutdown tally so the status file, the sentinel and
 * the archive say the same thing. `shutdownStatus` is the status the run is
 * closing with, or null while it is not closing: a `run-<status>` cause is
 * cut short only when it names the run's own ending. Returns null for a
 * record still in progress, which has no disposition yet.
 */
export function workerDisposition(
  record: DispositionEvidence,
  shutdownStatus: ShutdownStatus | null
): WorkerDisposition | null {
  switch (record.status) {
    case "in-progress":
      return null;
    case "abandoned":
      return "unsettled";
    case "complete":
      return "done";
    default:
      return shutdownStatus !== null && record.terminationCause?.kind === `run-${shutdownStatus}`
        ? "cut-short"
        : "failed";
  }
}

/** Finished-worker counts, one per disposition; used in the totals and per engine. */
export interface DispositionCounts {
  done: number;
  failed: number;
  cutShort: number;
  unsettled: number;
}

const DISPOSITION_COUNTER: Record<WorkerDisposition, keyof DispositionCounts> = {
  done: "done",
  failed: "failed",
  "cut-short": "cutShort",
  unsettled: "unsettled"
};

export interface AgentFailure {
  kind: string;
  message: string;
}

/** The minimal budget surface the progress model reads when serialising. */
export interface BudgetView {
  spent(engine: EngineName): number;
  remaining(engine: EngineName): number;
  readonly ceilings: Readonly<Partial<Record<EngineName, number | null>>>;
}

/**
 * The minimal admission surface the progress model reads when serialising.
 *
 * Admission owns the ceiling, its slot counters and its queue, and the
 * progress model keeps no copy of any of them: each snapshot reads them
 * afresh, so what it publishes about admission cannot drift from what
 * admission holds, and nothing needs clearing when a worker is dispatched,
 * falls back to another engine, is cancelled or settles. Whoever owns the
 * account calls {@link RunProgress.markChanged} when it changes, so the
 * snapshot is republished.
 */
export interface AdmissionView {
  /** The run-wide agent ceiling, or null when the run has none. */
  readonly ceiling: number | null;
  snapshot(): {
    /** Workers holding a ceiling slot: admitted and not yet released. */
    ceilingActive: number;
    /** Every worker admission is holding back, keyed by worker id. */
    waiting: ReadonlyMap<number, AdmissionWaitSnapshot>;
  };
}

export interface LiveAgentSnapshot {
  requestedModel: string | null;
  requestedEffort: string | null;
  resolvedModel: string | null;
  resolvedEffort: string | null;
  transcript: string | null;
  worktree: string | null;
  spent: number | null;
  lastEvidenceAtMs: number | null;
  finishedAtMs: number | null;
  failure: AgentFailure | null;

  id: number;
  engine: EngineName;
  label: string | null;
  phase: string | null;
  state: AgentState;
  /** 1 on the first try; >1 while a retry/correction is in flight. */
  attempt: number;
  /**
   * Epoch ms the worker left the queue and began executing; null while
   * queued. With `firstEvidenceAtMs` this is the liveness evidence a
   * supervisor reads mid-run: a leg running for minutes with no evidence is
   * suspect, one with recent evidence is healthy-but-slow — the distinction
   * that stops a healthy worker being killed on a misread.
   */
  startedAtMs: number | null;
  /** Epoch ms of the first observed sign of worker output; null until the engine reports one. */
  firstEvidenceAtMs: number | null;
  /**
   * What the worker is waiting on, when the harness knows. The worker's
   * state decides which wait it can carry, and each has one source:
   *
   * - queued — an admission wait naming the gate holding it, read from
   *   the {@link AdmissionView} when the snapshot is taken and never stored
   *   on the worker; null while admission is not holding it.
   * - running — a background task its session started (a long command, a
   *   Monitor) whose wake has not yet landed, as its engine reports it;
   *   null while the worker is thinking or its engine has no such notion.
   *   The distinction a supervisor needs between a stuck background task
   *   and a worker still generating.
   * - finished — null.
   */
  waitingOn: AgentWaitSnapshot | null;
}

/** The run-wide agent ceiling and the slots held under it, as admission counts them. */
export interface AgentCeilingSnapshot {
  /** The most workers the run may have in flight across all engines; null when it has no ceiling. */
  limit: number | null;
  /**
   * Workers holding a ceiling slot, counted whether or not the run has a
   * ceiling. A slot is taken just before its worker starts executing and
   * given back just after the worker settles, so this can briefly differ
   * from `totals.active`.
   */
  active: number;
}

export interface EngineProgressSnapshot extends DispositionCounts {
  /** Self-imposed concurrency cap, if the engine registered one. */
  cap: number | null;
  active: number;
  queued: number;
  spent: number;
  /** Per-engine token ceiling, or null when unbounded. */
  ceiling: number | null;
  /** Remaining tokens, or null when the engine is unbounded. */
  remaining: number | null;
}

/** An open hold as the snapshot shows it: what a poller needs to see the run is waiting. */
export interface OpenHoldSnapshot {
  id: string;
  /** Bounded to keep the snapshot small; the hold file carries the full text. */
  content: string;
  verdicts: string[];
  raisedAtMs: number;
}

export interface ProgressSnapshot {
  /**
   * Snapshot schema version. A number names exactly one declared shape, so
   * it rises by one with any change to that shape: a field added, removed
   * or renamed, a field's type or meaning changed, or a value added to a
   * set a reader switches on (a worker `state`, a `waitingOn.kind`, a
   * `gate`). Changes that land together share one rise. The writer
   * publishes the current version only, and a reader treats a number it was
   * not built for as unreadable.
   *
   * 5 gives a queued worker an admission wait and publishes the agent
   * ceiling. 4 finishes every worker with one of the four dispositions and
   * counts each; 3 retained finished workers as done or failed only. 2: one
   * file per run in the status directory (`ensemble.<run-uuid>.local.json`),
   * each carrying its writer's owner evidence; 1 was the single-slot
   * `ensemble.local.json`.
   */
  schema: 5;
  runId: string;
  pid: number;
  archiveDir: string | null;
  workflow: string | null;
  state: "running" | "finished";
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  currentPhase: string | null;
  totals: { active: number; queued: number } & DispositionCounts;
  agentCeiling: AgentCeilingSnapshot;
  engines: Record<string, EngineProgressSnapshot>;
  agents: LiveAgentSnapshot[];
  /** Open holds: present while the run awaits decisions, empty otherwise. */
  holds: OpenHoldSnapshot[];
}

export interface RunProgressOptions {
  runId: string;
  budget: BudgetView;
  admission: AdmissionView;
  /** Injectable clock; defaults to `Date.now`. Keeps snapshots testable. */
  now?: () => number;
  /** Injectable pid; defaults to `process.pid`. */
  pid?: number;
}

interface AgentRecord {
  requestedModel: string | null;
  requestedEffort: string | null;
  resolvedModel: string | null;
  resolvedEffort: string | null;
  transcript: string | null;
  worktree: string | null;
  spent: number | null;
  lastEvidenceAtMs: number | null;
  finishedAtMs: number | null;
  failure: AgentFailure | null;

  id: number;
  engine: EngineName;
  label: string | null;
  phase: string | null;
  state: AgentState;
  attempt: number;
  startedAt: number | null;
  firstEvidenceAt: number | null;
  /** The wait the worker's engine last reported. An admission wait is never stored here. */
  waitingOn: BackgroundTaskWaitSnapshot | null;
}

interface EngineCounters extends DispositionCounts {
  cap: number | null;
  active: number;
  queued: number;
}

export type ProgressListener = () => void;

/**
 * The single in-memory source of truth for what a run is doing right now:
 * current phase, per-engine live and per-disposition counts, and the live
 * worker list — keyed off the same `agent()` invocations the scheduler drives.
 *
 * It is pure state with no I/O. A serialiser (the status-file writer) subscribes
 * via {@link onChange} and persists {@link snapshot} wherever a renderer can
 * read it. The runtime always maintains one; persisting it is opt-in at the CLI
 * boundary, so carrying this model costs nothing when nobody is watching.
 */
export class RunProgress {
  readonly runId: string;

  #budget: BudgetView;
  #admission: AdmissionView;
  #now: () => number;
  #pid: number;

  #archiveDir: string | null = null;
  #finished = new Map<number, AgentRecord>();
  #workflow: string | null = null;
  #currentPhase: string | null = null;
  #state: "running" | "finished" = "running";
  #startedAt: number;
  #updatedAt: number;
  #finishedAt: number | null = null;

  #nextAgentId = 0;
  #live = new Map<number, AgentRecord>();
  #openHolds = new Map<string, OpenHoldSnapshot>();
  #engines = new Map<EngineName, EngineCounters>();
  #reportedSpend = new Map<EngineName, number>();
  #listeners = new Set<ProgressListener>();

  constructor(options: RunProgressOptions) {
    this.runId = options.runId;
    this.#budget = options.budget;
    this.#admission = options.admission;
    this.#now = options.now ?? (() => Date.now());
    this.#pid = options.pid ?? process.pid;
    this.#startedAt = this.#now();
    this.#updatedAt = this.#startedAt;
  }

  /** An open hold joins the snapshot the moment it is raised. */
  noteHoldRaised(hold: { id: string; content: string; verdicts: string[] }): void {
    this.#openHolds.set(hold.id, {
      id: hold.id,
      content: hold.content.length > 500 ? `${hold.content.slice(0, 500)}…` : hold.content,
      verdicts: [...hold.verdicts],
      raisedAtMs: this.#now()
    });
    this.#touch();
  }

  /** Settled holds — answered, timed out, or abandoned — leave the snapshot. */
  noteHoldSettled(id: string): void {
    if (this.#openHolds.delete(id)) {
      this.#touch();
    }
  }

  /** Records an engine's concurrency cap so the snapshot can show saturation. */
  registerEngine(engine: EngineName, cap: number): void {
    this.#counters(engine).cap = cap;
    this.#touch();
  }

  setArchiveDir(path: string | null): void {
    this.#archiveDir = path;
    this.#touch();
  }

  /** Publishes only observed identity; served values must not echo the request. */
  noteAgentIdentity(id: number, identity: Partial<Pick<LiveAgentSnapshot,
    "requestedModel" | "requestedEffort" | "resolvedModel" | "resolvedEffort">>): void {
    const record = this.#live.get(id);
    if (record === undefined) return;
    Object.assign(record, identity);
    this.#touch();
  }

  noteAgentTranscript(id: number, path: string | null): void {
    const record = this.#live.get(id);
    if (record === undefined) return;
    record.transcript = path;
    this.#touch();
  }

  noteAgentWorktree(id: number, path: string | null): void {
    const record = this.#live.get(id);
    if (record === undefined) return;
    record.worktree = path;
    this.#touch();
  }

  /** Cumulative worker tokens across attempts and targets; null means unobserved. */
  noteAgentSpend(id: number, spent: number | null): void {
    const record = this.#live.get(id);
    if (record === undefined || record.spent === spent) return;
    if (spent !== null && (!Number.isFinite(spent) || spent < 0)) {
      throw new RangeError("Worker spend must be finite and non-negative");
    }
    record.spent = spent;
    this.#touch();
  }

  setWorkflow(name: string | null): void {
    this.#workflow = name;
    this.#touch();
  }

  setPhase(title: string): void {
    this.#currentPhase = title;
    this.#touch();
  }

  /**
   * Registers a worker as queued and returns its id. The phase is captured at
   * queue time: an explicit `phase` wins, otherwise the run's current phase.
   */
  queueAgent(input: { engine: EngineName; label: string | null; phase: string | null }): number {
    const id = (this.#nextAgentId += 1);
    this.#live.set(id, {
      id,
      requestedModel: null, requestedEffort: null,
      resolvedModel: null, resolvedEffort: null,
      transcript: null, worktree: null, spent: null,
      lastEvidenceAtMs: null, finishedAtMs: null, failure: null,
      engine: input.engine,
      label: input.label,
      phase: input.phase ?? this.#currentPhase,
      state: "queued",
      attempt: 1,
      startedAt: null,
      firstEvidenceAt: null,
      waitingOn: null
    });
    this.#counters(input.engine).queued += 1;
    this.#touch();
    return id;
  }

  /** The phase fixed for a worker when it entered the queue. */
  queuedAgentPhase(id: number): string | null {
    return this.#live.get(id)?.phase ?? null;
  }

  /**
   * Returns a running worker to the queue on another engine: a fallback
   * chain step across engines releases the refused engine's slot and
   * waits for admission on the next, and the live view says so — the leg
   * reads queued on its new engine, its evidence timestamps reset for the
   * fresh dispatch, its earlier engine's counters restored.
   */
  requeueAgent(id: number, engine: EngineName): void {
    const record = this.#live.get(id);
    if (record === undefined) {
      return;
    }
    const previous = this.#counters(record.engine);
    if (record.state === "running") {
      previous.active -= 1;
    } else {
      previous.queued -= 1;
    }
    record.engine = engine;
    record.state = "queued";
    record.startedAt = null;
    record.firstEvidenceAt = null;
    record.lastEvidenceAtMs = null;
    record.resolvedModel = null;
    record.resolvedEffort = null;
    record.transcript = null;
    record.waitingOn = null;
    this.#counters(engine).queued += 1;
    this.#touch();
  }

  /** Moves a queued worker into the running state (a scheduler slot freed up). */
  startAgent(id: number): void {
    const record = this.#live.get(id);
    if (record === undefined || record.state !== "queued") {
      return;
    }
    record.state = "running";
    record.startedAt = this.#now();
    const counters = this.#counters(record.engine);
    counters.queued -= 1;
    counters.active += 1;
    this.#touch();
  }

  /**
   * Records the first observed sign of worker output for a live agent.
   * Each observation advances the last-output stamp; the first stamp stays fixed
   * across retries on the same target.
   */
  noteAgentEvidence(id: number): void {
    const record = this.#live.get(id);
    if (record === undefined || record.state !== "running") {
      return;
    }
    const now = this.#now();
    record.firstEvidenceAt ??= now;
    record.lastEvidenceAtMs = now;
    this.#touch();
  }

  /**
   * Records the background task a running worker is waiting on, or that it
   * no longer waits on one (`null`). Last write wins: the engine reports
   * each change as it observes it.
   */
  noteAgentWaiting(id: number, wait: BackgroundTaskWaitSnapshot | null): void {
    const record = this.#live.get(id);
    if (record === undefined || (record.waitingOn === null && wait === null)) {
      return;
    }
    record.waitingOn = wait;
    this.#touch();
  }

  /** Updates a running worker's attempt number (retry / in-session correction); a fresh attempt waits on nothing yet. */
  noteAttempt(id: number, attempt: number): void {
    const record = this.#live.get(id);
    if (record === undefined || record.attempt === attempt) {
      return;
    }
    record.attempt = attempt;
    record.waitingOn = null;
    this.#touch();
  }

  /**
   * Retires a worker with its disposition, counting it and freeing its slot.
   * `failure` is the account its record carries — kept for every disposition
   * but `done`. The first settlement is final: later calls are inert, so a
   * worker is never reclassified once published.
   */
  settleAgent(id: number, disposition: WorkerDisposition, failure: AgentFailure | null = null): void {
    const record = this.#live.get(id);
    if (record === undefined) {
      return;
    }
    this.#live.delete(id);
    const counters = this.#counters(record.engine);
    if (record.state === "running") {
      counters.active -= 1;
    } else {
      counters.queued -= 1;
    }
    counters[DISPOSITION_COUNTER[disposition]] += 1;
    record.state = disposition;
    record.finishedAtMs = this.#now();
    record.failure = disposition !== "done" && failure !== null ? { ...failure } : null;
    record.waitingOn = null;
    this.#finished.set(id, record);
    this.#touch();
  }

  /** Marks the run finished. The serialiser writes one final snapshot after. */
  finish(): void {
    if (this.#state === "finished") {
      return;
    }
    this.#state = "finished";
    this.#finishedAt = this.#now();
    this.#touch();
  }

  /**
   * Publishes a changed per-engine spend figure to live consumers. Repeated
   * reports of the same value are deliberately inert: accounting producers
   * may observe the same running turn more than once.
   */
  noteEngineSpend(engine: EngineName): void {
    const spent = this.#budget.spent(engine);
    if (this.#reportedSpend.get(engine) === spent) {
      return;
    }
    this.#reportedSpend.set(engine, spent);
    this.#touch();
  }

  /**
   * Refreshes the live snapshot without changing its modelled state: what
   * a view the snapshot reads (the admission account) calls when it changes.
   */
  markChanged(): void {
    this.#touch();
  }

  onChange(listener: ProgressListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  snapshot(): ProgressSnapshot {
    const engines: Record<string, EngineProgressSnapshot> = {};
    const totals = { active: 0, queued: 0, done: 0, failed: 0, cutShort: 0, unsettled: 0 };
    for (const engine of this.#engines.keys()) {
      const counters = this.#counters(engine);
      const remaining = this.#budget.remaining(engine);
      engines[engine] = {
        cap: counters.cap,
        active: counters.active,
        queued: counters.queued,
        done: counters.done,
        failed: counters.failed,
        cutShort: counters.cutShort,
        unsettled: counters.unsettled,
        spent: this.#budget.spent(engine),
        ceiling: this.#budget.ceilings[engine] ?? null,
        remaining: Number.isFinite(remaining) ? remaining : null
      };
      totals.active += counters.active;
      totals.queued += counters.queued;
      totals.done += counters.done;
      totals.failed += counters.failed;
      totals.cutShort += counters.cutShort;
      totals.unsettled += counters.unsettled;
    }

    // One read of admission's account per snapshot, so every admission
    // figure the snapshot carries comes from the same moment.
    const admission = this.#admission.snapshot();

    return {
      schema: 5,
      runId: this.runId,
      pid: this.#pid,
      archiveDir: this.#archiveDir,
      workflow: this.#workflow,
      state: this.#state,
      startedAt: this.#startedAt,
      updatedAt: this.#updatedAt,
      finishedAt: this.#finishedAt,
      currentPhase: this.#currentPhase,
      totals,
      agentCeiling: { limit: this.#admission.ceiling, active: admission.ceilingActive },
      engines,
      agents: this.#agents(),
      holds: [...this.#openHolds.values()]
    };
  }

  #agents(): LiveAgentSnapshot[] {
    const records = [...this.#live.values(), ...this.#finished.values()];
    // Running, queued, then finished workers; every worker stays visible.
    records.sort((a, b) => rank(a.state) - rank(b.state) || (rank(a.state) === 2 ? b.id - a.id : a.id - b.id));
    return records.map((record) => ({
      requestedModel: record.requestedModel,
      requestedEffort: record.requestedEffort,
      resolvedModel: record.resolvedModel,
      resolvedEffort: record.resolvedEffort,
      transcript: record.transcript,
      worktree: record.worktree,
      spent: record.spent,
      lastEvidenceAtMs: record.lastEvidenceAtMs,
      finishedAtMs: record.finishedAtMs,
      failure: record.failure === null ? null : { ...record.failure },
      id: record.id,
      engine: record.engine,
      label: record.label,
      phase: record.phase,
      state: record.state,
      attempt: record.attempt,
      startedAtMs: record.startedAt,
      firstEvidenceAtMs: record.firstEvidenceAt,
      waitingOn: record.waitingOn
    }));
  }

  #counters(engine: EngineName): EngineCounters {
    const counters = this.#engines.get(engine);
    if (counters === undefined) {
      const fresh: EngineCounters = { cap: null, active: 0, queued: 0, done: 0, failed: 0, cutShort: 0, unsettled: 0 };
      this.#engines.set(engine, fresh);
      return fresh;
    }
    return counters;
  }

  #touch(): void {
    this.#updatedAt = this.#now();
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

function rank(state: AgentState): number {
  return state === "running" ? 0 : state === "queued" ? 1 : 2;
}
