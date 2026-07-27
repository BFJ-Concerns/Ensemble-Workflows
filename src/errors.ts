export class EnsembleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A workflow-authored agent option that the runtime cannot honour. */
export class AgentOptionRejectedError extends EnsembleError {}

export class AppServerExitedError extends EnsembleError {}

export class AppServerRequestError extends EnsembleError {
  readonly code: number | undefined;
  readonly data?: unknown;

  constructor(method: string, error: { code: number | undefined; message: string | undefined; data?: unknown }) {
    super(`${method} failed: ${error.message ?? "unknown app-server error"}`);
    this.code = error.code;
    this.data = error.data;
  }
}

export class AppServerBackpressureError extends AppServerRequestError {}

export class AppServerStartupTimeoutError extends EnsembleError {
  constructor(timeoutMs: number) {
    super(`codex app-server initialize handshake timed out after ${timeoutMs}ms`);
  }
}

/**
 * Codex validates `outputSchema` against its own accepted subset before
 * generation. This is not the same failure as an agent returning JSON that does
 * not satisfy the user's schema, so keep it loud and distinguishable.
 */
export class CodexSchemaSubsetUnsupportedError extends EnsembleError {
  readonly code: number | undefined;
  readonly data?: unknown;

  constructor(error: { code: number | undefined; message: string | undefined; data?: unknown }) {
    super(
      "Codex rejected outputSchema before generation: the schema is outside Codex's accepted subset or malformed. " +
        "Use a schema supported by Codex outputSchema, or run the workflow on an engine that validates the full JSON Schema client-side.",
      { cause: error }
    );
    this.code = error.code;
    this.data = error.data;
  }
}

export class BudgetExceededError extends EnsembleError {
  constructor(engine: string, total: number, spent: number) {
    super(`Token budget exhausted for ${engine}: spent ${spent} of ${total} tokens`);
  }
}

export class MissingEngineError extends AgentOptionRejectedError {
  constructor() {
    super("agent() requires an engine field: use engine: 'codex', engine: 'claude', or engine: 'opencode'");
  }
}

export class UnknownEngineError extends AgentOptionRejectedError {
  constructor(engine: unknown) {
    super(`Unknown agent engine ${JSON.stringify(engine)}; expected 'codex', 'claude', or 'opencode'`);
  }
}

export class EngineNotImplementedError extends EnsembleError {}

export class EmptyAgentOutputError extends EnsembleError {}

/**
 * Base for *operational* failures of a Claude background worker — dispatch
 * died, polling timed out, the worker stalled past the recovery bound, the
 * valve couldn't inject, the transcript couldn't be read. The Claude engine
 * catches these and degrades to a graceful empty turn (→ the shared loop turns
 * that into `null` for a schema agent, or the empty-output error after the
 * bounded attempts for a text agent). It never lets one hang the run. A failure
 * that is *not* a `ClaudeWorkerError` is a genuine bug and propagates.
 */
export class ClaudeWorkerError extends EnsembleError {}

export class ClaudeDispatchError extends ClaudeWorkerError {}

export class ClaudePollTimeoutError extends ClaudeWorkerError {}

/** The background session registered but never produced a transcript at all. */
export class ClaudeFirstLifeTimeoutError extends ClaudeWorkerError {}

export class ClaudeBlockedError extends ClaudeWorkerError {}

export class ClaudeValveError extends ClaudeWorkerError {}

export class ClaudeTranscriptError extends ClaudeWorkerError {}

/**
 * Thrown when a workflow asks for `isolation:'worktree'` on the Claude engine.
 * Claude background sessions manage their own `.claude/worktrees/` isolation, so
 * the Codex git-worktree manager does not map onto them; v1 rejects the combination
 * outright rather than silently ignoring it or half-wiring a foreign mechanism.
 * This is a contract error, not an operational one — it fails fast, never retries.
 */
export class ClaudeWorktreeIsolationUnsupportedError extends AgentOptionRejectedError {
  constructor() {
    super(
      "isolation:'worktree' is not supported on the Claude engine in v1: " +
        "Claude background sessions manage their own .claude/worktrees isolation. " +
        "Run the worker without isolation, or use engine:'codex' for git-worktree isolation."
    );
  }
}

export class OpenCodeModelRequiredError extends AgentOptionRejectedError {
  constructor(registered: readonly string[]) {
    super(
      `agent({ engine:'opencode' }) requires a model from the curated opencode registry; expected one of ${registered
        .map((name) => JSON.stringify(name))
        .join(", ")}`
    );
  }
}

export class OpenCodeModelNotRegisteredError extends AgentOptionRejectedError {
  constructor(model: string, registered: readonly string[]) {
    super(
      `OpenCode model ${JSON.stringify(model)} is not registered; expected one of ${registered.map((name) => JSON.stringify(name)).join(", ")}`
    );
  }
}

export class OpenCodeWorkerError extends EnsembleError {}

export class OpenCodeRunError extends OpenCodeWorkerError {
  constructor(message: string) {
    super(message);
  }
}

export class OpenCodeWorktreeIsolationUnsupportedError extends AgentOptionRejectedError {
  constructor() {
    super(
      "isolation:'worktree' is not supported on the opencode engine in v1: " +
        "Ensemble only manages git-worktree isolation for Codex workers. " +
        "Run the worker without isolation, or use engine:'codex' for git-worktree isolation."
    );
  }
}

export class TurnTimeoutError extends EnsembleError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when a workflow asks a non-Claude engine to honour `fallbackModel`.
 * Only the Claude CLI exposes a fallback-model switch; silently dropping the
 * option would let a script believe its degradation policy was in force.
 */
export class FallbackModelUnsupportedError extends AgentOptionRejectedError {
  constructor(engine: string) {
    super(
      `fallbackModel is not supported on the ${engine} engine in v1: ` +
        "only the Claude engine exposes a fallback-model switch. " +
        "Remove fallbackModel, or use engine:'claude' for declared degradation."
    );
  }
}

export class RemovedAgentOptionError extends AgentOptionRejectedError {
  constructor(option: string) {
    super(
      `agent() option ${JSON.stringify(option)} was removed: all workers now run unrestricted with filesystem and network access. ` +
        `Remove ${JSON.stringify(option)} from this call.`
    );
  }
}

export class UnrecognisedAgentOptionError extends AgentOptionRejectedError {
  constructor(option: string, recognised: readonly string[]) {
    super(
      `Unrecognised agent() option ${JSON.stringify(option)}; expected one of ${recognised
        .map((name) => JSON.stringify(name))
        .join(", ")}`
    );
  }
}

/**
 * Thrown by `agent()` before any worker spawns when the requested schema does
 * not compile as JSON Schema. Failing fast here beats paying for a full turn
 * only to discover the schema at validation time.
 */
export class InvalidAgentSchemaError extends EnsembleError {
  constructor(message: string, options?: ErrorOptions) {
    super(`agent schema does not compile as JSON Schema: ${message}`, options);
  }
}
