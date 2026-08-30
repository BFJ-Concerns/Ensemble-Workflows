import type { EngineName, TokenUsageBreakdown, TokenUsageEvent } from "./types.js";

/**
 * The declared summary vocabulary: the one shape every summary usage
 * figure in the run record uses — the manifest's per-model rollup and the
 * per-agent totals alike. The classes are disjoint and sum to
 * `totalTokens` by construction, whatever the engine's native fields mean:
 *
 * - `freshInputTokens` — input actually processed uncached.
 * - `cachedInputTokens` — input served from (or written to) cache. Where
 *   the engine separates reads from writes, `cacheReadTokens` and
 *   `cacheCreationTokens` split this figure; absent means "not separable",
 *   never zero.
 * - `outputTokens` — generated output, excluding reasoning where the
 *   engine reports reasoning separately.
 * - `reasoningOutputTokens` — reasoning output where the engine separates
 *   it; `null` means the engine does not, and `outputTokens` carries the
 *   whole generation. `null` is never zero: a zero from a separating
 *   engine says "no reasoning spend", a `null` says "not knowable".
 *
 * - `unclassifiedTokens` — spend the engine reported in its own total that
 *   none of the declared classes covers (opencode steps carrying `total`
 *   alone are the known case). Naming it keeps the summary honest in both
 *   directions: no class absorbs tokens by lying about what they were, and
 *   no reported spend is erased into an all-zero summary.
 *
 * The engine-native usage events remain untouched beneath the summaries —
 * the vocabulary governs the summary, not the evidence.
 */
export interface UsageSummary {
  freshInputTokens: number;
  cachedInputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number | null;
  unclassifiedTokens: number;
  totalTokens: number;
}

/**
 * Return the monotonic usage increase since the previous engine report.
 * Engines may repeat their cumulative total while a worker is live; clamping
 * each field keeps the event stream delta-shaped and never charges a reset.
 */
export function subtractUsage(total: TokenUsageBreakdown, previous: TokenUsageBreakdown | null): TokenUsageBreakdown {
  const before = previous ?? {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
  const cacheCreationInputTokens =
    total.cacheCreationInputTokens === undefined
      ? undefined
      : Math.max(0, total.cacheCreationInputTokens - (before.cacheCreationInputTokens ?? 0));
  return {
    cachedInputTokens: Math.max(0, total.cachedInputTokens - before.cachedInputTokens),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    inputTokens: Math.max(0, total.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - before.outputTokens),
    reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - before.reasoningOutputTokens),
    totalTokens: Math.max(0, total.totalTokens - before.totalTokens)
  };
}

/**
 * The one inclusion rule per engine, in one place — the shared
 * `TokenUsageBreakdown` deliberately preserves each engine's native field
 * semantics, so the summary boundary is where those semantics are mapped
 * onto the declared classes. Each row states how it is known: "measured"
 * rows are verifiable from this repository's own capture code; "judgement"
 * rows are claims about upstream payloads the repo cannot verify by
 * construction, checked by reconciling the recorded summaries against the
 * native usage events kept beside them in the run record.
 *
 * - **codex** reports `inputTokens` *including* the cached share (measured:
 *   the ~2× dashboard overcount that motivated this vocabulary), and
 *   `outputTokens`
 *   *including* the reasoning share (judgement, 2026-08-27, from OpenAI
 *   usage-field semantics) — both are subtracted out to keep the classes
 *   disjoint.
 * - **claude** reports `inputTokens` *excluding* cache, `cachedInputTokens`
 *   as reads + creation with the creation share carried separately, and no
 *   reasoning split — reasoning is `null` and rides `outputTokens`
 *   (measured: `usageSince` in `src/claude-transcript.ts` builds exactly
 *   this shape).
 * - **opencode** reports input, output, reasoning, and cache all disjointly
 *   (measured harness-side: `aggregateOpenCodeUsage` in
 *   `src/opencode-engine.ts` sums them into its total; the disjointness of
 *   the upstream fields themselves is judgement, reconciled the same
 *   way); cache
 *   creation is separable only when the stream carried a cache object.
 */
const ENGINE_INCLUSION_RULES: Record<
  EngineName,
  { cachedWithinInput: boolean; reasoningWithinOutput: boolean; reasoningSeparable: boolean }
> = {
  codex: { cachedWithinInput: true, reasoningWithinOutput: true, reasoningSeparable: true },
  claude: { cachedWithinInput: false, reasoningWithinOutput: true, reasoningSeparable: false },
  opencode: { cachedWithinInput: false, reasoningWithinOutput: false, reasoningSeparable: true }
};

/**
 * Summarise an agent's usage events into the declared vocabulary. Deltas
 * (`event.last`) are summed, matching the rollup's long-standing
 * convention. Returns `null` when there are no events at all — the caller
 * records *why* there is no summary rather than publishing a zero-spend
 * figure no engine reported.
 */
export function summariseUsage(engine: EngineName, events: readonly TokenUsageEvent[]): UsageSummary | null {
  if (events.length === 0) {
    return null;
  }
  const rules = ENGINE_INCLUSION_RULES[engine];
  let fresh = 0;
  let cached = 0;
  let cacheCreation = 0;
  let cacheCreationSeparable = true;
  let output = 0;
  let reasoning = 0;
  let unclassified = 0;
  for (const event of events) {
    const delta = event.last;
    cached += delta.cachedInputTokens;
    if (delta.cacheCreationInputTokens === undefined) {
      cacheCreationSeparable = false;
    } else {
      cacheCreation += delta.cacheCreationInputTokens;
    }
    const deltaFresh = rules.cachedWithinInput
      ? Math.max(0, delta.inputTokens - delta.cachedInputTokens)
      : delta.inputTokens;
    const deltaOutput = rules.reasoningWithinOutput
      ? Math.max(0, delta.outputTokens - delta.reasoningOutputTokens)
      : delta.outputTokens;
    fresh += deltaFresh;
    reasoning += delta.reasoningOutputTokens;
    output += deltaOutput;
    // Spend the engine's own total covers but no class does — opencode's
    // total-only steps are the known case. Counting it keeps a wholly
    // unclassifiable event from collapsing into a zero-spend summary.
    unclassified += Math.max(
      0,
      delta.totalTokens - (deltaFresh + delta.cachedInputTokens + deltaOutput + delta.reasoningOutputTokens)
    );
  }
  const separableReasoning = rules.reasoningSeparable ? reasoning : null;
  return {
    freshInputTokens: fresh,
    cachedInputTokens: cached,
    ...(cacheCreationSeparable
      ? { cacheReadTokens: Math.max(0, cached - cacheCreation), cacheCreationTokens: cacheCreation }
      : {}),
    outputTokens: separableReasoning === null ? output + reasoning : output,
    reasoningOutputTokens: separableReasoning,
    unclassifiedTokens: unclassified,
    // The total is the class sum by construction, so the vocabulary's
    // disjoint-and-summing invariant cannot drift from the fields beside it.
    totalTokens: fresh + cached + output + reasoning + unclassified
  };
}

/**
 * Fold one summary into an accumulating one (rollup buckets). The cache
 * split and the reasoning class survive only while every contributor
 * carries them — a single not-separable contributor makes the merged
 * figure not separable, because a partial split presented whole would
 * claim precision the evidence never had.
 */
export function addUsageSummary(target: UsageSummary, delta: UsageSummary): UsageSummary {
  const splitSurvives =
    target.cacheReadTokens !== undefined &&
    target.cacheCreationTokens !== undefined &&
    delta.cacheReadTokens !== undefined &&
    delta.cacheCreationTokens !== undefined;
  const reasoningSurvives = target.reasoningOutputTokens !== null && delta.reasoningOutputTokens !== null;
  return {
    freshInputTokens: target.freshInputTokens + delta.freshInputTokens,
    cachedInputTokens: target.cachedInputTokens + delta.cachedInputTokens,
    ...(splitSurvives
      ? {
          cacheReadTokens: (target.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
          cacheCreationTokens: (target.cacheCreationTokens ?? 0) + (delta.cacheCreationTokens ?? 0)
        }
      : {}),
    outputTokens:
      reasoningSurvives || (target.reasoningOutputTokens === null && delta.reasoningOutputTokens === null)
        ? target.outputTokens + delta.outputTokens
        : target.outputTokens +
          (target.reasoningOutputTokens ?? 0) +
          delta.outputTokens +
          (delta.reasoningOutputTokens ?? 0),
    reasoningOutputTokens: reasoningSurvives
      ? (target.reasoningOutputTokens ?? 0) + (delta.reasoningOutputTokens ?? 0)
      : null,
    unclassifiedTokens: target.unclassifiedTokens + delta.unclassifiedTokens,
    totalTokens: target.totalTokens + delta.totalTokens
  };
}
