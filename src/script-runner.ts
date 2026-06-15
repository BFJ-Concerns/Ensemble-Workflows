import vm from "node:vm";

import { createWorkflowHooks } from "./hooks.js";

import type { WorkflowHooks, WorkflowLogSink, WorkflowRuntime } from "./hooks.js";

export class WorkflowScriptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WorkflowTimeoutError extends WorkflowScriptError {
  constructor(timeoutMs: number) {
    super(`Workflow timed out after ${timeoutMs}ms`);
  }
}

export interface WorkflowScriptResult {
  meta: unknown;
  result: unknown;
}

export interface RunWorkflowScriptOptions {
  source: string;
  filename: string;
  runtime: WorkflowRuntime;
  args?: string[];
  timeoutMs?: number;
  log: WorkflowLogSink;
}

interface ExtractedWorkflow {
  metaSource: string;
  bodySource: string;
}

const defaultTimeoutMs = 30 * 60 * 1_000;

export async function runWorkflowScript(options: RunWorkflowScriptOptions): Promise<WorkflowScriptResult> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const extracted = extractWorkflowSource(options.source);
  const hooks = createWorkflowHooks({
    runtime: options.runtime,
    args: options.args ?? [],
    log: options.log
  });
  const context = createSandboxContext(hooks);
  const script = new vm.Script(buildWrappedSource(extracted), {
    filename: options.filename
  });

  const runResult = script.runInContext(context, { timeout: timeoutMs }) as unknown;
  const resultRecord = asResultRecord(runResult);
  const result = await withTimeout(resultRecord.promise, timeoutMs);
  return {
    meta: normaliseVmValue(resultRecord.meta),
    result: normaliseVmValue(result)
  };
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

  return {
    metaSource: withoutBom.slice(expressionStart, expressionEnd + 1),
    bodySource: withoutBom.slice(bodyStart)
  };
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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
