import { resolveAmbientSettings } from "../../src/ambient-settings.js";

import type { OpenCodeModelRegistryEntry } from "../../src/opencode-model-registry.js";

/**
 * The models live legs dispatch to when they must name one. Which models an
 * account or machine can reach is the operator's to say, so nothing here is
 * pinned. A leg whose claim is about naming a model skips while its model is
 * unset; every other leg runs on the engine's own default and takes the
 * pinned model when one is set.
 *
 * - `ENSEMBLE_LIVE_CODEX_MODEL`: a Codex model for the legs that name one, and
 *   the model (at `low` effort) every other Codex leg takes when it is set.
 * - `ENSEMBLE_LIVE_OPENCODE_MODEL`: a key from the machine configuration's
 *   `opencode_models`; opencode has no default, so every opencode leg needs it.
 */
export const liveCodexModel = nonEmpty(process.env.ENSEMBLE_LIVE_CODEX_MODEL);
export const liveOpenCodeModel = nonEmpty(process.env.ENSEMBLE_LIVE_OPENCODE_MODEL);

/** The Codex model options a leg passes: the pinned model at `low` effort, or none for the engine default. */
export function liveCodexOptions(): { model?: string; effort?: "low" } {
  return liveCodexModel === undefined ? {} : { model: liveCodexModel, effort: "low" };
}

/** {@link liveCodexOptions} as object-literal properties for a workflow script's `agent()` call. */
export function liveCodexScriptOptions(): string {
  const options = liveCodexOptions();
  return Object.entries(options)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)},`)
    .join(" ");
}

/** The machine's declared opencode catalogue, for live legs that build a runtime directly rather than through the CLI. */
export function machineOpenCodeModels(): OpenCodeModelRegistryEntry[] {
  return resolveAmbientSettings({ env: process.env, cwd: process.cwd() }).openCodeModels;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}
