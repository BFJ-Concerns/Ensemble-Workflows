import assert from "node:assert/strict";
import test from "node:test";

import { buildCostRollup, type RollupAgentView, type RollupAttemptView } from "../../src/cost-rollup.js";
import { rollupViewOfArchivedRecord } from "../../src/run-record.js";

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

function agent(id: number, attempts: RollupAttemptView[], mayHaveUnlistedAttempt = false): RollupAgentView {
  return {
    id,
    engine: "codex",
    resolvedModel: attempts.findLast((a) => a.resolvedModel !== null)?.resolvedModel ?? null,
    attempts,
    mayHaveUnlistedAttempt
  };
}

test("a leaf whose every attempt reported its usage is a complete total", () => {
  const rollup = buildCostRollup([agent(1, [attempt(1)])]);
  const leaf = rollup.codex?.["gpt-6-luna"];
  assert.equal(leaf?.complete, true);
  assert.deepEqual(leaf?.unobserved, []);
  assert.equal("totalTokens" in (leaf?.tokens ?? {}), true);
});

test("a worker cut short beside a measured one on the same model leaves a lower bound naming it", () => {
  const rollup = buildCostRollup([
    agent(1, [attempt(1)]),
    agent(2, [attempt(1, { failureKind: "run-interrupted", tokenUsageEvents: [] })])
  ]);
  const leaf = rollup.codex?.["gpt-6-luna"];
  assert.equal(leaf?.complete, false);
  assert.deepEqual(leaf?.unobserved, [{ agent: 2, attempt: 1, reason: "worker-interrupted", measured: "none" }]);
  assert.deepEqual(leaf?.tokens, buildCostRollup([agent(1, [attempt(1)])]).codex?.["gpt-6-luna"]?.tokens);
});

test("an abandoned attempt books under the model it reported and marks what it measured", () => {
  const rollup = buildCostRollup([
    agent(1, [attempt(1, { settled: false, tokenUsageEvents: [] })])
  ]);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"], {
    tokens: { unavailable: "no-usage-reported" },
    cost: { unavailable: "no-provider-cost-reported" },
    complete: false,
    unobserved: [{ agent: 1, attempt: 1, reason: "record-unsettled", measured: "none" }]
  });
});

test("a live retry with no served identity leaves earlier measured spend complete", () => {
  const rollup = buildCostRollup([agent(1, [
    attempt(1, { failureKind: "empty-output" }),
    attempt(2, { settled: false, resolvedModel: null, tokenUsageEvents: [] })
  ])]);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"], buildCostRollup([agent(1, [attempt(1)])]).codex?.["gpt-6-luna"]);
  assert.deepEqual(rollup.codex?.unresolved, {
    tokens: { unavailable: "no-usage-reported" },
    cost: { unavailable: "no-provider-cost-reported" },
    complete: false,
    unobserved: [{ agent: 1, attempt: 2, reason: "record-unsettled", measured: "none" }]
  });
});

test("an archived abandoned retry without its own identity books under unresolved", () => {
  const view = rollupViewOfArchivedRecord(archivedRecord("abandoned", [
    { ...archivedAttempt("failed"), resolved_model: "gpt-6-luna", token_usage_events: [usage] },
    { ...archivedAttempt("abandoned"), attempt: 2 }
  ], { ...sweepAbandonment, resolved_model: "gpt-6-luna" }));
  assert.notEqual(view, null);
  const rollup = buildCostRollup([view!]);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"], buildCostRollup([agent(2, [attempt(1)])]).codex?.["gpt-6-luna"]);
  assert.deepEqual(rollup.codex?.unresolved?.unobserved, [
    { agent: 2, attempt: 2, reason: "record-unsettled", measured: "none" }
  ]);
});

test("a held turn with an explicit session identity keeps that model while unsettled", () => {
  const rollup = buildCostRollup([agent(1, [
    attempt(1, { failureKind: "empty-output" }),
    attempt(2, { settled: false, tokenUsageEvents: [] })
  ])]);
  assert.equal(rollup.codex?.unresolved, undefined);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"]?.unobserved, [
    { agent: 1, attempt: 2, reason: "record-unsettled", measured: "none" }
  ]);
});

test("a settled same-engine attempt can still use its agent's known model", () => {
  const rollup = buildCostRollup([agent(1, [
    attempt(1, { resolvedModel: null }),
    attempt(2)
  ])]);
  assert.equal(rollup.codex?.unresolved, undefined);
  const leaf = rollup.codex?.["gpt-6-luna"];
  assert.equal(leaf?.complete, true);
  assert.equal(leaf?.tokens !== undefined && "totalTokens" in leaf.tokens ? leaf.tokens.totalTokens : null, 28);
});

test("only the attempt the run's close cut short reads interrupted; a refusal spent nothing", () => {
  const rollup = buildCostRollup([
    agent(1, [
      attempt(1, { failureKind: "CodexSubstrateRefusedError", resolvedModel: null, tokenUsageEvents: [] }),
      attempt(2, { failureKind: "SomeEngineFailure", tokenUsageEvents: [] }),
      attempt(3, { failureKind: "run-interrupted" })
    ])
  ]);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"]?.unobserved, [
    { agent: 1, attempt: 2, reason: "engine-reported-no-usage", measured: "none" },
    { agent: 1, attempt: 3, reason: "worker-interrupted", measured: "partial" }
  ]);
});

test("an attempt that settled before the run ended keeps its spend complete, whatever the agent's status", () => {
  // The witness: the run was interrupted while the call waited for
  // re-admission on its next fallback target, after this attempt settled
  // on its own account. Its 14 tokens are the whole of its spend.
  const rollup = buildCostRollup([
    agent(1, [attempt(1, { failureKind: "upstream-unavailable" })])
  ]);
  const leaf = rollup.codex?.["gpt-6-luna"];
  assert.equal(leaf?.tokens !== undefined && "totalTokens" in leaf.tokens ? leaf.tokens.totalTokens : null, 14);
  assert.equal(leaf?.complete, true);
  assert.deepEqual(leaf?.unobserved, []);
});

test("a body that failed with the attempt in flight cut it short as an interrupt does", () => {
  const rollup = buildCostRollup([agent(1, [attempt(1, { failureKind: "run-failed" })])]);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"]?.unobserved, [
    { agent: 1, attempt: 1, reason: "worker-interrupted", measured: "partial" }
  ]);
});

test("a timed-out attempt the runtime retried keeps its partial spend marked, though the agent completed", () => {
  const rollup = buildCostRollup([
    agent(1, [attempt(1, { failureKind: "TurnTimeoutError" }), attempt(2)])
  ]);
  const leaf = rollup.codex?.["gpt-6-luna"];
  assert.equal(leaf?.tokens !== undefined && "totalTokens" in leaf.tokens ? leaf.tokens.totalTokens : null, 28);
  assert.equal(leaf?.complete, false);
  assert.deepEqual(leaf?.unobserved, [{ agent: 1, attempt: 1, reason: "worker-timed-out", measured: "partial" }]);
});

test("a retried attempt that timed out before reporting usage measured none of its spend", () => {
  const rollup = buildCostRollup([
    agent(1, [attempt(1, { failureKind: "TurnTimeoutError", tokenUsageEvents: [] }), attempt(2)])
  ]);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"]?.unobserved, [
    { agent: 1, attempt: 1, reason: "worker-timed-out", measured: "none" }
  ]);
});

test("every recorded timeout spelling ends its own attempt as timed out", () => {
  for (const failureKind of ["TurnTimeoutError", "claude-poll-timeout", "claude-first-life-timeout", "claude-registration-timeout"]) {
    const rollup = buildCostRollup([
      agent(1, [
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

test("a run deadline marks only the attempt it cut short timed out", () => {
  const rollup = buildCostRollup([
    agent(1, [
      attempt(1, { failureKind: "SomeEngineFailure", tokenUsageEvents: [] }),
      attempt(2, { failureKind: "run-timed-out" })
    ])
  ]);
  assert.deepEqual(rollup.codex?.["gpt-6-luna"]?.unobserved, [
    { agent: 1, attempt: 1, reason: "engine-reported-no-usage", measured: "none" },
    { agent: 1, attempt: 2, reason: "worker-timed-out", measured: "partial" }
  ]);
});

test("an agent known to have started nothing books a complete unresolved leaf", () => {
  const rollup = buildCostRollup([agent(2, [])]);
  assert.deepEqual(rollup.codex?.unresolved, {
    tokens: { unavailable: "no-usage-reported" },
    cost: { unavailable: "no-provider-cost-reported" },
    complete: true,
    unobserved: []
  });
});

test("an agent whose start evidence may be missing books an unnumbered unobserved attempt", () => {
  // The witness: an abandoned record with no attempts, whose start write
  // may have failed while its worker ran.
  const rollup = buildCostRollup([agent(2, [], true)]);
  assert.deepEqual(rollup.codex?.unresolved, {
    tokens: { unavailable: "no-usage-reported" },
    cost: { unavailable: "no-provider-cost-reported" },
    complete: false,
    unobserved: [{ agent: 2, attempt: null, reason: "record-unsettled", measured: "none" }]
  });
});

function archivedRecord(status: string, attempts: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_version: 5, kind: "agent_record", id: 2, engine: "codex", status, resolved_model: null, attempts, ...extra };
}

function archivedAttempt(status: string): Record<string, unknown> {
  return { attempt: 1, status, target: { engine: "codex", model: null }, failure: null, resolved_model: null, token_usage_events: [] };
}

const sweepAbandonment = { abandonment: { observed_at: "2026-11-10T00:00:00.000Z", reason: "owner-gone", observed_by: { pid: 1, run_uuid: "next" } } };

test("an archived record its writer never settled may have run an attempt it does not list", () => {
  for (const [label, record] of [
    ["swept with no attempts", archivedRecord("abandoned", [], sweepAbandonment)],
    ["swept after a settled attempt", archivedRecord("abandoned", [archivedAttempt("failed")], sweepAbandonment)],
    ["still in progress", archivedRecord("in-progress", [])]
  ] as const) {
    assert.equal(rollupViewOfArchivedRecord(record)?.mayHaveUnlistedAttempt, true, label);
  }
});

test("an archived record that lists its unsettled attempt, or that its writer settled, lists every attempt", () => {
  for (const [label, record] of [
    ["swept with its abandoned attempt listed", archivedRecord("abandoned", [archivedAttempt("abandoned")], sweepAbandonment)],
    ["abandoned by the run's own close during dispatch", archivedRecord("abandoned", [])],
    ["settled with no attempts", archivedRecord("failed", [])],
    ["settled interrupted", archivedRecord("interrupted", [archivedAttempt("failed")])]
  ] as const) {
    assert.equal(rollupViewOfArchivedRecord(record)?.mayHaveUnlistedAttempt, false, label);
  }
});

test("an attempt the record may not list books under the call's engine, leaving its listed attempts' leaf alone", () => {
  const rollup = buildCostRollup([agent(3, [attempt(1, { failureKind: "SomeEngineFailure" })], true)]);
  assert.equal(rollup.codex?.["gpt-6-luna"]?.complete, true);
  assert.deepEqual(rollup.codex?.unresolved?.unobserved, [
    { agent: 3, attempt: null, reason: "record-unsettled", measured: "none" }
  ]);
});
