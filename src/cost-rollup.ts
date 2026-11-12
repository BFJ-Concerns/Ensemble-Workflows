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
  /**
   * Summary usage in the declared vocabulary, or why there is none: the
   * reason `leafTokenAbsence` gives for the leaf's `unobserved` entries.
   */
  tokens: UsageSummary | { unavailable: TokenAbsenceReason };
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
  currency: string;
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
  /**
   * The attempt's number in that record's `attempts`, or null for an
   * attempt the record may have run without listing it
   * (`RollupAgentView.mayHaveUnlistedAttempt`): nothing recorded its start,
   * so nothing gave it a number. A null entry always reads
   * `record-unsettled` and `measured: "none"`.
   */
  attempt: number | null;
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
 *   next run's sweep found it, or found a record that may have had an
 *   attempt running without listing it.
 * - `worker-interrupted`: the run's ending cut the attempt short — its
 *   interrupt (SIGINT, SIGTERM), a body that returned with the leg in
 *   flight, or a body that failed with it in flight.
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
 * Why a leaf has no token figures: one word from the agent record's
 * `usage.unavailable` vocabulary, never a word of the roll-up's own. The
 * unobserved reasons apply when an attempt booked under the leaf ran
 * without reporting usage; `substrate-never-started` applies when every
 * attempt booked there was refused before a worker existed. The agent
 * record's `no-attempt-ran` never appears, because an agent that ran no
 * attempt books no leaf.
 */
export type TokenAbsenceReason = UnobservedSpendReason | "substrate-never-started";

/**
 * Which reason a leaf with no figures publishes when its attempts ended in
 * different ways, most uncertain first. The leaf states the least it
 * knows: unknown spend (`record-unsettled`, then the two kinds of cut-short
 * attempt) outranks an engine's own account of no usage, so the leaf reads
 * `engine-reported-no-usage` only when every attempt with spend to account
 * for settled on its engine's account without usage. The order otherwise
 * follows the agent record's own reasons. The full account stays in
 * `unobserved`, one entry per attempt.
 */
const TOKEN_ABSENCE_PRECEDENCE: readonly UnobservedSpendReason[] = [
  "record-unsettled",
  "worker-interrupted",
  "worker-timed-out",
  "engine-reported-no-usage"
];

/**
 * The `tokens.unavailable` word for a leaf with no figures, from the
 * leaf's `unobserved` entries alone: the first reason in
 * `TOKEN_ABSENCE_PRECEDENCE` that any entry carries. With no entries, every
 * attempt booked under the leaf was refused before a worker existed, so
 * the leaf reads `substrate-never-started`. That holds only because an
 * agent with no attempt, and no possible unlisted one, books no leaf: the
 * builder creates a leaf for an attempt, listed or possible, never for an
 * agent alone.
 */
export function leafTokenAbsence(unobserved: readonly UnobservedSpend[]): TokenAbsenceReason {
  return TOKEN_ABSENCE_PRECEDENCE.find((reason) => unobserved.some((entry) => entry.reason === reason)) ??
    "substrate-never-started";
}

/**
 * How one attempt ended, as far as its spend is concerned:
 *
 * - `settled`: the engine's own account settled it, complete or failed.
 * - `refused`: refused before any worker existed — nothing ran, so there
 *   is no spend to observe.
 * - `interrupted`: the run's ending cut it short.
 * - `timed-out`: a run or worker deadline cut it short.
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
 * Whether a recorded failure kind is a deadline the runtime enforced on
 * the worker. Two spellings reach a record: a thrown deadline recorded by
 * its class name (`TurnTimeoutError`, raised for Codex and opencode turn
 * and request deadlines), and an engine's own attempt-failure kind ending
 * in `-timeout` (Claude's `claude-poll-timeout`,
 * `claude-first-life-timeout`, `claude-registration-timeout`). The
 * runtime settles an agent `timed-out` by this same test, so an attempt
 * and its agent cannot disagree about whether a deadline ended it.
 */
export function isTimeoutFailureKind(kind: string): boolean {
  return kind === "TurnTimeoutError" || kind.endsWith("-timeout");
}

/**
 * The statuses the run's close settles its in-flight legs with, and the
 * failure kind it writes on the attempt each leg had in flight. The
 * runtime's close produces the kind with `runEndingFailureKind` and
 * `attemptEnding` reads it back, so the attempt the run cut short carries
 * that fact on its own entry: no later reader has to infer it from the
 * agent's status, which also reads `interrupted` for a leg that was only
 * waiting between attempts when the run ended.
 */
export type RunEndingStatus = "failed" | "timed-out" | "interrupted";
export type RunEndingFailureKind = `run-${RunEndingStatus}`;

export function runEndingFailureKind(status: RunEndingStatus): RunEndingFailureKind {
  return `run-${status}`;
}

/**
 * How a run-ending kind ends its attempt. A body that failed tears its legs
 * down exactly as an interrupt does, so its kind reads `interrupted`; only
 * the run deadline is a deadline.
 */
const RUN_ENDING_ATTEMPT_ENDING: Readonly<Record<RunEndingFailureKind, "interrupted" | "timed-out">> = {
  "run-interrupted": "interrupted",
  "run-failed": "interrupted",
  "run-timed-out": "timed-out"
};

function isRunEndingFailureKind(kind: string): kind is RunEndingFailureKind {
  return Object.hasOwn(RUN_ENDING_ATTEMPT_ENDING, kind);
}

/**
 * An agent record reduced to what the roll-up reads, in either writer's
 * terms. `attempts` lists every attempt the record shows ran, settled ones
 * first in number order and then, where one exists, the unsettled attempt
 * (the live attempt in a running record, the abandoned entry in a reaped
 * one).
 */
export interface RollupAgentView {
  id: number;
  /**
   * The engine the call asked for. An attempt the record may not list books
   * under it, since nothing recorded which target that attempt ran on.
   */
  engine: EngineName;
  /** The agent-level served model: last write wins across attempts. */
  resolvedModel: string | null;
  attempts: RollupAttemptView[];
  /**
   * Whether a worker may have run an attempt that `attempts` does not list.
   * The runtime records an attempt's start best-effort and invokes the
   * worker even when that write fails, so a missing start is not proof that
   * nothing ran. Each projection answers from its own evidence:
   *
   * - The writer's own view is always false. It holds every start the
   *   runtime announced in memory before any write of it can fail, so a
   *   record with no live attempt has started nothing it does not list.
   * - A view read back from an archived record is true when the record's
   *   writer never settled it — it reads `in-progress`, or `abandoned`
   *   with the sweep's `abandonment` block — and it lists no unsettled
   *   attempt. Such a record may have been between attempts or still
   *   queued, but the archive cannot tell which, so its spend is not
   *   claimed complete.
   *
   * When true, the roll-up books one `unobserved` entry with a null
   * `attempt` under the agent's `engine` and `"unresolved"`.
   */
  mayHaveUnlistedAttempt: boolean;
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
 * How an attempt ended, judged from the attempt's own evidence alone. The
 * agent's status says how the call ended, not how each attempt did: a
 * complete agent can carry a timed-out attempt the runtime retried, and an
 * interrupted one can end with every attempt settled, its last refused or
 * failed attempt already over while the call waited for re-admission on
 * the next fallback target. An attempt was cut short only when its own
 * failure says so — a run-ending kind the run's close wrote on it, or a
 * worker deadline's kind.
 */
export function attemptEnding(attempt: RollupAttemptView): AttemptEnding {
  if (!attempt.settled) {
    return "unsettled";
  }
  const kind = attempt.failureKind;
  if (kind === null) {
    return "settled";
  }
  if (REFUSED_BEFORE_WORKER_KINDS.has(kind)) {
    return "refused";
  }
  if (isRunEndingFailureKind(kind)) {
    return RUN_ENDING_ATTEMPT_ENDING[kind];
  }
  if (isTimeoutFailureKind(kind)) {
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
 * pin. Leaves exist for attempts, never for agents: every listed attempt,
 * refused ones included, books under exactly one leaf, and an attempt the
 * record may not list (`mayHaveUnlistedAttempt`) books under its engine's
 * `"unresolved"` model. An agent that lists no attempt and may not have run
 * one books nothing, so a run that dispatched no worker has an empty
 * roll-up. A leaf with no figures publishes `leafTokenAbsence` of its
 * `unobserved` entries.
 */
export function buildCostRollup(agents: readonly RollupAgentView[]): CostRollup {
  const buckets = new Map<string, Bucket>();
  const bucketFor = (engine: EngineName, model: string): Bucket => {
    const key = `${engine}\u0000${model}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { engine, model, tokens: null, cost: { amount: 0, currency: null, unpriced: false, unlike: false }, unobserved: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const agent of agents) {
    // A settled attempt that reported no served model of its own may borrow
    // the agent-level answer only when it came from its own engine:
    // the agent-level field is last-write-wins across attempts, and under
    // a cross-engine chain the last writer is the answering engine, whose
    // model must never label a refused engine's spend. An unsettled attempt
    // uses only its own identity, including a held turn's seeded session
    // identity; a fresh retry must never borrow its predecessor's model.
    const lastReporter = agent.attempts.findLast((attempt) => attempt.resolvedModel !== null)?.engine ?? agent.engine;
    for (const attempt of agent.attempts) {
      const borrowed = attempt.settled && attempt.engine === lastReporter ? agent.resolvedModel : null;
      // A provider's rejection overrides configured or borrowed identity,
      // including stale identity retained in an archived attempt.
      const model = attempt.engine === "codex" && attempt.failureKind === "model-not-found"
        ? null : attempt.resolvedModel ?? borrowed;
      const bucket = bucketFor(attempt.engine, model ?? "unresolved");
      const summary = summariseUsage(attempt.engine, attempt.tokenUsageEvents);
      if (summary !== null) {
        bucket.tokens = bucket.tokens === null ? summary : addUsageSummary(bucket.tokens, summary);
        for (const event of attempt.tokenUsageEvents) {
          addProviderCost(bucket.cost, event);
        }
      }
      const ending = attemptEnding(attempt);
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
    if (agent.mayHaveUnlistedAttempt) {
      const bucket = bucketFor(agent.engine, "unresolved");
      bucket.unobserved.push({ agent: agent.id, attempt: null, reason: "record-unsettled", measured: "none" });
    }
  }

  const rollup: CostRollup = {};
  for (const bucket of buckets.values()) {
    const engineLeaves = (rollup[bucket.engine] ??= {});
    engineLeaves[bucket.model] = {
      tokens: bucket.tokens ?? { unavailable: leafTokenAbsence(bucket.unobserved) },
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
  /** A usage event without a usable price prevents publishing a partial charge as a total. */
  unpriced: boolean;
  /** Latched once two events disagree on currency; never unlatched. */
  unlike: boolean;
}

function publishedCost(accumulator: CostAccumulator): CostRollupLeaf["cost"] {
  if (accumulator.unlike) {
    return { unavailable: "unlike-currencies" };
  }
  if (accumulator.unpriced || accumulator.currency === null || !Number.isFinite(accumulator.amount)) {
    return { unavailable: "no-provider-cost-reported" };
  }
  return { amount: accumulator.amount, currency: accumulator.currency, source: "provider-reported" };
}

function addProviderCost(target: CostAccumulator, event: TokenUsageEvent): void {
  if (target.unlike) {
    return;
  }
  const cost = event.raw.cost;
  const currency = typeof event.raw.currency === "string" && event.raw.currency.trim().length > 0 ? event.raw.currency : null;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || currency === null) {
    target.unpriced = true;
    return;
  }
  if (target.currency !== null && currency !== target.currency) {
    target.unlike = true;
    return;
  }
  target.amount += cost;
  if (target.currency === null) {
    target.currency = currency;
  }
}
