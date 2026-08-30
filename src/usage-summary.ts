import type { EngineName, TokenUsageEvent } from "./types.js";

/**
 * The declared summary vocabulary: the one shape every summary usage
 * figure in the run record uses — the manifest's per-model rollup and the
 * per-agent totals alike. The classes are disjoint and sum to
 * `totalTokens` by construction, whatever the engine's native fields mean:
 *
 * - `freshInputTokens` — input actually processed uncached.
 * - `cachedInputTokens` — the combined cache figure retained for admission
 *   and total reconciliation. It is not itself a pricing class where it
 *   combines reads and writes: use `cacheReadTokens` and
 *   `cacheCreationTokens` when the engine separates them. Their absence
 *   means "not separable", never zero.
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
 * - **claude** reports `inputTokens` *excluding* cache,
 *   `cachedInputTokens` as reads + creation with the creation share carried
 *   separately, but no reasoning split. The transcript adapter leaves the
 *   optional native field absent, so the summary publishes reasoning as
 *   `null` and keeps the whole generation in `outputTokens`
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
  { cachedWithinInput: boolean; reasoningWithinOutput: boolean }
> = {
  codex: { cachedWithinInput: true, reasoningWithinOutput: true },
  claude: { cachedWithinInput: false, reasoningWithinOutput: true },
  opencode: { cachedWithinInput: false, reasoningWithinOutput: false }
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
  let reasoningSeparable = true;
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
    const deltaReasoning = delta.reasoningOutputTokens;
    if (deltaReasoning === undefined) {
      reasoningSeparable = false;
    }
    const reportedReasoning = deltaReasoning ?? 0;
    const deltaOutput = rules.reasoningWithinOutput && deltaReasoning !== undefined
      ? Math.max(0, delta.outputTokens - reportedReasoning)
      : delta.outputTokens;
    fresh += deltaFresh;
    reasoning += reportedReasoning;
    output += deltaOutput;
    // Spend the engine's own total covers but no class does — opencode's
    // total-only steps are the known case. Counting it keeps a wholly
    // unclassifiable event from collapsing into a zero-spend summary.
    unclassified += Math.max(
      0,
      delta.totalTokens - (deltaFresh + delta.cachedInputTokens + deltaOutput + reportedReasoning)
    );
  }
  const separableReasoning = reasoningSeparable ? reasoning : null;
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
