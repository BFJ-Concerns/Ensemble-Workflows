import type { EngineName } from "./types.js";

// Live agents are bounded in the serialised snapshot so a thousand-wide fan-out
// doesn't produce a thousand-entry file on every change. Running agents are
// favoured over merely-queued ones; the true counts always live in `totals`.
const MAX_AGENTS_IN_SNAPSHOT = 64;

/** A worker's lifecycle state as the progress model sees it. */
export type AgentState = "queued" | "running";

/** The minimal budget surface the progress model reads when serialising. */
export interface BudgetView {
  spent(engine: EngineName): number;
  remaining(engine: EngineName): number;
  readonly ceilings: Readonly<Partial<Record<EngineName, number | null>>>;
}

export interface LiveAgentSnapshot {
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

export interface ProgressSnapshot {
  /** Snapshot schema version, bumped if the shape ever changes. */
  schema: 1;
  runId: string;
  pid: number;
  workflow: string | null;
  state: "running" | "finished";
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  currentPhase: string | null;
  totals: { active: number; queued: number; done: number; failed: number };
  engines: Record<string, EngineProgressSnapshot>;
  agents: LiveAgentSnapshot[];
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
  id: number;
  engine: EngineName;
  label: string | null;
  phase: string | null;
  state: AgentState;
  attempt: number;
  startedAt: number | null;
  firstEvidenceAt: number | null;
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

  #workflow: string | null = null;
  #currentPhase: string | null = null;
  #state: "running" | "finished" = "running";
  #startedAt: number;
  #updatedAt: number;
  #finishedAt: number | null = null;

  #nextAgentId = 0;
  #live = new Map<number, AgentRecord>();
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

  /** Records an engine's concurrency cap so the snapshot can show saturation. */
  registerEngine(engine: EngineName, cap: number): void {
    this.#counters(engine).cap = cap;
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
      engine: input.engine,
      label: input.label,
      phase: input.phase ?? this.#currentPhase,
      state: "queued",
      attempt: 1,
      startedAt: null,
      firstEvidenceAt: null
    });
    this.#counters(input.engine).queued += 1;
    this.#touch();
    return id;
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
   * Idempotent — the earliest observation wins — so engines may report on
   * every attempt without the consumer losing the original timestamp.
   */
  noteAgentEvidence(id: number): void {
    const record = this.#live.get(id);
    if (record === undefined || record.firstEvidenceAt !== null) {
      return;
    }
    record.firstEvidenceAt = this.#now();
    this.#touch();
  }

  /** Updates a running worker's attempt number (retry / in-session correction). */
  noteAttempt(id: number, attempt: number): void {
    const record = this.#live.get(id);
    if (record === undefined || record.attempt === attempt) {
      return;
    }
    record.attempt = attempt;
    this.#touch();
  }

  /** Retires a worker, tallying it as done or failed and freeing its slot. */
  settleAgent(id: number, outcome: "done" | "failed"): void {
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
      schema: 1,
      runId: this.runId,
      pid: this.#pid,
      workflow: this.#workflow,
      state: this.#state,
      startedAt: this.#startedAt,
      updatedAt: this.#updatedAt,
      finishedAt: this.#finishedAt,
      currentPhase: this.#currentPhase,
      totals,
      engines,
      agents: this.#liveAgents()
    };
  }

  #liveAgents(): LiveAgentSnapshot[] {
    const records = [...this.#live.values()];
    // Running agents first, then the queued tail, capped for file size. The
    // counts are never lost — `totals`/`engines` carry the full tally.
    records.sort((a, b) => rank(a.state) - rank(b.state) || a.id - b.id);
    return records.slice(0, MAX_AGENTS_IN_SNAPSHOT).map((record) => ({
      id: record.id,
      engine: record.engine,
      label: record.label,
      phase: record.phase,
      state: record.state,
      attempt: record.attempt,
      startedAtMs: record.startedAt,
      firstEvidenceAtMs: record.firstEvidenceAt
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
  return state === "running" ? 0 : 1;
}
