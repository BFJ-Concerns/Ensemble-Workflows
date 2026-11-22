import { assertValidAgentOptions } from "./engine-option-validation.js";
import { withRemapFallback } from "./dispatch-remap.js";
import { attributeMergedChain, selectFallback } from "./fallback-source.js";
import { withDeclaredModels, withTargetChain } from "./named-targets.js";
import { BudgetExceededError, PreSpawnAuthorError, agentIdentityOf, describeError, isRunEnding } from "./errors.js";
import { presentOperationalError } from "./operator-diagnosis.js";

import type {
  AgentCallSignature,
  AgentOptions,
  AgentRequest,
  Budget,
  DispatchLookup,
  EngineName,
  FallbackTarget,
  IdentifiedAgentResult,
  JsonSchema,
  LiteralWorkerSessionOptions,
  WorkerSessionOptions
} from "./types.js";
import type { WorkerSession } from "./runtime.js";
import type { HoldDecision, RaiseHoldOptions } from "./holds.js";
import type { IsolatedWorktreeRecord } from "./worktree-isolation.js";
import type { OpenCodeModelRegistry } from "./opencode-model-registry.js";

export interface WorkflowRuntime {
  readonly budget: Budget;
  readonly worktrees: readonly IsolatedWorktreeRecord[];
  /**
   * The opencode registry this runtime's dispatch consults, so load-time
   * validation reads the same one. Optional: a runtime that does not expose
   * it validates against the module default, as before.
   */
  readonly openCodeModelRegistry?: OpenCodeModelRegistry | undefined;
  /**
   * Holds a combinator's promise open from creation to settlement as the
   * runtime holds `agent()`'s own, so the run's ending rejecting it is
   * marked handled at close when the script never awaited it. Optional: a
   * runtime without it leaves an un-awaited combinator's rejection to Node.
   */
  trackCallPromise?: <T>(promise: Promise<T>) => Promise<T>;
  // The canonical overload set, not a Parameters/ReturnType projection of
  // the runtime method: TypeScript resolves those utility types to the
  // *last* overload alone, which is exactly the collapse that hid the
  // schema and identity signatures from hooks consumers.
  agent: AgentCallSignature;
  /**
   * Multi-turn worker sessions; see EnsembleRuntime.createWorkerSession.
   * Optional so a minimal WorkflowRuntime (a test fake, an embedding) stays
   * valid; the `session` hook fails loud, pre-spawn, when it is absent.
   */
  createWorkerSession?: (options: WorkerSessionOptions) => WorkerSession<boolean>;
  /**
   * Runtime holds; see EnsembleRuntime.raiseHold. Optional on the
   * same terms as createWorkerSession; the `hold` hook fails loud when
   * absent.
   */
  raiseHold?: (options: RaiseHoldOptions) => Promise<HoldDecision>;
  notePhase: (title: string) => void;
  /**
   * Script-recorded tallies; see EnsembleRuntime.recordTally.
   * Optional on the same terms as the other capabilities; the `tally`
   * hook fails loud when absent.
   */
  recordTally?: (name: string, value: number) => Promise<void>;
  /**
   * Resolve a call's named target against the run's bindings before its
   * `defaults` merge; see EnsembleRuntime.resolveNamedTarget. Optional: a
   * runtime without it receives the call's `target` unresolved and judges
   * it itself, with no script `defaults` for the resolved engine applied.
   */
  resolveNamedTarget?: <T extends object>(options: T) => T;
  /**
   * Judge a declared fallback chain's named entries against the run's
   * bindings, throwing before spawn as a dispatch would; see
   * EnsembleRuntime.settleFallbackChain. The script runner calls it on a
   * script's `defaults` chains before the body runs. Optional: without it
   * those entries are judged at dispatch.
   */
  settleFallbackChain?: (chain: readonly FallbackTarget[]) => void;
  /**
   * The dispatch lookup; see EnsembleRuntime.lookupDispatch. Optional on
   * the same terms as the other capabilities; the `lookupDispatch` hook
   * fails loud when absent.
   */
  lookupDispatch?: (
    options: Partial<AgentRequest> | undefined,
    applyDefaults: (resolved: Partial<AgentOptions>) => Partial<AgentOptions>
  ) => DispatchLookup;
}

/**
 * The per-engine policy knobs a script's `export const defaults` may set.
 * The chain is engine-agnostic — a Codex block may name a Claude target —
 * and is judged whole at load time like the rest of the block.
 */
export interface WorkflowEngineDefaults {
  model?: string;
  effort?: string;
  fallback?: FallbackTarget[] | false;
}

export type WorkflowDefaults = Partial<Record<EngineName, WorkflowEngineDefaults>>;

export type WorkflowLogSink = (message: string) => void;

export interface WorkflowHooks {
  agent: WorkflowRuntime["agent"];
  /**
   * Create a multi-turn worker session. Script defaults merge exactly
   * as for `agent()`: the session's engine block supplies model, effort,
   * and the fallback chain where the call leaves them unset.
   */
  session: {
    (options: WorkerSessionOptions & { identity: true }): WorkerSession<true>;
    (options: WorkerSessionOptions & { identity?: false }): WorkerSession<false>;
    (options: WorkerSessionOptions): WorkerSession<boolean>;
  };
  /**
   * Raise a hold and await its decision: content and accepted
   * verdicts in, the decider's verdict (and note) back, from a decision
   * file any process can write.
   */
  hold: (options: RaiseHoldOptions) => Promise<HoldDecision>;
  workflow: (nameOrRef: unknown, args?: unknown) => Promise<unknown>;
  parallel: <T>(thunks: Array<() => T | Promise<T>>) => Promise<Array<Awaited<T> | null>>;
  pipeline: <Item>(
    items: Item[],
    ...stages: Array<(previous: unknown, originalItem: Item, index: number) => unknown | Promise<unknown>>
  ) => Promise<unknown[]>;
  phase: (title: string) => void;
  log: (message: string) => void;
  /**
   * Record a named count into the run record: `await tally("fix
   * rounds", 3)`. Numbers only, last write wins per name; the archive
   * carries them beside the usage summary for a reader who never opens a
   * transcript.
   */
  tally: (name: string, value: number) => Promise<void>;
  /**
   * The dispatch lookup: `lookupDispatch({ target: "reviewer" })` answers
   * where `agent()` given those options would first dispatch — engine,
   * model and model family — with nothing dispatched, the script's
   * `defaults` applied as the call would apply them. An unbound target
   * answers `bound: false`.
   */
  lookupDispatch: (options?: Partial<AgentRequest>) => DispatchLookup;
  budget: Budget;
  worktrees: readonly IsolatedWorktreeRecord[];
  args: unknown;
}

export function createWorkflowHooks(options: {
  runtime: WorkflowRuntime;
  args: unknown;
  log: WorkflowLogSink;
  workflow: (nameOrRef: unknown, args?: unknown) => Promise<unknown>;
  /** Presents a caught author error before the combinator logs its stack. */
  presentError?: (error: unknown) => void;
  /** Script-level `export const defaults`; per-call options override it. */
  defaults?: WorkflowDefaults;
}): WorkflowHooks {
  const writeLog = (message: string): void => {
    options.log(message);
  };
  const defaults = options.defaults ?? {};
  // The combinators' promises are the script's to await or not; the run's
  // ending rejects them (hooks rethrow it), so they are held open like a
  // call's own promise and marked handled at close when nothing awaits.
  const track = <T,>(promise: Promise<T>): Promise<T> =>
    options.runtime.trackCallPromise !== undefined ? options.runtime.trackCallPromise(promise) : promise;

  // A named chain entry whose binding names no model takes the script's
  // model for the bound engine, as a call naming that engine would.
  const declaredModel = (engine: EngineName): string | undefined => defaults[engine]?.model;
  // A named target resolves before the merge, so the `defaults` block that
  // applies is the resolved engine's.
  const resolveTarget = <T extends object>(declared: T): T =>
    options.runtime.resolveNamedTarget !== undefined ? options.runtime.resolveNamedTarget(declared) : declared;

  // The defaults-merging wrapper restates the canonical signatures so each
  // call site narrows exactly as a direct runtime call would; the merged
  // options flow through the runtime's general signature, so no cast is
  // needed anywhere in the plumbing.
  function agentWithDefaults(prompt: string, agentOptions: AgentRequest & { identity: true }): Promise<IdentifiedAgentResult>;
  function agentWithDefaults(prompt: string, agentOptions: AgentRequest & { schema: JsonSchema }): Promise<unknown | null>;
  function agentWithDefaults(prompt: string, agentOptions: AgentRequest & { schema?: undefined }): Promise<string | null>;
  function agentWithDefaults(prompt: string, agentOptions: Partial<AgentOptions>): Promise<string | unknown | null>;
  function agentWithDefaults(prompt: string, agentOptions?: Partial<AgentOptions>): Promise<string | unknown | null> {
    return options.runtime.agent(prompt, withDeclaredModels(mergeAgentDefaults(defaults, agentOptions, resolveTarget), declaredModel));
  }

  return {
    agent: agentWithDefaults,
    session: ((sessionOptions: WorkerSessionOptions) => {
      const createWorkerSession = options.runtime.createWorkerSession;
      if (createWorkerSession === undefined) {
        // Pre-spawn and loud, like every capability the runtime cannot
        // honour — never a silent no-op session.
        throw new PreSpawnAuthorError("this runtime does not support multi-turn worker sessions");
      }
      return createWorkerSession.call(options.runtime, withDeclaredModels(mergeSessionDefaults(defaults, sessionOptions, resolveTarget), declaredModel));
    }) as WorkflowHooks["session"],
    hold: (holdOptions) => {
      const raiseHold = options.runtime.raiseHold;
      if (raiseHold === undefined) {
        throw new PreSpawnAuthorError("this runtime does not support holds");
      }
      return raiseHold.call(options.runtime, holdOptions);
    },
    workflow: options.workflow,
    parallel: (thunks) => track(parallel(thunks, writeLog, options.presentError)),
    pipeline: (items, ...stages) => track(pipeline(items, stages, writeLog, options.presentError)),
    phase: (title) => {
      options.runtime.notePhase(title);
      writeLog(`[phase] ${title}`);
    },
    log: (message) => {
      writeLog(message);
    },
    lookupDispatch: (lookupOptions) => {
      const lookupDispatch = options.runtime.lookupDispatch;
      if (lookupDispatch === undefined) {
        throw new PreSpawnAuthorError("this runtime does not support the dispatch lookup");
      }
      return lookupDispatch.call(options.runtime, lookupOptions, (resolved) => withDeclaredModels(applyAgentDefaults(defaults, resolved), declaredModel));
    },
    tally: (name, value) => {
      const recordTally = options.runtime.recordTally;
      if (recordTally === undefined) {
        throw new PreSpawnAuthorError("this runtime does not support tallies");
      }
      return recordTally.call(options.runtime, name, value);
    },
    // A read-only facade: handing the live TokenBudget to the script would
    // expose record() and the events array to script mutation.
    budget: {
      spent: (engine) => options.runtime.budget.spent(engine),
      remaining: (engine) => options.runtime.budget.remaining(engine)
    },
    worktrees: options.runtime.worktrees,
    args: Array.isArray(options.args) ? [...options.args] : options.args
  };
}

export async function parallel<T>(
  thunks: Array<() => T | Promise<T>>,
  log: WorkflowLogSink,
  presentError?: (error: unknown) => void
): Promise<Array<Awaited<T> | null>> {
  return Promise.all(
    thunks.map(async (thunk, index) => {
      try {
        return await thunk();
      } catch (error) {
        // The exempt family, not one class: any pre-spawn author error —
        // a rejected option, an unresolvable workflow() reference, a
        // nesting violation — fails the run rather than nulling the slot.
        // Budget refusals also propagate: a refused dispatch or turn is
        // not a worker failure. The run's own ending passes through too:
        // a leg torn down at shutdown is not a worker failing. Collapsing
        // it would let the body resume and act on a run that has ended.
        if (error instanceof PreSpawnAuthorError || error instanceof BudgetExceededError || isRunEnding(error)) {
          throw error;
        }
        presentError?.(error);
        log(`parallel thunk ${index} failed: ${describeWorkerFailure(error)}`);
        // An identified call's failure keeps its identity: the carrier
        // the runtime attached becomes the envelope the fan-in reads, with
        // output null carrying the collapse and `failure` carrying the
        // discrimination — a failed leg is in-script distinguishable from
        // one that legitimately answered null. The envelope *is* the
        // thunk's declared resolution shape for an identity: true call.
        return (collapsedEnvelope(error) ?? null) as Awaited<T> | null;
      }
    })
  );
}

export async function pipeline<Item>(
  items: Item[],
  stages: Array<(previous: unknown, originalItem: Item, index: number) => unknown | Promise<unknown>>,
  log: WorkflowLogSink,
  presentError?: (error: unknown) => void
): Promise<unknown[]> {
  return Promise.all(
    items.map(async (item, index) => {
      let previous: unknown = item;

      for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
        const stage = stages[stageIndex];
        if (stage === undefined) {
          throw new Error(`pipeline stage ${stageIndex} is missing`);
        }

        try {
          previous = await stage(previous, item, index);
        } catch (error) {
          // Same pass-throughs as parallel(): author errors, budget
          // refusals, and the run's own ending.
          if (error instanceof PreSpawnAuthorError || error instanceof BudgetExceededError || isRunEnding(error)) {
            throw error;
          }
          presentError?.(error);
          log(`pipeline item ${index} stage ${stageIndex} failed: ${describeWorkerFailure(error)}`);
          // Same identity-preserving collapse as parallel(): the failed
          // item resolves its identity envelope — failure carried so a
          // failed leg is distinguishable from a genuine null answer — when
          // the failing call declared one, bare null otherwise.
          return collapsedEnvelope(error);
        }
      }

      return previous;
    })
  );
}

/**
 * The envelope a collapsed identified leg resolves to: its label and phase
 * from the identity the runtime attached to the failure, no output, the
 * failure's account, and no answering target. Null for a failure that
 * carries no identity — a call that did not opt in.
 */
function collapsedEnvelope(error: unknown): IdentifiedAgentResult | null {
  const identity = agentIdentityOf(error);
  if (identity === null) {
    return null;
  }
  return { label: identity.label, phase: identity.phase, output: null, failure: describeError(error), answeredBy: null };
}

/**
 * Call-site options win over the script's per-engine defaults. Only *defined*
 * call-site values override — a conditional spread that leaves `model:
 * undefined` must not erase the default it was meant to fall back to.
 *
 * A call naming a target is resolved first, so its engine is the binding's
 * and so is its model where the binding names one; the block for that
 * engine then fills what the call and binding left unsaid, as for a call
 * naming the engine literally. A chain the call and the block both leave
 * undeclared comes from the binding.
 */
function mergeAgentDefaults(
  defaults: WorkflowDefaults,
  agentOptions: Partial<AgentOptions> | undefined,
  resolveTarget: <T extends object>(declared: T) => T
): Partial<AgentOptions> {
  assertValidAgentOptions(agentOptions ?? {});
  return applyAgentDefaults(defaults, resolveTarget(agentOptions ?? {}));
}

/**
 * The second half of {@link mergeAgentDefaults}: the script's block for the
 * engine `declared` already names (a target resolved) fills what it leaves
 * unsaid. The dispatch lookup applies it alone, after judging the target.
 */
function applyAgentDefaults(defaults: WorkflowDefaults, declared: Partial<AgentOptions>): Partial<AgentOptions> {
  return withFallbackDefaults(defaults, declared, mergeResolvedAgentDefaults(defaults, declared));
}

function mergeResolvedAgentDefaults(defaults: WorkflowDefaults, declared: Partial<AgentOptions>): Partial<AgentOptions> {
  const engine = declared.engine;
  const engineDefaults = typeof engine === "string" ? defaults[engine] : undefined;
  if (engine === undefined || engineDefaults === undefined) {
    // No block to merge: the options are the call's own (resolved), and the
    // runtime attributes their chain to the call, the target or none.
    return withTargetChain(declared, declared);
  }
  const merged: Record<string, unknown> = { ...engineDefaults };
  for (const [key, value] of Object.entries(declared)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return withTargetChain(declared, attributeMergedChain(merged as Partial<AgentOptions>, declared.fallback, engine));
}

/**
 * The session analogue of {@link mergeAgentDefaults}: the engine block's
 * model, effort, and fallback chain apply where the creation call leaves them
 * unset, and defined call-site values win. Validation stays the runtime's —
 * this merge must not pre-judge keys.
 */
function mergeSessionDefaults(
  defaults: WorkflowDefaults,
  sessionOptions: WorkerSessionOptions,
  resolveTarget: <T extends object>(declared: T) => T
): LiteralWorkerSessionOptions {
  const declared = resolveTarget(sessionOptions as LiteralWorkerSessionOptions);
  return withFallbackDefaults(defaults, declared, mergeResolvedSessionDefaults(defaults, declared));
}

function mergeResolvedSessionDefaults(defaults: WorkflowDefaults, declared: LiteralWorkerSessionOptions): LiteralWorkerSessionOptions {
  const engineDefaults = typeof declared.engine === "string" ? defaults[declared.engine] : undefined;
  if (engineDefaults === undefined) {
    return withTargetChain(declared, declared);
  }
  const merged: Record<string, unknown> = { ...engineDefaults };
  for (const [key, value] of Object.entries(declared)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return withTargetChain(declared, attributeMergedChain(merged as unknown as LiteralWorkerSessionOptions, declared.fallback, declared.engine));
}

/** Carry call, destination defaults and binding precedence into a remapped dispatch. */
function withFallbackDefaults<T extends object>(
  defaults: WorkflowDefaults,
  declared: Pick<Partial<AgentOptions>, "fallback">,
  merged: T
): T {
  return withRemapFallback(merged, (engine) => {
    const fallback = defaults[engine]?.fallback;
    const options = withTargetChain(declared, attributeMergedChain(
      fallback === undefined ? {} : { fallback }, declared.fallback, engine
    ));
    return selectFallback(options, options, undefined);
  });
}

/**
 * A collapsed leg's log line goes through the shared operator seam first:
 * a worker's operational death is presented as its cause, not as a stack
 * of harness frames attributed to the author's fan-out. Undiagnosed
 * errors keep their stack — evidence over tidiness.
 */
function describeWorkerFailure(error: unknown): string {
  const presented = presentOperationalError(error);
  if (presented !== null) {
    return presented;
  }
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}
