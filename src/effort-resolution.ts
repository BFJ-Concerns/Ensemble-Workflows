import { builtInServedLevels } from "./built-in-effort-levels.js";
import { EffortBoundsUnservedError } from "./errors.js";
import type { EngineName } from "./types.js";

/**
 * The one effort vocabulary every `agent()` and `defaults` declaration
 * speaks, in ascending order: one canonical vocabulary, converted to an
 * engine's native form before the engine sees it, rather than an
 * engine-owned domain. The harness owns this domain and judges it
 * pre-spawn. The order is the vocabulary's own: a machine bound and a
 * clamp to the nearest served level both compare levels by their position
 * here. A name an engine advertises joins the set only when it is a
 * reasoning level, and only by a contract change. opencode also accepts
 * raw variants its registry entry declares, judged by the adapter.
 */
export const CANONICAL_EFFORT_DOMAIN = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type CanonicalEffort = (typeof CANONICAL_EFFORT_DOMAIN)[number];

export function isCanonicalEffort(value: unknown): value is CanonicalEffort {
  return (CANONICAL_EFFORT_DOMAIN as readonly unknown[]).includes(value);
}

/**
 * The levels one model serves: each canonical level it accepts, mapped to
 * the native name its engine is dispatched with for that level. A level
 * absent from the map is one the model does not serve. Every source of
 * served levels speaks this one shape, so a name outside the vocabulary
 * has no key to sit under and can never be dispatched through a clamp.
 */
export type ServedEffortLevels = Readonly<Partial<Record<CanonicalEffort, string>>>;

/**
 * One entry of the machine configuration's `effort` section.
 *
 * `ceiling` and `floor` bound, inclusively, the canonical level a dispatch
 * to the entry's targets may run at. `levels` declares the served levels of
 * the one model an `engine:model` key names — a model the built-in table
 * does not know, or a table row to correct — and stands in place of every
 * other source for that model, whole. It sits on an `engine:model` key
 * only: a native name belongs to a model.
 *
 * ```json
 * "effort": {
 *   "*": { "ceiling": "xhigh" },
 *   "codex": { "floor": "low" },
 *   "opencode:local-coder": { "levels": { "low": "low", "high": "think" } }
 * }
 * ```
 */
export interface EffortTargetPolicy {
  ceiling?: CanonicalEffort;
  floor?: CanonicalEffort;
  levels?: ServedEffortLevels;
}

/**
 * The `effort` section as written, keyed by target: `*` (every dispatch),
 * `<engine>` (every model on that engine), or `<engine>:<model>`, the
 * model spelt as a dispatch names it — a Codex or Claude model string, an
 * opencode registry key.
 */
export type EffortSection = Readonly<Record<string, EffortTargetPolicy>>;

/**
 * The `effort` section in force and where it was read from, which a
 * refusal names. Machine-held: nothing a script, flag or environment
 * variable supplies reaches it.
 */
export interface EffortPolicy {
  section: EffortSection;
  source: string;
}

/**
 * The `effort` section keys that apply to one target, most specific first:
 * `engine:model`, then `engine`, then `*`. A target with no model has no
 * model key.
 */
export function effortPolicyKeys(engine: EngineName, model: string | undefined): string[] {
  return [...(model !== undefined ? [`${engine}:${model}`] : []), engine, "*"];
}

const ENGINE_NAMES = ["codex", "claude", "opencode"] as const satisfies readonly EngineName[];
const EFFORT_TARGET_POLICY_FIELDS = ["ceiling", "floor", "levels"];

/**
 * Judges an `effort` section's shape, whichever door it came through — the
 * machine configuration file or a library caller's own policy — so both
 * meet one rule: keys are `*`, an engine, or `engine:model` with a model
 * named; `ceiling` and `floor` are canonical levels, the floor no higher
 * than the ceiling of the same entry; `levels` is a non-empty map from
 * canonical level to a non-empty native name, on an `engine:model` key
 * only. Bounds that conflict across keys are a property of one target and
 * are judged where a target is resolved.
 *
 * `fail` is called with the offending path relative to the section (empty
 * for the section itself) and the reason, and must throw: the door owns
 * the error, so the file's reader names the key and the file as it does
 * for every other section.
 */
export function assertEffortSection(
  section: unknown,
  fail: (path: string, detail: string) => never
): asserts section is EffortSection {
  if (!isPlainObject(section)) {
    fail("", "must be a JSON object of target keys (\"*\", an engine, or engine:model) to { ceiling?, floor?, levels? }");
  }
  for (const [key, entry] of Object.entries(section)) {
    const separator = key.indexOf(":");
    const engine = separator === -1 ? key : key.slice(0, separator);
    const model = separator === -1 ? undefined : key.slice(separator + 1);
    if (key !== "*" && !(ENGINE_NAMES as readonly string[]).includes(engine)) {
      fail(key, `target keys are "*", an engine (${ENGINE_NAMES.join(" | ")}), or engine:model`);
    }
    if (model !== undefined && model.trim().length === 0) {
      fail(key, "an engine:model key must name its model");
    }
    if (!isPlainObject(entry)) {
      fail(key, "must be a JSON object of ceiling, floor and levels");
    }
    for (const field of Object.keys(entry)) {
      if (!EFFORT_TARGET_POLICY_FIELDS.includes(field)) {
        fail(`${key}.${field}`, `unknown field; an entry carries ${EFFORT_TARGET_POLICY_FIELDS.join(", ")}`);
      }
    }
    const { ceiling, floor, levels } = entry;
    for (const [field, level] of [["ceiling", ceiling], ["floor", floor]] as const) {
      if (level !== undefined && !isCanonicalEffort(level)) {
        fail(`${key}.${field}`, `must be one of ${CANONICAL_EFFORT_DOMAIN.join(" | ")}`);
      }
    }
    if (isCanonicalEffort(ceiling) && isCanonicalEffort(floor) && effortRank(floor) > effortRank(ceiling)) {
      fail(key, `floor ${floor} is above ceiling ${ceiling}`);
    }
    if (levels === undefined) {
      continue;
    }
    if (model === undefined) {
      fail(`${key}.levels`, "served levels belong to one model: declare them on an engine:model key");
    }
    if (!isPlainObject(levels) || Object.keys(levels).length === 0) {
      fail(`${key}.levels`, "must be a non-empty JSON object of canonical levels to the model's native names");
    }
    for (const [level, native] of Object.entries(levels)) {
      if (!isCanonicalEffort(level)) {
        fail(`${key}.levels.${level}`, `levels are keyed by canonical level: ${CANONICAL_EFFORT_DOMAIN.join(" | ")}`);
      }
      if (typeof native !== "string" || native.trim().length === 0 || native === "ultra") {
        fail(`${key}.levels.${level}`, "must be the non-empty native name the engine is dispatched with");
      }
    }
  }
}

/** A level's position in the canonical order, lowest first. */
export function effortRank(level: CanonicalEffort): number {
  return CANONICAL_EFFORT_DOMAIN.indexOf(level);
}

/** One machine bound in force for a target: its level, and the `effort` section key that set it. */
export interface EffortBound {
  level: CanonicalEffort;
  key: string;
}

/**
 * The machine's bounds in force for one target, each taken on its own from
 * the most specific key that sets it (`effortPolicyKeys`), so a model's
 * floor does not lift an engine-wide or machine-wide ceiling. Null where no
 * applicable key sets that bound.
 */
export interface EffortBounds {
  ceiling: EffortBound | null;
  floor: EffortBound | null;
}

/**
 * Where a model's served levels can come from, in the order the sources
 * are consulted. The first source that knows the model supplies its levels
 * whole; sources never merge.
 *
 * - `machine-map` — the `levels` map the machine's `effort` section
 *   declares under the dispatch's `engine:model` key.
 * - `built-in-table` — the row Ensemble ships for the model's identity
 *   (`builtInServedLevels`), whatever route reaches the model.
 * - `engine-report` — what the engine itself says the model serves
 *   (`EngineEffortReport`).
 */
export const SERVED_LEVEL_SOURCES = ["machine-map", "built-in-table", "engine-report"] as const;

export type ServedLevelSource = (typeof SERVED_LEVEL_SOURCES)[number];

/**
 * An engine's own account of the model one dispatch runs on
 * (`EngineAdapter.effortReport`).
 */
export interface EngineEffortReport {
  /**
   * The model the dispatch runs on, by the identity the built-in table
   * knows models by: for a dispatch that pins no model, the engine's
   * default. Null where the engine cannot say.
   */
  identity: string | null;
  /**
   * The levels the engine says that model serves, in canonical terms: a
   * name the engine advertises that the vocabulary lacks is left out.
   * Null where the engine names no canonical level for it.
   */
  levels: ServedEffortLevels | null;
}

/** One dispatch's effort question: the level asked for, and the target it goes to. */
export interface EffortDispatch {
  /** The canonical level the call, its `defaults`, or its fallback-chain entry asked for. */
  requested: CanonicalEffort;
  engine: EngineName;
  /** The model as the dispatch names it — the name `engine:model` keys are spelt with — or undefined where it pins none. */
  model: string | undefined;
  /**
   * The model's identity, as the built-in table knows models: the pinned
   * name itself, unless the engine reaches models by names of its own
   * (`EngineAdapter.modelIdentity`). Undefined where the dispatch pins no
   * model.
   */
  identity: string | undefined;
  /** The machine's `effort` section in force, or null where the run has none. */
  policy: EffortPolicy | null;
  /**
   * Asks the engine for its own account of the dispatched model. Called at
   * most once per resolution, and only where the answer can matter: the
   * dispatch pins no model, so only the engine knows which one runs, or
   * neither the machine's map nor the built-in table knows the model. An
   * engine with no account resolves null.
   */
  engineReport: () => Promise<EngineEffortReport | null>;
}

/**
 * How one dispatch's effort was resolved, as its attempt record carries
 * it, so a clamped dispatch is legible from the record alone. It is the
 * harness's account of what it asked the engine for; the level the engine
 * then reports serving is recorded beside it from the engine's own
 * evidence and is never derived from this.
 */
export interface EffortResolution {
  requested: CanonicalEffort;
  /** The machine's bounds in force for the dispatched target, whether or not they moved the level. */
  bounds: EffortBounds;
  /**
   * The source that knew the model's served levels and the canonical level
   * chosen from them, inside the bounds. Null where no source knew the
   * model: the level, held within the bounds, was passed through for the
   * engine to judge.
   */
  served: { source: ServedLevelSource; level: CanonicalEffort } | null;
  /** The name the engine was dispatched with: the chosen level's native name, or the passed-through level. */
  dispatched: string;
}

/**
 * Resolves one dispatch's effort for the target it goes to. Judged per
 * dispatch, so a call's own target, each fallback-chain entry and a
 * session's creating turn each take their own target's answer.
 *
 * The requested level is first held within the machine's bounds for the
 * target, then clamped to the nearest level the model serves inside those
 * bounds, the served levels coming from the first of `SERVED_LEVEL_SOURCES`
 * that knows the model; a model no source knows has its bounded level
 * passed through. A dispatch that pins no model is keyed, for bounds and
 * for every source, by the model its engine reports it runs on, where the
 * engine says.
 *
 * Awaited once per target, after the call is admitted and before its
 * invocation or session is created — never while a call is being admitted:
 * an engine's report can need its substrate started, and an engine starts
 * on first use, so a fallback entry's engine is asked only when the chain
 * reaches it.
 *
 * Rejects with `EffortBoundsUnservedError` where the bounds admit no level
 * the model serves: the dispatch is refused before its worker spawns.
 * Rejects with whatever `engineReport` rejects with. Nothing else is
 * thrown: every other input was judged when the option and the section
 * were validated.
 */
export async function resolveEffort(dispatch: EffortDispatch): Promise<EffortResolution> {
  let model = dispatch.model;
  let identity = dispatch.identity;
  let report: EngineEffortReport | null = null;
  if (model === undefined) {
    report = await dispatch.engineReport();
    model = report?.identity ?? undefined;
    identity = model;
  }
  const section = dispatch.policy?.section ?? {};
  const keys = effortPolicyKeys(dispatch.engine, model);
  const bound = (field: "ceiling" | "floor"): EffortBound | null => {
    for (const key of keys) {
      const level = Object.hasOwn(section, key) ? section[key]?.[field] : undefined;
      if (level !== undefined) return { level, key };
    }
    return null;
  };
  const bounds = { ceiling: bound("ceiling"), floor: bound("floor") };
  const lower = bounds.floor === null ? 0 : effortRank(bounds.floor.level);
  const upper = bounds.ceiling === null ? CANONICAL_EFFORT_DOMAIN.length - 1 : effortRank(bounds.ceiling.level);
  const bounded = Math.min(upper, Math.max(lower, effortRank(dispatch.requested)));
  let levels = model === undefined ? undefined : section[`${dispatch.engine}:${model}`]?.levels;
  let source: ServedLevelSource = "machine-map";
  if (levels === undefined) {
    levels = identity === undefined ? undefined : builtInServedLevels(identity);
    source = "built-in-table";
  }
  if (levels === undefined) {
    if (dispatch.model !== undefined) report = await dispatch.engineReport();
    // A report can identify a routed model that the original name did not.
    levels = report?.identity == null ? undefined : builtInServedLevels(report.identity);
    if (levels === undefined) {
      levels = report?.levels ?? undefined;
      source = "engine-report";
    }
  }
  const candidates = CANONICAL_EFFORT_DOMAIN.filter((level) => {
    const rank = effortRank(level);
    return rank >= lower && rank <= upper && (levels === undefined || (levels[level] !== undefined && levels[level] !== "ultra"));
  });
  if (candidates.length === 0) {
    throw new EffortBoundsUnservedError({ engine: dispatch.engine, model: model ?? null,
      requested: dispatch.requested, bounds, source: dispatch.policy?.source ?? "the model's served levels",
      served: CANONICAL_EFFORT_DOMAIN.filter((level) => levels?.[level] !== undefined) });
  }
  // Ascending candidates break an equal-distance tie towards less effort.
  const chosen = candidates.reduce((best, level) =>
    Math.abs(effortRank(level) - bounded) < Math.abs(effortRank(best) - bounded) ? level : best
  );
  return {
    requested: dispatch.requested,
    bounds,
    served: levels === undefined ? null : { source, level: chosen },
    dispatched: levels?.[chosen] ?? chosen
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
