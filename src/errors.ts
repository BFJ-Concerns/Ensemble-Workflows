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

export class BudgetExceededError extends EnsembleError {
  constructor(total: number, spent: number) {
    super(`Token budget exhausted: spent ${spent} of ${total} tokens`);
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

export class TurnTimeoutError extends EnsembleError {
  constructor(message: string) {
    super(message);
  }
}
