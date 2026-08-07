import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createRuntime } from "../../src/index.js";

import type { AgentOptions, EngineName } from "../../src/types.js";

const isLive = process.env.ENSEMBLE_LIVE === "1";
const execFileAsync = promisify(execFile);

test(
  "live per-call cwd places Codex, Claude, and opencode workers in the same requested directory",
  { skip: !isLive, timeout: 900_000 },
  async () => {
    const markerDir = await mkdtemp(path.join(tmpdir(), "ensemble-uniform-cwd-"));
    const marker = `UNIFORM_CWD_${randomUUID()}`;
    await writeFile(path.join(markerDir, "marker.txt"), marker);
    const runtime = await createRuntime({
      cwd: process.cwd(),
      concurrencyCaps: { codex: 1, claude: 1, opencode: 1 },
      defaultTurnTimeoutMs: 420_000,
      defaultMaxAttempts: 1
    });

    const engines: Array<{ name: EngineName; model?: string }> = [
      { name: "codex" },
      { name: "claude" },
      { name: "opencode", model: "glm-5.2" }
    ];

    try {
      for (const engine of engines) {
        const options: AgentOptions & { schema?: undefined } = {
          engine: engine.name,
          cwd: markerDir,
          ...(engine.model !== undefined ? { model: engine.model } : {})
        };
        const result = await runtime.agent(
          "Read marker.txt from your current working directory using your tools. Return the file's exact contents.",
          options
        );
        assert.match(result, new RegExp(marker), `${engine.name} did not return the marker read from its cwd`);
      }
    } finally {
      await runtime.close();
      await rm(markerDir, { recursive: true, force: true });
    }
  }
);

test(
  "live worktree placement preserves a branch carrying each engine's commit",
  { skip: !isLive, timeout: 1_200_000 },
  async () => {
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "ensemble-uniform-worktree-"));
    const repo = path.join(fixtureRoot, "repo");
    await initialiseRepo(repo);
    const runtime = await createRuntime({
      cwd: repo,
      concurrencyCaps: { codex: 1, claude: 1, opencode: 1 },
      defaultTurnTimeoutMs: 420_000,
      defaultMaxAttempts: 1
    });
    const engines: Array<{ name: EngineName; model?: string }> = [
      { name: "codex" },
      { name: "claude" },
      { name: "opencode", model: "glm-5.2" }
    ];

    try {
      for (const engine of engines) {
        const token = `UNIFORM_WORKTREE_${engine.name}_${randomUUID()}`;
        const filename = `placement-${engine.name}.txt`;
        const options: AgentOptions & { schema?: undefined } = {
          engine: engine.name,
          cwd: repo,
          isolation: "worktree",
          ...(engine.model !== undefined ? { model: engine.model } : {})
        };
        const previousWorktrees = runtime.worktrees.length;
        const result = await runtime.agent(
          `Create ${filename} containing exactly ${token} followed by a newline. ` +
            `Run git add ${filename} and git commit -m "record ${engine.name} placement". ` +
            "Return the file contents after the commit succeeds.",
          options
        );

        assert.match(result, new RegExp(token), `${engine.name} did not report the committed token`);
        assert.equal(runtime.worktrees.length, previousWorktrees + 1);
        const worktree = runtime.worktrees.at(-1);
        assert.ok(worktree, `${engine.name} produced no worktree record`);
        assert.equal(worktree.changed, true);
        assert.equal(worktree.removed, false);
        const committed = await git(repo, ["show", `${worktree.branch}:${filename}`]);
        // The claim is that the branch carries the marker the worker was asked
        // to commit. Whether the worker ended the file with a newline is its
        // own formatting choice — no contract requires one, and models vary
        // between sessions (observed 2026-08-07: the same opencode model wrote
        // the file with a trailing newline one day and without one the next,
        // failing this assertion twice with no harness change in between).
        // Compare the content and let the trailing whitespace be.
        assert.equal(committed.trimEnd(), token, `${engine.name} branch did not carry the committed marker`);
      }
    } finally {
      await runtime.close();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }
);

async function initialiseRepo(repo: string): Promise<void> {
  await mkdir(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "ensemble-workflows@example.invalid"]);
  await git(repo, ["config", "user.name", "Ensemble Workflows Test"]);
  await writeFile(path.join(repo, "README.md"), "uniform placement fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
