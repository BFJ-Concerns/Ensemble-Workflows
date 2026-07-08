import { randomUUID } from "node:crypto";

import { TokenBudget, tokenUsageEventFromParams } from "./budget.js";
import {
  AppServerBackpressureError,
  EmptyAgentOutputError,
  MissingEngineError,
  UnknownEngineError
} from "./errors.js";
import { RunProgress } from "./progress.js";
import {
  ClaudeEngineAdapter,
  CodexEngineAdapter,
  EngineRegistry,
  OpenCodeEngineAdapter,
  createDefaultEngineRegistry,
  defaultCodexConcurrency
} from "./engines.js";
import { assertCompilableSchema, parseJsonFromText, validateJsonSchema } from "./schema.js";

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
  TurnResult,
  TokenUsageEvent
} from "./types.js";
import type { EngineAdapter, EngineAttemptFailure, EngineInvocation, EngineTurnOptions } from "./engines.js";
import type { RunRecordWriter, RuntimeAgentAttemptRecord, RuntimeAgentRecord } from "./run-record.js";
import type { IsolatedWorktreeRecord, WorktreeIsolationManager } from "./worktree-isolation.js";

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * A worker that finished successfully, recorded in completion order. The CLI
 * emits these as a best-effort partial result when a stopped run exits before
 * the script returns — turning interruption from total loss into recovered work.
 */
export interface CompletedAgentOutput {
  id: number;
  engine: EngineName;
  label: string | null;
  phase: string | null;
  output: unknown;
}

export class EnsembleRuntime {
  readonly budget: TokenBudget;
  readonly worktrees: IsolatedWorktreeRecord[] = [];
  /** Live, in-memory view of what the run is doing. Always maintained; persisting it is opt-in at the CLI. */
  readonly progress: RunProgress;

  #engines: EngineRegistry;
  #defaultTurnTimeoutMs: number | undefined;
  #defaultMaxAttempts: number;
  #eventListeners = new Set<RuntimeEventListener>();
  #completed: CompletedAgentOutput[] = [];
  #runRecorder: RunRecordWriter | null = null;
  #closed = false;

  constructor(options: {
    engines?: EngineRegistry;
    transport?: RuntimeTransport;
    concurrencyCaps?: EngineConcurrencyCaps;
    budgetCeilings?: EngineBudgetCeilings;
    defaultTurnTimeoutMs?: number;
    defaultMaxAttempts: number;
    worktreeManager?: WorktreeIsolationManager;
    runId?: string;
    now?: () => number;
  }) {
    this.budget = new TokenBudget(options.budgetCeilings);
    this.progress = new RunProgress({
      runId: options.runId ?? randomUUID(),
      budget: this.budget,
      ...(options.now !== undefined ? { now: options.now } : {})
    });
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
        }),
        new OpenCodeEngineAdapter({
          ...(options.concurrencyCaps?.opencode !== undefined ? { concurrency: options.concurrencyCaps.opencode } : {})
        })
      ]);
    this.#registerEngineCaps();
  }

  static async create(options: RuntimeOptions = {}): Promise<EnsembleRuntime> {
    let runtime: EnsembleRuntime | null = null;
    const worktrees: IsolatedWorktreeRecord[] = [];
    const engines = await createDefaultEngineRegistry({
      cwd: options.cwd ?? process.cwd(),
      codexBin: options.codexBin ?? "codex",
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      startupHandshakeTimeoutMs: options.startupHandshakeTimeoutMs ?? 120_000,
      clientName: options.clientName ?? "ensemble-workflows",
      clientVersion: options.clientVersion ?? "0.0.0",
      onEvent: (event) => {
        runtime?.handleEngineEvent("codex", event);
      },
      onClaudeEvent: (event) => {
        runtime?.handleEngineEvent("claude", event);
      },
      onOpenCodeEvent: (event) => {
        runtime?.handleEngineEvent("opencode", event);
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
      ...(options.defaultTurnTimeoutMs !== undefined ? { defaultTurnTimeoutMs: options.defaultTurnTimeoutMs } : {}),
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

  setRunRecorder(recorder: RunRecordWriter | null): void {
    this.#runRecorder = recorder;
  }

  /** Sets the run's current phase. Driven by the script's `phase()` hook. */
  notePhase(title: string): void {
    this.progress.setPhase(title);
  }

  handleEngineEvent(engine: EngineName, event: RuntimeEvent): void {
    if (event.method === "thread/tokenUsage/updated") {
      const usageEvent = tokenUsageEventFromParams(event.params);
      if (usageEvent !== null) {
        this.budget.record(engine, usageEvent);
        // Refresh the live view so its spend figures track each turn's usage.
        this.progress.markChanged();
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
    if (options.schema !== undefined) {
      // A malformed schema would otherwise surface only after the first paid turn.
      assertCompilableSchema(options.schema);
    }

    const engine = this.#engineFor(options.engine);
    const agentId = this.progress.queueAgent({
      engine: engine.name,
      label: options.label ?? null,
      phase: options.phase ?? null
    });
    if (engine.name === "claude" && options.model === undefined) {
      // Unpinned Claude burns the ambient default model silently; make it visible.
      this.#emitEvent({
        method: "claude/unpinnedModel",
        params: { agentId, label: options.label ?? null },
        receivedAt: Date.now()
      });
    }
    const agentRecord = this.#newAgentRecord(agentId, engine.name, options);
    return engine.schedule(async () => {
      this.progress.startAgent(agentId);
      try {
        const result = await this.#runAgent(engine, prompt, options, agentId, agentRecord);
        // A schema agent that exhausts its retries returns null: a graceful failure.
        const outcome = result === null ? "failed" : "done";
        this.progress.settleAgent(agentId, outcome);
        agentRecord.status = outcome === "done" ? "complete" : "failed";
        agentRecord.rawOutput = lastRawOutput(agentRecord);
        agentRecord.validatedOutput = result;
        // Retain successful outputs so a timeout can surface completed work. A
        // null result carries nothing recoverable, so it is not recorded.
        if (outcome === "done") {
          this.#completed.push({
            id: agentId,
            engine: engine.name,
            label: options.label ?? null,
            phase: options.phase ?? null,
            output: result
          });
        }
        await this.#recordAgentSafely(agentRecord);
        return result;
      } catch (error) {
        this.progress.settleAgent(agentId, "failed");
        agentRecord.status = "failed";
        agentRecord.rawOutput = lastRawOutput(agentRecord);
        agentRecord.validatedOutput = null;
        await this.#recordAgentSafely(agentRecord);
        throw error;
      }
    });
  }

  /**
   * The archive is observability: a bookkeeping failure must not reject (or,
   * on the success path, falsify) the agent whose work it records. Failures
   * surface as an event the CLI logs to stderr.
   */
  async #recordAgentSafely(record: RuntimeAgentRecord): Promise<void> {
    try {
      await this.#runRecorder?.recordAgent(record);
    } catch (error) {
      this.#emitEvent({
        method: "runRecord/writeFailed",
        params: {
          agentId: record.id,
          message: error instanceof Error ? error.message : String(error)
        },
        receivedAt: Date.now()
      });
    }
  }

  /**
   * Outputs of every worker that finished successfully, in completion order.
   * The CLI reads this to assemble a partial result if the whole-workflow
   * timeout fires before the script returns.
   */
  completedOutputs(): readonly CompletedAgentOutput[] {
    return this.#completed;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#engines.close();
  }

  async #runAgent(
    engine: EngineAdapter,
    prompt: string,
    options: Partial<AgentOptions>,
    agentId: number,
    agentRecord: RuntimeAgentRecord
  ): Promise<string | unknown | null> {
    const invocation = engine.createInvocation(prompt, this.#engineTurnOptions(options));
    try {
      if (options.schema !== undefined) {
        return await this.#runSchemaAgent(engine.name, invocation, { ...options, schema: options.schema }, agentId, agentRecord);
      }
      return await this.#runTextAgent(engine.name, invocation, options, agentId, agentRecord);
    } finally {
      await invocation.close?.();
    }
  }

  async #runTextAgent(
    engine: EngineName,
    invocation: EngineInvocation,
    options: Partial<AgentOptions>,
    agentId: number,
    agentRecord: RuntimeAgentRecord
  ): Promise<string> {
    const maxAttempts = options.maxAttempts ?? this.#defaultMaxAttempts;
    let lastError: Error | null = null;
    let previousFailure: EngineAttemptFailure | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.progress.noteAttempt(agentId, attempt);
      this.budget.assertCanStart(engine);
      const startedAt = Date.now();
      try {
        const result = await invocation.runAttempt({
          attempt,
          ...(previousFailure !== undefined ? { previousFailure } : {})
        });
        recordResolvedModel(agentRecord, result);
        const text = result.text.trim();
        if (text.length > 0) {
          agentRecord.attempts.push(attemptRecord(attempt, "complete", null, result.text, result.text, startedAt, result));
          return text;
        }
        previousFailure = {
          kind: "empty-output",
          message: `agent returned empty text on attempt ${attempt}`
        };
        agentRecord.attempts.push(attemptRecord(attempt, "failed", previousFailure, result.text, null, startedAt, result));
        lastError = new EmptyAgentOutputError(previousFailure.message);
      } catch (error) {
        const failure = failureFromError(error);
        agentRecord.attempts.push(attemptRecord(attempt, "failed", failure, null, null, startedAt, null));
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
    options: Partial<AgentOptions> & { schema: JsonSchema },
    agentId: number,
    agentRecord: RuntimeAgentRecord
  ): Promise<unknown | null> {
    const maxAttempts = options.maxAttempts ?? this.#defaultMaxAttempts;
    let previousFailure: EngineAttemptFailure | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.progress.noteAttempt(agentId, attempt);
      this.budget.assertCanStart(engine);
      const startedAt = Date.now();
      try {
        const result = await invocation.runAttempt({
          attempt,
          ...(previousFailure !== undefined ? { previousFailure } : {})
        });
        recordResolvedModel(agentRecord, result);
        // A silent worker (timeout, hang) is not a JSON problem: label it
        // empty-output so records and retry nudges point at the real failure.
        if (result.text.trim().length === 0) {
          previousFailure = {
            kind: "empty-output",
            message: `agent returned empty text on attempt ${attempt}`
          };
          agentRecord.attempts.push(attemptRecord(attempt, "failed", previousFailure, result.text, null, startedAt, result));
          continue;
        }
        const parsed = parseJsonFromText(result.text);
        if (parsed === null) {
          previousFailure = {
            kind: "invalid-json",
            message: "agent output did not contain parseable JSON"
          };
          agentRecord.attempts.push(attemptRecord(attempt, "failed", previousFailure, result.text, null, startedAt, result));
          continue;
        }

        const validation = validateJsonSchema(parsed.value, options.schema);
        if (validation.ok) {
          agentRecord.attempts.push(attemptRecord(attempt, "complete", null, result.text, parsed.value, startedAt, result));
          return parsed.value;
        }
        previousFailure = {
          kind: "schema-validation",
          message: JSON.stringify(validation.errors ?? [])
        };
        agentRecord.attempts.push(attemptRecord(attempt, "failed", previousFailure, result.text, null, startedAt, result));
      } catch (error) {
        const failure = failureFromError(error);
        agentRecord.attempts.push(attemptRecord(attempt, "failed", failure, null, null, startedAt, null));
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

  #registerEngineCaps(): void {
    for (const name of this.#engines.names()) {
      const adapter = this.#engines.get(name);
      if (adapter !== undefined) {
        this.progress.registerEngine(name, adapter.concurrency);
      }
    }
  }

  #engineFor(engine: unknown): EngineAdapter {
    if (engine === undefined) {
      throw new MissingEngineError();
    }
    if (typeof engine !== "string") {
      throw new UnknownEngineError(engine);
    }
    const adapter = this.#engines.get(engine as EngineName);
    if (adapter === undefined) {
      throw new UnknownEngineError(engine);
    }
    return adapter;
  }

  #engineTurnOptions(options: Partial<AgentOptions>): EngineTurnOptions {
    const resolvedTimeoutMs = options.timeoutMs ?? this.#defaultTurnTimeoutMs;
    return {
      webSearch: options.webSearch ?? false,
      ...(resolvedTimeoutMs !== undefined ? { timeoutMs: resolvedTimeoutMs } : {}),
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
      ...(options.isolation !== undefined ? { isolation: options.isolation } : {}),
      ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {})
    };
  }

  #newAgentRecord(id: number, engine: EngineName, options: Partial<AgentOptions>): RuntimeAgentRecord {
    return {
      id,
      engine,
      model: typeof options.model === "string" ? options.model : null,
      effort: typeof options.effort === "string" ? options.effort : null,
      fallbackModel: typeof options.fallbackModel === "string" ? options.fallbackModel : null,
      resolvedModel: null,
      label: options.label ?? null,
      phase: options.phase ?? null,
      status: "in-progress",
      creationOrder: id,
      concurrencyGroup: engine,
      schema: options.schema ?? null,
      rawOutput: null,
      validatedOutput: null,
      attempts: []
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

function attemptRecord(
  attempt: number,
  status: "complete" | "failed",
  failure: { kind: string; message: string } | null,
  rawOutput: string | null,
  validatedOutput: unknown,
  startedAtMs: number,
  result: Pick<TurnResult, "durationMs" | "firstDeltaMs" | "tokenUsageEvents" | "transcripts"> | null
): RuntimeAgentAttemptRecord {
  return {
    attempt,
    status,
    failure,
    rawOutput,
    validatedOutput,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: result?.durationMs ?? null,
    firstDeltaMs: result?.firstDeltaMs ?? null,
    tokenUsageEvents: result?.tokenUsageEvents ?? [],
    transcripts: result?.transcripts ?? []
  };
}

function recordResolvedModel(record: RuntimeAgentRecord, result: TurnResult): void {
  if (result.resolvedModel !== undefined) {
    record.resolvedModel = result.resolvedModel;
  }
}

function failureFromError(error: unknown): { kind: string; message: string } {
  if (error instanceof Error) {
    return { kind: error.name, message: error.message };
  }
  return { kind: "error", message: String(error) };
}

function lastRawOutput(record: RuntimeAgentRecord): string | null {
  for (let index = record.attempts.length - 1; index >= 0; index -= 1) {
    const rawOutput = record.attempts[index]?.rawOutput;
    if (rawOutput !== undefined && rawOutput !== null) {
      return rawOutput;
    }
  }
  return null;
}
