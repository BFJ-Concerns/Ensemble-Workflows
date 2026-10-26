import type { EngineName } from "./types.js";

/**
 * The one reasoning-effort vocabulary every `agent()`, `session()`,
 * `defaults` and fallback-chain declaration speaks, in ascending order.
 * The harness owns the domain and judges it before any worker spawns; a
 * level is then resolved per dispatch for the target it goes to
 * (`resolveEffort`): held within the machine's bounds, converted to the
 * dispatched model's native name, and clamped to the nearest level that
 * model serves. The set names every level some shipped engine serves —
 * `max` for Claude Code's native ceiling, `none` for the Codex models the
 * provider accepted it on — so a level is never unreachable through
 * `agent()` on the engine that offers it. Growing or shrinking the set is a
 * contract change, never a code change beside a new engine.
 */
export const CANONICAL_EFFORT_DOMAIN = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type CanonicalEffort = (typeof CANONICAL_EFFORT_DOMAIN)[number];

export function isCanonicalEffort(value: unknown): value is CanonicalEffort {
  return (CANONICAL_EFFORT_DOMAIN as readonly unknown[]).includes(value);
}

/**
 * The levels a model serves: each canonical level the model accepts, mapped
 * to the name the engine is dispatched with. A canonical level absent from
 * the map is one the model does not serve, so a request for it clamps to
 * the nearest level present.
 */
export type ServedEffortLevels = Readonly<Partial<Record<CanonicalEffort, string>>>;

/**
 * One entry of the machine configuration's `effort` section, keyed by
 * target: `*` (every dispatch), `<engine>` (every model on that engine) or
 * `<engine>:<model>`. `ceiling` and `floor` bound the requested level —
 * the most specific key carrying either supplies both, so a bound on a
 * model replaces an engine-wide pair rather than merging with it. `levels`
 * declares the model's served levels, for a model the built-in table does
 * not know (a self-hosted route) or to correct a table entry; it sits on an
 * engine or model key, never on `*`, since native names are an engine's.
 */
export interface EffortTargetSettings {
  ceiling?: CanonicalEffort;
  floor?: CanonicalEffort;
  levels?: ServedEffortLevels;
}

export type EffortSettings = Readonly<Record<string, EffortTargetSettings>>;

/** Where a dispatch's served levels came from, in the order the sources are consulted. */
export type ServedLevelSource = "machine" | "engine" | "built-in";

/**
 * How one dispatch's effort was resolved: the record's account of a clamp,
 * so a clamped dispatch is observable, never silent. `requested` is the
 * canonical level the call asked for; `bound` the machine bound that moved
 * it, if one did; `served` the source the model's levels were taken from
 * and the level that source settled on, or `none` where no source knew the
 * model and the bounded level was passed through for the engine to judge;
 * `dispatched` the name the engine was actually given. The level the engine
 * then reports serving is `resolved_effort` beside it, read from the
 * engine's own report — never from this resolution.
 */
export interface EffortResolution {
  requested: CanonicalEffort;
  bound: { rule: "ceiling" | "floor"; key: string; level: CanonicalEffort } | null;
  served: { source: ServedLevelSource; level: CanonicalEffort } | { source: "none"; level: null };
  dispatched: string;
}

/**
 * The served levels Ensemble ships for well-known models, keyed as the
 * `effort` section is, so a common setup needs no effort configuration. A
 * machine map overrides a row; an engine's own per-model report outranks
 * one too (Codex lists each model's levels at `model/list`), so a row for
 * a Codex model is the fallback for a listing that does not name it.
 *
 * Every row is a dated measurement, re-pointed when the engine moves:
 *
 * - `claude`: the Claude CLI serves `low | medium | high | xhigh | max`,
 *   a domain of the CLI rather than the model (Claude Code 2.1.283, its
 *   `--effort` help and the `effort` its transcripts report serving,
 *   2026-09-27). The CLI silently runs an unknown `--effort` value at its
 *   default (witnessed 2026-08-30), so this row is what keeps a
 *   non-native name off its command line: `none` and `minimal` clamp to
 *   `low`.
 * - The Codex rows are `model/list`'s `supportedReasoningEfforts` as
 *   codex-cli 0.162.1 reported them on 2026-10-26. No listed model served
 *   `none` or `minimal`; `gpt-5.5` stopped at `xhigh`; several listed an
 *   `ultra` the canonical set does not name, which is therefore unreachable
 *   until the contract names it.
 */
export const BUILT_IN_SERVED_LEVELS: EffortSettings = {
  claude: { levels: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  "codex:gpt-6.1-sol": { levels: codexLevels("low", "medium", "high", "xhigh", "max") },
  "codex:gpt-6-astra": { levels: codexLevels("low", "medium", "high", "xhigh", "max") },
  "codex:gpt-6-sol": { levels: codexLevels("low", "medium", "high", "xhigh", "max") },
  "codex:gpt-6-luna": { levels: codexLevels("low", "medium", "high", "xhigh", "max") },
  "codex:gpt-5.6-sol": { levels: codexLevels("low", "medium", "high", "xhigh", "max") },
  "codex:gpt-5.6-terra": { levels: codexLevels("low", "medium", "high", "xhigh", "max") },
  "codex:gpt-5.6-luna": { levels: codexLevels("low", "medium", "high", "xhigh", "max") },
  "codex:gpt-5.5": { levels: codexLevels("low", "medium", "high", "xhigh") }
};

/** Codex names its levels as the canonical set does, so a served level maps to itself. */
function codexLevels(...levels: CanonicalEffort[]): ServedEffortLevels {
  return Object.fromEntries(levels.map((level) => [level, level])) as ServedEffortLevels;
}

/**
 * The served levels an engine's own per-model report yields, in canonical
 * terms: each reported name that is a canonical level maps to itself, and
 * a reported name outside the set is dropped — it names a level the
 * vocabulary cannot ask for. An empty result is no report.
 */
export function servedLevelsFromReport(reported: readonly string[]): ServedEffortLevels | null {
  const levels = Object.fromEntries(reported.filter(isCanonicalEffort).map((level) => [level, level])) as ServedEffortLevels;
  return Object.keys(levels).length === 0 ? null : levels;
}

/**
 * The `effort` section keys that apply to a target, most specific first:
 * `engine:model`, then `engine`, then `*`. An unpinned model has no
 * model-specific key.
 */
export function effortTargetKeys(engine: EngineName, model: string | undefined): string[] {
  return [...(model !== undefined ? [`${engine}:${model}`] : []), engine, "*"];
}

/**
 * Resolves one dispatch's effort for its target. Two clamps in order: the
 * machine's bounds first (a limit the script cannot lift), then the clamp
 * to the nearest level the model serves — the served levels taken from the
 * first source that knows the model: the machine's `effort` section, the
 * engine's own per-model report, the built-in table; a model in none of
 * them has its bounded level passed through for the engine to judge.
 * Pure: the engine's report is the caller's to fetch, so the function is
 * the same whichever adapter the target names.
 */
export function resolveEffort(input: {
  requested: CanonicalEffort;
  engine: EngineName;
  model: string | undefined;
  settings: EffortSettings;
  engineReport: ServedEffortLevels | null;
  builtIn?: EffortSettings;
}): EffortResolution {
  const keys = effortTargetKeys(input.engine, input.model);
  const bounded = applyMachineBounds(input.requested, keys, input.settings);
  const served = servedLevelsFor(keys, input.settings, input.engineReport, input.builtIn ?? BUILT_IN_SERVED_LEVELS);
  if (served === null) {
    return { requested: input.requested, bound: bounded.bound, served: { source: "none", level: null }, dispatched: bounded.level };
  }
  const level = nearestServedLevel(bounded.level, served.levels);
  return {
    requested: input.requested,
    bound: bounded.bound,
    served: { source: served.source, level },
    dispatched: served.levels[level] as string
  };
}

function applyMachineBounds(
  requested: CanonicalEffort,
  keys: readonly string[],
  settings: EffortSettings
): { level: CanonicalEffort; bound: EffortResolution["bound"] } {
  const key = keys.find((candidate) => settings[candidate]?.ceiling !== undefined || settings[candidate]?.floor !== undefined);
  if (key === undefined) {
    return { level: requested, bound: null };
  }
  const { ceiling, floor } = settings[key] as EffortTargetSettings;
  if (ceiling !== undefined && rank(requested) > rank(ceiling)) {
    return { level: ceiling, bound: { rule: "ceiling", key, level: ceiling } };
  }
  if (floor !== undefined && rank(requested) < rank(floor)) {
    return { level: floor, bound: { rule: "floor", key, level: floor } };
  }
  return { level: requested, bound: null };
}

function servedLevelsFor(
  keys: readonly string[],
  settings: EffortSettings,
  engineReport: ServedEffortLevels | null,
  builtIn: EffortSettings
): { source: ServedLevelSource; levels: ServedEffortLevels } | null {
  // `levels` never sits on `*`, so the wildcard key is skipped here.
  const targetKeys = keys.filter((key) => key !== "*");
  const machine = targetKeys.map((key) => settings[key]?.levels).find((levels) => levels !== undefined);
  if (machine !== undefined) {
    return { source: "machine", levels: machine };
  }
  if (engineReport !== null && Object.keys(engineReport).length > 0) {
    return { source: "engine", levels: engineReport };
  }
  const shipped = targetKeys.map((key) => builtIn[key]?.levels).find((levels) => levels !== undefined);
  return shipped === undefined ? null : { source: "built-in", levels: shipped };
}

/**
 * The served level nearest the one asked for: the level itself where
 * served, else the closest by position in the canonical order, a tie going
 * to the lower level (the cheaper of two equally near neighbours).
 */
export function nearestServedLevel(level: CanonicalEffort, served: ServedEffortLevels): CanonicalEffort {
  const candidates = CANONICAL_EFFORT_DOMAIN.filter((candidate) => served[candidate] !== undefined);
  if (candidates.length === 0) {
    throw new Error("a served-level map must name at least one level");
  }
  const wanted = rank(level);
  let nearest = candidates[0] as CanonicalEffort;
  for (const candidate of candidates) {
    if (Math.abs(rank(candidate) - wanted) < Math.abs(rank(nearest) - wanted)) {
      nearest = candidate;
    }
  }
  return nearest;
}

function rank(level: CanonicalEffort): number {
  return CANONICAL_EFFORT_DOMAIN.indexOf(level);
}
