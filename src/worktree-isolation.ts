import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { WorktreePlacementRejectedError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface IsolatedWorktree {
  path: string;
  branch: string;
  /** The commit the worktree branched from — the reference point for "did the worker commit anything?". */
  baseCommit: string;
}

export interface IsolatedWorktreeRecord extends IsolatedWorktree {
  changed: boolean;
  removed: boolean;
}

export interface WorktreeIsolationManager {
  create(baseCwd: string): Promise<IsolatedWorktree>;
  finish(worktree: IsolatedWorktree): Promise<IsolatedWorktreeRecord>;
}

export class GitWorktreeIsolationManager implements WorktreeIsolationManager {
  #counter = 0;
  #repoRoots = new Map<string, Promise<string>>();
  #worktreeRoots = new Map<string, string>();

  async create(baseCwd: string): Promise<IsolatedWorktree> {
    const repoRoot = await this.#gitRepoRoot(baseCwd);
    const name = this.#uniqueName();
    const branch = `ensemble-workflows/${name}`;
    const worktreePath = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}.ensemble-workflows-worktrees`, name);

    await mkdir(path.dirname(worktreePath), { recursive: true });
    await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
    const baseCommit = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
    this.#worktreeRoots.set(worktreePath, repoRoot);

    return {
      path: worktreePath,
      branch,
      baseCommit
    };
  }

  async finish(worktree: IsolatedWorktree): Promise<IsolatedWorktreeRecord> {
    const status = await git(worktree.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    // A worker that commits its work leaves a clean status but moves the branch
    // tip; both count as changed, or `branch -D` below would orphan the commits.
    const tip = (await git(worktree.path, ["rev-parse", "HEAD"])).trim();
    const changed = status.trim().length > 0 || tip !== worktree.baseCommit;

    if (changed) {
      this.#worktreeRoots.delete(worktree.path);
      return {
        ...worktree,
        changed: true,
        removed: false
      };
    }

    const repoRoot = this.#worktreeRoots.get(worktree.path);
    if (repoRoot === undefined) {
      throw new Error(`worktree was not created by this manager: ${worktree.path}`);
    }
    await git(repoRoot, ["worktree", "remove", worktree.path]);
    await git(repoRoot, ["branch", "-D", worktree.branch]);
    this.#worktreeRoots.delete(worktree.path);

    return {
      ...worktree,
      changed: false,
      removed: true
    };
  }

  async #gitRepoRoot(baseCwd: string): Promise<string> {
    const resolvedCwd = path.resolve(baseCwd);
    let repoRoot = this.#repoRoots.get(resolvedCwd);
    if (repoRoot === undefined) {
      repoRoot = git(resolvedCwd, ["rev-parse", "--show-toplevel"]).catch((error: unknown) => {
        throw new WorktreePlacementRejectedError(resolvedCwd, {
          cause: error
        });
      });
      this.#repoRoots.set(resolvedCwd, repoRoot);
    }
    try {
      return (await repoRoot).trim();
    } catch (error) {
      this.#repoRoots.delete(resolvedCwd);
      throw error;
    }
  }

  #uniqueName(): string {
    this.#counter += 1;
    return `${process.pid}-${Date.now()}-${this.#counter}-${randomUUID().slice(0, 8)}`;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${formatExecError(error)}`, {
      cause: error
    });
  }
}

function formatExecError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    return stderr.length > 0 ? stderr : message;
  }
  return String(error);
}
