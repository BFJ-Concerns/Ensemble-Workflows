import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { WorktreeGitUnavailableError, WorktreePlacementRejectedError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface IsolatedWorktree {
  path: string;
  branch: string;
  /** The commit the worktree branched from — the reference point for "did the worker commit anything?". */
  baseCommit: string;
}

/**
 * Where a finished worktree's work is, as finalisation found it:
 *
 * - `unchanged`: no commit and no uncommitted file; the worktree and its
 *   branch were removed.
 * - `uncommitted`: the work is only in the worktree's files — staged,
 *   unstaged or untracked — and the branch still points at the base commit.
 * - `committed`: the tip moved off the base commit and the files are clean,
 *   so the branch holds all of the work.
 * - `committed-and-uncommitted`: the tip moved and files are left
 *   uncommitted, so the branch holds only part of the work.
 * - `unknown`: finalisation failed, so none of the above was established.
 */
export type WorktreeState =
  | "unchanged"
  | "uncommitted"
  | "committed"
  | "committed-and-uncommitted"
  | "unknown";

/**
 * A finished worktree. `state` is the one field to branch on; `tipCommit`,
 * `changed` and `removed` follow from it, and the union admits no other
 * combination. `changed` is the retention signal: every state but
 * `unchanged` keeps the worktree and its branch, `unknown` included, since a
 * failed finalisation did not prove there was nothing to keep.
 */
export type IsolatedWorktreeRecord = IsolatedWorktree & (
  | { state: "unchanged"; tipCommit: string; changed: false; removed: true }
  | {
      state: "uncommitted" | "committed" | "committed-and-uncommitted";
      tipCommit: string;
      changed: true;
      removed: false;
    }
  | { state: "unknown"; tipCommit: null; changed: true; removed: false }
);

/** The record of a worktree whose finalisation failed: kept, with nothing claimed about its contents. */
export function unknownWorktreeRecord(worktree: IsolatedWorktree): IsolatedWorktreeRecord {
  return { ...worktree, state: "unknown", tipCommit: null, changed: true, removed: false };
}

export interface WorktreeIsolationManager {
  create(baseCwd: string): Promise<IsolatedWorktree>;
  finish(worktree: IsolatedWorktree): Promise<IsolatedWorktreeRecord>;
}

interface RepositoryRoots {
  checkout: string;
  container: string;
}

export class GitWorktreeIsolationManager implements WorktreeIsolationManager {
  #counter = 0;
  #repoRoots = new Map<string, Promise<RepositoryRoots>>();
  #worktreeRoots = new Map<string, string>();

  async create(baseCwd: string): Promise<IsolatedWorktree> {
    const repoRoots = await this.#gitRepoRoots(baseCwd);
    const name = this.#uniqueName();
    const branch = `ensemble-workflows/${name}`;
    const worktreePath = path.join(repoRoots.container, name);

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
    // tip; either observation keeps the worktree, or `branch -D` below would
    // orphan the commits.
    const tip = (await git(worktree.path, ["rev-parse", "HEAD"])).trim();
    const state = inspectedState({
      committed: tip !== worktree.baseCommit,
      uncommitted: status.trim().length > 0
    });

    if (state !== "unchanged") {
      this.#worktreeRoots.delete(worktree.path);
      return {
        ...worktree,
        state,
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
      state,
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
        if (error instanceof WorktreeGitUnavailableError) throw error;
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
    const common = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    // Address the main Git directory so config.worktree is read from there,
    // rather than from the linked checkout that happens to dispatch this call.
    const worktree = (await git(cwd, ["--git-dir", common, "config", "--get", "--default", "", "core.worktree"])).trim();
    // Placement depends only on shared metadata, including when no main
    // checkout is recorded (bare repositories and separate git directories).
    // A .git directory places the container beside its parent;
    // other common directories place it beside the repository metadata.
    const root = worktree.length > 0 ? path.resolve(common, worktree)
      : path.basename(common) === ".git" ? path.dirname(common)
      : common;
    const container = path.join(path.dirname(root), `${path.basename(root)}.ensemble-workflows-worktrees`);
    return { checkout, container };
  }

  #uniqueName(): string {
    this.#counter += 1;
    return `${process.pid}-${Date.now()}-${this.#counter}-${randomUUID().slice(0, 8)}`;
  }
}

/** The state two successful reads establish: whether the tip moved, and whether files are left uncommitted. */
function inspectedState(observed: { committed: boolean; uncommitted: boolean }): Exclude<WorktreeState, "unknown"> {
  if (observed.committed) {
    return observed.uncommitted ? "committed-and-uncommitted" : "committed";
  }
  return observed.uncommitted ? "uncommitted" : "unchanged";
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    // ENOENT can also mean the working directory vanished. Only name the
    // executable when the directory still exists.
    if (error instanceof Error && "code" in error && error.code === "ENOENT" &&
        await stat(cwd).then((info) => info.isDirectory(), () => false)) {
      throw new WorktreeGitUnavailableError({ cause: error });
    }
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
