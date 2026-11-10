import assert from "node:assert/strict";
import test from "node:test";

import { appServerErrorFromPayload } from "../../src/app-server.js";
import { appServerDiagnosticOf, CodexSchemaSubsetUnsupportedError } from "../../src/errors.js";
import { classifyAttemptFailure, diagnoseAttemptFailure } from "../../src/failure-classification.js";

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

test("a Codex turn that exhausted Codex's own retries is classified by the provider status it forwarded", () => {
  // The archived shape from the 2026-10-26 rate-limit incident: Codex spent
  // its retries on 429s and ended the turn with an object-shaped
  // codexErrorInfo carrying the last status.
  const exhausted = (httpStatusCode: number | null) =>
    classifyAttemptFailure(
      evidence({
        engine: "codex",
        failure: {
          kind: "AppServerRequestError",
          message:
            'turn notification failed (responseTooManyFailedAttempts): {"responseTooManyFailedAttempts":{"httpStatusCode":429}}: exceeded retry limit, last status: 429 Too Many Requests'
        },
        appServerDiagnostic: { code: "responseTooManyFailedAttempts", httpStatusCode }
      })
    );
  assert.deepEqual(exhausted(429), { class: "availability", rule: "codex.rate-limit" });
  assert.deepEqual(exhausted(500), { class: "availability", rule: "codex.provider-internal-error" });
  assert.deepEqual(exhausted(503), { class: "availability", rule: "codex.provider-internal-error" });
  // The message still names a 429; only the structured status is read.
  assert.deepEqual(exhausted(400), { class: "unclassified", rule: null });
  assert.deepEqual(exhausted(null), { class: "unclassified", rule: null });
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

test("Codex schema rejections forwarded as typed invalid requests keep their specific rule", () => {
  const body = JSON.stringify({ error: {
    message: "Invalid schema for response_format 'x'",
    type: "invalid_request_error",
    param: "text.format.schema",
    code: "invalid_json_schema"
  } });
  const error = appServerErrorFromPayload("turn notification", {
    code: "other",
    message: body,
    data: { error: { message: body, codexErrorInfo: "other" } }
  });
  assert.ok(error instanceof CodexSchemaSubsetUnsupportedError);
  assert.deepEqual(classifyAttemptFailure(evidence({
    engine: "codex",
    failure: { kind: error.constructor.name, message: error.message },
    appServerDiagnostic: appServerDiagnosticOf(error)
  })), { class: "unclassified", rule: "codex.schema-rejected" });
});

test("Codex recognises a typed provider request rejection, never the catch-all code or prose alone", () => {
  const classify = (payload: string | null, code = "other") => classifyAttemptFailure(evidence({
    engine: "codex",
    failure: { kind: "AppServerRequestError", message: "invalid_request_error: prompt rejected" },
    appServerDiagnostic: { code, payload }
  }));
  const notification = (message: unknown) => JSON.stringify({ error: { message } });
  const provider = JSON.stringify({ error: { type: "invalid_request_error", message: "arbitrary wording" } });
  assert.deepEqual(classify(notification(provider)), { class: "unclassified", rule: "codex.provider-request-rejected" });
  for (const payload of [null, "not JSON", "null", "[]", "{}", notification(null), notification("prompt rejected"),
    notification("null"), notification("[]"), notification(JSON.stringify({ error: { type: "unknown_error" } }))]) {
    assert.deepEqual(classify(payload), { class: "unclassified", rule: null });
  }
  assert.deepEqual(classify(notification(provider), "somethingNew"), { class: "unclassified", rule: null });
  assert.deepEqual(classify(notification(provider), "serverOverloaded"), { class: "availability", rule: "codex.server-overloaded" });
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

test("run settlement and a local engine shutdown have distinct non-refusal rules", () => {
  for (const engine of ["codex", "claude", "opencode"] as const) {
    assert.deepEqual(
      classifyAttemptFailure(evidence({ engine, failure: { kind: "run-interrupted", message: "the run ended" } })),
      { class: "unclassified", rule: "run-settlement" }
    );
    assert.deepEqual(
      classifyAttemptFailure(evidence({ engine, failure: { kind: "EngineShutdownError", message: "shutting down" } })),
      { class: "unclassified", rule: "engine-shutdown" }
    );
  }
});

test("credential diagnoses preserve engine evidence and name each engine's sign-in step", () => {
  for (const [engine, remedy] of [["codex", "codex login"], ["claude", "claude auth login"], ["opencode", "opencode auth login"]] as const) {
    const input = evidence({ engine, failure: { kind: "engine-error", message: "HTTP 401: invalid credentials" } });
    const failure = diagnoseAttemptFailure(input);
    assert.equal(failure.kind, "authentication-failure");
    assert.ok(failure.message.includes(remedy));
    assert.ok(failure.message.includes(input.failure.message));
    assert.deepEqual(classifyAttemptFailure({ ...input, failure }), { class: "unclassified", rule: `${engine}.authentication-failure` });
  }
  const input = evidence({ engine: "codex", failure: { kind: "engine-error", message: "gateway mentions invalid_api_key" }, appServerDiagnostic: { code: "serverOverloaded", httpStatusCode: 503 } });
  assert.deepEqual(diagnoseAttemptFailure(input), input.failure);
  assert.equal(diagnoseAttemptFailure(evidence({ engine: "claude", failure: { kind: "claude-worker-diagnostic", message: "denied" }, diagnostics: { apiError: { status: 401, code: "authentication_error" } } })).kind, "authentication-failure");
});

test("credential words do not override an established availability diagnosis", () => {
  const cases: Array<[AttemptFailureEvidence, string]> = [
    [evidence({ engine: "codex", failure: { kind: "AppServerExitedError", message: "Recent stderr: 401 Unauthorized" } }), "codex.substrate-dead"],
    [evidence({ engine: "codex", failure: { kind: "CodexSubstrateRefusedError", message: "Recent stderr: HTTP 401" } }), "codex.substrate-refused"],
    [evidence({ engine: "claude", failure: { kind: "ClaudeDispatchError", message: "authentication failed" } }), "claude.dispatch-refused"],
    [evidence({ engine: "claude", failure: { kind: "claude-registration-timeout", message: "invalid_api_key" } }), "claude.no-registration"],
    [evidence({ engine: "codex", failure: { kind: "AppServerRequestError", message: "HTTP 401" }, appServerDiagnostic: { code: "httpConnectionFailed" } }), "codex.provider-unreachable"]
  ];
  for (const [input, rule] of cases) {
    const failure = diagnoseAttemptFailure(input);
    assert.deepEqual(failure, input.failure);
    assert.deepEqual(classifyAttemptFailure({ ...input, failure }), { class: "availability", rule });
  }
});

test("a structured provider 401 outranks the retry-promise availability wrapper", () => {
  for (const status of [401, 429, 503, null]) {
    const input = evidence({
      engine: "codex",
      failure: { kind: "AppServerRetryPromiseBrokenError", message: "Reconnecting... unexpected status 401 Unauthorized" },
      appServerDiagnostic: { code: "responseStreamDisconnected", httpStatusCode: status }
    });
    const failure = diagnoseAttemptFailure(input);
    if (status === 401) {
      assert.equal(failure.kind, "authentication-failure");
      assert.match(failure.message, /codex login/);
      assert.ok(failure.message.includes(input.failure.message));
      assert.deepEqual(classifyAttemptFailure({ ...input, failure }), { class: "unclassified", rule: "codex.authentication-failure" });
    } else {
      assert.deepEqual(failure, input.failure);
      assert.equal(classifyAttemptFailure({ ...input, failure }).class, "availability");
    }
  }
});
