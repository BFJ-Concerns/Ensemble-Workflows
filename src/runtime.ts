import { cpus } from "node:os";

import { CodexAppServerTransport } from "./app-server.js";
import { TokenBudget, tokenUsageEventFromParams } from "./budget.js";
import { AppServerBackpressureError, EmptyAgentOutputError } from "./errors.js";
import { Scheduler } from "./scheduler.js";
import { parseJsonFromText, validateJsonSchema } from "./schema.js";

import type {
  AgentOptions,
  Budget,
  JsonSchema,
  RuntimeEvent,
  RuntimeOptions,
  RuntimeTransport,
  SandboxMode,
  TokenUsageEvent
} from "./types.js";

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export class CodexRuntime {
  readonly budget: TokenBudget;
  readonly scheduler: Scheduler;

  #transport: RuntimeTransport;
  #defaultTurnTimeoutMs: number;
  #defaultMaxAttempts: number;
  #eventListeners = new Set<RuntimeEventListener>();
  #closed = false;

  constructor(options: {
    transport: RuntimeTransport;
    concurrency: number;
    budgetTotal?: number | null;
    defaultTurnTimeoutMs: number;
    defaultMaxAttempts: number;
  }) {
    this.#transport = options.transport;
    this.scheduler = new Scheduler(options.concurrency);
    this.budget = new TokenBudget(options.budgetTotal ?? null);
    this.#defaultTurnTimeoutMs = options.defaultTurnTimeoutMs;
    this.#defaultMaxAttempts = options.defaultMaxAttempts;
  }

  static async create(options: RuntimeOptions = {}): Promise<CodexRuntime> {
    let runtime: CodexRuntime | null = null;
    const transport = await CodexAppServerTransport.start({
      cwd: options.cwd ?? process.cwd(),
      codexBin: options.codexBin ?? "codex",
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      clientName: options.clientName ?? "codex-workflows",
      clientVersion: options.clientVersion ?? "0.0.0",
      onEvent: (event) => {
        runtime?.handleTransportEvent(event);
      }
    });

    runtime = new CodexRuntime({
      transport,
      concurrency: options.concurrency ?? defaultConcurrency(),
      budgetTotal: options.budgetTotal ?? null,
      defaultTurnTimeoutMs: options.defaultTurnTimeoutMs ?? 240_000,
      defaultMaxAttempts: options.defaultMaxAttempts ?? 3
    });

    return runtime;
  }

  onEvent(listener: RuntimeEventListener): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  handleTransportEvent(event: RuntimeEvent): void {
    if (event.method === "thread/tokenUsage/updated") {
      const usageEvent = tokenUsageEventFromParams(event.params);
      if (usageEvent !== null) {
        this.budget.record(usageEvent);
      }
    }

    for (const listener of this.#eventListeners) {
      listener(event);
    }
  }

  async agent(prompt: string, options: AgentOptions & { schema: JsonSchema }): Promise<unknown | null>;
  async agent(prompt: string, options?: AgentOptions & { schema?: undefined }): Promise<string>;
  async agent(prompt: string, options: AgentOptions = {}): Promise<string | unknown | null> {
    if (this.#closed) {
      throw new Error("CodexRuntime is closed");
    }

    return this.scheduler.schedule(() => this.#runAgent(prompt, options));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#transport.close();
  }

  #runAgent(prompt: string, options: AgentOptions): Promise<string | unknown | null> {
    if (options.schema !== undefined) {
      return this.#runSchemaAgent(prompt, { ...options, schema: options.schema });
    }
    return this.#runTextAgent(prompt, options);
  }

  async #runTextAgent(prompt: string, options: AgentOptions): Promise<string> {
    const maxAttempts = options.maxAttempts ?? this.#defaultMaxAttempts;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.budget.assertCanStart();
      try {
        const result = await this.#runSingleTurn(prompt, options);
        const text = result.text.trim();
        if (text.length > 0) {
          return text;
        }
        lastError = new EmptyAgentOutputError(`agent returned empty text on attempt ${attempt}`);
      } catch (error) {
        if (!isRetryableError(error) || attempt === maxAttempts) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new EmptyAgentOutputError("agent returned empty text");
  }

  async #runSchemaAgent(prompt: string, options: AgentOptions & { schema: JsonSchema }): Promise<unknown | null> {
    const maxAttempts = options.maxAttempts ?? this.#defaultMaxAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.budget.assertCanStart();
      try {
        const result = await this.#runSingleTurn(prompt, options);
        const parsed = parseJsonFromText(result.text);
        if (parsed === null) {
          continue;
        }

        const validation = validateJsonSchema(parsed.value, options.schema);
        if (validation.ok) {
          return parsed.value;
        }
      } catch (error) {
        if (!isRetryableError(error) || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    return null;
  }

  async #runSingleTurn(prompt: string, options: AgentOptions) {
    const threadId = await this.#transport.openThread({
      webSearch: options.webSearch ?? false,
      sandbox: normaliseSandbox(options.sandbox)
    });

    const turnOptions = {
      timeoutMs: options.timeoutMs ?? this.#defaultTurnTimeoutMs
    } satisfies { timeoutMs: number };
    return this.#transport.runTurn(threadId, prompt, {
      ...turnOptions,
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {})
    });
  }
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<CodexRuntime> {
  return CodexRuntime.create(options);
}

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}

export type { Budget, TokenUsageEvent };

function normaliseSandbox(sandbox: SandboxMode | undefined): SandboxMode {
  return sandbox ?? "read-only";
}

function isRetryableError(error: unknown): boolean {
  return error instanceof AppServerBackpressureError;
}
