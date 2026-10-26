import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createRuntime } from "../../src/index.js";
import { liveCodexOptions, liveOpenCodeModel, machineOpenCodeModels } from "./live-models.js";

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
      openCodeModels: machineOpenCodeModels(),
      defaultTurnTimeoutMs: 420_000,
      defaultMaxAttempts: 1
    });

    try {
      for (const engine of liveEngines()) {
        const copy = `placed-${engine.name}.txt`;
        const options: AgentOptions & { schema?: undefined } = { engine: engine.name, cwd: markerDir, ...engine.options };
        await runtime.agent(
          `Copy marker.txt in your current working directory to a new file named ${copy} in the same directory, ` +
            "using relative paths only. Then reply with the single word done.",
          options
        );
        // Placement is witnessed by a relative-path copy of a marker the worker
        // could find nowhere else, left in the requested directory — not by
        // the worker's reply.
        assert.equal(
          (await readFile(path.join(markerDir, copy), "utf8")).trimEnd(),
          marker,
          `${engine.name} did not start in the requested cwd`
        );
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
      openCodeModels: machineOpenCodeModels(),
      defaultTurnTimeoutMs: 420_000,
      defaultMaxAttempts: 1
    });
    try {
      for (const engine of liveEngines()) {
        const token = `UNIFORM_WORKTREE_${engine.name}_${randomUUID()}`;
        const filename = `placement-${engine.name}.txt`;
        const options: AgentOptions & { schema?: undefined } = {
          engine: engine.name,
          cwd: repo,
          isolation: "worktree",
          ...engine.options
        };
        const previousWorktrees = runtime.worktrees.length;
        await runtime.agent(
          `Create ${filename} containing exactly ${token} followed by a newline. ` +
            `Run git add ${filename} and git commit -m "record ${engine.name} placement". ` +
            "Then reply with the single word done.",
          options
        );

        assert.equal(runtime.worktrees.length, previousWorktrees + 1);
        const worktree = runtime.worktrees.at(-1);
        assert.ok(worktree, `${engine.name} produced no worktree record`);
        assert.equal(worktree.changed, true, `${engine.name} left no change in its worktree`);
        assert.equal(worktree.removed, false, `${engine.name}'s changed worktree was removed`);
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

function liveEngines(): Array<{ name: EngineName; options: { model?: string; effort?: string } }> {
  return [
    { name: "codex", options: liveCodexOptions() },
    { name: "claude", options: {} },
    ...(liveOpenCodeModel !== undefined ? [{ name: "opencode" as const, options: { model: liveOpenCodeModel } }] : [])
  ];
}

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
