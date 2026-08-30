import assert from "node:assert/strict";
import test from "node:test";

import { addUsageSummary, summariseUsage } from "../../src/usage-summary.js";

import type { TokenUsageBreakdown, TokenUsageEvent } from "../../src/types.js";

function event(last: TokenUsageBreakdown): TokenUsageEvent {
  return { threadId: "thread", turnId: "turn", last, total: last, raw: {} };
}

test("no events yields null, never a zero-spend summary", () => {
  assert.equal(summariseUsage("codex", []), null);
});

test("codex spend maps by subtraction: cached out of input, reasoning out of output", () => {
  const summary = summariseUsage("codex", [
    event({ cachedInputTokens: 8, inputTokens: 20, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 25 })
  ]);
  assert.deepEqual(summary, {
    freshInputTokens: 12,
    cachedInputTokens: 8,
    outputTokens: 3,
    reasoningOutputTokens: 2,
    unclassifiedTokens: 0,
    totalTokens: 25
  });
});

test("claude preserves its reported reasoning zero and splits cache for pricing where reported", () => {
  const summary = summariseUsage("claude", [
    event({
      cachedInputTokens: 10,
      cacheCreationInputTokens: 3,
      inputTokens: 220,
      outputTokens: 40,
      reasoningOutputTokens: 0,
      totalTokens: 270
    })
  ]);
  assert.deepEqual(summary, {
    freshInputTokens: 220,
    cachedInputTokens: 10,
    cacheReadTokens: 7,
    cacheCreationTokens: 3,
    outputTokens: 40,
    reasoningOutputTokens: 0,
    unclassifiedTokens: 0,
    totalTokens: 270
  });
});

test("opencode spend is already disjoint: classes pass through and sum", () => {
  const summary = summariseUsage("opencode", [
    event({
      cachedInputTokens: 4,
      cacheCreationInputTokens: 1,
      inputTokens: 30,
      outputTokens: 9,
      reasoningOutputTokens: 6,
      totalTokens: 49
    })
  ]);
  assert.deepEqual(summary, {
    freshInputTokens: 30,
    cachedInputTokens: 4,
    cacheReadTokens: 3,
    cacheCreationTokens: 1,
    outputTokens: 9,
    reasoningOutputTokens: 6,
    unclassifiedTokens: 0,
    totalTokens: 49
  });
});

test("a wholly unclassifiable event keeps its reported spend as unclassified, never zero", () => {
  // opencode's total-only steps: the aggregate carries spend only in the
  // engine total. Erasing it into an all-zero summary would make reported
  // spend indistinguishable from no spend.
  const summary = summariseUsage("opencode", [
    event({ cachedInputTokens: 0, inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 100 })
  ]);
  assert.deepEqual(summary, {
    freshInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    unclassifiedTokens: 100,
    totalTokens: 100
  });
});

test("merging drops a split that not every contributor carries", () => {
  const separable = summariseUsage("claude", [
    event({
      cachedInputTokens: 10,
      cacheCreationInputTokens: 3,
      inputTokens: 1,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 12
    })
  ]);
  const combinedOnly = summariseUsage("claude", [
    event({ cachedInputTokens: 5, inputTokens: 1, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 7 })
  ]);
  assert.ok(separable !== null && combinedOnly !== null);
  const merged = addUsageSummary(separable, combinedOnly);
  // A partial split presented whole would claim precision the evidence
  // never had: the combined cached figure survives, the read/creation
  // split does not.
  assert.deepEqual(merged, {
    freshInputTokens: 2,
    cachedInputTokens: 15,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    unclassifiedTokens: 0,
    totalTokens: 19
  });
});

test("merging folds separable reasoning into output when a contributor cannot separate it", () => {
  const codex = summariseUsage("codex", [
    event({ cachedInputTokens: 0, inputTokens: 4, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 9 })
  ]);
  assert.ok(codex !== null);
  // `null` remains the public representation for a genuinely unseparable
  // reasoning class, even though Claude's native events now report zero.
  const combinedReasoning = {
    freshInputTokens: 4,
    cachedInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: null,
    unclassifiedTokens: 0,
    totalTokens: 9
  };
  const merged = addUsageSummary(codex, combinedReasoning);
  assert.equal(merged.reasoningOutputTokens, null);
  assert.equal(merged.outputTokens, 10);
  assert.equal(merged.totalTokens, 18);
});
