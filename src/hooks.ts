import type { Budget } from "./types.js";
import type { EnsembleRuntime } from "./runtime.js";
import type { IsolatedWorktreeRecord } from "./worktree-isolation.js";

export interface WorkflowRuntime {
  readonly budget: Budget;
  readonly worktrees: readonly IsolatedWorktreeRecord[];
  agent: (...args: Parameters<EnsembleRuntime["agent"]>) => ReturnType<EnsembleRuntime["agent"]>;
}

export type WorkflowLogSink = (message: string) => void;

export interface WorkflowHooks {
  agent: WorkflowRuntime["agent"];
  parallel: <T>(thunks: Array<() => T | Promise<T>>) => Promise<Array<Awaited<T> | null>>;
  pipeline: <Item>(
    items: Item[],
    ...stages: Array<(previous: unknown, originalItem: Item, index: number) => unknown | Promise<unknown>>
  ) => Promise<unknown[]>;
  phase: (title: string) => void;
  log: (message: string) => void;
  budget: Budget;
  worktrees: readonly IsolatedWorktreeRecord[];
  args: string[];
}

export function createWorkflowHooks(options: {
  runtime: WorkflowRuntime;
  args: string[];
  log: WorkflowLogSink;
}): WorkflowHooks {
  const writeLog = (message: string): void => {
    options.log(message);
  };

  return {
    agent: options.runtime.agent.bind(options.runtime) as WorkflowRuntime["agent"],
    parallel: (thunks) => parallel(thunks, writeLog),
    pipeline: (items, ...stages) => pipeline(items, stages, writeLog),
    phase: (title) => {
      writeLog(`[phase] ${title}`);
    },
    log: (message) => {
      writeLog(message);
    },
    budget: options.runtime.budget,
    worktrees: options.runtime.worktrees,
    args: [...options.args]
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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}
