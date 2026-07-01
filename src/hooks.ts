import type { AgentOptions, Budget, EngineName } from "./types.js";
import type { EnsembleRuntime } from "./runtime.js";
import type { IsolatedWorktreeRecord } from "./worktree-isolation.js";

export interface WorkflowRuntime {
  readonly budget: Budget;
  readonly worktrees: readonly IsolatedWorktreeRecord[];
  agent: (...args: Parameters<EnsembleRuntime["agent"]>) => ReturnType<EnsembleRuntime["agent"]>;
  notePhase: (title: string) => void;
}

/** The per-engine policy knobs a script's `export const defaults` may set. */
export interface WorkflowEngineDefaults {
  model?: string;
  effort?: string;
  fallbackModel?: string;
}

export type WorkflowDefaults = Partial<Record<EngineName, WorkflowEngineDefaults>>;

export type WorkflowLogSink = (message: string) => void;

export interface WorkflowHooks {
  agent: WorkflowRuntime["agent"];
  workflow: (nameOrRef: unknown, args?: unknown) => Promise<unknown>;
  parallel: <T>(thunks: Array<() => T | Promise<T>>) => Promise<Array<Awaited<T> | null>>;
  pipeline: <Item>(
    items: Item[],
    ...stages: Array<(previous: unknown, originalItem: Item, index: number) => unknown | Promise<unknown>>
  ) => Promise<unknown[]>;
  phase: (title: string) => void;
  log: (message: string) => void;
  budget: Budget;
  worktrees: readonly IsolatedWorktreeRecord[];
  args: unknown;
}

export function createWorkflowHooks(options: {
  runtime: WorkflowRuntime;
  args: unknown;
  log: WorkflowLogSink;
  workflow: (nameOrRef: unknown, args?: unknown) => Promise<unknown>;
  /** Script-level `export const defaults`; per-call options override it. */
  defaults?: WorkflowDefaults;
}): WorkflowHooks {
  const writeLog = (message: string): void => {
    options.log(message);
  };
  const runtimeAgent = options.runtime.agent.bind(options.runtime) as WorkflowRuntime["agent"];
  const defaults = options.defaults ?? {};

  return {
    agent: ((prompt: string, agentOptions?: Partial<AgentOptions>) =>
      runtimeAgent(prompt, mergeAgentDefaults(defaults, agentOptions) as never)) as WorkflowRuntime["agent"],
    workflow: options.workflow,
    parallel: (thunks) => parallel(thunks, writeLog),
    pipeline: (items, ...stages) => pipeline(items, stages, writeLog),
    phase: (title) => {
      options.runtime.notePhase(title);
      writeLog(`[phase] ${title}`);
    },
    log: (message) => {
      writeLog(message);
    },
    // A read-only facade: handing the live TokenBudget into the sandbox would
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
  log: WorkflowLogSink
): Promise<Array<Awaited<T> | null>> {
  return Promise.all(
    thunks.map(async (thunk, index) => {
      try {
        return await thunk();
      } catch (error) {
        log(`parallel thunk ${index} failed: ${formatError(error)}`);
        return null;
      }
    })
  );
}

export async function pipeline<Item>(
  items: Item[],
  stages: Array<(previous: unknown, originalItem: Item, index: number) => unknown | Promise<unknown>>,
  log: WorkflowLogSink
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
          log(`pipeline item ${index} stage ${stageIndex} failed: ${formatError(error)}`);
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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}
