import assert from "node:assert/strict";
import test from "node:test";

import { buildCostRollup, type RollupAgentView, type RollupAttemptView } from "../../src/cost-rollup.js";

import type { TokenUsageEvent } from "../../src/types.js";

const usage: TokenUsageEvent = {
  threadId: "thread",
  turnId: "turn",
  last: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  total: { cachedInputTokens: 0, inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  raw: {}
};

function attempt(number: number, overrides: Partial<RollupAttemptView> = {}): RollupAttemptView {
  return {
    attempt: number,
    engine: "codex",
    resolvedModel: "gpt-6-luna",
    settled: true,
    failureKind: null,
    tokenUsageEvents: [usage],
    ...overrides
  };
}

function agent(id: number, status: RollupAgentView["status"], attempts: RollupAttemptView[]): RollupAgentView {
  return { id, engine: "codex", status, resolvedModel: attempts.findLast((a) => a.resolvedModel !== null)?.resolvedModel ?? null, attempts };
}

test("a leaf whose every attempt reported its usage is a complete total", () => {
  const rollup = buildCostRollup([agent(1, "complete", [attempt(1)])]);
  const leaf = rollup.codex?.["gpt-6-luna"];
  assert.equal(leaf?.complete, true);
  assert.deepEqual(leaf?.unobserved, []);
  assert.equal("totalTokens" in (leaf?.tokens ?? {}), true);
});

test("a worker cut short beside a measured one on the same model leaves a lower bound naming it", () => {
  const rollup = buildCostRollup([
    agent(1, "complete", [attempt(1)]),
    agent(2, "interrupted", [attempt(1, { failureKind: "EngineShutdownError", tokenUsageEvents: [] })])
  ]);
  const leaf = rollup.codex?.["gpt-6-luna"];
  assert.equal(leaf?.complete, false);
  assert.deepEqual(leaf?.unobserved, [{ agent: 2, attempt: 1, reason: "worker-interrupted", measured: "none" }]);
  assert.deepEqual(leaf?.tokens, buildCostRollup([agent(1, "complete", [attempt(1)])]).codex?.["gpt-6-luna"]?.tokens);
});

test("an abandoned attempt books under the model it reported and marks what it measured", () => {
  const rollup = buildCostRollup([
    agent(1, "abandoned", [attempt(1, { settled: false, tokenUsageEvents: [] })])
  ]);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"], {
    tokens: { unavailable: "no-usage-reported" },
    cost: { unavailable: "no-provider-cost-reported" },
    complete: false,
    unobserved: [{ agent: 1, attempt: 1, reason: "record-unsettled", measured: "none" }]
  });
});

test("only the last attempt of an interrupted record was cut short; a refusal spent nothing", () => {
  const rollup = buildCostRollup([
    agent(1, "interrupted", [
      attempt(1, { failureKind: "CodexSubstrateRefusedError", resolvedModel: null, tokenUsageEvents: [] }),
      attempt(2, { failureKind: "SomeEngineFailure", tokenUsageEvents: [] }),
      attempt(3, { failureKind: "EngineShutdownError" })
    ])
  ]);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"]?.unobserved, [
    { agent: 1, attempt: 2, reason: "engine-reported-no-usage", measured: "none" },
    { agent: 1, attempt: 3, reason: "worker-interrupted", measured: "partial" }
  ]);
});

test("a timed-out attempt the runtime retried keeps its partial spend marked, though the agent completed", () => {
  const rollup = buildCostRollup([
    agent(1, "complete", [attempt(1, { failureKind: "TurnTimeoutError" }), attempt(2)])
  ]);
  const leaf = rollup.codex?.["gpt-6-luna"];
  assert.equal(leaf?.tokens !== undefined && "totalTokens" in leaf.tokens ? leaf.tokens.totalTokens : null, 28);
  assert.equal(leaf?.complete, false);
  assert.deepEqual(leaf?.unobserved, [{ agent: 1, attempt: 1, reason: "worker-timed-out", measured: "partial" }]);
});

test("a retried attempt that timed out before reporting usage measured none of its spend", () => {
  const rollup = buildCostRollup([
    agent(1, "complete", [attempt(1, { failureKind: "TurnTimeoutError", tokenUsageEvents: [] }), attempt(2)])
  ]);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"]?.unobserved, [
    { agent: 1, attempt: 1, reason: "worker-timed-out", measured: "none" }
  ]);
});

test("every recorded timeout spelling ends its own attempt as timed out", () => {
  for (const failureKind of ["TurnTimeoutError", "claude-poll-timeout", "claude-first-life-timeout", "claude-registration-timeout"]) {
    const rollup = buildCostRollup([
      agent(1, "failed", [
        attempt(1, { failureKind, tokenUsageEvents: [] }),
        attempt(2, { failureKind: "SomeEngineFailure" })
      ])
    ]);
    assert.deepEqual(
      rollup.codex?.["gpt-6-luna"]?.unobserved,
      [{ agent: 1, attempt: 1, reason: "worker-timed-out", measured: "none" }],
      failureKind
    );
  }
});

test("a run deadline that ended the record marks only its last attempt timed out", () => {
  const rollup = buildCostRollup([
    agent(1, "timed-out", [
      attempt(1, { failureKind: "SomeEngineFailure", tokenUsageEvents: [] }),
      attempt(2, { failureKind: "run-timed-out" })
    ])
  ]);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"]?.unobserved, [
    { agent: 1, attempt: 1, reason: "engine-reported-no-usage", measured: "none" },
    { agent: 1, attempt: 2, reason: "worker-timed-out", measured: "partial" }
  ]);
});
