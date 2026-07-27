import {
  FallbackModelUnsupportedError,
  OpenCodeModelNotRegisteredError,
  RemovedAgentOptionError,
  UnrecognisedAgentOptionError
} from "./errors.js";
import { defaultOpenCodeModelRegistry } from "./opencode-model-registry.js";

import type { OpenCodeModelRegistry, OpenCodeModelRegistryEntry } from "./opencode-model-registry.js";
import type { EngineName } from "./types.js";

interface EngineDefaultOptions {
  model?: string;
  effort?: string;
  fallbackModel?: string;
}

const AGENT_OPTION_KEYS = [
  "engine",
  "schema",
  "model",
  "effort",
  "fallbackModel",
  "cwd",
  "isolation",
  "timeoutMs",
  "maxAttempts",
  "label",
  "phase"
] as const;
const AGENT_OPTION_KEY_SET = new Set<string>(AGENT_OPTION_KEYS);
const REMOVED_AGENT_OPTION_KEYS = new Set(["sandbox", "network", "webSearch"]);

export function assertRecognisedAgentOptions(options: object): void {
  for (const key of Object.keys(options)) {
    if (REMOVED_AGENT_OPTION_KEYS.has(key)) {
      throw new RemovedAgentOptionError(key);
    }
    if (!AGENT_OPTION_KEY_SET.has(key)) {
      throw new UnrecognisedAgentOptionError(key, AGENT_OPTION_KEYS);
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
  if (engine === "opencode" && defaults.model !== undefined) {
    requireRegisteredOpenCodeModel(defaults.model, openCodeModelRegistry);
  }
}
