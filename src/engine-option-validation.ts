import {
  FallbackModelUnsupportedError,
  InvalidAgentOptionValueError,
  OpenCodeModelNotRegisteredError,
  RemovedAgentOptionError,
  UnrecognisedAgentOptionError
} from "./errors.js";
import { defaultOpenCodeModelRegistry } from "./opencode-model-registry.js";

import type { OpenCodeModelRegistry, OpenCodeModelRegistryEntry } from "./opencode-model-registry.js";
import type { AgentOptions, EngineName } from "./types.js";

/** Node's 32-bit setTimeout ceiling: above it the platform's timer silently misbehaves. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  identity: true
} satisfies Record<keyof AgentOptions, true>);
const AGENT_OPTION_KEY_SET = new Set<string>(AGENT_OPTION_KEYS);
const REMOVED_AGENT_OPTION_KEYS = new Set(["sandbox", "network", "webSearch"]);

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
  assertPositiveIntegerOption(values, "timeoutMs", MAX_TIMER_DELAY_MS);
  assertPositiveIntegerOption(values, "maxAttempts");
  if (values.identity !== undefined && typeof values.identity !== "boolean") {
    throw new InvalidAgentOptionValueError("identity", values.identity, "a boolean");
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
  if (engine === "opencode" && defaults.model !== undefined) {
    requireRegisteredOpenCodeModel(defaults.model, openCodeModelRegistry);
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
