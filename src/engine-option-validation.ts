import {
  FallbackTargetRejectedError,
  InvalidAgentOptionsError,
  AgentOptionRejectedError,
  InvalidAgentOptionValueError,
  OpenCodeModelNotRegisteredError,
  RemovedAgentOptionError,
  UnreadableAgentOptionError,
  UnrecognisedAgentOptionError
} from "./errors.js";
import { assertValidStripOption } from "./capability-stripping.js";
import { CANONICAL_EFFORT_DOMAIN, isCanonicalEffort } from "./effort-resolution.js";
import { defaultOpenCodeModelRegistry } from "./opencode-model-registry.js";

import type { OpenCodeModelRegistry, OpenCodeModelRegistryEntry } from "./opencode-model-registry.js";
import type { AgentOptions, EngineName, FallbackTarget, LiteralWorkerSessionOptions } from "./types.js";

/** Node's 32-bit setTimeout ceiling: above it the platform's timer silently misbehaves. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The option-level judgement of the canonical effort vocabulary: an `effort` outside it is refused before any worker spawns. */
export function assertCanonicalEffortSupported(effort: unknown): void {
  if (effort !== undefined && !isCanonicalEffort(effort)) {
    throw new InvalidAgentOptionValueError(
      "effort",
      effort,
      `one of ${CANONICAL_EFFORT_DOMAIN.join(" | ")} (the canonical effort vocabulary)`
    );
  }
}

interface EngineDefaultOptions {
  model?: string;
  effort?: string;
  fallback?: FallbackTarget[] | false;
}

const AGENT_OPTION_KEYS = Object.keys({
  engine: true,
  target: true,
  schema: true,
  model: true,
  effort: true,
  fallback: true,
  cwd: true,
  isolation: true,
  timeoutMs: true,
  maxAttempts: true,
  label: true,
  phase: true,
  identity: true,
  strip: true,
  lean: true
} satisfies Record<keyof AgentOptions, true>);
const AGENT_OPTION_KEY_SET = new Set<string>(AGENT_OPTION_KEYS);
/**
 * Keys a script may still be carrying from a retired contract. Each is
 * named at rejection so the author learns what replaced it: `fallbackModel`
 * (the Claude-only engine-side swap) became the harness-driven `fallback`
 * chain on every engine.
 */
const REMOVED_AGENT_OPTION_KEYS = new Set(["sandbox", "network", "webSearch", "fallbackModel"]);

/**
 * Read and validate `cwd` once, then shadow only its later value reads.
 *
 * The returned Proxy delegates every other operation to the caller's object.
 * Its key presence and enumeration therefore stay unchanged, and accessors or
 * traps that supply other options remain live. Every downstream `cwd` read,
 * including an `undefined` snapshot, returns the value captured here without
 * re-entering the caller's accessor or trap.
 */
export function snapshotAgentCwd<T extends object>(options: T): T {
  let cwd: unknown;
  try {
    cwd = (options as { cwd?: unknown }).cwd;
  } catch (error) {
    throw new UnreadableAgentOptionError("cwd", "a string path", error);
  }
  return new Proxy(options, {
    get(target, property, receiver) {
      return property === "cwd" ? cwd : Reflect.get(target, property, receiver);
    }
  });
}

export function assertValidAgentOptions(options: object): void {
  const errors: AgentOptionRejectedError[] = [];
  const collect = (check: () => void): void => {
    try {
      check();
    } catch (error) {
      if (!(error instanceof AgentOptionRejectedError)) {
        throw error;
      }
      errors.push(error);
    }
  };
  for (const key of Object.keys(options)) {
    if (REMOVED_AGENT_OPTION_KEYS.has(key)) {
      errors.push(new RemovedAgentOptionError(key));
    } else if (!AGENT_OPTION_KEY_SET.has(key)) {
      errors.push(new UnrecognisedAgentOptionError(key, AGENT_OPTION_KEYS));
    }
  }

  const values = options as Record<string, unknown>;
  const unreadable = Symbol("unreadable option");
  const read = (key: string, expected: string): unknown | typeof unreadable => {
    try {
      return values[key];
    } catch (error) {
      errors.push(new UnreadableAgentOptionError(key, expected, error));
      return unreadable;
    }
  };
  const cwd = read("cwd", "a string path");
  if (cwd !== unreadable) {
    collect(() => {
      if (cwd !== undefined && typeof cwd !== "string") {
        throw new InvalidAgentOptionValueError("cwd", cwd, "a string path");
      }
    });
  }
  const isolation = read("isolation", 'exactly "worktree"');
  if (isolation !== unreadable) {
    collect(() => {
      if (isolation !== undefined && isolation !== "worktree") {
        throw new InvalidAgentOptionValueError("isolation", isolation, 'exactly "worktree"');
      }
    });
  }
  const target = read("target", "a target name");
  if (target !== unreadable) {
    collect(() => assertValidTargetName(target));
  }
  // Harness-owned domain, judged before any worker spawns; opencode's
  // effort is the registry entry's served variants, judged by its adapter.
  // A call naming a target has no engine until the name resolves, and is
  // judged again then.
  const engine = read("engine", "an engine name");
  const effort = read("effort", `one of ${CANONICAL_EFFORT_DOMAIN.join(" | ")}`);
  if (effort !== unreadable && (effort === "ultra" || (engine !== unreadable && engine !== "opencode" && target === undefined))) {
    collect(() => assertCanonicalEffortSupported(effort));
  }
  for (const key of ["timeoutMs", "maxAttempts"] as const) {
    const value = read(key, "a positive integer");
    if (value !== unreadable) {
      collect(() => assertPositiveIntegerOption({ [key]: value }, key, key === "timeoutMs" ? MAX_TIMER_DELAY_MS : undefined));
    }
  }
  const identity = read("identity", "a boolean");
  if (identity !== unreadable) {
    collect(() => {
      if (identity !== undefined && typeof identity !== "boolean") {
        throw new InvalidAgentOptionValueError("identity", identity, "a boolean");
      }
    });
  }
  const lean = read("lean", "a boolean");
  if (lean !== unreadable) {
    collect(() => {
      if (lean !== undefined && typeof lean !== "boolean") {
        throw new InvalidAgentOptionValueError("lean", lean, "a boolean");
      }
    });
  }
  const strip = read("strip", "a list of capabilities");
  if (strip !== unreadable && strip !== undefined) {
    collect(() => assertValidStripOption(strip));
  }
  const fallback = read("fallback", "a valid fallback chain");
  if (fallback !== unreadable) {
    collect(() => assertValidFallbackOption(fallback));
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 0) {
    throw new InvalidAgentOptionsError(errors);
  }
}

const WORKER_SESSION_OPTION_KEYS = Object.keys({
  engine: true,
  target: true,
  model: true,
  effort: true,
  fallback: true,
  cwd: true,
  isolation: true,
  timeoutMs: true,
  maxAttempts: true,
  label: true,
  phase: true,
  strip: true,
  lean: true,
  stalenessMark: true,
  identity: true
} satisfies Record<keyof LiteralWorkerSessionOptions, true>);
const WORKER_SESSION_OPTION_KEY_SET = new Set<string>(WORKER_SESSION_OPTION_KEYS);

/**
 * Session creation options. `identity` fixes the resolution shape for every
 * turn; only `schema` varies per turn. A creation-time schema would claim one
 * shape for turns whose whole point is having different ones.
 */
export function assertValidWorkerSessionOptions(options: object): void {
  for (const key of Object.keys(options)) {
    if (REMOVED_AGENT_OPTION_KEYS.has(key)) {
      throw new RemovedAgentOptionError(key);
    }
    if (!WORKER_SESSION_OPTION_KEY_SET.has(key)) {
      throw new UnrecognisedAgentOptionError(key, WORKER_SESSION_OPTION_KEYS);
    }
  }

  const values = options as Record<string, unknown>;
  if (values.effort === "ultra") assertCanonicalEffortSupported(values.effort);
  if (values.isolation !== undefined && values.isolation !== "worktree") {
    throw new InvalidAgentOptionValueError("isolation", values.isolation, 'exactly "worktree"');
  }
  // Same canonical-effort judgement as agent(): sessions fix effort at
  // creation, so an out-of-domain level must fail before the held worker
  // spawns. opencode sessions are refused pre-spawn elsewhere; the
  // exemption here keeps the two rejections from racing to name the error.
  // A session naming a target is judged once the name resolves.
  assertValidTargetName(values.target);
  if (values.engine !== "opencode" && values.target === undefined) {
    assertCanonicalEffortSupported(values.effort);
  }
  assertPositiveIntegerOption(values, "timeoutMs", MAX_TIMER_DELAY_MS);
  assertPositiveIntegerOption(values, "maxAttempts");
  if (values.stalenessMark !== undefined && typeof values.stalenessMark !== "boolean") {
    throw new InvalidAgentOptionValueError("stalenessMark", values.stalenessMark, "a boolean");
  }
  if (values.identity !== undefined && typeof values.identity !== "boolean") {
    throw new InvalidAgentOptionValueError("identity", values.identity, "a boolean");
  }
  if (values.lean !== undefined && typeof values.lean !== "boolean") {
    throw new InvalidAgentOptionValueError("lean", values.lean, "a boolean");
  }
  if (values.strip !== undefined) {
    assertValidStripOption(values.strip);
  }
  assertValidFallbackOption(values.fallback);
}

/**
 * A `target` names a binding in the machine configuration's `targets` map:
 * a non-empty string. Whether the name is bound, and whether the call also
 * names a literal engine or model, is judged where the bindings are known
 * (`resolveNamedTarget`), so that refusal can name the file.
 */
function assertValidTargetName(target: unknown): void {
  if (target !== undefined && (typeof target !== "string" || target.trim().length === 0)) {
    throw new InvalidAgentOptionValueError("target", target, "a non-empty string naming a target the machine configuration binds");
  }
}

const SESSION_TURN_OPTION_KEYS = ["schema"];
const SESSION_TURN_OPTION_KEY_SET = new Set<string>(SESSION_TURN_OPTION_KEYS);

/** A send()'s options: schema is the one per-turn variation the contract permits. */
export function assertValidSessionTurnOptions(options: object): void {
  for (const key of Object.keys(options)) {
    if (!SESSION_TURN_OPTION_KEY_SET.has(key)) {
      throw new UnrecognisedAgentOptionError(key, SESSION_TURN_OPTION_KEYS);
    }
  }
}

/** A call or an engine defaults block can explicitly disable fallback. */
export function assertValidFallbackOption(value: unknown): asserts value is FallbackTarget[] | false | undefined {
  if (value !== false) assertValidFallbackChain(value);
}

/**
 * A fallback chain is judged whole, pre-spawn, wherever it is declared — a
 * call site, a session, an engine's `defaults` block, or a named target's
 * binding: an array of targets, each either a full literal target naming an
 * engine and a model, Codex or Claude only (opencode is held at its existing
 * surface and skips new capability by default, so an opencode entry throws
 * here rather than failing unnoticed on the day the chain first advances),
 * or a named target, whose binding is judged where the bindings are known
 * (`settleChain`); either with any effort in the canonical vocabulary. The
 * chain's own engine is never consulted: a Codex block may name a Claude
 * target — that cross-family step is the motivating case.
 */
export function assertValidFallbackChain(chain: unknown): asserts chain is FallbackTarget[] | undefined {
  if (chain === undefined) {
    return;
  }
  if (!Array.isArray(chain)) {
    throw new FallbackTargetRejectedError("the chain must be an array of { engine, model, effort? } or { target, effort? } targets");
  }
  if (chain.length === 0) {
    throw new FallbackTargetRejectedError("the chain must not be empty");
  }
  chain.forEach((entry, index) => {
    const target = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    if (target === null) {
      throw new FallbackTargetRejectedError(`entry ${index} must be an object naming engine and model, or a target`);
    }
    for (const key of Object.keys(target)) {
      if (key !== "engine" && key !== "model" && key !== "effort" && key !== "target") {
        throw new FallbackTargetRejectedError(
          `entry ${index} carries unrecognised key ${JSON.stringify(key)}; a target names engine, model, and optionally effort, or a named target and optionally effort`
        );
      }
    }
    if (target.effort !== undefined && !isCanonicalEffort(target.effort)) {
      throw new FallbackTargetRejectedError(`entry ${index} effort must be one of ${CANONICAL_EFFORT_DOMAIN.join(" | ")}, got ${JSON.stringify(target.effort)}`);
    }
    if (target.target !== undefined) {
      // A target beside a literal engine or model is refused where the
      // file whose binding would supply them can be named (`settleChain`).
      if (typeof target.target !== "string" || target.target.trim().length === 0) {
        throw new FallbackTargetRejectedError(`entry ${index} target must be a non-empty string naming a target the machine configuration binds`);
      }
      return;
    }
    if (target.engine === "opencode") {
      throw new FallbackTargetRejectedError(`entry ${index} names the opencode engine, which is held at its one-shot surface and takes no chain entries`);
    }
    if (target.engine !== "codex" && target.engine !== "claude" && target.engine !== "agy") {
      throw new FallbackTargetRejectedError(`entry ${index} must name engine "codex", "claude" or "agy", got ${JSON.stringify(target.engine)}`);
    }
    if (typeof target.model !== "string" || target.model.length === 0) {
      throw new FallbackTargetRejectedError(`entry ${index} must name its model: a fallback that inherits an ambient default is a substitution nobody chose`);
    }
  });
}

export function requireRegisteredOpenCodeModel(
  model: string,
  registry: OpenCodeModelRegistry = defaultOpenCodeModelRegistry
): OpenCodeModelRegistryEntry {
  const registered = registry.get(model);
  if (registered === undefined) {
    throw new OpenCodeModelNotRegisteredError(model, registry);
  }
  return registered;
}

/** Validate policy fields whose compatibility depends on the selected engine. */
export function validateEngineDefaults(
  engine: EngineName,
  defaults: EngineDefaultOptions,
  openCodeModelRegistry: OpenCodeModelRegistry = defaultOpenCodeModelRegistry
): void {
  assertValidFallbackOption(defaults.fallback);
  if (defaults.effort === "ultra") assertCanonicalEffortSupported(defaults.effort);
  if (engine !== "opencode") {
    // A bad static declaration fails before the body runs, not at the
    // first paid dispatch — the same canonical domain agent() enforces.
    assertCanonicalEffortSupported(defaults.effort);
  }
  if (engine === "opencode" && defaults.model !== undefined) {
    const model = requireRegisteredOpenCodeModel(defaults.model, openCodeModelRegistry);
    // The registry owns the variant domain; a declared effort is judged
    // here only when the declared model names the entry to judge against —
    // an effort defaulted without a model waits for the call that names one.
    if (defaults.effort !== undefined && !isCanonicalEffort(defaults.effort) && !model.variants.includes(defaults.effort)) {
      throw new InvalidAgentOptionValueError(
        "effort",
        defaults.effort,
        model.variants.length > 0
          ? `one of ${model.variants.join(" | ")} (the variants the registry declares for ${model.key})`
          : `absent — the registry entry for ${model.key} declares no served variants`
      );
    }
  }
}

function assertPositiveIntegerOption(
  options: Record<string, unknown>,
  option: "timeoutMs" | "maxAttempts",
  maximum?: number
): void {
  const value = options[option];
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || (maximum !== undefined && value > maximum))
  ) {
    const expected = maximum === undefined ? "a positive integer" : `a positive integer no greater than ${maximum}`;
    throw new InvalidAgentOptionValueError(option, value, expected);
  }
}
