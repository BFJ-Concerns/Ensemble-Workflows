import { addUsageSummary, summariseUsage, type UsageSummary } from "./usage-summary.js";
import type { EngineName, TokenUsageEvent } from "./types.js";

/**
 * The manifest's `cost_rollup`: engine -> served model -> one leaf. Never
 * summed across engines.
 *
 * Two writers produce it from different record shapes: the run's own
 * writer from its in-memory agent records and live attempts, and the next
 * run's abandonment sweep from the agent records a dead run left on disk.
 * Each maps its records into `RollupAgentView`s and calls
 * `buildCostRollup`; every judgement — which bucket an attempt books
 * under, whether its spend was observed — is made here, once, so the two
 * writers cannot publish different roll-ups for the same evidence.
 */
export type CostRollup = Record<string, Record<string, CostRollupLeaf>>;

/**
 * One engine and served model's figures, and whether they are the whole
 * of what ran there. `complete` is the reading a consumer needs before it
 * treats `tokens` as a total: true only when no attempt booked under the
 * leaf has spend the figures leave out, otherwise the figures are a lower
 * bound and `unobserved` says whose spend is missing and why. A leaf with
 * no figures at all (`tokens.unavailable`) is complete only when nothing
 * booked under it ran a worker.
 */
export interface CostRollupLeaf {
  /** Summary usage in the declared vocabulary, or why there is none. */
  tokens: UsageSummary | { unavailable: "no-usage-reported" };
  /**
   * Money, in the same absence-with-a-reason idiom: the reported form only
   * where an engine reported cost with its usage. The harness prices
   * nothing itself.
   */
  cost: ReportedCost | { unavailable: "no-provider-cost-reported" | "unlike-currencies" };
  complete: boolean;
  /** One entry per attempt whose spend the figures omit, in agent then attempt order; empty when `complete`. */
  unobserved: UnobservedSpend[];
}

/** Provider-reported spend, summed across the leaf's own usage events. */
export interface ReportedCost {
  amount: number;
  currency: string | null;
  /** Always `provider-reported`: the harness has no pricing table. */
  source: "provider-reported";
}

/**
 * An attempt that ran a worker whose spend the leaf's figures do not fully
 * contain. `measured` says how much of it they do contain: `"partial"` when
 * the attempt reported some usage before it ended (the figures include
 * that, a lower bound for the attempt), `"none"` when it reported nothing.
 */
export interface UnobservedSpend {
  /** The agent record's `id`. */
  agent: number;
  /** The attempt's number in that record's `attempts`. */
  attempt: number;
  reason: UnobservedSpendReason;
  measured: "partial" | "none";
}

/**
 * Why an attempt's spend is not fully observed. The words are the agent
 * record's own `usage.unavailable` vocabulary, so one cause reads the same
 * on the agent and on the roll-up:
 *
 * - `record-unsettled`: no outcome was observed. In a live manifest the
 *   attempt is still running; in an abandoned run the writer died with it
 *   running (SIGKILL, or any death the launcher could not handle) and the
 *   next run's sweep found it.
 * - `worker-interrupted`: the run's interrupt (SIGINT, SIGTERM, or a body
 *   that returned with the leg in flight) cut the attempt short.
 * - `worker-timed-out`: a run or turn deadline the runtime enforced cut it
 *   short.
 * - `engine-reported-no-usage`: the attempt settled on its engine's own
 *   account and that account carried no usage.
 */
export type UnobservedSpendReason =
  | "record-unsettled"
  | "worker-interrupted"
  | "worker-timed-out"
  | "engine-reported-no-usage";

/**
 * How one attempt ended, as far as its spend is concerned:
 *
 * - `settled`: the engine's own account settled it, complete or failed.
 * - `refused`: refused before any worker existed — nothing ran, so there
 *   is no spend to observe.
 * - `interrupted` / `timed-out`: the runtime cut it short.
 * - `unsettled`: no outcome observed (running, or abandoned).
 */
export type AttemptEnding = "settled" | "refused" | "interrupted" | "timed-out" | "unsettled";

/**
 * Failure kinds raised when a substrate refused an attempt before any
 * worker process existed. Such an attempt spent nothing.
 */
export const REFUSED_BEFORE_WORKER_KINDS: ReadonlySet<string> = new Set([
  "CodexSubstrateRefusedError",
  "ClaudeDispatchError"
]);

/**
 * An agent record reduced to what the roll-up reads, in either writer's
 * terms. `attempts` lists every attempt that demonstrably ran, settled ones
 * first in number order and then, where one exists, the unsettled attempt
 * (the live attempt in a running record, the abandoned entry in a reaped
 * one).
 */
export interface RollupAgentView {
  id: number;
  /** The engine the call asked for; books an agent with no attempts. */
  engine: EngineName;
  /** The agent record's status. */
  status: "in-progress" | "complete" | "failed" | "timed-out" | "interrupted" | "abandoned";
  /** The agent-level served model: last write wins across attempts. */
  resolvedModel: string | null;
  attempts: RollupAttemptView[];
}

export interface RollupAttemptView {
  attempt: number;
  /** The engine this attempt was dispatched to (its `target.engine`). */
  engine: EngineName;
  /** The served model this attempt's engine reported, or null. */
  resolvedModel: string | null;
  /** False for the unsettled attempt; true for every entry the record lists as settled. */
  settled: boolean;
  /** The settled attempt's `failure.kind`, or null. */
  failureKind: string | null;
  tokenUsageEvents: readonly TokenUsageEvent[];
}

/**
 * How an attempt ended. The runtime cuts short only the attempt in flight
 * when it ends a record — the last one — so earlier attempts of an
 * interrupted or timed-out record settled on their own.
 */
export function attemptEnding(agent: RollupAgentView, attempt: RollupAttemptView): AttemptEnding {
  if (!attempt.settled) {
    return "unsettled";
  }
  if (attempt.failureKind !== null && REFUSED_BEFORE_WORKER_KINDS.has(attempt.failureKind)) {
    return "refused";
  }
  const last = agent.attempts.findLast((candidate) => candidate.settled) === attempt;
  if (last && agent.status === "interrupted") {
    return "interrupted";
  }
  if (last && agent.status === "timed-out") {
    return "timed-out";
  }
  return "settled";
}

const UNOBSERVED_REASON: Record<Exclude<AttemptEnding, "settled" | "refused">, UnobservedSpendReason> = {
  interrupted: "worker-interrupted",
  "timed-out": "worker-timed-out",
  unsettled: "record-unsettled"
};

/**
 * Builds the roll-up from every agent the run recorded. Spend is booked
 * under the engine and served model of each attempt — never the requested
 * pin — with an agent that has no attempt at all booked under its engine's
 * `"unresolved"` model.
 */
export function buildCostRollup(agents: readonly RollupAgentView[]): CostRollup {
  const buckets = new Map<string, Bucket>();
  const bucketFor = (engine: EngineName, model: string): Bucket => {
    const key = `${engine}\u0000${model}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { engine, model, tokens: null, cost: { amount: 0, currency: null, reported: false, unlike: false }, unobserved: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const agent of agents) {
    if (agent.attempts.length === 0) {
      bucketFor(agent.engine, "unresolved");
      continue;
    }
    // An attempt that reported no served model of its own may borrow the
    // agent-level answer only when that answer came from its own engine:
    // the agent-level field is last-write-wins across attempts, and under
    // a cross-engine chain the last writer is the answering engine, whose
    // model must never label a refused engine's spend.
    const lastReporter = agent.attempts.findLast((attempt) => attempt.resolvedModel !== null)?.engine ?? agent.engine;
    for (const attempt of agent.attempts) {
      const borrowed = attempt.engine === lastReporter ? agent.resolvedModel : null;
      const bucket = bucketFor(attempt.engine, attempt.resolvedModel ?? borrowed ?? "unresolved");
      const summary = summariseUsage(attempt.engine, attempt.tokenUsageEvents);
      if (summary !== null) {
        bucket.tokens = bucket.tokens === null ? summary : addUsageSummary(bucket.tokens, summary);
        for (const event of attempt.tokenUsageEvents) {
          addProviderCost(bucket.cost, event);
        }
      }
      const ending = attemptEnding(agent, attempt);
      if (ending === "refused" || (ending === "settled" && summary !== null)) {
        continue;
      }
      bucket.unobserved.push({
        agent: agent.id,
        attempt: attempt.attempt,
        reason: ending === "settled" ? "engine-reported-no-usage" : UNOBSERVED_REASON[ending],
        measured: summary === null ? "none" : "partial"
      });
    }
  }

  const rollup: CostRollup = {};
  for (const bucket of buckets.values()) {
    const engineLeaves = (rollup[bucket.engine] ??= {});
    engineLeaves[bucket.model] = {
      tokens: bucket.tokens ?? { unavailable: "no-usage-reported" },
      cost: publishedCost(bucket.cost),
      complete: bucket.unobserved.length === 0,
      unobserved: bucket.unobserved
    };
  }
  return rollup;
}

interface Bucket {
  engine: EngineName;
  model: string;
  tokens: UsageSummary | null;
  cost: CostAccumulator;
  unobserved: UnobservedSpend[];
}

/**
 * Cost accumulates apart from the published shape because the published
 * shape is a statement, not a running total: a leaf that never sees a
 * provider-reported figure publishes the reason rather than a zero, and
 * one that sees unlike currencies publishes that reason rather than a
 * cross-currency sum.
 */
interface CostAccumulator {
  amount: number;
  currency: string | null;
  reported: boolean;
  /** Latched once two events disagree on currency; never unlatched. */
  unlike: boolean;
}

function publishedCost(accumulator: CostAccumulator): CostRollupLeaf["cost"] {
  if (accumulator.unlike) {
    return { unavailable: "unlike-currencies" };
  }
  if (!accumulator.reported) {
    return { unavailable: "no-provider-cost-reported" };
  }
  return { amount: accumulator.amount, currency: accumulator.currency, source: "provider-reported" };
}

function addProviderCost(target: CostAccumulator, event: TokenUsageEvent): void {
  if (target.unlike) {
    return;
  }
  const cost = event.raw.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost)) {
    return;
  }
  const currency = typeof event.raw.currency === "string" ? event.raw.currency : null;
  if (target.currency !== null && currency !== null && currency !== target.currency) {
    target.unlike = true;
    return;
  }
  target.amount += cost;
  target.reported = true;
  if (currency !== null && target.currency === null) {
    target.currency = currency;
  }
}
