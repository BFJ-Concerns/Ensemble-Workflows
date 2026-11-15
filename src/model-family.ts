import type { OpenCodeModelRegistry } from "./opencode-model-registry.js";
import type { EngineName } from "./types.js";

/**
 * The model family a dispatch target runs on, as the harness judges it
 * wherever it reports one — the dispatch lookup's answer, an identified
 * call's envelope, and the single-family judgement of a run's workers.
 * Codex and Claude are each one family, named for their engine; an opencode
 * route takes the `family` its registry entry declares. Null where the
 * harness cannot tell: an opencode route whose entry declares no family, or
 * a model the registry does not hold.
 */
export function modelFamilyOf(
  engine: EngineName,
  model: string | null | undefined,
  openCodeModels: OpenCodeModelRegistry | undefined
): string | null {
  if (engine !== "opencode") {
    return engine;
  }
  if (model === null || model === undefined) {
    return null;
  }
  return openCodeModels?.get(model)?.family ?? null;
}
