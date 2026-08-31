import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const fakeClaudePath = path.resolve("test/fixtures/claude/blocked-worker-cli.mjs");
const archiveReaderPath = path.resolve("test/consumers/read-claude-interruption-evidence.mjs");

test("built CLI archives an interrupted Claude worker's already-served evidence", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-claude-interruption-estate-"));
  const binDirectory = path.join(directory, "bin");
  const recordStore = path.join(directory, "records");
  const workerHome = path.join(directory, "home");
  const statePath = path.join(directory, "roster.json");
  try {
    await mkdir(binDirectory);
    await mkdir(workerHome);
    await writeFile(path.join(binDirectory, "claude"), `#!/usr/bin/env node\nimport ${JSON.stringify(fakeClaudePath)};\n`);
    await chmod(path.join(binDirectory, "claude"), 0o755);

    const run = await runInterruptedCli(
      [bundledCliPath, "agent", "keep working", "--engine", "claude", "--max-attempts", "1"],
      {
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: workerHome,
        ENSEMBLE_FAKE_CLAUDE_STATE: statePath,
        ENSEMBLE_FAKE_CLAUDE_GENERATING: "1",
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore,
        ENSEMBLE_STATUS: "0",
        XDG_DATA_HOME: path.join(directory, "data")
      },
      statePath
    );

    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stdout, /"partial":true/);
    assert.match(run.stderr, /interrupted/i);

    const readBack = await runNode([archiveReaderPath, recordStore], {}, 15_000);
    assert.equal(readBack.code, 0, readBack.stderr);
    assert.deepEqual(JSON.parse(readBack.stdout), {
      status: "interrupted",
      resolvedModel: "claude-fake-worker",
      transcripts: 1,
      totalTokens: 159
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runInterruptedCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  statePath: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  await waitForDispatch(statePath);
  // The roster read is the first half of the active poll. Let the runtime
  // complete that cycle — including its transcript read — before the caller
  // sends the interruption that this fixture is supplying a worker for.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  child.kill("SIGINT");
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForDispatch(statePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as { sessions?: unknown[]; polls?: number };
      if ((state.sessions?.length ?? 0) > 0 && (state.polls ?? 0) > 0) {
        return;
      }
    } catch {
      // The fixture has not completed dispatch yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the Claude fixture did not dispatch a worker");
}
