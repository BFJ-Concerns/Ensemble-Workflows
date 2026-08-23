import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as acorn from "acorn";
import detectGlobals from "acorn-globals";

import { validateEngineDefaults } from "./engine-option-validation.js";
import { EnsembleError, PreSpawnAuthorError } from "./errors.js";

import type { OpenCodeModelRegistry } from "./opencode-model-registry.js";
import { createWorkflowHooks } from "./hooks.js";
import {
  NestedWorkflowError,
  WorkflowResolutionError,
  resolveWorkflowReference
} from "./workflow-registry.js";

import type { WorkflowDefaults, WorkflowEngineDefaults, WorkflowLogSink, WorkflowRuntime } from "./hooks.js";
import type { WorkflowReference } from "./workflow-registry.js";

/**
 * Workflow-authoring errors — script shape, load-time checks, defaults
 * validation, and the output-boundary contract. A member of the pre-spawn
 * author-error family: every instance that can reach a combinator thunk is
 * raised before a worker spawns (a bad `workflow()` argument, a composed
 * child's load-time failure), so the combinators propagate it rather than
 * collapsing a fan-out of identical author mistakes to a filterable
 * all-null success. The settlement-time return-value check also uses this
 * class, but it runs only at the top-level run's own surface (depth 0),
 * where no combinator sits between it and the caller.
 */
export class WorkflowScriptError extends PreSpawnAuthorError {}

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
 * The fail-loud set is a function, a symbol, a cycle, or a
 * BigInt (the values stringify drops silently or throws on).
 *
 * Call this on the exact value that will cross the boundary — after any
 * normalisation — never on a precursor: a clone can differ from its source
 * in precisely the properties this check judges. The final stringify probe
 * backstops the walk for exotic values the traversal cannot see (a boxed
 * BigInt has no enumerable properties to walk), so approval here means the
 * downstream stringify genuinely cannot throw.
 */
export function assertJsonSerialisable(value: unknown, label: string, pathRoot: string): void {
  const offence = findUnserialisable(value, pathRoot, new Set(), true);
  if (offence !== null) {
    throw new WorkflowScriptError(`${label} must be a JSON value: ${offence}`);
  }
  try {
    JSON.stringify(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowScriptError(`${label} must be a JSON value: JSON.stringify rejected it (${message})`);
  }
}

function findUnserialisable(value: unknown, path: string, ancestors: Set<object>, honourToJson: boolean): string | null {
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
  if (honourToJson && typeof toJson === "function") {
    // Mirror JSON.stringify: toJSON is invoked once per value, and its
    // result is serialised without consulting toJSON again on that same
    // value (nested values inside it are judged normally). Re-honouring it
    // here sent `{ toJSON() { return this; } }` — a value stringify accepts
    // — into unbounded recursion.
    return findUnserialisable(toJson.call(value), path, ancestors, false);
  }
  if (ancestors.has(value)) {
    return `${path} closes a cycle`;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const offence = findUnserialisable(value[index], `${path}[${index}]`, ancestors, true);
        if (offence !== null) {
          return offence;
        }
      }
      return null;
    }
    for (const [key, entry] of Object.entries(value)) {
      const offence = findUnserialisable(entry, `${path}.${key}`, ancestors, true);
      if (offence !== null) {
        return offence;
      }
    }
    return null;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Deliberately outside the pre-spawn author-error family: a breached
 * deadline is an operational bound, not an authoring mistake, so it takes
 * the ordinary failure path rather than the combinators' propagation
 * exemption. (Historically a `WorkflowScriptError` subclass; re-parented
 * when that class joined the family.)
 */
export class WorkflowTimeoutError extends EnsembleError {
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
  /**
   * Called once per composed-child invocation, before the child runs, with
   * the resolved script path, its source, and its arguments. The supplied
   * callback owns its own failure handling — recording is observability, so
   * an implementation that can fail reports rather than throws (the CLI's
   * does; see `runRecord/writeFailed`).
   */
  onWorkflowInvocation?: (invocation: { scriptPath: string; source: string; args: unknown }) => void | Promise<void>;
}

interface ExtractedWorkflow {
  metaSource: string;
  /** Source of the optional `export const defaults = { … }` block, or null. */
  defaultsSource: string | null;
  bodySource: string;
}

/**
 * The identifiers the wrapper binds into the body's scope, in one place so
 * the wrapper's destructuring, the bindings object, and the load-time
 * free-identifier allowlist cannot drift apart. `meta` is the script's own
 * frozen export; `require` is a CommonJS loader resolving from the script's
 * path — dynamic `import()` and `import.meta` need no binding because the
 * body executes as a genuine ES module.
 */
const HOOK_BINDING_NAMES = [
  "agent",
  "workflow",
  "parallel",
  "pipeline",
  "phase",
  "log",
  "budget",
  "worktrees",
  "args",
  "meta",
  "require"
] as const;

type WorkflowBodyBindings = Record<(typeof HOOK_BINDING_NAMES)[number], unknown>;

type WorkflowBodyFunction = (bindings: WorkflowBodyBindings) => Promise<unknown>;

export async function runWorkflowScript(options: RunWorkflowScriptOptions): Promise<WorkflowScriptResult> {
  const extracted = extractWorkflowSource(options.source);
  const defaults = readWorkflowDefaults(
    extracted.defaultsSource,
    options.filename,
    // Validate against the registry the runtime will actually dispatch with:
    // one registry choice, consulted at both load and dispatch.
    options.runtime.openCodeModelRegistry
  );
  const resolvedFilename = path.resolve(options.filename);
  const cwd = options.cwd ?? path.dirname(resolvedFilename);
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
            // Provenance before execution, matching the dispatch-time agent
            // write: a child that dies mid-run still leaves evidence it was
            // invoked, with what source and which arguments.
            await options.onWorkflowInvocation?.({ scriptPath, source, args: args ?? [] });
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
  // Meta is evaluated ahead of the body so it can be bound read-only: the
  // script may read the object it was required to declare, never mutate it.
  const declaredMeta = readWorkflowMeta(options.source, options.filename);
  assertKnownFreeIdentifiers(buildWrappedSource(extracted), options.filename);
  const run = await importWorkflowBody(extracted, resolvedFilename);
  const bindings: WorkflowBodyBindings = {
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
    // Frozen, and destructured as a `const` binding in the module wrapper
    // (modules are strict code), so both a property write and a wholesale
    // rebinding throw rather than silently mutating what the archive
    // already recorded.
    meta: deepFreeze(cloneDeclaredMeta(declaredMeta)),
    // Module loading resolves from the script's own path: relative
    // specifiers and node_modules walks behave as they would for a module
    // sitting where the script sits.
    require: createRequire(resolvedFilename)
  };
  // The body starts here: its synchronous prefix runs inside this call, and
  // everything after its first await settles through the returned promise.
  const resultPromise = run(bindings);
  const resultSettlement = resultPromise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error })
  );
  // Meta is known the moment the script evaluates — surface it before awaiting
  // the body so a live status view can name the run from the start.
  await options.onMeta?.(declaredMeta);
  const settlement = await withTimeout(resultSettlement, options.timeoutMs);
  if (settlement.status === "rejected") {
    throw settlement.error;
  }
  // Settlement-time check, on the value the body actually produced: the
  // return value is printed, hashed, and archived, so a non-JSON value
  // fails the run loudly here rather than collapsing to a lossy `null`
  // downstream. Judged on the *normalised* value — the one the CLI will
  // stringify — never the raw one: structuredClone drops prototypes
  // (and with them prototype toJSON methods), so the two can differ in
  // exactly the properties this check exists to judge. Only the top-level
  // run's return crosses that boundary — a child's return flows back into
  // the parent script as a value, and is checked when (and only when) the
  // parent returns it.
  const result = normaliseResultValue(settlement.value);
  if (workflowDepth === 0) {
    assertJsonSerialisable(result, "workflow return value", "return value");
  }
  return {
    meta: declaredMeta,
    result
  };
}

/**
 * `meta` and `defaults` are object literals evaluated ahead of the body, and
 * they stay inside a bare `node:vm` context with a short synchronous timeout
 * deliberately: registry listing evaluates the meta of every saved workflow,
 * so a literal with a spinning getter must be bounded there even though the
 * body itself now runs as ordinary, unbounded Node code. This is literal
 * evaluation, not the retired sandbox.
 */
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

  // Optional second export: `export const defaults = { … }` directly after meta.
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
  filename: string = "workflow.js",
  openCodeModelRegistry?: OpenCodeModelRegistry
): WorkflowDefaults | undefined {
  if (defaultsSource === null) {
    return undefined;
  }
  const script = new vm.Script(`(${defaultsSource});`, { filename });
  const value = normaliseVmValue(script.runInNewContext(undefined, { timeout: 100 }));
  return validateWorkflowDefaults(value, openCodeModelRegistry);
}

function validateWorkflowDefaults(value: unknown, openCodeModelRegistry?: OpenCodeModelRegistry): WorkflowDefaults {
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
    // Consult the runtime's own registry when the caller supplies one, so an
    // injected registry cannot make load time reject a model dispatch would
    // accept (the over-strict direction — worse than no check at all).
    validateEngineDefaults(engine, engineDefaults, openCodeModelRegistry);
    defaults[engine] = engineDefaults;
  }
  return defaults;
}

function buildWrappedSource(workflow: ExtractedWorkflow): string {
  return `export default async (__ensembleHooks) => {
const { ${HOOK_BINDING_NAMES.join(", ")} } = __ensembleHooks;
${workflow.bodySource}
};`;
}

/**
 * Workflow bodies execute as genuine ES modules served from memory: the
 * wrapped source is registered against the script's own file URL (tagged
 * with a run-unique query so the module cache never returns a stale body),
 * and a `node:module` load hook serves it instead of the on-disk bytes.
 * Executing under the script's own URL is what makes the full-Node contract
 * hold without a temp file: `import.meta.url` names the script's location,
 * and relative and bare dynamic `import()` specifiers resolve exactly as
 * they would for a module at that path.
 */
const pendingWorkflowModules = new Map<string, string>();
let workflowModuleLoaderRegistered = false;

function ensureWorkflowModuleLoader(): void {
  if (workflowModuleLoaderRegistered) {
    return;
  }
  registerHooks({
    // The resolve hook must short-circuit too: default resolution stats a
    // file: URL for existence before load is consulted, and the script's
    // source is not required to exist on disk (a library caller passes
    // source directly; the CLI's synthetic direct-agent workflow has no
    // file at all).
    resolve(specifier, context, nextResolve) {
      if (pendingWorkflowModules.has(specifier)) {
        return { url: specifier, format: "module", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const source = pendingWorkflowModules.get(url);
      if (source !== undefined) {
        return { format: "module", source, shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  workflowModuleLoaderRegistered = true;
}

async function importWrappedModule(wrappedSource: string, filename: string): Promise<Record<string, unknown>> {
  ensureWorkflowModuleLoader();
  const url = `${pathToFileURL(filename).href}?ensemble-workflow-run=${randomUUID()}`;
  pendingWorkflowModules.set(url, wrappedSource);
  try {
    return (await import(url)) as Record<string, unknown>;
  } finally {
    pendingWorkflowModules.delete(url);
  }
}

/**
 * Compile-and-load with author-facing diagnostics: V8 is the syntax
 * authority (nothing here rejects what Node would execute), and the one
 * shape error worth explaining — `export const defaults` declared in the
 * body instead of directly after `meta` — is diagnosed by recompiling with
 * that export blanked, exactly as the vm-era compile step did.
 */
async function importWorkflowBody(workflow: ExtractedWorkflow, filename: string): Promise<WorkflowBodyFunction> {
  let namespace: Record<string, unknown>;
  try {
    namespace = await importWrappedModule(buildWrappedSource(workflow), filename);
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
      await importWrappedModule(buildWrappedSource({ ...workflow, bodySource: bodyWithoutDefaultsExport }), filename);
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
  const run = namespace.default;
  if (typeof run !== "function") {
    throw new WorkflowScriptError("Workflow script did not produce a runnable body");
  }
  return run as WorkflowBodyFunction;
}

/**
 * The bound `meta` is a frozen clone, so an uncloneable meta (a method in
 * the literal survives `normaliseVmValue`'s degrade-to-raw path) must fail
 * as the authoring mistake it is — one clean line naming what to change —
 * not as a raw DataCloneError with a stack.
 */
function cloneDeclaredMeta(meta: unknown): unknown {
  try {
    return structuredClone(meta);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowScriptError(
      `Workflow meta must be a plain data literal the runtime can clone and freeze: ${message}`,
      { cause: error }
    );
  }
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
 * Fail-loud-before-spend: a free identifier that is neither a Node global,
 * a bound hook, nor a module-scope binding fails at load with the unknown
 * names, instead of as a `ReferenceError` after paid agent phases. The
 * allowlist is enumerated from the real `globalThis` at check time rather
 * than hand-listed, so it cannot drift from what the executing module
 * actually resolves. `typeof`-only references are exempt — probing for an
 * absent global is the defensive idiom this check must not punish — and the
 * hook names are included for robustness even though the wrapper's `const`
 * destructuring already keeps them from being free.
 */
function assertKnownFreeIdentifiers(wrappedSource: string, filename: string): void {
  const knownGlobals = new Set([...Object.getOwnPropertyNames(globalThis), ...HOOK_BINDING_NAMES]);
  let found: ReturnType<typeof detectGlobals>;
  try {
    // Module grammar, matching how the wrapper actually executes — the body
    // may legally contain dynamic `import()` and `import.meta`.
    const ast = acorn.parse(wrappedSource, { ecmaVersion: "latest", sourceType: "module" });
    found = detectGlobals(ast as never);
  } catch {
    // V8 is the syntax authority: a parser disagreement here must not
    // reject a script Node can execute, so the check degrades to nothing
    // and any genuine syntax error surfaces from the module load instead.
    return;
  }
  const unknown = found
    // acorn-globals reports ThisExpression as a free name, but `this` is
    // syntax whose value V8 supplies wherever the compiled module permits it.
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
      `Workflow ${filename} references identifiers that are not defined: ${unknown.join(", ")}. ` +
        "A free identifier must be a Node global, a bound hook, or a module-scope binding " +
        "(require, dynamic import(), import.meta) — a mistyped name fails here, at load, " +
        "before any worker spawns."
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
  // A reference the runtime cannot even narrow is a resolution failure,
  // the same family the registry raises for a mistyped name.
  throw new WorkflowResolutionError("workflow() expects a workflow name string or { scriptPath: string }");
}

/**
 * The return value crosses a structured-clone boundary before it is
 * stringified: the clone is the documented normalisation (prototypes and
 * their toJSON methods do not survive it), and the serialisability check
 * judges exactly this value. A value the clone rejects is kept as-is —
 * the settlement check then names what stringify would lose.
 */
function normaliseResultValue(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** Meta and defaults literals cross out of their evaluation vm the same way. */
function normaliseVmValue(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
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
