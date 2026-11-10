import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveAmbientSettings } from "../../src/ambient-settings.js";
import { createRuntime } from "../../src/index.js";
import { RunRecordWriter } from "../../src/run-record.js";

const exec = promisify(execFile);
const isLive = process.env.ENSEMBLE_LIVE === "1";

test("live Claude edits its placed checkout, subdirectory and Ensemble worktree", {
  skip: !isLive, timeout: 900_000
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-placed-edits-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  const git = async (cwd: string, args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Ensemble Placement Test"]);
  await git(repo, ["config", "user.email", "ensemble@example.invalid"]);
  await writeFile(path.join(repo, "README.md"), "placement fixture\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["switch", "-c", "placed-feature"]);
  await mkdir(path.join(repo, "nested"));
  await writeFile(path.join(repo, "nested/feature.txt"), "placed feature\n");
  await mkdir(path.join(repo, ".claude"));
  const settings = '{"worktree":{"bgIsolation":"worktree"}}\n';
  await writeFile(path.join(repo, ".claude/settings.json"), settings);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "feature"]);
  const ambient = resolveAmbientSettings({ env: process.env, cwd: repo });
  // Use the shared daemon; only runtime-owned sessions are stopped on close.
  // Authentication stays in memory and the control plane's private settings.
  const runtime = await createRuntime({
    cwd: repo, workerEnvironment: ambient.workerEnvironment,
    defaultTurnTimeoutMs: 240_000, defaultMaxAttempts: 1
  });
  try {
    const writer = await RunRecordWriter.start({
      storeDir: path.join(root, "records"), cwd: repo, runUuid: randomUUID(),
      workflowPath: path.join(root, "workflow.js"), workflowSource: "return true;", args: [], cliFlags: { jsonArgs: false }
    });
    runtime.setRunRecorder(writer);
    let ordinal = 0;
    for (const placement of ["checkout", "subdirectory", "isolation"] as const) {
      ordinal += 1;
      const cwd = placement === "subdirectory" ? path.join(repo, "nested") : repo;
      const before = await git(repo, ["rev-parse", "HEAD"]);
      const token = `UNIFORM_WORKTREE_claude_${randomUUID()}`;
      const filename = `placement-${placement}.txt`;
      // The same edit-and-commit request as uniform-placement.live.test.ts;
      // assertions read files, git and the archive rather than the reply.
      const result = await runtime.agent(
        `Create ${filename} containing exactly ${token} followed by a newline. ` +
          `Run git add ${filename} and git commit -m "record claude placement". ` +
          "Return the file contents after the commit succeeds.",
        { engine: "claude", model: "sonnet", cwd, ...(placement === "isolation" ? { isolation: "worktree" as const } : {}) }
      );
      assert.notEqual(result, null, `${placement} did not complete`);
      const record = JSON.parse(await readFile(path.join(writer.archiveDir, `agents/${String(ordinal).padStart(6, "0")}/agent.json`), "utf8"));
      const placed = placement === "isolation" ? runtime.worktrees.at(-1)?.path : cwd;
      assert.ok(placed);
      assert.equal(record.resolved_cwd, placed);
      assert.equal((await readFile(path.join(placed, filename), "utf8")).trimEnd(), token);
      assert.equal(await readFile(path.join(repo, ".claude/settings.json"), "utf8"), settings);
      await git(placed, ["merge-base", "--is-ancestor", before, "HEAD"]);
      assert.notEqual(await git(placed, ["rev-parse", "HEAD"]), before);
      assert.deepEqual(record.attempts[0].diagnostics.worktrees, []);
      const trees = (await git(repo, ["worktree", "list", "--porcelain"])).split("\n").filter((line) => line.startsWith("worktree "));
      assert.equal(trees.length, placement === "isolation" ? 2 : 1, "unexpected hidden worktree");
      if (placement === "isolation") {
        assert.equal(await git(repo, ["rev-parse", "HEAD"]), before);
        assert.equal(record.worktree.branch, runtime.worktrees.at(-1)?.branch);
      }
    }
    await runtime.close();
    await writer.finish({ status: "complete", exitCode: 0, result: true });
  } finally {
    await runtime.close();
    for (const tree of runtime.worktrees) {
      await git(repo, ["worktree", "remove", "--force", tree.path]);
    }
    await rm(root, { recursive: true, force: true });
  }
});
