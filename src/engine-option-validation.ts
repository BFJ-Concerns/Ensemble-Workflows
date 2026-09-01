import {
  FallbackModelUnsupportedError,
  InvalidAgentOptionValueError,
  OpenCodeModelNotRegisteredError,
  RemovedAgentOptionError,
  UnreadableAgentOptionError,
  UnrecognisedAgentOptionError
} from "./errors.js";
import { assertValidStripOption } from "./capability-stripping.js";
import { defaultOpenCodeModelRegistry } from "./opencode-model-registry.js";

import type { OpenCodeModelRegistry, OpenCodeModelRegistryEntry } from "./opencode-model-registry.js";
import type { AgentOptions, EngineName, WorkerSessionOptions } from "./types.js";

/** Node's 32-bit setTimeout ceiling: above it the platform's timer silently misbehaves. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The one effort vocabulary every `agent()` and `defaults` declaration
 * speaks: one canonical vocabulary, converted per engine rather than an
 * engine-owned domain. The harness owns this domain and judges it
 * pre-spawn; each engine's adapter converts a canonical level to its own
 * native form, clamping to the nearest level the engine offers, and the
 * resolved native value lands in the run record so a clamped dispatch is
 * observable, never silent. opencode is exempt, being held at its existing
 * surface: its `effort` names the registry entry's served variants and is
 * judged against them by the adapter.
 */
export const CANONICAL_EFFORT_DOMAIN = ["minimal", "low", "medium", "high", "xhigh"] as const;

export type CanonicalEffort = (typeof CANONICAL_EFFORT_DOMAIN)[number];

export function assertCanonicalEffortSupported(effort: unknown): void {
  if (effort !== undefined && !(CANONICAL_EFFORT_DOMAIN as readonly unknown[]).includes(effort)) {
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
  fallbackModel?: string;
}

const AGENT_OPTION_KEYS = Object.keys({
  engine: true,
  schema: true,
  model: true,
  effort: true,
  fallbackModel: true,
  cwd: true,
  isolation: true,
  timeoutMs: true,
  maxAttempts: true,
  label: true,
  phase: true,
  identity: true,
  strip: true
} satisfies Record<keyof AgentOptions, true>);
const AGENT_OPTION_KEY_SET = new Set<string>(AGENT_OPTION_KEYS);
const REMOVED_AGENT_OPTION_KEYS = new Set(["sandbox", "network", "webSearch"]);

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
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new InvalidAgentOptionValueError("cwd", cwd, "a string path");
  }
  return new Proxy(options, {
    get(target, property, receiver) {
      return property === "cwd" ? cwd : Reflect.get(target, property, receiver);
    }
  });
}

export function assertValidAgentOptions(options: object): void {
  for (const key of Object.keys(options)) {
    if (REMOVED_AGENT_OPTION_KEYS.has(key)) {
      throw new RemovedAgentOptionError(key);
    }
    if (!AGENT_OPTION_KEY_SET.has(key)) {
      throw new UnrecognisedAgentOptionError(key, AGENT_OPTION_KEYS);
    }
  }

  const values = options as Record<string, unknown>;
  if (values.isolation !== undefined && values.isolation !== "worktree") {
    throw new InvalidAgentOptionValueError("isolation", values.isolation, 'exactly "worktree"');
  }
  // Harness-owned domain, judged before any worker spawns; opencode's
  // effort is the registry entry's served variants, judged by its adapter.
  if (values.engine !== "opencode") {
    assertCanonicalEffortSupported(values.effort);
  }
  assertPositiveIntegerOption(values, "timeoutMs", MAX_TIMER_DELAY_MS);
  assertPositiveIntegerOption(values, "maxAttempts");
  if (values.identity !== undefined && typeof values.identity !== "boolean") {
    throw new InvalidAgentOptionValueError("identity", values.identity, "a boolean");
  }
  if (values.strip !== undefined) {
    assertValidStripOption(values.strip);
  }
}

const WORKER_SESSION_OPTION_KEYS = Object.keys({
  engine: true,
  model: true,
  effort: true,
  fallbackModel: true,
  cwd: true,
  isolation: true,
  timeoutMs: true,
  maxAttempts: true,
  label: true,
  phase: true,
  strip: true,
  stalenessMark: true
} satisfies Record<keyof WorkerSessionOptions, true>);
const WORKER_SESSION_OPTION_KEY_SET = new Set<string>(WORKER_SESSION_OPTION_KEYS);

/**
 * Session creation options. The absence of `schema` and `identity`
 * from the known set is the contract, not an oversight: per-turn variation
 * is schema alone, carried by each `send()` — a creation-time schema would
 * claim one shape for turns whose whole point is having different ones.
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
  if (values.isolation !== undefined && values.isolation !== "worktree") {
    throw new InvalidAgentOptionValueError("isolation", values.isolation, 'exactly "worktree"');
  }
  // Same canonical-effort judgement as agent(): sessions fix effort at
  // creation, so an out-of-domain level must fail before the held worker
  // spawns. opencode sessions are refused pre-spawn elsewhere; the
  // exemption here keeps the two rejections from racing to name the error.
  if (values.engine !== "opencode") {
    assertCanonicalEffortSupported(values.effort);
  }
  assertPositiveIntegerOption(values, "timeoutMs", MAX_TIMER_DELAY_MS);
  assertPositiveIntegerOption(values, "maxAttempts");
  if (values.stalenessMark !== undefined && typeof values.stalenessMark !== "boolean") {
    throw new InvalidAgentOptionValueError("stalenessMark", values.stalenessMark, "a boolean");
  }
  if (values.strip !== undefined) {
    assertValidStripOption(values.strip);
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

export function assertFallbackModelSupported(engine: EngineName, fallbackModel: string | undefined): void {
  if (fallbackModel !== undefined && engine !== "claude") {
    throw new FallbackModelUnsupportedError(engine);
  }
}

export function requireRegisteredOpenCodeModel(
  model: string,
  registry: OpenCodeModelRegistry = defaultOpenCodeModelRegistry
): OpenCodeModelRegistryEntry {
  const registered = registry.get(model);
  if (registered === undefined) {
    throw new OpenCodeModelNotRegisteredError(model, registry.names());
  }
  return registered;
}

/** Validate policy fields whose compatibility depends on the selected engine. */
export function validateEngineDefaults(
  engine: EngineName,
  defaults: EngineDefaultOptions,
  openCodeModelRegistry: OpenCodeModelRegistry = defaultOpenCodeModelRegistry
): void {
  assertFallbackModelSupported(engine, defaults.fallbackModel);
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
    if (defaults.effort !== undefined && !model.variants.includes(defaults.effort)) {
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
