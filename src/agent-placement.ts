import path from "node:path";

import { GitWorktreeIsolationManager } from "./worktree-isolation.js";

import type { AgentOptions } from "./types.js";
import type {
  IsolatedWorktree,
  IsolatedWorktreeRecord,
  WorktreeIsolationManager
} from "./worktree-isolation.js";

export interface AgentPlacement {
  cwd: string;
  worktree?: IsolatedWorktree;
}

export class AgentPlacementManager {
  readonly baseCwd: string;

  #worktreeManager: WorktreeIsolationManager;

  constructor(options: { baseCwd: string; worktreeManager?: WorktreeIsolationManager }) {
    this.baseCwd = path.resolve(options.baseCwd);
    this.#worktreeManager = options.worktreeManager ?? new GitWorktreeIsolationManager();
  }

  async open(options: Pick<Partial<AgentOptions>, "cwd" | "isolation">): Promise<AgentPlacement> {
    const requestedCwd = resolveAgentCwd(this.baseCwd, options.cwd);
    if (options.isolation !== "worktree") {
      return { cwd: requestedCwd };
    }

    const worktree = await this.#worktreeManager.create(requestedCwd);
    return { cwd: worktree.path, worktree };
  }

  async close(placement: AgentPlacement): Promise<IsolatedWorktreeRecord | null> {
    if (placement.worktree === undefined) {
      return null;
    }
    return this.#worktreeManager.finish(placement.worktree);
  }
}

export function resolveAgentCwd(baseCwd: string, requestedCwd: string | undefined): string {
  return path.resolve(baseCwd, requestedCwd ?? ".");
}
