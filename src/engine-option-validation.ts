import { FallbackModelUnsupportedError, OpenCodeModelNotRegisteredError } from "./errors.js";
import { defaultOpenCodeModelRegistry } from "./opencode-model-registry.js";

import type { OpenCodeModelRegistry, OpenCodeModelRegistryEntry } from "./opencode-model-registry.js";
import type { EngineName } from "./types.js";

interface EngineDefaultOptions {
  model?: string;
  effort?: string;
  fallbackModel?: string;
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
