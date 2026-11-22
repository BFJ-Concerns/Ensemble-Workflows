import { ZCodeModelRequiredError } from "./errors.js";

/**
 * A zcode model as a call names it: provider first, split at the first
 * `/`, so the model id keeps any `/` or `:` of its own
 * (`nanogpt/z-ai/glm-5.3-flash`, `gateway/claude-opus-5-5[1m]`).
 */
export interface ZCodeModelSelection {
  provider: string;
  model: string;
}

export function parseZCodeModel(spelling: string | undefined): ZCodeModelSelection {
  const separator = spelling?.indexOf("/") ?? -1;
  if (spelling === undefined || separator <= 0 || separator === spelling.length - 1 ||
      spelling.slice(0, separator).trim().length === 0 || spelling.slice(separator + 1).trim().length === 0) {
    throw new ZCodeModelRequiredError(spelling);
  }
  return { provider: spelling.slice(0, separator), model: spelling.slice(separator + 1) };
}
