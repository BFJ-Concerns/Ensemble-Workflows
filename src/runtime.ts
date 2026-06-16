import { TokenBudget, tokenUsageEventFromParams } from "./budget.js";
import {
  AppServerBackpressureError,
  EmptyAgentOutputError,
  MissingEngineError,
  UnknownEngineError
} from "./errors.js";
import {
  ClaudeEngineAdapter,
  CodexEngineAdapter,
  EngineRegistry,
  createDefaultEngineRegistry,
  defaultCodexConcurrency
} from "./engines.js";
import { parseJsonFromText, validateJsonSchema } from "./schema.js";

import type {
  AgentOptions,
  Budget,
  EngineBudgetCeilings,
  EngineConcurrencyCaps,
  EngineName,
  JsonSchema,
  RuntimeEvent,
  RuntimeOptions,
  RuntimeTransport,
  TokenUsageEvent
} from "./types.js";
import type { EngineAdapter, EngineAttemptFailure, EngineInvocation, EngineTurnOptions } from "./engines.js";
import type { IsolatedWorktreeRecord, WorktreeIsolationManager } from "./worktree-isolation.js";

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export class EnsembleRuntime {
  readonly budget: TokenBudget;
  readonly worktrees: IsolatedWorktreeRecord[] = [];

  #engines: EngineRegistry;
  #defaultTurnTimeoutMs: number;
  #defaultMaxAttempts: number;
  #eventListeners = new Set<RuntimeEventListener>();
  #closed = false;

  constructor(options: {
    engines?: EngineRegistry;
    transport?: RuntimeTransport;
    concurrencyCaps?: EngineConcurrencyCaps;
    budgetCeilings?: EngineBudgetCeilings;
    defaultTurnTimeoutMs: number;
    defaultMaxAttempts: number;
    worktreeManager?: WorktreeIsolationManager;
  }) {
    this.budget = new TokenBudget(options.budgetCeilings);
    this.#defaultTurnTimeoutMs = options.defaultTurnTimeoutMs;
    this.#defaultMaxAttempts = options.defaultMaxAttempts;
    this.#engines =
      options.engines ??
      new EngineRegistry([
        new CodexEngineAdapter({
          transport: requireTransport(options.transport),
          concurrency: options.concurrencyCaps?.codex ?? defaultCodexConcurrency(),
          ...(options.worktreeManager !== undefined ? { worktreeManager: options.worktreeManager } : {}),
          onEvent: (event) => this.handleEngineEvent("codex", event),
          onWorktreeFinished: (record) => this.worktrees.push(record)
        }),
        new ClaudeEngineAdapter({
          ...(options.concurrencyCaps?.claude !== undefined ? { concurrency: options.concurrencyCaps.claude } : {})
        })
      ]);
  }

  static async create(options: RuntimeOptions = {}): Promise<EnsembleRuntime> {
    let runtime: EnsembleRuntime | null = null;
    const worktrees: IsolatedWorktreeRecord[] = [];
    const engines = await createDefaultEngineRegistry({
      cwd: options.cwd ?? process.cwd(),
      codexBin: options.codexBin ?? "codex",
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      clientName: options.clientName ?? "ensemble-workflows",
      clientVersion: options.clientVersion ?? "0.0.0",
      onEvent: (event) => {
        runtime?.handleEngineEvent("codex", event);
      },
      onClaudeEvent: (event) => {
        runtime?.handleEngineEvent("claude", event);
      },
      onWorktreeFinished: (record) => {
        if (runtime === null) {
          worktrees.push(record);
          return;
        }
        runtime.worktrees.push(record);
      },
      ...(options.concurrencyCaps !== undefined ? { concurrencyCaps: options.concurrencyCaps } : {})
    });

    runtime = new EnsembleRuntime({
      engines,
      ...(options.budgetCeilings !== undefined ? { budgetCeilings: options.budgetCeilings } : {}),
      defaultTurnTimeoutMs: options.defaultTurnTimeoutMs ?? 240_000,
      defaultMaxAttempts: options.defaultMaxAttempts ?? 3
    });
    runtime.worktrees.push(...worktrees);

    return runtime;
  }

  onEvent(listener: RuntimeEventListener): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  handleEngineEvent(engine: EngineName, event: RuntimeEvent): void {
    if (event.method === "thread/tokenUsage/updated") {
      const usageEvent = tokenUsageEventFromParams(event.params);
      if (usageEvent !== null) {
        this.budget.record(engine, usageEvent);
      }
    }

    this.#emitEvent(event);
  }

  handleTransportEvent(event: RuntimeEvent): void {
    this.handleEngineEvent("codex", event);
  }

  async agent(prompt: string, options: AgentOptions & { schema: JsonSchema }): Promise<unknown | null>;
  async agent(prompt: string, options: AgentOptions & { schema?: undefined }): Promise<string>;
  async agent(prompt: string, options: Partial<AgentOptions> = {}): Promise<string | unknown | null> {
    if (this.#closed) {
      throw new Error("EnsembleRuntime is closed");
    }

    const engine = this.#engineFor(options.engine);
    return engine.schedule(() => this.#runAgent(engine, prompt, options));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#engines.close();
  }

  async #runAgent(engine: EngineAdapter, prompt: string, options: Partial<AgentOptions>): Promise<string | unknown | null> {
    const invocation = engine.createInvocation(prompt, this.#engineTurnOptions(options));
    try {
      if (options.schema !== undefined) {
        return await this.#runSchemaAgent(engine.name, invocation, { ...options, schema: options.schema });
      }
      return await this.#runTextAgent(engine.name, invocation, options);
    } finally {
      await invocation.close?.();
    }
  }

  async #runTextAgent(engine: EngineName, invocation: EngineInvocation, options: Partial<AgentOptions>): Promise<string> {
    const maxAttempts = options.maxAttempts ?? this.#defaultMaxAttempts;
    let lastError: Error | null = null;
    let previousFailure: EngineAttemptFailure | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.budget.assertCanStart(engine);
      try {
        const result = await invocation.runAttempt({
          attempt,
          ...(previousFailure !== undefined ? { previousFailure } : {})
        });
        const text = result.text.trim();
        if (text.length > 0) {
          return text;
        }
        previousFailure = {
          kind: "empty-output",
          message: `agent returned empty text on attempt ${attempt}`
        };
        lastError = new EmptyAgentOutputError(previousFailure.message);
      } catch (error) {
        if (!isRetryableError(error) || attempt === maxAttempts) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new EmptyAgentOutputError("agent returned empty text");
  }

  async #runSchemaAgent(
    engine: EngineName,
    invocation: EngineInvocation,
    options: Partial<AgentOptions> & { schema: JsonSchema }
  ): Promise<unknown | null> {
    const maxAttempts = options.maxAttempts ?? this.#defaultMaxAttempts;
    let previousFailure: EngineAttemptFailure | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.budget.assertCanStart(engine);
      try {
        const result = await invocation.runAttempt({
          attempt,
          ...(previousFailure !== undefined ? { previousFailure } : {})
        });
        const parsed = parseJsonFromText(result.text);
        if (parsed === null) {
          previousFailure = {
            kind: "invalid-json",
            message: "agent output did not contain parseable JSON"
          };
          continue;
        }

        const validation = validateJsonSchema(parsed.value, options.schema);
        if (validation.ok) {
          return parsed.value;
        }
        previousFailure = {
          kind: "schema-validation",
          message: JSON.stringify(validation.errors ?? [])
        };
      } catch (error) {
        if (!isRetryableError(error) || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    return null;
  }

  #emitEvent(event: RuntimeEvent): void {
    for (const listener of this.#eventListeners) {
      listener(event);
    }
  }

  #engineFor(engine: unknown): EngineAdapter {
    if (engine === undefined) {
      throw new MissingEngineError();
    }
    if (engine !== "codex" && engine !== "claude") {
      throw new UnknownEngineError(engine);
    }
    const adapter = this.#engines.get(engine);
    if (adapter === undefined) {
      throw new UnknownEngineError(engine);
    }
    return adapter;
  }

  #engineTurnOptions(options: Partial<AgentOptions>): EngineTurnOptions {
    return {
      webSearch: options.webSearch ?? false,
      timeoutMs: options.timeoutMs ?? this.#defaultTurnTimeoutMs,
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.isolation !== undefined ? { isolation: options.isolation } : {}),
      ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {})
    };
  }
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<EnsembleRuntime> {
  return EnsembleRuntime.create(options);
}

export function defaultConcurrency(): number {
  return defaultCodexConcurrency();
}

export type { Budget, TokenUsageEvent };

function isRetryableError(error: unknown): boolean {
  return error instanceof AppServerBackpressureError;
}

function requireTransport(transport: RuntimeTransport | undefined): RuntimeTransport {
  if (transport === undefined) {
    throw new Error("EnsembleRuntime requires either engines or a Codex transport");
  }
  return transport;
}
