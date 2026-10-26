import assert from "node:assert/strict";
import test from "node:test";

import { classifyAttemptFailure } from "../../src/failure-classification.js";

import type { AttemptFailureEvidence } from "../../src/failure-classification.js";

function evidence(overrides: Partial<AttemptFailureEvidence> & Pick<AttemptFailureEvidence, "engine" | "failure">): AttemptFailureEvidence {
  return { appServerDiagnostic: null, diagnostics: undefined, ...overrides };
}

test("output failures classify as output on every engine, never advancing a chain", () => {
  for (const engine of ["codex", "claude", "opencode"] as const) {
    for (const kind of ["empty-output", "invalid-json", "schema-validation"]) {
      assert.deepEqual(
        classifyAttemptFailure(evidence({ engine, failure: { kind, message: "bad answer" } })),
        { class: "output", rule: "output" }
      );
    }
  }
});

test("a Codex refusal is classified from the app-server's own code, outranking the harness error class", () => {
  // The same harness class (a terminal error notification surfaces as
  // AppServerRequestError) carries different provider codes; the code is
  // what the table reads. The codes are codex-cli 0.153.2's vocabulary.
  const cases: Array<[string, string]> = [
    ["usageLimitExceeded", "codex.usage-limit"],
    ["rateLimitExceeded", "codex.rate-limit"],
    ["serverOverloaded", "codex.server-overloaded"],
    ["httpConnectionFailed", "codex.provider-unreachable"],
    ["internalServerError", "codex.provider-internal-error"]
  ];
  for (const [code, rule] of cases) {
    assert.deepEqual(
      classifyAttemptFailure(
        evidence({
          engine: "codex",
          failure: { kind: "AppServerRequestError", message: `turn notification failed (${code})` },
          appServerDiagnostic: { code }
        })
      ),
      { class: "availability", rule }
    );
  }
});

test("a dead or unstartable Codex substrate is availability, a deadline is recognised but unclassified", () => {
  assert.deepEqual(
    classifyAttemptFailure(evidence({ engine: "codex", failure: { kind: "AppServerExitedError", message: "exited" } })),
    { class: "availability", rule: "codex.substrate-dead" }
  );
  assert.deepEqual(
    classifyAttemptFailure(evidence({ engine: "codex", failure: { kind: "AppServerStartupTimeoutError", message: "handshake" } })),
    { class: "availability", rule: "codex.substrate-unstartable" }
  );
  // The substrate never started or was gone when a thread was asked for:
  // the pre-spawn refusal the runtime spends no attempt on.
  assert.deepEqual(
    classifyAttemptFailure(
      evidence({ engine: "codex", failure: { kind: "CodexSubstrateRefusedError", message: "could not serve a thread" } })
    ),
    { class: "availability", rule: "codex.substrate-refused" }
  );
  assert.deepEqual(
    classifyAttemptFailure(evidence({ engine: "codex", failure: { kind: "TurnTimeoutError", message: "deadline" } })),
    { class: "unclassified", rule: "codex.deadline" }
  );
  assert.deepEqual(
    classifyAttemptFailure(evidence({ engine: "opencode", failure: { kind: "TurnTimeoutError", message: "deadline" } })),
    { class: "unclassified", rule: "opencode.deadline" }
  );
});

test("Codex schema rejection before generation is recognised without attributing a worker answer", () => {
  assert.deepEqual(
    classifyAttemptFailure(evidence({
      engine: "codex",
      failure: { kind: "CodexSchemaSubsetUnsupportedError", message: "arbitrary wording" },
      appServerDiagnostic: { code: -32602 }
    })),
    { class: "unclassified", rule: "codex.schema-rejected" }
  );
});

test("an unrecognised Codex diagnostic is unclassified with no rule, never defaulted into a class", () => {
  // A code the table has never seen — the shape a stale table produces when
  // Codex rewords its errors. `rule: null` is the archive's tell.
  assert.deepEqual(
    classifyAttemptFailure(
      evidence({
        engine: "codex",
        failure: { kind: "AppServerRequestError", message: "turn notification failed (somethingNew)" },
        appServerDiagnostic: { code: "somethingNew" }
      })
    ),
    { class: "unclassified", rule: null }
  );
});

test("a Claude API refusal is classified from the synthetic reply's status and code, not its prose", () => {
  // The observed 2026-08-30 shape: status 429, code rate_limit.
  assert.deepEqual(
    classifyAttemptFailure(
      evidence({
        engine: "claude",
        failure: { kind: "claude-worker-diagnostic", message: "API Error: Request rejected (429) · cooling down" },
        diagnostics: { apiError: { status: 429, code: "rate_limit" } }
      })
    ),
    { class: "availability", rule: "claude.rate-limit" }
  );
  // The overload family by status alone, when the code is one the table
  // does not carry.
  assert.deepEqual(
    classifyAttemptFailure(
      evidence({
        engine: "claude",
        failure: { kind: "claude-worker-diagnostic", message: "API Error: 529" },
        diagnostics: { apiError: { status: 529, code: null } }
      })
    ),
    { class: "availability", rule: "claude.overloaded" }
  );
  // A refusal the API made for a reason that is not availability — a bad
  // model name — is recognised and judged neither class.
  assert.deepEqual(
    classifyAttemptFailure(
      evidence({
        engine: "claude",
        failure: { kind: "claude-worker-diagnostic", message: "API Error: 400 unknown provider for model x" },
        diagnostics: { apiError: { status: 400, code: "invalid_request" } }
      })
    ),
    { class: "unclassified", rule: "claude.api-refusal" }
  );
  // A synthetic reply that carried no annotation at all: a client
  // diagnostic, judged neither class — and distinct from a stale table.
  assert.deepEqual(
    classifyAttemptFailure(
      evidence({ engine: "claude", failure: { kind: "claude-worker-diagnostic", message: "the session produced no model reply" } })
    ),
    { class: "unclassified", rule: "claude.client-diagnostic" }
  );
});

test("a Claude worker that could not start or never showed life is availability; a stall is not", () => {
  // A refused dispatch reaches the classifier as the thrown class name (the
  // engine rethrows it rather than returning a failed turn), like Codex's
  // thrown transport classes.
  assert.deepEqual(
    classifyAttemptFailure(
      evidence({ engine: "claude", failure: { kind: "ClaudeDispatchError", message: "Claude Code refused to dispatch" } })
    ),
    { class: "availability", rule: "claude.dispatch-refused" }
  );
  // The daemon took the dispatch but never registered the session: an
  // operational availability failure, spent and retried — not a refusal.
  assert.deepEqual(
    classifyAttemptFailure(
      evidence({ engine: "claude", failure: { kind: "claude-registration-timeout", message: "did not register" } })
    ),
    { class: "availability", rule: "claude.no-registration" }
  );
  assert.deepEqual(
    classifyAttemptFailure(evidence({ engine: "claude", failure: { kind: "claude-first-life-timeout", message: "no transcript" } })),
    { class: "availability", rule: "claude.no-first-life" }
  );
  assert.deepEqual(
    classifyAttemptFailure(evidence({ engine: "claude", failure: { kind: "claude-blocked", message: "blocked" } })),
    { class: "unclassified", rule: "claude.blocked" }
  );
});

test("the run's own settlement is never a refusal, whatever engine the turn was on", () => {
  for (const engine of ["codex", "claude", "opencode"] as const) {
    assert.deepEqual(
      classifyAttemptFailure(evidence({ engine, failure: { kind: "run-interrupted", message: "the run ended" } })),
      { class: "unclassified", rule: "run-settlement" }
    );
    assert.deepEqual(
      classifyAttemptFailure(evidence({ engine, failure: { kind: "EngineShutdownError", message: "shutting down" } })),
      { class: "unclassified", rule: "run-settlement" }
    );
  }
});
