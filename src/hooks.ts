import { assertValidAgentOptions } from "./engine-option-validation.js";
import { PreSpawnAuthorError, agentIdentityOf } from "./errors.js";
import { presentOperationalError } from "./operator-diagnosis.js";

import type {
  AgentCallSignature,
  AgentOptions,
  Budget,
  EngineName,
  FallbackTarget,
  IdentifiedAgentResult,
  JsonSchema,
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
  createWorkerSession?: (options: WorkerSessionOptions) => WorkerSession;
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
}

/**
 * The per-engine policy knobs a script's `export const defaults` may set.
 * The chain is engine-agnostic — a Codex block may name a Claude target —
 * and is judged whole at load time like the rest of the block.
 */
export interface WorkflowEngineDefaults {
  model?: string;
  effort?: string;
  fallback?: FallbackTarget[];
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
  session: (options: WorkerSessionOptions) => WorkerSession;
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

  // The defaults-merging wrapper restates the canonical signatures so each
  // call site narrows exactly as a direct runtime call would; the merged
  // options flow through the runtime's general signature, so no cast is
  // needed anywhere in the plumbing.
  function agentWithDefaults(prompt: string, agentOptions: AgentOptions & { identity: true }): Promise<IdentifiedAgentResult>;
  function agentWithDefaults(prompt: string, agentOptions: AgentOptions & { schema: JsonSchema }): Promise<unknown | null>;
  function agentWithDefaults(prompt: string, agentOptions: AgentOptions & { schema?: undefined }): Promise<string>;
  function agentWithDefaults(prompt: string, agentOptions: Partial<AgentOptions>): Promise<string | unknown | null>;
  function agentWithDefaults(prompt: string, agentOptions?: Partial<AgentOptions>): Promise<string | unknown | null> {
    return options.runtime.agent(prompt, mergeAgentDefaults(defaults, agentOptions));
  }

  return {
    agent: agentWithDefaults,
    session: (sessionOptions) => {
      const createWorkerSession = options.runtime.createWorkerSession;
      if (createWorkerSession === undefined) {
        // Pre-spawn and loud, like every capability the runtime cannot
        // honour — never a silent no-op session.
        throw new PreSpawnAuthorError("this runtime does not support multi-turn worker sessions");
      }
      return createWorkerSession.call(options.runtime, mergeSessionDefaults(defaults, sessionOptions));
    },
    hold: (holdOptions) => {
      const raiseHold = options.runtime.raiseHold;
      if (raiseHold === undefined) {
        throw new PreSpawnAuthorError("this runtime does not support holds");
      }
      return raiseHold.call(options.runtime, holdOptions);
    },
    workflow: options.workflow,
    parallel: (thunks) => parallel(thunks, writeLog, options.presentError),
    pipeline: (items, ...stages) => pipeline(items, stages, writeLog, options.presentError),
    phase: (title) => {
      options.runtime.notePhase(title);
      writeLog(`[phase] ${title}`);
    },
    log: (message) => {
      writeLog(message);
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
        if (error instanceof PreSpawnAuthorError) {
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
        const identity = agentIdentityOf(error);
        if (identity !== null) {
          return {
            label: identity.label,
            phase: identity.phase,
            output: null,
            failure: { message: error instanceof Error ? error.message : String(error) }
          } as Awaited<T>;
        }
        return null;
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
          if (error instanceof PreSpawnAuthorError) {
            throw error;
          }
          presentError?.(error);
          log(`pipeline item ${index} stage ${stageIndex} failed: ${describeWorkerFailure(error)}`);
          // Same identity-preserving collapse as parallel(): the failed
          // item resolves its identity envelope — failure carried so a
          // failed leg is distinguishable from a genuine null answer — when
          // the failing call declared one, bare null otherwise.
          const identity = agentIdentityOf(error);
          if (identity !== null) {
            return {
              label: identity.label,
              phase: identity.phase,
              output: null,
              failure: { message: error instanceof Error ? error.message : String(error) }
            };
          }
          return null;
        }
      }

      return previous;
    })
  );
}

/**
 * Call-site options win over the script's per-engine defaults. Only *defined*
 * call-site values override — a conditional spread that leaves `model:
 * undefined` must not erase the default it was meant to fall back to.
 */
function mergeAgentDefaults(
  defaults: WorkflowDefaults,
  agentOptions: Partial<AgentOptions> | undefined
): Partial<AgentOptions> {
  assertValidAgentOptions(agentOptions ?? {});
  const engine = agentOptions?.engine;
  const engineDefaults = typeof engine === "string" ? defaults[engine] : undefined;
  if (engineDefaults === undefined) {
    return agentOptions ?? {};
  }
  const merged: Record<string, unknown> = { ...engineDefaults };
  for (const [key, value] of Object.entries(agentOptions ?? {})) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as Partial<AgentOptions>;
}

/**
 * The session analogue of {@link mergeAgentDefaults}: the engine block's
 * model, effort, and fallback chain apply where the creation call leaves them
 * unset, and defined call-site values win. Validation stays the runtime's —
 * this merge must not pre-judge keys.
 */
function mergeSessionDefaults(
  defaults: WorkflowDefaults,
  sessionOptions: WorkerSessionOptions
): WorkerSessionOptions {
  const engineDefaults = typeof sessionOptions.engine === "string" ? defaults[sessionOptions.engine] : undefined;
  if (engineDefaults === undefined) {
    return sessionOptions;
  }
  const merged: Record<string, unknown> = { ...engineDefaults };
  for (const [key, value] of Object.entries(sessionOptions)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged as unknown as WorkerSessionOptions;
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
