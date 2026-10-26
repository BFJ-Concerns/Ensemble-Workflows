import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rmdir } from "node:fs/promises";
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
  /** The branch tip observed during finalisation, or null when finalisation could not inspect it. */
  tipCommit: string | null;
  changed: boolean;
  removed: boolean;
}

export interface WorktreeIsolationManager {
  create(baseCwd: string): Promise<IsolatedWorktree>;
  finish(worktree: IsolatedWorktree): Promise<IsolatedWorktreeRecord>;
}

interface RepositoryRoots {
  checkout: string;
  main: string;
}

export class GitWorktreeIsolationManager implements WorktreeIsolationManager {
  #counter = 0;
  #repoRoots = new Map<string, Promise<RepositoryRoots>>();
  #worktreeRoots = new Map<string, string>();

  async create(baseCwd: string): Promise<IsolatedWorktree> {
    const repoRoots = await this.#gitRepoRoots(baseCwd);
    const name = this.#uniqueName();
    const branch = `ensemble-workflows/${name}`;
    const worktreePath = path.join(path.dirname(repoRoots.main), `${path.basename(repoRoots.main)}.ensemble-workflows-worktrees`, name);

    await mkdir(path.dirname(worktreePath), { recursive: true });
    await git(repoRoots.checkout, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
    const baseCommit = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
    this.#worktreeRoots.set(worktreePath, repoRoots.checkout);

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
        tipCommit: tip,
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
    // When this was the container's last worktree, the empty directory goes
    // with it rather than persisting beside the user's repository. rmdir is
    // non-recursive by contract, so a container still holding siblings —
    // including one being created concurrently — fails ENOTEMPTY and is
    // kept; that atomicity is the concurrency safety, not a check-then-act.
    try {
      await rmdir(path.dirname(worktree.path));
    } catch {
      // ENOTEMPTY (siblings remain) and ENOENT (already gone) are both
      // fine outcomes; container cleanup never fails a finished worker.
    }

    return {
      ...worktree,
      tipCommit: tip,
      changed: false,
      removed: true
    };
  }

  async #gitRepoRoots(baseCwd: string): Promise<RepositoryRoots> {
    const resolvedCwd = path.resolve(baseCwd);
    let repoRoots = this.#repoRoots.get(resolvedCwd);
    if (repoRoots === undefined) {
      repoRoots = this.#resolveRepoRoots(resolvedCwd).catch((error: unknown) => {
        throw new WorktreePlacementRejectedError(resolvedCwd, {
          cause: error
        });
      });
      this.#repoRoots.set(resolvedCwd, repoRoots);
    }
    try {
      return await repoRoots;
    } catch (error) {
      this.#repoRoots.delete(resolvedCwd);
      throw error;
    }
  }

  async #resolveRepoRoots(cwd: string): Promise<RepositoryRoots> {
    const checkout = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const common = path.resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).trim());
    const worktree = (await git(cwd, ["config", "--get", "--default", "", "core.worktree"])).trim();
    // A normal repository stores its common directory at <main>/.git.
    // Submodules record the main checkout relative to their common git dir.
    // A separate git dir without core.worktree records no main checkout path;
    // keep placement beside the checkout in that layout.
    const main = worktree.length > 0 ? path.resolve(common, worktree)
      : path.basename(common) === ".git" ? path.dirname(common)
      : checkout;
    return { checkout, main };
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
