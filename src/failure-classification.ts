import type { EngineName, JsonObject } from "./types.js";

/**
 * The three classes every failed attempt lands in, and what each one
 * means for the fallback chain:
 *
 * - `availability` — the engine refused or lost the worker before it
 *   answered: allowance exhausted, provider overload past its own retry,
 *   a substrate that is dead or cannot start. The one class that advances a
 *   chain, because the prompt was never judged.
 * - `output` — the worker answered badly: empty text, unparseable JSON, a
 *   schema miss. Retried in place on the same target, never chained: a bad
 *   answer is evidence about the prompt as much as the model.
 * - `unclassified` — neither. With a `rule` named, the classifier
 *   recognised the failure and judged it neither class (a turn deadline, a
 *   client diagnostic about a bad model name). With `rule: null`, nothing
 *   in the table matched: the engine's diagnostic is recorded beside it
 *   untouched, and a consumer reading `null` here is reading a table that
 *   has gone stale as the engine reworded its errors — visible in the
 *   archive, never defaulted into a class.
 */
export type FailureClass = "availability" | "output" | "unclassified";

export interface FailureClassification {
  class: FailureClass;
  /** The classifier rule that matched, or null when none did. */
  rule: string | null;
}

/**
 * What one failed attempt gives the classifier: the failure the attempt
 * recorded (an engine attempt-failure kind, or a thrown error's class name
 * and message), the Codex app-server diagnostic where one rode the error,
 * and the engine-specific diagnostics the attempt result carried.
 */
export interface AttemptFailureEvidence {
  engine: EngineName;
  failure: { kind: string; message: string };
  appServerDiagnostic: { code: number | string | null } | null;
  diagnostics: JsonObject | undefined;
}

const OUTPUT_FAILURE_KINDS = new Set(["empty-output", "invalid-json", "schema-validation"]);

/**
 * Codex names its terminal conditions in the `codexErrorInfo` field of the
 * turn's error notification (the app-server diagnostic's `code`). The names
 * are the app-server's own vocabulary, read from codex-cli 0.153.2, and
 * the table lists only those whose meaning is settled; an unlisted name is
 * left `unclassified` with `rule: null` rather than guessed.
 */
const CODEX_AVAILABILITY_CODES = new Map<string, string>([
  ["usageLimitExceeded", "codex.usage-limit"],
  ["rateLimitExceeded", "codex.rate-limit"],
  ["serverOverloaded", "codex.server-overloaded"],
  ["httpConnectionFailed", "codex.provider-unreachable"],
  ["responseStreamConnectionFailed", "codex.provider-unreachable"],
  ["internalServerError", "codex.provider-internal-error"]
]);

/** Thrown error classes (the attempt's `failure.kind`) whose meaning is fixed by this harness. */
const CODEX_ERROR_CLASSES = new Map<string, FailureClassification>([
  // The substrate died or never came up: the worker was lost before answering.
  ["AppServerExitedError", { class: "availability", rule: "codex.substrate-dead" }],
  ["AppServerStartupTimeoutError", { class: "availability", rule: "codex.substrate-unstartable" }],
  // The server refused to take more load (JSON-RPC -32001).
  ["AppServerBackpressureError", { class: "availability", rule: "codex.backpressure" }],
  // The provider promised a retry and then went silent past the bound.
  ["AppServerRetryPromiseBrokenError", { class: "availability", rule: "codex.retry-promise-broken" }],
  // Codex refused the schema before generation: the shape, not the engine.
  ["CodexSchemaSubsetUnsupportedError", { class: "output", rule: "codex.schema-rejected" }],
  // A started turn that never produced output before the transport's bound.
  ["AppServerFirstOutputTimeoutError", { class: "unclassified", rule: "codex.first-output-deadline" }],
  ["TurnTimeoutError", { class: "unclassified", rule: "codex.deadline" }]
]);

/**
 * Claude Code writes a synthetic assistant entry when the API refused the
 * request, carrying the HTTP status and the API's own error code (observed
 * 2026-08-30: `apiErrorStatus: 429`, `error: "rate_limit"`). The engine
 * surfaces both as attempt diagnostics; this table reads them.
 */
const CLAUDE_AVAILABILITY_STATUSES = new Map<number, string>([
  [429, "claude.rate-limit"],
  [503, "claude.service-unavailable"],
  [529, "claude.overloaded"]
]);
const CLAUDE_AVAILABILITY_CODES = new Map<string, string>([
  ["rate_limit", "claude.rate-limit"],
  ["rate_limit_error", "claude.rate-limit"],
  ["overloaded_error", "claude.overloaded"]
]);

const CLAUDE_FAILURE_KINDS = new Map<string, FailureClassification>([
  // Claude Code refused to start the worker at all. The engine throws
  // it rather than returning a failed turn, so the kind is the thrown class
  // name, as the Codex rows are keyed; the runtime spends no attempt on it —
  // it advances the chain or propagates as a pre-spawn refusal.
  ["ClaudeDispatchError", { class: "availability", rule: "claude.dispatch-refused" }],
  // The session registered but never produced a transcript: a dead worker.
  ["claude-first-life-timeout", { class: "availability", rule: "claude.no-first-life" }],
  ["claude-poll-timeout", { class: "unclassified", rule: "claude.deadline" }],
  ["claude-blocked", { class: "unclassified", rule: "claude.blocked" }],
  ["claude-valve-error", { class: "unclassified", rule: "claude.valve" }],
  ["claude-transcript-error", { class: "unclassified", rule: "claude.transcript" }],
  ["claude-collection-error", { class: "unclassified", rule: "claude.collection" }]
]);

/**
 * Classify one failed attempt from the evidence its record carries. Pure
 * and total: every input yields a classification, and only a diagnostic
 * the table does not recognise yields `rule: null`.
 */
export function classifyAttemptFailure(evidence: AttemptFailureEvidence): FailureClassification {
  const { kind } = evidence.failure;
  if (OUTPUT_FAILURE_KINDS.has(kind)) {
    return { class: "output", rule: "output" };
  }
  // The run ended under the worker: the harness settled it, the engine did
  // not fail, so no engine table has a say.
  if (kind.startsWith("run-")) {
    return { class: "unclassified", rule: "run-settlement" };
  }
  if (kind === "EngineShutdownError") {
    return { class: "unclassified", rule: "run-settlement" };
  }
  switch (evidence.engine) {
    case "codex":
      return classifyCodexFailure(kind, evidence.appServerDiagnostic);
    case "claude":
      return classifyClaudeFailure(kind, evidence.diagnostics);
    case "opencode":
      return kind === "opencode-run-error"
        ? { class: "unclassified", rule: "opencode.run-error" }
        : { class: "unclassified", rule: null };
  }
}

function classifyCodexFailure(
  kind: string,
  diagnostic: { code: number | string | null } | null
): FailureClassification {
  // The app-server's own code outranks the harness's error class: the
  // class says how the failure reached us, the code says what the provider
  // reported, and the provider's word is the classification's evidence.
  const code = diagnostic?.code;
  if (typeof code === "string") {
    const rule = CODEX_AVAILABILITY_CODES.get(code);
    if (rule !== undefined) {
      return { class: "availability", rule };
    }
  }
  return CODEX_ERROR_CLASSES.get(kind) ?? { class: "unclassified", rule: null };
}

function classifyClaudeFailure(kind: string, diagnostics: JsonObject | undefined): FailureClassification {
  if (kind === "claude-worker-diagnostic") {
    const apiError = claudeApiErrorOf(diagnostics);
    if (apiError !== null) {
      const byStatus = apiError.status === null ? undefined : CLAUDE_AVAILABILITY_STATUSES.get(apiError.status);
      const byCode = apiError.code === null ? undefined : CLAUDE_AVAILABILITY_CODES.get(apiError.code);
      const rule = byStatus ?? byCode;
      if (rule !== undefined) {
        return { class: "availability", rule };
      }
      // The API answered with a status the table does not read as
      // availability (a 400 for a bad model name, say): recognised as a
      // client-side refusal, judged neither class.
      return { class: "unclassified", rule: "claude.api-refusal" };
    }
    return { class: "unclassified", rule: "claude.client-diagnostic" };
  }
  return CLAUDE_FAILURE_KINDS.get(kind) ?? { class: "unclassified", rule: null };
}

/** The `{ status, code }` the Claude engine records under `diagnostics.apiError`, when the transcript carried one. */
function claudeApiErrorOf(diagnostics: JsonObject | undefined): { status: number | null; code: string | null } | null {
  const apiError = diagnostics?.apiError;
  if (typeof apiError !== "object" || apiError === null || Array.isArray(apiError)) {
    return null;
  }
  const record = apiError as Record<string, unknown>;
  return {
    status: typeof record.status === "number" ? record.status : null,
    code: typeof record.code === "string" ? record.code : null
  };
}
