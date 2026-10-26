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
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-non-git-"));
  try {
    const manager = new GitWorktreeIsolationManager();
    await assert.rejects(() => manager.create(directory), /requires cwd to be inside a git repository/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitWorktreeIsolationManager removes unchanged worktrees and their temporary branch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-worktree-"));
  const repo = path.join(directory, "repo");
  await mkdir(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "ensemble-workflows@example.invalid"]);
  await git(repo, ["config", "user.name", "Ensemble Workflows Test"]);
  await writeFile(path.join(repo, "README.md"), "temporary isolation fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);

  try {
    const manager = new GitWorktreeIsolationManager();
    const worktree = await manager.create(repo);
    await access(worktree.path);

    const record = await manager.finish(worktree);

    assert.equal(record.changed, false);
    assert.equal(record.removed, true);
    assert.equal(record.tipCommit, worktree.baseCommit);
    await assert.rejects(() => access(worktree.path), /ENOENT/);
    await assert.rejects(() => git(repo, ["rev-parse", "--verify", worktree.branch]), /unknown revision|Needed a single revision/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitWorktreeIsolationManager keeps a worktree whose worker committed its changes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-worktree-"));
  const repo = path.join(directory, "repo");
  await mkdir(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "ensemble-workflows@example.invalid"]);
  await git(repo, ["config", "user.name", "Ensemble Workflows Test"]);
  await writeFile(path.join(repo, "README.md"), "temporary isolation fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);

  try {
    const manager = new GitWorktreeIsolationManager();
    const worktree = await manager.create(repo);

    // The worker commits its work: clean status, moved tip.
    await writeFile(path.join(worktree.path, "feature.txt"), "worker output\n");
    await git(worktree.path, ["add", "feature.txt"]);
    await git(worktree.path, ["config", "user.email", "ensemble-workflows@example.invalid"]);
    await git(worktree.path, ["config", "user.name", "Ensemble Workflows Test"]);
    await git(worktree.path, ["commit", "-m", "worker output"]);

    const record = await manager.finish(worktree);

    assert.equal(record.changed, true);
    assert.equal(record.removed, false);
    await access(worktree.path);
    const tip = (await git(repo, ["rev-parse", worktree.branch])).trim();
    assert.equal(record.tipCommit, tip);
    assert.notEqual(tip, worktree.baseCommit);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the container directory goes with its last worktree and survives while siblings remain", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-worktree-container-"));
  const repo = path.join(directory, "repo");
  await initialiseRepo(repo);
  const container = path.join(directory, "repo.ensemble-workflows-worktrees");

  try {
    const manager = new GitWorktreeIsolationManager();
    const first = await manager.create(repo);
    const second = await manager.create(repo);

    // Finishing one of two leaves the container (a sibling still lives there)…
    await manager.finish(first);
    await access(container);

    // …and finishing the last removes it, so no empty directory persists
    // beside the user's repository.
    await manager.finish(second);
    await assert.rejects(() => access(container), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a retained changed worktree keeps its container after an unchanged sibling is removed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-worktree-retained-"));
  const repo = path.join(directory, "repo");
  await initialiseRepo(repo);
  const container = path.join(directory, "repo.ensemble-workflows-worktrees");

  try {
    const manager = new GitWorktreeIsolationManager();
    const changed = await manager.create(repo);
    const unchanged = await manager.create(repo);
    await writeFile(path.join(changed.path, "feature.txt"), "worker output\n");

    const changedRecord = await manager.finish(changed);
    assert.equal(changedRecord.removed, false);
    await manager.finish(unchanged);

    // The retained worktree is real work product; its container must stand.
    await access(container);
    await access(changed.path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a linked checkout creates worktrees beside the main checkout", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-worktree-linked-"));
  const repo = path.join(directory, "repo");
  const linked = path.join(directory, "linked");
  await initialiseRepo(repo);
  await git(repo, ["worktree", "add", "-b", "linked", linked]);
  const container = path.join(directory, "repo.ensemble-workflows-worktrees");

  try {
    const manager = new GitWorktreeIsolationManager();
    const fromMain = await manager.create(repo);
    const fromLinked = await manager.create(linked);

    assert.equal(path.dirname(fromMain.path), container);
    assert.equal(path.dirname(fromLinked.path), container);
    await writeFile(path.join(fromLinked.path, "feature.txt"), "worker output\n");
    await manager.finish(fromMain);
    const retained = await manager.finish(fromLinked);
    assert.equal(retained.removed, false);
    await access(fromLinked.path);
    await access(container);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one manager creates worktrees from different repositories independently", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-worktree-multi-repo-"));
  const firstRepo = path.join(directory, "first");
  const secondRepo = path.join(directory, "second");
  await initialiseRepo(firstRepo);
  await initialiseRepo(secondRepo);
  const manager = new GitWorktreeIsolationManager();

  try {
    const first = await manager.create(firstRepo);
    const second = await manager.create(secondRepo);

    assert.match(first.path, /first\.ensemble-workflows-worktrees/);
    assert.match(second.path, /second\.ensemble-workflows-worktrees/);
    await git(firstRepo, ["rev-parse", "--verify", first.branch]);
    await git(secondRepo, ["rev-parse", "--verify", second.branch]);
    await manager.finish(first);
    await manager.finish(second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function initialiseRepo(repo: string): Promise<void> {
  await mkdir(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "ensemble-workflows@example.invalid"]);
  await git(repo, ["config", "user.name", "Ensemble Workflows Test"]);
  await writeFile(path.join(repo, "README.md"), "temporary isolation fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
