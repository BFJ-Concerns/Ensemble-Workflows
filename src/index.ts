import { createRuntime as createRuntimeInstance } from "./runtime.js";

import type { AgentOptions, JsonSchema, RuntimeOptions } from "./types.js";
import type { CodexRuntime } from "./runtime.js";

let defaultRuntime: Promise<CodexRuntime> | null = null;

export async function agent(prompt: string, options: AgentOptions & { schema: JsonSchema }): Promise<unknown | null>;
export async function agent(prompt: string, options?: AgentOptions & { schema?: undefined }): Promise<string>;
export async function agent(prompt: string, options: AgentOptions = {}): Promise<string | unknown | null> {
  const runtime = await getDefaultRuntime();
  if (options.schema !== undefined) {
    return runtime.agent(prompt, { ...options, schema: options.schema });
  }
  return runtime.agent(prompt, options as AgentOptions & { schema?: undefined });
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<CodexRuntime> {
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

export { CodexRuntime, defaultConcurrency } from "./runtime.js";
export { TokenBudget, tokenUsageEventFromParams } from "./budget.js";
export { createWorkflowHooks, parallel, pipeline } from "./hooks.js";
export { runWorkflowScript, extractWorkflowSource, WorkflowScriptError, WorkflowTimeoutError } from "./script-runner.js";
export { parseJsonFromText, validateJsonSchema } from "./schema.js";
export type { WorkflowHooks, WorkflowLogSink, WorkflowRuntime } from "./hooks.js";
export type {
  AgentOptions,
  Budget,
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

async function getDefaultRuntime(): Promise<CodexRuntime> {
  defaultRuntime ??= createRuntimeInstance();
  return defaultRuntime;
}
