import vm from "node:vm";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createWorkflowHooks } from "./hooks.js";
import {
  NestedWorkflowError,
  resolveWorkflowReference
} from "./workflow-registry.js";

import type { WorkflowDefaults, WorkflowEngineDefaults, WorkflowHooks, WorkflowLogSink, WorkflowRuntime } from "./hooks.js";
import type { WorkflowReference } from "./workflow-registry.js";

export class WorkflowScriptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WorkflowTimeoutError extends WorkflowScriptError {
  /** The breached deadline, so callers can report it without re-parsing the message. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Workflow timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

export interface WorkflowScriptResult {
  meta: unknown;
  result: unknown;
}

export interface RunWorkflowScriptOptions {
  source: string;
  filename: string;
  /** The run cwd used for resolving child workflow registry and script-path references. */
  cwd?: string;
  runtime: WorkflowRuntime;
  args?: unknown;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  workflowDepth?: number;
  log: WorkflowLogSink;
  /** Called with the parsed `meta` as soon as the script evaluates, before its body resolves. */
  onMeta?: (meta: unknown) => void | Promise<void>;
}

interface ExtractedWorkflow {
  metaSource: string;
  /** Source of the optional `export const defaults = { … }` block, or null. */
  defaultsSource: string | null;
  bodySource: string;
}

export async function runWorkflowScript(options: RunWorkflowScriptOptions): Promise<WorkflowScriptResult> {
  const extracted = extractWorkflowSource(options.source);
  const defaults = readWorkflowDefaults(extracted.defaultsSource, options.filename);
  const cwd = options.cwd ?? path.dirname(path.resolve(options.filename));
  const workflowDepth = options.workflowDepth ?? 0;
  const hooks = createWorkflowHooks({
    runtime: options.runtime,
    args: options.args ?? [],
    log: options.log,
    ...(defaults !== undefined ? { defaults } : {}),
    workflow:
      workflowDepth === 0
        ? async (nameOrRef, args) => {
            const scriptPath = await resolveWorkflowReference(asWorkflowReference(nameOrRef), {
              cwd,
              ...(options.env !== undefined ? { env: options.env } : {}),
              readMeta: readWorkflowMeta
            });
            const source = await readFile(scriptPath, "utf8");
            const child = await runWorkflowScript({
              source,
              filename: scriptPath,
              cwd,
              runtime: options.runtime,
              args: args ?? [],
              ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
              ...(options.env !== undefined ? { env: options.env } : {}),
              workflowDepth: workflowDepth + 1,
              log: options.log
            });
            return child.result;
          }
        : async () => {
            throw new NestedWorkflowError();
          }
  });
  const context = createSandboxContext(hooks);
  const script = new vm.Script(buildWrappedSource(extracted), {
    filename: options.filename
  });

  let runResult: unknown;
  try {
    runResult =
      options.timeoutMs === undefined
        ? (script.runInContext(context) as unknown)
        : (script.runInContext(context, { timeout: options.timeoutMs }) as unknown);
  } catch (error) {
    if (options.timeoutMs !== undefined && isVmTimeoutError(error)) {
      throw new WorkflowTimeoutError(options.timeoutMs);
    }
    throw error;
  }
  const resultRecord = asResultRecord(runResult);
  const meta = normaliseVmValue(resultRecord.meta);
  const resultSettlement = resultRecord.promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error })
  );
  // Meta is known the moment the script evaluates — surface it before awaiting
  // the body so a live status view can name the run from the start.
  await options.onMeta?.(meta);
  const settlement = await withTimeout(resultSettlement, options.timeoutMs);
  if (settlement.status === "rejected") {
    throw settlement.error;
  }
  return {
    meta,
    result: normaliseVmValue(settlement.value)
  };
}

export function readWorkflowMeta(source: string, filename: string = "workflow.js"): unknown {
  const extracted = extractWorkflowSource(source);
  const script = new vm.Script(`(${extracted.metaSource});`, { filename });
  return normaliseVmValue(script.runInNewContext(undefined, { timeout: 100 }));
}

export function extractWorkflowSource(source: string): ExtractedWorkflow {
  const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const match = /^\s*export\s+const\s+meta\s*=/.exec(withoutBom);
  if (match === null) {
    throw new WorkflowScriptError("Workflow script must begin with `export const meta = { ... }`");
  }

  const expressionStart = skipWhitespace(withoutBom, match[0].length);
  if (withoutBom[expressionStart] !== "{") {
    throw new WorkflowScriptError("Workflow meta must be an object literal");
  }

  const expressionEnd = findBalancedObjectEnd(withoutBom, expressionStart);
  let bodyStart = skipWhitespace(withoutBom, expressionEnd + 1);
  if (withoutBom[bodyStart] === ";") {
    bodyStart += 1;
  }

  // Optional second export: `export const defaults = { \u2026 }` directly after meta.
  let defaultsSource: string | null = null;
  const afterMeta = skipWhitespace(withoutBom, bodyStart);
  const defaultsMatch = /^export\s+const\s+defaults\s*=/.exec(withoutBom.slice(afterMeta));
  if (defaultsMatch !== null) {
    const defaultsStart = skipWhitespace(withoutBom, afterMeta + defaultsMatch[0].length);
    if (withoutBom[defaultsStart] !== "{") {
      throw new WorkflowScriptError("Workflow defaults must be an object literal");
    }
    const defaultsEnd = findBalancedObjectEnd(withoutBom, defaultsStart);
    defaultsSource = withoutBom.slice(defaultsStart, defaultsEnd + 1);
    bodyStart = skipWhitespace(withoutBom, defaultsEnd + 1);
    if (withoutBom[bodyStart] === ";") {
      bodyStart += 1;
    }
  }

  return {
    metaSource: withoutBom.slice(expressionStart, expressionEnd + 1),
    defaultsSource,
    bodySource: withoutBom.slice(bodyStart)
  };
}

/** Evaluate and shape-check a script's `export const defaults` block. */
export function readWorkflowDefaults(
  defaultsSource: string | null,
  filename: string = "workflow.js"
): WorkflowDefaults | undefined {
  if (defaultsSource === null) {
    return undefined;
  }
  const script = new vm.Script(`(${defaultsSource});`, { filename });
  const value = normaliseVmValue(script.runInNewContext(undefined, { timeout: 100 }));
  return validateWorkflowDefaults(value);
}

function validateWorkflowDefaults(value: unknown): WorkflowDefaults {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowScriptError("Workflow defaults must be an object keyed by engine name");
  }
  const defaults: WorkflowDefaults = {};
  for (const [engine, engineValue] of Object.entries(value)) {
    if (engine !== "codex" && engine !== "claude" && engine !== "opencode") {
      throw new WorkflowScriptError(
        `Workflow defaults key ${JSON.stringify(engine)} is not an engine; expected codex, claude, or opencode`
      );
    }
    if (typeof engineValue !== "object" || engineValue === null || Array.isArray(engineValue)) {
      throw new WorkflowScriptError(`Workflow defaults.${engine} must be an object of agent options`);
    }
    const engineDefaults: WorkflowEngineDefaults = {};
    for (const [option, optionValue] of Object.entries(engineValue as Record<string, unknown>)) {
      if (option !== "model" && option !== "effort" && option !== "fallbackModel") {
        throw new WorkflowScriptError(
          `Workflow defaults.${engine}.${option} is not supported; defaults may set model, effort, or fallbackModel`
        );
      }
      if (typeof optionValue !== "string" || optionValue.length === 0) {
        throw new WorkflowScriptError(`Workflow defaults.${engine}.${option} must be a non-empty string`);
      }
      engineDefaults[option] = optionValue;
    }
    defaults[engine] = engineDefaults;
  }
  return defaults;
}

function buildWrappedSource(workflow: ExtractedWorkflow): string {
  return `"use strict";
const __workflowMeta = (${workflow.metaSource});
const __workflowPromise = (async () => {
${workflow.bodySource}
})();
({ meta: __workflowMeta, promise: __workflowPromise });`;
}

function createSandboxContext(hooks: WorkflowHooks): vm.Context {
  return vm.createContext(
    {
      agent: hooks.agent,
      workflow: hooks.workflow,
      parallel: hooks.parallel,
      pipeline: hooks.pipeline,
      phase: hooks.phase,
      log: hooks.log,
      budget: hooks.budget,
      worktrees: hooks.worktrees,
      args: hooks.args
    },
    {
      name: "ensemble-workflow-script",
      codeGeneration: {
        strings: false,
        wasm: false
      }
    }
  );
}

function asWorkflowReference(value: unknown): WorkflowReference {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "scriptPath" in value &&
    typeof (value as { scriptPath?: unknown }).scriptPath === "string"
  ) {
    return { scriptPath: (value as { scriptPath: string }).scriptPath };
  }
  throw new WorkflowScriptError("workflow() expects a workflow name string or { scriptPath: string }");
}

function asResultRecord(value: unknown): { meta: unknown; promise: Promise<unknown> } {
  if (typeof value !== "object" || value === null || !("promise" in value)) {
    throw new WorkflowScriptError("Workflow script did not produce a result promise");
  }
  const promise = (value as { promise: unknown }).promise;
  if (!isPromiseLike(promise)) {
    throw new WorkflowScriptError("Workflow script did not produce a result promise");
  }
  return { meta: (value as { meta?: unknown }).meta, promise: Promise.resolve(promise) };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function normaliseVmValue(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function isVmTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || (typeof message === "string" && /Script execution timed out/.test(message));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }

  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new WorkflowTimeoutError(timeoutMs));
    }, timeoutMs);
    timeout.unref();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index] ?? "")) {
    index += 1;
  }
  return index;
}

function findBalancedObjectEnd(source: string, start: number): number {
  let depth = 0;
  let index = start;

  while (index < source.length) {
    const char = source[index];

    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) {
        if (char !== "}") {
          throw new WorkflowScriptError("Workflow meta object closed with the wrong delimiter");
        }
        return index;
      }
      if (depth < 0) {
        break;
      }
      index += 1;
      continue;
    }

    if (char === "\"" || char === "'") {
      index = skipQuotedString(source, index, char);
      continue;
    }

    if (char === "`") {
      index = skipTemplateLiteral(source, index);
      continue;
    }

    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }

    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }

    index += 1;
  }

  throw new WorkflowScriptError("Workflow meta object is not balanced");
}

function skipQuotedString(source: string, start: number, quote: "\"" | "'"): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    index += 1;
  }
  throw new WorkflowScriptError("Workflow meta string is not terminated");
}

function skipTemplateLiteral(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") {
      return index + 1;
    }
    index += 1;
  }
  throw new WorkflowScriptError("Workflow meta template string is not terminated");
}

function skipLineComment(source: string, start: number): number {
  const end = source.indexOf("\n", start + 2);
  return end === -1 ? source.length : end + 1;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  if (end === -1) {
    throw new WorkflowScriptError("Workflow meta block comment is not terminated");
  }
  return end + 2;
}
