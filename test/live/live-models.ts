import { resolveAmbientSettings } from "../../src/ambient-settings.js";

import type { OpenCodeModelRegistryEntry } from "../../src/opencode-model-registry.js";

/**
 * The models live legs dispatch to when they must name one. Which models an
 * account or machine can reach is the operator's to say, so nothing here is
 * pinned: a leg whose model is unset skips, and the other legs keep each
 * engine's own default.
 *
 * - `ENSEMBLE_LIVE_CODEX_MODEL`: a Codex model for the legs that pass one
 *   explicitly.
 * - `ENSEMBLE_LIVE_OPENCODE_MODEL`: a key from the machine configuration's
 *   `opencode_models`; opencode has no default, so every opencode leg needs it.
 */
export const liveCodexModel = nonEmpty(process.env.ENSEMBLE_LIVE_CODEX_MODEL);
export const liveOpenCodeModel = nonEmpty(process.env.ENSEMBLE_LIVE_OPENCODE_MODEL);

/** The machine's declared opencode catalogue, for live legs that build a runtime directly rather than through the CLI. */
export function machineOpenCodeModels(): OpenCodeModelRegistryEntry[] {
  return resolveAmbientSettings({ env: process.env, cwd: process.cwd() }).openCodeModels;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}
