import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { archivedAgent, assertEach, runLauncher } from "./launcher.js";
import { liveCodexScriptOptions, liveOpenCodeModel } from "./live-models.js";

const isLive = process.env.ENSEMBLE_LIVE === "1";
const execFileAsync = promisify(execFile);

/** The engines a placement journey covers, each with the `agent()` options its leg passes. */
const engines: Array<{ name: string; scriptOptions: string }> = [
  { name: "codex", scriptOptions: liveCodexScriptOptions() },
  { name: "claude", scriptOptions: "" },
  ...(liveOpenCodeModel !== undefined
    ? [{ name: "opencode", scriptOptions: `model: ${JSON.stringify(liveOpenCodeModel)},` }]
    : [])
];

test(
  "live per-call cwd places Codex, Claude, and opencode workers in the same requested directory",
  { skip: !isLive, timeout: 900_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-uniform-cwd-"));
    const markerDir = path.join(directory, "target");
    const recordStore = path.join(directory, "records");
    const script = path.join(directory, "workflow.js");
    const marker = `UNIFORM_CWD_${randomUUID()}`;
    await mkdir(markerDir);
    await writeFile(path.join(markerDir, "marker.txt"), marker);

    try {
      await writeFile(
        script,
        `export const meta = { name: "uniform-per-call-cwd" };\n` +
          engines
            .map(
              (engine) => `
                await agent(
                  "Copy marker.txt in your current working directory to a new file named placed-${engine.name}.txt in the same directory, using relative paths only. Then reply with the single word done.",
                  { engine: "${engine.name}", ${engine.scriptOptions} cwd: ${JSON.stringify(markerDir)}, label: "cwd-${engine.name}", maxAttempts: 1 }
                );`
            )
            .join("\n") +
          "\nreturn null;"
      );
      const result = await runLauncher([script], {
        env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: recordStore, ENSEMBLE_STATUS: "0" }
      });
      assert.equal(result.code, 0, result.stderr);

      // Placement is witnessed by a relative-path copy of a marker the worker
      // could find nowhere else, left in the requested directory, and by the
      // directory the archive says the worker started in — not by the
      // worker's reply.
      const checks: Array<[string, () => void]> = [];
      for (const engine of engines) {
        const copy = await readFile(path.join(markerDir, `placed-${engine.name}.txt`), "utf8").catch(() => null);
        const agent = await archivedAgent(recordStore, `cwd-${engine.name}`);
        checks.push(
          [`${engine.name} left its copy in the requested cwd`, () => assert.equal(copy?.trimEnd(), marker)],
          [`${engine.name}'s archived cwd is the requested one`, () => assert.equal(agent.resolved_cwd, markerDir)]
        );
      }
      assertEach(checks);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  "live worktree placement preserves a branch carrying each engine's commit",
  { skip: !isLive, timeout: 1_200_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-uniform-worktree-"));
    const repo = path.join(directory, "repo");
    const script = path.join(directory, "workflow.js");
    await initialiseRepo(repo);
    const tokens = new Map(engines.map((engine) => [engine.name, `UNIFORM_WORKTREE_${engine.name}_${randomUUID()}`]));

    try {
      await writeFile(
        script,
        `export const meta = { name: "uniform-worktree-placement" };\nconst placed = [];\n` +
          engines
            .map(
              (engine) => `
                await agent(
                  ${JSON.stringify(
                    `Create placement-${engine.name}.txt containing exactly ${tokens.get(engine.name)} followed by a newline. ` +
                      `Run git add placement-${engine.name}.txt and git commit -m "record ${engine.name} placement". ` +
                      "Then reply with the single word done."
                  )},
                  { engine: "${engine.name}", ${engine.scriptOptions} isolation: "worktree", label: "worktree-${engine.name}", maxAttempts: 1 }
                );
                placed.push({ engine: "${engine.name}", worktree: worktrees.at(-1) ?? null });`
            )
            .join("\n") +
          "\nreturn placed;"
      );
      const result = await runLauncher([script], {
        cwd: repo,
        env: { ...process.env, ENSEMBLE_RUN_RECORD: "0", ENSEMBLE_STATUS: "0" }
      });
      assert.equal(result.code, 0, result.stderr);
      const placed = JSON.parse(result.stdout) as Array<{
        engine: string;
        worktree: { branch: string; changed: boolean; removed: boolean } | null;
      }>;

      const checks: Array<[string, () => void]> = [];
      for (const engine of engines) {
        const worktree = placed.find((entry) => entry.engine === engine.name)?.worktree ?? null;
        // The claim is that the branch carries the marker the worker was
        // asked to commit. Whether the worker ended the file with a newline is
        // its own formatting choice, so trailing whitespace is ignored.
        const committed =
          worktree === null
            ? null
            : await execFileAsync("git", ["show", `${worktree.branch}:placement-${engine.name}.txt`], { cwd: repo }).then(
                ({ stdout }) => stdout.trimEnd(),
                () => null
              );
        checks.push(
          [`${engine.name}'s worktree is recorded changed`, () => assert.equal(worktree?.changed, true)],
          [`${engine.name}'s changed worktree is kept`, () => assert.equal(worktree?.removed, false)],
          [`${engine.name}'s branch carries its commit`, () => assert.equal(committed, tokens.get(engine.name))]
        );
      }
      assertEach(checks);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

async function initialiseRepo(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "ensemble-workflows@example.invalid"]);
  await git(repo, ["config", "user.name", "Ensemble Workflows Test"]);
  await writeFile(path.join(repo, "README.md"), "uniform placement fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
