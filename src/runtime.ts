import { randomUUID } from "node:crypto";

import { AgentPlacementManager, resolveAgentCwd } from "./agent-placement.js";
import { AdmissionController } from "./admission.js";
import { TokenBudget, tokenUsageEventFromParams } from "./budget.js";
import { assertRecognisedAgentOptions } from "./engine-option-validation.js";
import {
  AppServerBackpressureError,
  AppServerOverloadedError,
  AppServerRetryPromiseBrokenError,
  EmptyAgentOutputError,
  EngineShutdownError,
  MissingEngineError,
  partialWorkerTextOf,
  TurnTimeoutError,
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
import { assertCompilableSchema, selectLastValidJsonFromText } from "./schema.js";

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
import type {
  EngineAdapter,
  EngineAttemptFailure,
  EngineAttemptResult,
  EngineInvocation,
  EngineTurnOptions
} from "./engines.js";
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

interface AgentExecutionResult {
  status: "complete" | "failed";
  value: unknown;
}

type AgentExecutionCompletion =
  | { ok: true; execution: AgentExecutionResult }
  | { ok: false; error: unknown };

export class EnsembleRuntime {
  readonly budget: TokenBudget;
  readonly worktrees: IsolatedWorktreeRecord[] = [];
  /** Live, in-memory view of what the run is doing. Always maintained; persisting it is opt-in at the CLI. */
  readonly progress: RunProgress;

  #engines: EngineRegistry;
  #admission: AdmissionController;
  #placement: AgentPlacementManager;
  #defaultTurnTimeoutMs: number | undefined;
  #defaultMaxAttempts: number;
  #eventListeners = new Set<RuntimeEventListener>();
  #completed: CompletedAgentOutput[] = [];
  #runRecorder: RunRecordWriter | null = null;
  #shutdownAgentStatus: "failed" | "timed-out" | "interrupted" = "interrupted";
  #closed = false;

  constructor(options: {
    engines?: EngineRegistry;
    transport?: RuntimeTransport;
    cwd?: string;
    agentCeiling?: number | null;
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
    this.#placement = new AgentPlacementManager({
      baseCwd: options.cwd ?? process.cwd(),
      ...(options.worktreeManager !== undefined ? { worktreeManager: options.worktreeManager } : {})
    });
    this.#engines =
      options.engines ??
      new EngineRegistry([
        new CodexEngineAdapter({
          transport: requireTransport(options.transport),
          concurrency: options.concurrencyCaps?.codex ?? defaultCodexConcurrency()
        }),
        new ClaudeEngineAdapter({
          ...(options.concurrencyCaps?.claude !== undefined ? { concurrency: options.concurrencyCaps.claude } : {})
        }),
        new OpenCodeEngineAdapter({
          ...(options.concurrencyCaps?.opencode !== undefined ? { concurrency: options.concurrencyCaps.opencode } : {})
        })
      ]);
    this.#admission = new AdmissionController({
      ceiling: options.agentCeiling ?? null,
      caps: this.#engineCaps()
    });
    this.#registerEngineCaps();
  }

  static async create(options: RuntimeOptions = {}): Promise<EnsembleRuntime> {
    let runtime: EnsembleRuntime | null = null;
    const cwd = options.cwd ?? process.cwd();
    const engines = await createDefaultEngineRegistry({
      cwd,
      codexBin: options.codexBin ?? "codex",
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      ...(options.retryPromiseSilenceTimeoutMs !== undefined
        ? { retryPromiseSilenceTimeoutMs: options.retryPromiseSilenceTimeoutMs }
        : {}),
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
      ...(options.concurrencyCaps !== undefined ? { concurrencyCaps: options.concurrencyCaps } : {})
    });

    runtime = new EnsembleRuntime({
      engines,
      cwd,
      ...(options.budgetCeilings !== undefined ? { budgetCeilings: options.budgetCeilings } : {}),
      ...(options.defaultTurnTimeoutMs !== undefined ? { defaultTurnTimeoutMs: options.defaultTurnTimeoutMs } : {}),
      ...(options.agentCeiling !== undefined ? { agentCeiling: options.agentCeiling } : {}),
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
    assertRecognisedAgentOptions(options);
    if (options.schema !== undefined) {
      // A malformed schema would otherwise surface only after the first paid turn.
      assertCompilableSchema(options.schema);
    }

    const engine = this.#engineFor(options.engine);
    const queuedAt = Date.now();
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
    const agentRecord = this.#newAgentRecord(agentId, engine.name, prompt, options);
    // Dispatch-time record: persisted in-progress before the engine is
    // called, so a worker that dies uncleanly still leaves evidence it was
    // asked. Settlement overwrites this same record (last write wins).
    await this.#recordAgentSafely(agentRecord);
    return this.#runAdmitted(engine, prompt, options, agentId, agentRecord, queuedAt);
  }

  async #runAdmitted(
    engine: EngineAdapter,
    prompt: string,
    options: Partial<AgentOptions>,
    agentId: number,
    agentRecord: RuntimeAgentRecord,
    queuedAt: number
  ): Promise<unknown> {
    let started = false;
    try {
      return await this.#admission.admit(engine.name, agentId, () =>
        engine.schedule(async () => {
          started = true;
          return this.#executeAgent(engine, prompt, options, agentId, agentRecord, queuedAt);
        })
      );
    } catch (error) {
      // A rejection before the task started (admission or scheduler shutdown)
      // bypasses #executeAgent's own settlement: settle the progress entry and
      // persist the record here so a cancelled queued worker is not left
      // counted as queued for ever.
      if (!started) {
        this.progress.settleAgent(agentId, "failed");
        agentRecord.status = this.#terminalAgentStatus(error, agentRecord);
        agentRecord.queuedMs = Math.max(0, Date.now() - queuedAt);
        agentRecord.executionMs = 0;
        await this.#recordAgentSafely(agentRecord);
      }
      throw error;
    }
  }

  async #executeAgent(
    engine: EngineAdapter,
    prompt: string,
    options: Partial<AgentOptions>,
    agentId: number,
    agentRecord: RuntimeAgentRecord,
    queuedAt: number
  ): Promise<unknown> {
    const executionStartedAt = Date.now();
    this.progress.startAgent(agentId);
    try {
      const execution = await this.#runAgent(engine, prompt, options, agentId, agentRecord);
      const outcome = execution.status === "complete" ? "done" : "failed";
      const executionEndedAt = Date.now();
      agentRecord.queuedMs = Math.max(0, executionStartedAt - queuedAt);
      agentRecord.executionMs = Math.max(0, executionEndedAt - executionStartedAt);
      this.progress.settleAgent(agentId, outcome);
      agentRecord.status = outcome === "done" ? "complete" : this.#terminalAgentStatus(null, agentRecord);
      agentRecord.rawOutput = lastRawOutput(agentRecord);
      agentRecord.validatedOutput = execution.value;
      // Retain successful outputs so a timeout can surface completed work.
      // This includes schema-valid JSON null; failure is carried separately
      // by the execution status rather than inferred from the returned value.
      if (outcome === "done") {
        this.#completed.push({
          id: agentId,
          engine: engine.name,
          label: options.label ?? null,
          phase: options.phase ?? null,
          output: execution.value
        });
      }
      await this.#recordAgentSafely(agentRecord);
      return execution.value;
    } catch (error) {
      const executionEndedAt = Date.now();
      agentRecord.queuedMs = Math.max(0, executionStartedAt - queuedAt);
      agentRecord.executionMs = Math.max(0, executionEndedAt - executionStartedAt);
      this.progress.settleAgent(agentId, "failed");
      agentRecord.status = this.#terminalAgentStatus(error, agentRecord);
      agentRecord.rawOutput = lastRawOutput(agentRecord);
      agentRecord.validatedOutput = null;
      await this.#recordAgentSafely(agentRecord);
      throw error;
    }
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

  async close(status: "failed" | "timed-out" | "interrupted" = "interrupted"): Promise<void> {
    this.#shutdownAgentStatus = status;
    this.#closed = true;
    this.#admission.close();
    await this.#engines.close();
  }

  #terminalAgentStatus(error: unknown, record: RuntimeAgentRecord): "failed" | "timed-out" | "interrupted" {
    if (error instanceof EngineShutdownError) {
      return this.#shutdownAgentStatus;
    }
    if (error instanceof TurnTimeoutError || record.attempts.at(-1)?.failure?.kind.endsWith("-timeout") === true) {
      return "timed-out";
    }
    return "failed";
  }

  async #runAgent(
    engine: EngineAdapter,
    prompt: string,
    options: Partial<AgentOptions>,
    agentId: number,
    agentRecord: RuntimeAgentRecord
  ): Promise<AgentExecutionResult> {
    const placement = await this.#placement.open(options);
    agentRecord.resolvedCwd = placement.cwd;
    agentRecord.isolation = options.isolation ?? null;
    let invocation: EngineInvocation | undefined;
    let completion: AgentExecutionCompletion | undefined;
    try {
      invocation = engine.createInvocation(prompt, this.#engineTurnOptions(options, placement.cwd));
      if (options.schema !== undefined) {
        completion = {
          ok: true,
          execution: await this.#runSchemaAgent(
            engine.name,
            invocation,
            { ...options, schema: options.schema },
            agentId,
            agentRecord
          )
        };
      } else {
        completion = {
          ok: true,
          execution: {
            status: "complete",
            value: await this.#runTextAgent(engine.name, invocation, options, agentId, agentRecord)
          }
        };
      }
    } catch (error) {
      completion = { ok: false, error };
    } finally {
      try {
        try {
          await invocation?.close?.();
        } catch (error) {
          // Preserve the established rule that invocation shutdown replaces
          // the worker completion; finalisation must not replace either one.
          completion = { ok: false, error };
        }
      } finally {
        try {
          const worktree = await this.#placement.close(placement);
          if (worktree !== null) {
            this.#publishWorktree(agentRecord, worktree);
            this.#emitEvent({
              method: "worktree/finished",
              params: {
                path: worktree.path,
                branch: worktree.branch,
                changed: worktree.changed,
                removed: worktree.removed
              },
              receivedAt: Date.now()
            });
          }
        } catch (error) {
          if (placement.worktree !== undefined) {
            // Finalisation did not prove that the branch was unchanged or
            // removed. Retain the recoverable identity conservatively.
            const worktree = {
              ...placement.worktree,
              tipCommit: null,
              changed: true,
              removed: false
            };
            this.#publishWorktree(agentRecord, worktree);
            this.#emitEvent({
              method: "worktree/finalisationFailed",
              params: {
                agentId,
                path: worktree.path,
                branch: worktree.branch,
                message: failureFromError(error).message
              },
              receivedAt: Date.now()
            });
          }
          if (completion?.ok !== false) {
            completion = { ok: false, error };
          }
        }
      }
    }

    if (completion === undefined) {
      throw new Error("agent execution ended without a result");
    }
    if (!completion.ok) {
      throw completion.error;
    }
    return completion.execution;
  }

  #publishWorktree(agentRecord: RuntimeAgentRecord, worktree: IsolatedWorktreeRecord): void {
    this.worktrees.push(worktree);
    agentRecord.worktree = {
      branch: worktree.branch,
      baseCommit: worktree.baseCommit,
      tipCommit: worktree.tipCommit,
      changed: worktree.changed,
      removed: worktree.removed
    };
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
        this.#recordResolvedCodexDefault(engine, options, agentId, agentRecord, result);
        recordTurnMetadata(agentRecord, result);
        const operationalFailure = recordOperationalFailure(agentRecord, attempt, startedAt, result);
        if (operationalFailure !== undefined) {
          previousFailure = operationalFailure;
          lastError = new EmptyAgentOutputError(previousFailure.message);
          continue;
        }
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
        // Terminalisation invariant: a failed turn's attempt record carries
        // whatever the worker had said before it died, not a bare null.
        agentRecord.attempts.push(
          attemptRecord(attempt, "failed", failure, partialWorkerTextOf(error), null, startedAt, null)
        );
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
  ): Promise<AgentExecutionResult> {
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
        this.#recordResolvedCodexDefault(engine, options, agentId, agentRecord, result);
        recordTurnMetadata(agentRecord, result);
        const operationalFailure = recordOperationalFailure(agentRecord, attempt, startedAt, result);
        if (operationalFailure !== undefined) {
          previousFailure = operationalFailure;
          continue;
        }
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
        const selection = selectLastValidJsonFromText(result.text, options.schema);
        if (selection.kind === "invalid-json") {
          previousFailure = {
            kind: "invalid-json",
            message: "agent output did not contain parseable JSON"
          };
          agentRecord.attempts.push(attemptRecord(attempt, "failed", previousFailure, result.text, null, startedAt, result));
          continue;
        }
        if (selection.kind === "valid") {
          agentRecord.parseRoute = selection.parsed.source;
          agentRecord.attempts.push(
            attemptRecord(attempt, "complete", null, result.text, selection.parsed.value, startedAt, result)
          );
          return {
            status: "complete",
            value: selection.parsed.value
          };
        }
        previousFailure = {
          kind: "schema-validation",
          message: JSON.stringify(selection.validation.errors ?? [])
        };
        agentRecord.attempts.push(attemptRecord(attempt, "failed", previousFailure, result.text, null, startedAt, result));
      } catch (error) {
        const failure = failureFromError(error);
        // Terminalisation invariant: a failed turn's attempt record carries
        // whatever the worker had said before it died, not a bare null.
        agentRecord.attempts.push(
          attemptRecord(attempt, "failed", failure, partialWorkerTextOf(error), null, startedAt, null)
        );
        if (!isRetryableError(error) || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    return {
      status: "failed",
      value: null
    };
  }

  #emitEvent(event: RuntimeEvent): void {
    for (const listener of this.#eventListeners) {
      listener(event);
    }
  }

  #recordResolvedCodexDefault(
    engine: EngineName,
    options: Partial<AgentOptions>,
    agentId: number,
    record: RuntimeAgentRecord,
    result: TurnResult
  ): void {
    if (engine !== "codex" || options.model !== undefined || record.resolvedModel !== null || result.resolvedModel === undefined) {
      return;
    }
    this.#emitEvent({
      method: "codex/unpinnedModelResolved",
      params: {
        agentId,
        label: options.label ?? null,
        model: result.resolvedModel,
        effort: result.resolvedEffort ?? null
      },
      receivedAt: Date.now()
    });
  }

  #registerEngineCaps(): void {
    for (const name of this.#engines.names()) {
      const adapter = this.#engines.get(name);
      if (adapter !== undefined) {
        this.progress.registerEngine(name, adapter.concurrency);
      }
    }
  }

  #engineCaps(): ReadonlyMap<EngineName, number> {
    const caps = new Map<EngineName, number>();
    for (const name of this.#engines.names()) {
      const adapter = this.#engines.get(name);
      if (adapter !== undefined) {
        caps.set(name, adapter.concurrency);
      }
    }
    return caps;
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

  #engineTurnOptions(options: Partial<AgentOptions>, cwd: string): EngineTurnOptions {
    const resolvedTimeoutMs = options.timeoutMs ?? this.#defaultTurnTimeoutMs;
    return {
      ...(resolvedTimeoutMs !== undefined ? { timeoutMs: resolvedTimeoutMs } : {}),
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
      cwd
    };
  }

  #newAgentRecord(
    id: number,
    engine: EngineName,
    prompt: string,
    options: Partial<AgentOptions>
  ): RuntimeAgentRecord {
    return {
      id,
      engine,
      prompt,
      options: {
        timeoutMs: options.timeoutMs ?? this.#defaultTurnTimeoutMs ?? null,
        maxAttempts: options.maxAttempts ?? this.#defaultMaxAttempts
      },
      model: typeof options.model === "string" ? options.model : null,
      effort: typeof options.effort === "string" ? options.effort : null,
      fallbackModel: typeof options.fallbackModel === "string" ? options.fallbackModel : null,
      resolvedModel: null,
      resolvedCwd: resolveAgentCwd(this.#placement.baseCwd, options.cwd),
      isolation: options.isolation ?? null,
      worktree: null,
      label: options.label ?? null,
      phase: options.phase ?? null,
      status: "in-progress",
      creationOrder: id,
      concurrencyGroup: engine,
      schema: options.schema ?? null,
      parseRoute: null,
      rawOutput: null,
      validatedOutput: null,
      queuedMs: 0,
      executionMs: 0,
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
  return (
    error instanceof AppServerBackpressureError ||
    error instanceof AppServerOverloadedError ||
    error instanceof AppServerRetryPromiseBrokenError
  );
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
  result: Pick<TurnResult, "durationMs" | "firstDeltaMs" | "tokenUsageEvents" | "transcripts" | "diagnostics"> | null
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
    transcripts: result?.transcripts ?? [],
    diagnostics: result?.diagnostics ?? {}
  };
}

function recordTurnMetadata(record: RuntimeAgentRecord, result: TurnResult): void {
  if (result.resolvedModel !== undefined) {
    record.resolvedModel = result.resolvedModel;
  }
}

function recordOperationalFailure(
  record: RuntimeAgentRecord,
  attempt: number,
  startedAtMs: number,
  result: EngineAttemptResult
): EngineAttemptFailure | undefined {
  if (result.attemptFailure === undefined) {
    return undefined;
  }
  record.attempts.push(
    attemptRecord(attempt, "failed", result.attemptFailure, result.text, null, startedAtMs, result)
  );
  return result.attemptFailure;
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
