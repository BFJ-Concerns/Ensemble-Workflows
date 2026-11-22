import type { OpenCodeModelRegistry } from "./opencode-model-registry.js";
import type { EngineName } from "./types.js";

/**
 * The machine's model family assignments (the config file's
 * `model_families` section): a model name, as a call or an engine names
 * it, mapped to the family it belongs to. An assignment outranks the
 * harness's own grouping.
 */
export type ModelFamilyAssignments = Readonly<Record<string, string>>;

/**
 * The families the harness can place a model in by its name alone, each
 * matched against the bare model name. Claude Code's own aliases (`opus`,
 * `sonnet`, `haiku`, `fable`) are Claude, and OpenAI's `o`-series and
 * `codex-` models are GPT.
 */
const NAME_GROUPS: readonly (readonly [RegExp, string])[] = [
  [/^(claude|opus|sonnet|haiku|fable)(-|\[|$)/, "claude"],
  [/^(gpt|chatgpt|codex)(-|$)|^o[1-9](-|$)/, "gpt"],
  [/^gemini(-|$)/, "gemini"],
  [/^glm(?:\d+(?:\.\d+)*)?(-|$)/, "glm"],
  [/^kimi(-|$)/, "kimi"],
  [/^qwen/, "qwen"],
  [/^deepseek(-|$)/, "deepseek"],
  [/^grok(-|$)/, "grok"],
  [/^llama/, "llama"],
  [/^(mistral|mixtral|codestral|devstral|magistral|ministral)(-|$)/, "mistral"],
  [/^minimax(-|$)/, "minimax"]
];

/**
 * Match the final route segment without its tag, ignoring case. If the
 * bare match fails, allow one dotted vendor prefix such as `anthropic.`.
 */
export function groupModelName(model: string): string | null {
  const [name = ""] = model.slice(model.lastIndexOf("/") + 1).toLowerCase().split(":", 1);
  const bare = NAME_GROUPS.find(([pattern]) => pattern.test(name));
  if (bare !== undefined) return bare[1];

  const vendorModel = /^[a-z0-9-]+\.(.+)$/.exec(name)?.[1];
  if (vendorModel === undefined) return null;
  return NAME_GROUPS.find(([pattern]) => pattern.test(vendorModel))?.[1] ?? null;
}

/**
 * A dispatch target as its family is judged: the engine, the model the
 * call named (null where it named none), and the model the engine served
 * for it (null where nothing has been served, or the engine reported none).
 */
export interface FamilyJudgedTarget {
  engine: EngineName;
  requested: string | null;
  served: string | null;
}

/**
 * The model family a dispatch target runs on, as the harness judges it
 * wherever it reports one — the dispatch lookup's answer, an identified
 * call's envelope, and the single-family judgement of a run's workers. The
 * family belongs to the model, never to the engine that runs it.
 *
 * The names judged are the model the call named and the model the engine
 * served, so a call naming no model is judged by the model its engine's
 * default resolved to once a worker reports it. For an opencode route the
 * registry entry's key and `provider/model` route stand in for the named
 * model, and the entry's own `family` outranks everything else. Otherwise
 * a machine assignment for any of those names outranks the harness's
 * grouping of them; the first name that places the model decides. Null
 * where none does: the family is unknown.
 */
export function modelFamilyOf(
  target: FamilyJudgedTarget,
  assignments: ModelFamilyAssignments,
  openCodeModels: OpenCodeModelRegistry | undefined
): string | null {
  const entry = target.engine === "opencode" && target.requested !== null ? openCodeModels?.get(target.requested) : undefined;
  if (entry?.family !== undefined) {
    return entry.family;
  }
  const names = [
    ...(entry !== undefined ? [entry.key, entry.providerModel] : target.requested !== null ? [target.requested] : []),
    ...(target.served !== null ? [target.served] : [])
  ];
  for (const name of names) {
    if (Object.hasOwn(assignments, name)) {
      return assignments[name] ?? null;
    }
  }
  for (const name of names) {
    const family = groupModelName(name);
    if (family !== null) {
      return family;
    }
  }
  return null;
}

/** The one model family every worker of a run resolved onto, and how many workers that was. */
export interface SingleFamilyJudgement {
  family: string;
  workers: number;
}

/**
 * The single-family judgement over a run's workers, given each worker's
 * family as judged on the target it resolved to at dispatch (null where
 * unknown): the one family every worker resolved onto and how many workers
 * that was, or null where no worker ran, where they spanned families, or
 * where any worker's family is unknown — the fact is then unknown and
 * nothing is said.
 */
export function singleFamilyOf(families: readonly (string | null)[]): SingleFamilyJudgement | null {
  const distinct = new Set(families);
  const [family] = distinct;
  return families.length > 0 && distinct.size === 1 && typeof family === "string" ? { family, workers: families.length } : null;
}
