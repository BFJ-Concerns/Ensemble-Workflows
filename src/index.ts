import { createRuntime as createRuntimeInstance } from "./runtime.js";

import type { AgentOptions, IdentifiedAgentResult as IdentifiedAgentResultType, JsonSchema, RuntimeOptions } from "./types.js";
export type { AgentCallSignature, IdentifiedAgentResult } from "./types.js";
import type { EnsembleRuntime } from "./runtime.js";

let defaultRuntime: Promise<EnsembleRuntime> | null = null;

// The canonical AgentCallSignature (src/types.ts), restated as function
// overloads because an arrow cannot implement a multi-signature interface;
// conformance is compile-checked where the hooks typing tests assign this
// wrapper to the interface.
export async function agent(prompt: string, options: AgentOptions & { identity: true }): Promise<IdentifiedAgentResultType>;
export async function agent(prompt: string, options: AgentOptions & { schema: JsonSchema }): Promise<unknown | null>;
export async function agent(prompt: string, options: AgentOptions & { schema?: undefined }): Promise<string>;
export async function agent(prompt: string, options: Partial<AgentOptions>): Promise<string | unknown | null>;
export async function agent(prompt: string, options: Partial<AgentOptions> = {}): Promise<string | unknown | null> {
  const runtime = await getDefaultRuntime();
  return runtime.agent(prompt, options);
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
export {
  runWorkflowScript,
  extractWorkflowSource,
  readWorkflowScript,
  WorkflowScriptError,
  WorkflowTimeoutError
} from "./script-runner.js";
export { parseJsonFromText, validateJsonSchema } from "./schema.js";
export { RunProgress } from "./progress.js";
export { RunRecordWriter, resolveRunDirectory } from "./run-record.js";
export type { WorkflowInvocationRecord } from "./run-record.js";
export {
  CompletionSentinel,
  SENTINEL_FILENAME,
  SENTINEL_SCHEMA_VERSION
} from "./completion-sentinel.js";
export type {
  CompletionSentinelOptions,
  SentinelManifestAttestation,
  SentinelOutcome
} from "./completion-sentinel.js";
export {
  HOLD_SCOPE_ENV,
  HoldManager,
  defaultHoldsDirectory,
  enumerateHolds,
  holdScopeSegment,
  resolveHoldScope
} from "./holds.js";
export type {
  EnumeratedHold,
  EnumerateHoldsOptions,
  HoldAnswerRejection,
  HoldDecision,
  HoldEnumeration,
  HoldFileRecord,
  RaiseHoldOptions
} from "./holds.js";
export {
  HoldRejectedError,
  HoldTimeoutError,
  MultiTurnUnsupportedError,
  PreSpawnAuthorError,
  SessionBusyError,
  SessionClosedError,
  WorkflowScriptReadError,
  attachPartialWorkerText,
  partialWorkerTextOf,
  attachWorkerExitStatus,
  workerExitStatusOf
} from "./errors.js";
export type { WorkerExitStatus } from "./errors.js";
export {
  AmbientConfigError,
  CONFIG_SCHEMA_VERSION,
  AGENT_CEILING_ENV,
  CALLER_IDENTITY_ENV,
  RUN_RECORD_ENV,
  RUN_RECORD_DIR_ENV,
  resolveAmbientSettings,
  resolveRunRecordDir,
  resolveStatusDir
} from "./ambient-settings.js";
export { StatusFileWriter, STATUS_FILENAME, snapshotOwnerGone } from "./status-file.js";
export type { SnapshotOwnerEvidence } from "./status-file.js";
export {
  NestedWorkflowError,
  WorkflowResolutionError,
  defaultWorkflowRegistryDirs,
  listSavedWorkflows,
  resolveWorkflowReference
} from "./workflow-registry.js";
export type { WorkflowHooks, WorkflowLogSink, WorkflowRuntime } from "./hooks.js";
export type {
  AmbientSettings,
  AmbientSettingFlags,
  Resolved,
  SettingLayer
} from "./ambient-settings.js";
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
  EngineWorkerEnvironment,
  IsolationMode,
  JsonObject,
  JsonSchema,
  RuntimeEvent,
  RuntimeOptions,
  RuntimeTransport,
  SessionTurnOptions,
  ThreadStartOptions,
  TokenAccountingMode,
  TokenUsageBreakdown,
  TokenUsageEvent,
  TurnResult,
  TurnStartOptions,
  WorkerSessionOptions
} from "./types.js";
export { WorkerSession } from "./runtime.js";
export type {
  EngineAdapter,
  EngineAttemptContext,
  EngineAttemptFailure,
  EngineAttemptResult,
  EngineInvocation,
  EngineSessionTurn,
  EngineTurnOptions,
  EngineWorkerSession
} from "./engines.js";
export { STRIPPABLE_CAPABILITIES } from "./capability-stripping.js";
export type { CapabilityEnforcement, EngineCapabilityTable, StrippableCapability } from "./capability-stripping.js";
export { summariseUsage } from "./usage-summary.js";
export type { UsageSummary } from "./usage-summary.js";
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
