import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runNode } from "./estate-process.js";

const execFileAsync = promisify(execFile);
const launcher = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const route of ["single agent", "workflow"] as const) {
  test(`${route} worktree isolation names missing git instead of blaming the repository`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-missing-git-"));
    try {
      const repo = path.join(directory, "repo");
      const emptyPath = path.join(directory, "empty-path");
      await mkdir(repo);
      await mkdir(emptyPath);
      await execFileAsync("git", ["init", repo]);
      const workflow = path.join(directory, "workflow.js");
      await writeFile(workflow, `export const meta = { name: "missing-git" };\nreturn await agent("hello", ${JSON.stringify({
        engine: "codex", isolation: "worktree", cwd: repo
      })});\n`);
      const args = route === "single agent"
        ? ["agent", "--engine=codex", "--isolation=worktree", `--cwd=${repo}`, "hello"]
        : [workflow];
      const run = await runNode([launcher, ...args], {
        PATH: emptyPath,
        ENSEMBLE_STATUS: "0",
        ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records")
      }, 15_000);

      assert.equal(run.code, 1, run.stderr);
      assert.match(run.stderr, /git executable.*(?:not found|missing).*PATH/i);
      assert.match(run.stderr, /install git.*PATH/i);
      assert.doesNotMatch(run.stderr, /requires cwd to be inside a git repository/);
      const envelope = JSON.parse(run.stdout) as { error: { kind: string; message: string } };
      assert.equal(envelope.error.kind, "WorktreeGitUnavailableError");
      assert.match(envelope.error.message, /install git.*PATH/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
