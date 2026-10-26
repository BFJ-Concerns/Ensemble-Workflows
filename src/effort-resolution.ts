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
 * An engine's own per-model effort report: the model it describes — the
 * engine's default for an unpinned dispatch, so the resolution can take
 * that model's keys — and its served levels in canonical terms, null where
 * the engine lists the model but names no level the vocabulary can ask
 * for.
 */
export interface ServedEffortReport {
  model: string;
  levels: ServedEffortLevels | null;
}

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
 * The `--effort` values the Claude CLI accepts, which are the canonical
 * levels of the same name (Claude Code 2.1.283, its `--effort` help and the
 * `effort` its transcripts report serving, 2026-09-27). The CLI silently
 * runs an unknown value at its default (witnessed 2026-08-30), so this set
 * is enforced twice: a machine `claude` map may name only these, and the
 * Claude adapter refuses any other name pre-spawn.
 */
export const CLAUDE_CLI_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly CanonicalEffort[];

export function isClaudeCliEffort(value: string): value is (typeof CLAUDE_CLI_EFFORT_LEVELS)[number] {
  return (CLAUDE_CLI_EFFORT_LEVELS as readonly string[]).includes(value);
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
 * - `claude`: `CLAUDE_CLI_EFFORT_LEVELS`, engine-wide — the CLI's domain,
 *   not a model's — so `none` and `minimal` clamp to `low`.
 * - The Codex rows are `model/list`'s `supportedReasoningEfforts` as
 *   codex-cli 0.162.1 reported them on 2026-10-26. No listed model served
 *   `none` or `minimal`; `gpt-5.5` stopped at `xhigh`; several listed an
 *   `ultra` the canonical set does not name, which is therefore unreachable
 *   until the contract names it.
 */
export const BUILT_IN_SERVED_LEVELS: EffortSettings = {
  claude: { levels: Object.fromEntries(CLAUDE_CLI_EFFORT_LEVELS.map((level) => [level, level])) as ServedEffortLevels },
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
 *
 * The engine's report is fetched only where its answer can matter: for an
 * unpinned target, to learn which model the dispatch runs on, so that
 * model's keys bound and map it; for a pinned one, only when no machine map
 * covers it. A machine map therefore resolves a pinned model without a
 * round trip to the engine. The fetch is the caller's, so the function is
 * the same whichever adapter the target names.
 */
export async function resolveEffort(input: {
  requested: CanonicalEffort;
  engine: EngineName;
  model: string | undefined;
  settings: EffortSettings;
  engineReport: () => Promise<ServedEffortReport | null>;
  builtIn?: EffortSettings;
}): Promise<EffortResolution> {
  let keys = effortTargetKeys(input.engine, input.model);
  let machine = machineLevelsFor(keys, input.settings);
  let report: ServedEffortReport | null = null;
  if (input.model === undefined || machine === undefined) {
    report = await input.engineReport();
    if (input.model === undefined && report !== null) {
      keys = effortTargetKeys(input.engine, report.model);
      machine = machineLevelsFor(keys, input.settings);
    }
  }
  const bounded = applyMachineBounds(input.requested, keys, input.settings);
  const served = servedLevelsFor(keys, machine, report, input.builtIn ?? BUILT_IN_SERVED_LEVELS);
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

/** The first `levels` map among the target's keys; `*` carries none, so it is skipped. */
function machineLevelsFor(keys: readonly string[], settings: EffortSettings): ServedEffortLevels | undefined {
  return keys.filter((key) => key !== "*").map((key) => settings[key]?.levels).find((levels) => levels !== undefined);
}

function servedLevelsFor(
  keys: readonly string[],
  machine: ServedEffortLevels | undefined,
  report: ServedEffortReport | null,
  builtIn: EffortSettings
): { source: ServedLevelSource; levels: ServedEffortLevels } | null {
  if (machine !== undefined) {
    return { source: "machine", levels: machine };
  }
  if (report !== null && report.levels !== null) {
    return { source: "engine", levels: report.levels };
  }
  const shipped = machineLevelsFor(keys, builtIn);
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

const ENGINE_NAMES = ["codex", "claude", "opencode"] as const satisfies readonly EngineName[];
const EFFORT_TARGET_FIELDS = new Set(["ceiling", "floor", "levels"]);

/**
 * Judges an `effort` section as `resolveEffort` will read it, whichever
 * door it came through — the machine configuration file or a library
 * caller's `effortSettings`: target keys are `*`, an engine, or
 * `engine:model`; bounds are canonical levels with the floor no higher than
 * the ceiling; `levels` is a non-empty map from canonical level to the
 * engine's native name, on an engine or model key only (a native name is an
 * engine's, so a `*` map could name nothing every engine accepts), and on
 * `claude` only names the CLI accepts. opencode takes no key: its effort
 * names a declared variant and is dispatched as given, unresolved. `fail`
 * is called with the offending path, relative to the section, and the
 * reason, and must throw.
 */
export function assertEffortSettings(
  section: unknown,
  fail: (path: string, message: string) => never
): asserts section is EffortSettings {
  if (!isObject(section) || Array.isArray(section)) {
    fail("", "must be an object of target keys (\"*\", an engine, or engine:model) to settings");
  }
  for (const [key, settings] of Object.entries(section)) {
    const engine = key === "*" ? null : key.includes(":") ? key.slice(0, key.indexOf(":")) : key;
    const model = key.includes(":") ? key.slice(key.indexOf(":") + 1) : undefined;
    if (engine !== null && !(ENGINE_NAMES as readonly string[]).includes(engine)) {
      fail(key, `target keys are "*", an engine (${ENGINE_NAMES.join(" | ")}), or engine:model`);
    }
    if (engine === "opencode") {
      fail(key, "opencode dispatches are not resolved: their effort names a declared variant and is sent as given");
    }
    if (model !== undefined && model.trim().length === 0) {
      fail(key, "an engine:model key must name its model");
    }
    if (!isObject(settings) || Array.isArray(settings)) {
      fail(key, "must be an object");
    }
    for (const field of Object.keys(settings)) {
      if (!EFFORT_TARGET_FIELDS.has(field)) {
        fail(`${key}.${field}`, `unknown field; the fields are ${[...EFFORT_TARGET_FIELDS].join(", ")}`);
      }
    }
    const { ceiling, floor, levels } = settings;
    for (const [field, value] of [["ceiling", ceiling], ["floor", floor]] as const) {
      if (value !== undefined && !isCanonicalEffort(value)) {
        fail(`${key}.${field}`, `must be one of ${CANONICAL_EFFORT_DOMAIN.join(" | ")}`);
      }
    }
    if (isCanonicalEffort(ceiling) && isCanonicalEffort(floor) && rank(floor) > rank(ceiling)) {
      fail(key, `floor ${floor} is above ceiling ${ceiling}`);
    }
    if (levels !== undefined) {
      assertServedLevels(levels, engine, `${key}.levels`, fail);
    }
  }
}

function assertServedLevels(
  levels: unknown,
  engine: string | null,
  path: string,
  fail: (path: string, message: string) => never
): asserts levels is ServedEffortLevels {
  if (engine === null) {
    fail(path, "served levels belong to an engine or engine:model key, not \"*\"");
  }
  if (!isObject(levels) || Array.isArray(levels) || Object.keys(levels).length === 0) {
    fail(path, "must be a non-empty object of canonical levels to the engine's native names");
  }
  for (const [level, native] of Object.entries(levels)) {
    if (!isCanonicalEffort(level)) {
      fail(`${path}.${level}`, `levels are keyed by canonical level: ${CANONICAL_EFFORT_DOMAIN.join(" | ")}`);
    }
    if (typeof native !== "string" || native.trim().length === 0) {
      fail(`${path}.${level}`, "must be the non-empty native name the engine is dispatched with");
    }
    if (engine === "claude" && !isClaudeCliEffort(native)) {
      fail(
        `${path}.${level}`,
        `the Claude CLI runs an unknown --effort at its default, so a claude map names only ${CLAUDE_CLI_EFFORT_LEVELS.join(" | ")}`
      );
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
