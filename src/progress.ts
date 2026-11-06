import type { AgentWaitSnapshot, EngineName } from "./types.js";

/** A worker's lifecycle state as the progress model sees it. */
export type AgentState = "queued" | "running" | "done" | "failed";

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
   * What the worker is waiting on, when the harness is waiting with it: a
   * background task its session started (a long command, a Monitor) whose
   * wake has not yet landed. Null while the worker is thinking or its
   * engine has no such notion. The distinction a supervisor needs between a
   * stuck background task and a worker still generating.
   */
  waitingOn: AgentWaitSnapshot | null;
}

export interface EngineProgressSnapshot {
  /** Self-imposed concurrency cap, if the engine registered one. */
  cap: number | null;
  active: number;
  queued: number;
  done: number;
  failed: number;
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
   * Snapshot schema version. 3 retains finished workers and their outcomes.
   * 2: one file per run in the status directory
   * (`ensemble.<run-uuid>.local.json`), each carrying its writer's owner
   * evidence; 1 was the single-slot `ensemble.local.json`.
   */
  schema: 3;
  runId: string;
  pid: number;
  archiveDir: string | null;
  workflow: string | null;
  state: "running" | "finished";
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  currentPhase: string | null;
  totals: { active: number; queued: number; done: number; failed: number };
  engines: Record<string, EngineProgressSnapshot>;
  agents: LiveAgentSnapshot[];
  /** Open holds: present while the run awaits decisions, empty otherwise. */
  holds: OpenHoldSnapshot[];
}

export interface RunProgressOptions {
  runId: string;
  budget: BudgetView;
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
  waitingOn: AgentWaitSnapshot | null;
}

interface EngineCounters {
  cap: number | null;
  active: number;
  queued: number;
  done: number;
  failed: number;
}

export type ProgressListener = () => void;

/**
 * The single in-memory source of truth for what a run is doing right now:
 * current phase, per-engine queue/active/done/failed counts, and the live
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
   * Records what a live worker is waiting on — a background task its
   * session started — or that it no longer is (`null`). Last write wins:
   * the engine reports each change as it observes it.
   */
  noteAgentWaiting(id: number, wait: AgentWaitSnapshot | null): void {
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

  /** Retires a worker, tallying it as done or failed and freeing its slot. */
  settleAgent(id: number, outcome: "done" | "failed", failure: AgentFailure | null = null): void {
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
    if (outcome === "done") {
      counters.done += 1;
    } else {
      counters.failed += 1;
    }
    record.state = outcome;
    record.finishedAtMs = this.#now();
    record.failure = outcome === "failed" && failure !== null ? { ...failure } : null;
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

  /** Refreshes the live snapshot without changing its modelled state. */
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
    const totals = { active: 0, queued: 0, done: 0, failed: 0 };
    for (const engine of this.#engines.keys()) {
      const counters = this.#counters(engine);
      const remaining = this.#budget.remaining(engine);
      engines[engine] = {
        cap: counters.cap,
        active: counters.active,
        queued: counters.queued,
        done: counters.done,
        failed: counters.failed,
        spent: this.#budget.spent(engine),
        ceiling: this.#budget.ceilings[engine] ?? null,
        remaining: Number.isFinite(remaining) ? remaining : null
      };
      totals.active += counters.active;
      totals.queued += counters.queued;
      totals.done += counters.done;
      totals.failed += counters.failed;
    }

    return {
      schema: 3,
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
      const fresh: EngineCounters = { cap: null, active: 0, queued: 0, done: 0, failed: 0 };
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
