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

export class TurnTimeoutError extends EnsembleError {
  constructor(message: string) {
    super(message);
  }
}
