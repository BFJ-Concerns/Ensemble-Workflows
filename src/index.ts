import { createRuntime as createRuntimeInstance } from "./runtime.js";

import type { AgentOptions, JsonSchema, RuntimeOptions } from "./types.js";
import type { EnsembleRuntime } from "./runtime.js";

let defaultRuntime: Promise<EnsembleRuntime> | null = null;

export async function agent(prompt: string, options: AgentOptions & { schema: JsonSchema }): Promise<unknown | null>;
export async function agent(prompt: string, options: AgentOptions & { schema?: undefined }): Promise<string>;
export async function agent(prompt: string, options: Partial<AgentOptions> = {}): Promise<string | unknown | null> {
  const runtime = await getDefaultRuntime();
  if (options.schema !== undefined) {
    return runtime.agent(prompt, { ...options, schema: options.schema } as AgentOptions & { schema: JsonSchema });
  }
  return runtime.agent(prompt, options as AgentOptions & { schema?: undefined });
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<EnsembleRuntime> {
  return createRuntimeInstance(options);
}

export async function closeDefaultRuntime(): Promise<void> {
  if (defaultRuntime === null) {
    return;
  }
  const runtime = await defaultRuntime;
  defaultRuntime = null;
  await runtime.close();
}

export { EnsembleRuntime, defaultConcurrency } from "./runtime.js";
export { TokenBudget, tokenUsageEventFromParams } from "./budget.js";
export { EngineRegistry, CodexEngineAdapter, ClaudeEngineAdapter, OpenCodeEngineAdapter } from "./engines.js";
export { defaultOpenCodeModelRegistry } from "./opencode-model-registry.js";
export { createWorkflowHooks, parallel, pipeline } from "./hooks.js";
export { runWorkflowScript, extractWorkflowSource, WorkflowScriptError, WorkflowTimeoutError } from "./script-runner.js";
export { parseJsonFromText, validateJsonSchema } from "./schema.js";
export { RunProgress } from "./progress.js";
export { RunRecordWriter } from "./run-record.js";
export { resolveRunRecordDir, RUN_RECORD_ENV, RUN_RECORD_DIR_ENV } from "./run-record-config.js";
export { StatusFileWriter, STATUS_FILENAME } from "./status-file.js";
export { resolveStatusDir } from "./status-config.js";
export {
  NestedWorkflowError,
  WorkflowResolutionError,
  defaultWorkflowRegistryDirs,
  listSavedWorkflows,
  resolveWorkflowReference
} from "./workflow-registry.js";
export type { WorkflowHooks, WorkflowLogSink, WorkflowRuntime } from "./hooks.js";
export type {
  AgentState,
  BudgetView,
  EngineProgressSnapshot,
  LiveAgentSnapshot,
  ProgressSnapshot,
  RunProgressOptions
} from "./progress.js";
export type {
  AgentOptions,
  Budget,
  EngineBudgetCeilings,
  EngineConcurrencyCaps,
  EngineName,
  IsolationMode,
  JsonObject,
  JsonSchema,
  RuntimeEvent,
  RuntimeOptions,
  RuntimeTransport,
  SandboxMode,
  ThreadStartOptions,
  TokenAccountingMode,
  TokenUsageBreakdown,
  TokenUsageEvent,
  TurnResult,
  TurnStartOptions
} from "./types.js";
export type {
  EngineAdapter,
  EngineAttemptContext,
  EngineAttemptFailure,
  EngineAttemptResult,
  EngineInvocation,
  EngineTurnOptions
} from "./engines.js";
export type { IsolatedWorktree, IsolatedWorktreeRecord, WorktreeIsolationManager } from "./worktree-isolation.js";
export type {
  SavedWorkflowEntry,
  SavedWorkflowMeta,
  WorkflowReference,
  WorkflowRegistryDirs,
  WorkflowRegistryListing,
  WorkflowRegistryNote
} from "./workflow-registry.js";

async function getDefaultRuntime(): Promise<EnsembleRuntime> {
  defaultRuntime ??= createRuntimeInstance();
  return defaultRuntime;
}
