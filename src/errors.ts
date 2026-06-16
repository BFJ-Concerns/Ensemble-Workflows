export class EnsembleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

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

export class MissingEngineError extends EnsembleError {
  constructor() {
    super("agent() requires an engine field: use engine: 'codex' or engine: 'claude'");
  }
}

export class UnknownEngineError extends EnsembleError {
  constructor(engine: unknown) {
    super(`Unknown agent engine ${JSON.stringify(engine)}; expected 'codex' or 'claude'`);
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
export class ClaudeWorktreeIsolationUnsupportedError extends EnsembleError {
  constructor() {
    super(
      "isolation:'worktree' is not supported on the Claude engine in v1: " +
        "Claude background sessions manage their own .claude/worktrees isolation. " +
        "Run the worker without isolation, or use engine:'codex' for git-worktree isolation."
    );
  }
}

/**
 * Thrown when a workflow asks for live web search on the Claude engine. Ensemble
 * only wires `webSearch` through Codex's app-server config in v1; silently
 * dropping it would make a script believe the worker searched when it did not.
 */
export class ClaudeWebSearchUnsupportedError extends EnsembleError {
  constructor() {
    super(
      "webSearch:true is not supported on the Claude engine in v1: " +
        "Ensemble only enables live web search through Codex's app-server config. " +
        "Run the worker without webSearch, or use engine:'codex' for live web search."
    );
  }
}

/**
 * Thrown when a workflow asks Claude to honour Ensemble's Codex app-server
 * sandbox option. Claude background workers are not launched through that
 * sandbox boundary, so the only honest v1 behaviour is to fail fast.
 */
export class ClaudeSandboxUnsupportedError extends EnsembleError {
  constructor(sandbox: string) {
    super(
      `sandbox:${JSON.stringify(sandbox)} is not supported on the Claude engine in v1: ` +
        "the sandbox option is a Codex app-server capability. " +
        "Run the worker without sandbox, or use engine:'codex' when you need Ensemble-managed sandboxing."
    );
  }
}

export class TurnTimeoutError extends EnsembleError {
  constructor(message: string) {
    super(message);
  }
}
