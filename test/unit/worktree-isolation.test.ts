import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { GitWorktreeIsolationManager } from "../../src/worktree-isolation.js";

const execFileAsync = promisify(execFile);

test("GitWorktreeIsolationManager rejects non-git cwd with a clear error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-workflow-non-git-"));
  try {
    const manager = new GitWorktreeIsolationManager(directory);
    await assert.rejects(() => manager.create(), /requires cwd to be inside a git repo/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitWorktreeIsolationManager removes unchanged worktrees and their temporary branch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-workflow-worktree-"));
  const repo = path.join(directory, "repo");
  await mkdir(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "codex-workflows@example.invalid"]);
  await git(repo, ["config", "user.name", "Codex Workflows Test"]);
  await writeFile(path.join(repo, "README.md"), "temporary isolation fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);

  try {
    const manager = new GitWorktreeIsolationManager(repo);
    const worktree = await manager.create();
    await access(worktree.path);

    const record = await manager.finish(worktree);

    assert.equal(record.changed, false);
    assert.equal(record.removed, true);
    await assert.rejects(() => access(worktree.path), /ENOENT/);
    await assert.rejects(() => git(repo, ["rev-parse", "--verify", worktree.branch]), /unknown revision|Needed a single revision/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
