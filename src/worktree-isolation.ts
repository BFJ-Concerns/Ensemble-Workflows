import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface IsolatedWorktree {
  path: string;
  branch: string;
}

export interface IsolatedWorktreeRecord extends IsolatedWorktree {
  changed: boolean;
  removed: boolean;
}

export interface WorktreeIsolationManager {
  create(): Promise<IsolatedWorktree>;
  finish(worktree: IsolatedWorktree): Promise<IsolatedWorktreeRecord>;
}

export class GitWorktreeIsolationManager implements WorktreeIsolationManager {
  readonly baseCwd: string;

  #counter = 0;
  #repoRoot: Promise<string> | null = null;

  constructor(baseCwd: string) {
    this.baseCwd = baseCwd;
  }

  async create(): Promise<IsolatedWorktree> {
    const repoRoot = await this.#gitRepoRoot();
    const name = this.#uniqueName();
    const branch = `ensemble-workflows/${name}`;
    const worktreePath = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}.ensemble-workflows-worktrees`, name);

    await mkdir(path.dirname(worktreePath), { recursive: true });
    await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);

    return {
      path: worktreePath,
      branch
    };
  }

  async finish(worktree: IsolatedWorktree): Promise<IsolatedWorktreeRecord> {
    const status = await git(worktree.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const changed = status.trim().length > 0;

    if (changed) {
      return {
        ...worktree,
        changed: true,
        removed: false
      };
    }

    const repoRoot = await this.#gitRepoRoot();
    await git(repoRoot, ["worktree", "remove", worktree.path]);
    await git(repoRoot, ["branch", "-D", worktree.branch]);

    return {
      ...worktree,
      changed: false,
      removed: true
    };
  }

  async #gitRepoRoot(): Promise<string> {
    this.#repoRoot ??= git(this.baseCwd, ["rev-parse", "--show-toplevel"]).catch((error: unknown) => {
      throw new Error(`isolation:'worktree' requires cwd to be inside a git repo: ${this.baseCwd}`, {
        cause: error
      });
    });
    return (await this.#repoRoot).trim();
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
