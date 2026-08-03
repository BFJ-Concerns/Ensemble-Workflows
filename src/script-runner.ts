import vm from "node:vm";
import { readFile } from "node:fs/promises";
import path from "node:path";

import detectGlobals from "acorn-globals";

import { validateEngineDefaults } from "./engine-option-validation.js";
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

/**
 * Settlement-time guard for the run's output surface: the workflow return
 * value and `workflow()` arguments are printed, hashed, and archived, so a
 * value JSON.stringify would silently drop, mangle, or throw on must fail
 * the run loudly instead of degrading to a lossy approximation. The walk
 * mirrors JSON.stringify's own semantics (toJSON honoured, enumerable own
 * string-keyed properties, symbol keys ignored) and names the first
 * offending path so the author can find it. Two collapses are deliberately
 * permitted as JSON's documented mappings rather than lossy surprises:
 * `undefined` (a script without a top-level return prints `null`; an
 * undefined property vanishes) and non-finite numbers (`budget.remaining`
 * on an unbounded engine is legitimately `Infinity`, printing as `null`).
 * The contract's fail-loud set is a function, a cycle, or an
 * undefined-collapsing value — plus BigInt, which throws in stringify.
 */
export function assertJsonSerialisable(value: unknown, label: string, pathRoot: string): void {
  const offence = findUnserialisable(value, pathRoot, new Set());
  if (offence !== null) {
    throw new WorkflowScriptError(`${label} must be a JSON value: ${offence}`);
  }
}

function findUnserialisable(value: unknown, path: string, ancestors: Set<object>): string | null {
  switch (typeof value) {
    case "function":
      return `${path} is a function`;
    case "symbol":
      return `${path} is a symbol`;
    case "bigint":
      return `${path} is a BigInt`;
    case "object":
      break;
    default:
      return null;
  }
  if (value === null) {
    return null;
  }
  const toJson = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJson === "function") {
    return findUnserialisable(toJson.call(value), path, ancestors);
  }
  if (ancestors.has(value)) {
    return `${path} closes a cycle`;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const offence = findUnserialisable(value[index], `${path}[${index}]`, ancestors);
        if (offence !== null) {
          return offence;
        }
      }
      return null;
    }
    for (const [key, entry] of Object.entries(value)) {
      const offence = findUnserialisable(entry, `${path}.${key}`, ancestors);
      if (offence !== null) {
        return offence;
      }
    }
    return null;
  } finally {
    ancestors.delete(value);
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
            // Arguments cross the same printed-and-archived boundary as the
            // parent's return value, so they meet the same bar, before the
            // child script is even resolved.
            assertJsonSerialisable(args ?? [], "workflow() arguments", "args");
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
  // Meta is evaluated ahead of the body so the sandbox can bind it read-only:
  // the script may read the object it was required to declare, never mutate it.
  const declaredMeta = readWorkflowMeta(options.source, options.filename);
  const context = createSandboxContext(hooks, declaredMeta);
  const script = compileWorkflowScript(extracted, options.filename);
  assertKnownFreeIdentifiers(buildWrappedSource(extracted), context, options.filename);

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
  // Settlement-time check, on the value the body actually produced: the
  // return value is printed, hashed, and archived, so a non-JSON value
  // fails the run loudly here rather than collapsing to a lossy `null`
  // downstream. Only the top-level run's return crosses that boundary —
  // a child's return flows back into the parent script as a value, and is
  // checked when (and only when) the parent returns it.
  if (workflowDepth === 0) {
    assertJsonSerialisable(settlement.value, "workflow return value", "return value");
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
  const afterMeta = skipWhitespaceAndComments(withoutBom, bodyStart);
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
    validateEngineDefaults(engine, engineDefaults);
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

function compileWorkflowScript(workflow: ExtractedWorkflow, filename: string): vm.Script {
  try {
    return new vm.Script(buildWrappedSource(workflow), { filename });
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    const bodyWithoutDefaultsExport = workflow.bodySource.replace(
      /\bexport(?=\s+const\s+defaults\s*=)/g,
      "      "
    );
    if (bodyWithoutDefaultsExport === workflow.bodySource) {
      throw error;
    }

    try {
      new vm.Script(buildWrappedSource({ ...workflow, bodySource: bodyWithoutDefaultsExport }), { filename });
    } catch {
      throw new WorkflowScriptError(
        `Workflow body contains \`export const defaults\`, but its placement could not be checked because the body has another syntax error: ${error.message}`,
        { cause: error }
      );
    }

    throw new WorkflowScriptError(
      "Workflow `export const defaults` must follow `meta`, with only whitespace or comments between them",
      { cause: error }
    );
  }
}

function createSandboxContext(hooks: WorkflowHooks, meta: unknown): vm.Context {
  const bindings: Record<string, unknown> = {
    agent: hooks.agent,
    workflow: hooks.workflow,
    parallel: hooks.parallel,
    pipeline: hooks.pipeline,
    phase: hooks.phase,
    log: hooks.log,
    budget: hooks.budget,
    worktrees: hooks.worktrees,
    args: hooks.args,
    // The script's own declared meta, readable without redeclaring it.
    // Frozen: the body runs in strict mode, so a write throws rather than
    // silently mutating what the archive already recorded.
    meta: deepFreeze(structuredClone(meta)),
    // Side-effect-free platform globals, bound explicitly because scripts
    // demonstrably reach for them. Pure computation over values — no
    // filesystem, process, or network reach — so they widen convenience,
    // not capability. `Buffer` stays out: TextEncoder covers the
    // byte-length case without dragging Node-API expectations in.
    TextEncoder,
    TextDecoder,
    structuredClone,
    URL,
    URLSearchParams,
    atob,
    btoa,
    crypto: Object.freeze({
      randomUUID: () => crypto.randomUUID(),
      subtle: Object.freeze({
        digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => crypto.subtle.digest(algorithm, data)
      })
    })
  };
  const context = vm.createContext(bindings, {
    name: "ensemble-workflow-script",
    codeGeneration: {
      strings: false,
      wasm: false
    }
  });
  // The values are frozen or facades, but the *bindings* would still be
  // writable: `meta = {...}` would silently rebind the global. Lock every
  // binding so reassignment throws under strict mode. The explicit `value`
  // matters: inside a vm context, defineProperty without one clears the
  // binding instead of preserving it.
  for (const name of Object.keys(bindings)) {
    vm.runInContext(
      `Object.defineProperty(globalThis, ${JSON.stringify(name)}, { value: globalThis[${JSON.stringify(
        name
      )}], writable: false, configurable: false, enumerable: true });`,
      context
    );
  }
  return context;
}

/** Walks the parsed AST for any ImportExpression node (depth-first, cycle-free by construction). */
function containsImportExpression(node: unknown): boolean {
  if (typeof node !== "object" || node === null) {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some(containsImportExpression);
  }
  const record = node as Record<string, unknown>;
  if (record.type === "ImportExpression") {
    return true;
  }
  return Object.entries(record).some(
    ([key, child]) => key !== "parents" && typeof child === "object" && containsImportExpression(child)
  );
}

/**
 * Freeze without assuming acyclicity: meta is script-authored, and
 * `structuredClone` preserves cycles, so a naive recursion would overflow
 * the stack on a self-referential meta instead of loading it read-only.
 */
function deepFreeze(value: unknown): unknown {
  const seen = new Set<object>();
  const freeze = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    for (const child of Object.values(candidate)) {
      freeze(child);
    }
    Object.freeze(candidate);
  };
  freeze(value);
  return value;
}

/**
 * The identifiers a bare vm context supplies on its own — the ECMAScript
 * intrinsics (`JSON`, `Promise`, `Map`, …) plus vm's own scaffolding.
 * Enumerated from a real empty context rather than hand-listed, so the set
 * cannot drift from what the sandbox actually resolves; memoised because it
 * is identical for every script. Node globals (`Buffer`, `process`,
 * `setTimeout`, `fetch`) are absent from a vm context, which is exactly why
 * they must not be read from the host's `globalThis` here.
 */
let sandboxIntrinsics: Set<string> | undefined;

function vmIntrinsicNames(): Set<string> {
  if (sandboxIntrinsics === undefined) {
    const probe = vm.createContext({});
    const names = vm.runInContext(
      "Object.getOwnPropertyNames(globalThis)",
      probe
    ) as string[];
    sandboxIntrinsics = new Set(names);
  }
  return sandboxIntrinsics;
}

/**
 * Fail-loud-before-spend: a free identifier the sandbox does not bind fails
 * at load with the unknown names, instead of as a `ReferenceError` after
 * paid agent phases. `typeof`-only references are exempt — probing for an
 * absent global is the defensive idiom this check must not punish.
 */
function assertKnownFreeIdentifiers(wrappedSource: string, context: vm.Context, filename: string): void {
  const knownGlobals = new Set([...vmIntrinsicNames(), ...Object.keys(context as object)]);
  let found: ReturnType<typeof detectGlobals>;
  let ast: ReturnType<typeof detectGlobals.parse>;
  try {
    ast = detectGlobals.parse(wrappedSource);
    found = detectGlobals(ast);
  } catch {
    // The source already compiled under vm.Script; a parser disagreement here
    // must not reject a script the runtime can execute.
    return;
  }
  // Dynamic import is denied by the sandbox but introduces no free
  // identifier, so without this walk it would surface only at execution —
  // after paid agent phases, the exact late failure this check exists to
  // prevent.
  if (containsImportExpression(ast)) {
    throw new WorkflowScriptError(
      `Workflow ${filename} uses dynamic import(), which the sandbox does not provide. ` +
        "Scripts cannot load modules; the available hooks and platform globals are listed in the runtime README."
    );
  }
  const unknown = found
    // acorn-globals reports ThisExpression as a free name, but `this` is
    // syntax whose value V8 supplies wherever the compiled script permits it.
    .filter((global) => global.name !== "this")
    .filter((global) => !knownGlobals.has(global.name))
    .filter(
      (global) =>
        !global.nodes.every((node) => {
          const parents = (node as { parents?: Array<{ type?: string; operator?: string }> }).parents ?? [];
          const parent = parents[parents.length - 2];
          return parent?.type === "UnaryExpression" && parent.operator === "typeof";
        })
    )
    .map((global) => global.name);
  if (unknown.length > 0) {
    throw new WorkflowScriptError(
      `Workflow ${filename} references identifiers the sandbox does not provide: ${unknown.join(", ")}. ` +
        "Scripts run without Node globals (no require, process, or Buffer); the available hooks and " +
        "platform globals are listed in the runtime README."
    );
  }
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

function skipWhitespaceAndComments(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    index = skipWhitespace(source, index);
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index);
      continue;
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index);
      continue;
    }
    return index;
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
  let index = start + 2;
  while (index < source.length) {
    const char = source[index];
    if (char === "\r") {
      return source[index + 1] === "\n" ? index + 2 : index + 1;
    }
    if (char === "\n" || char === "\u2028" || char === "\u2029") {
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  if (end === -1) {
    throw new WorkflowScriptError("Workflow meta block comment is not terminated");
  }
  return end + 2;
}
