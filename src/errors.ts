export class CodexWorkflowsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AppServerExitedError extends CodexWorkflowsError {}

export class AppServerRequestError extends CodexWorkflowsError {
  readonly code: number | undefined;
  readonly data?: unknown;

  constructor(method: string, error: { code: number | undefined; message: string | undefined; data?: unknown }) {
    super(`${method} failed: ${error.message ?? "unknown app-server error"}`);
    this.code = error.code;
    this.data = error.data;
  }
}

export class AppServerBackpressureError extends AppServerRequestError {}

export class BudgetExceededError extends CodexWorkflowsError {
  constructor(total: number, spent: number) {
    super(`Token budget exhausted: spent ${spent} of ${total} tokens`);
  }
}

export class EmptyAgentOutputError extends CodexWorkflowsError {}

export class TurnTimeoutError extends CodexWorkflowsError {
  constructor(message: string) {
    super(message);
  }
}
