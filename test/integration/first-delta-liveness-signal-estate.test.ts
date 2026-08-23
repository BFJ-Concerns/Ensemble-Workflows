import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const appServerFixturePath = path.resolve("test/fixtures/codex/recording-app-server.mjs");
const deadlineAcceleratorPath = path.resolve("test/fixtures/codex/accelerate-post-promise-deadline.mjs");
const schemaCodexPath = spawnSync("which", ["codex"], { encoding: "utf8" }).stdout.trim();

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RecordedAttempt {
  status: string;
  failure: { kind?: string; message?: string } | null;
  first_delta_ms: number | null;
}

test("built consumer terminalises a turn with no output before its ordinary timeout", async () => {
  await withFixture(async (fixture) => {
    const startedAt = Date.now();
    const result = await fixture.run({ ENSEMBLE_FAKE_CODEX_STALL_AFTER_TURN_START: "1" });

    assert.equal(result.code, 1, result.stderr);
    assert.ok(Date.now() - startedAt < 1_500, "first-output deadline must win over the 2s turn timeout");
    assert.equal(result.stdout, '{"partial":true,"reason":"failed","completed":[]}\n');
    assert.match(result.stderr, /AppServerFirstDeltaTimeoutError/);
    const attempt = await fixture.onlyAttempt();
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.failure?.kind, "AppServerFirstDeltaTimeoutError");
  });
});

async function withFixture(run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-first-delta-estate-"));
  const binDirectory = path.join(directory, "bin");
  const fakeCodex = path.join(binDirectory, "codex");
  const capturePath = path.join(directory, "codex-input.jsonl");
  const recordStore = path.join(directory, "records");
  const workflow = path.join(directory, "workflow.js");
  await mkdir(binDirectory);
  await writeFile(capturePath, "");
  await writeFile(fakeCodex, `#!/usr/bin/env node\nimport ${JSON.stringify(appServerFixturePath)};\n`);
  await chmod(fakeCodex, 0o755);
  await writeFile(
    workflow,
    `
      export const meta = { name: "first-delta-liveness-signal" };
      return await agent("exercise first-output liveness", {
        engine: "codex",
        maxAttempts: 1,
        timeoutMs: 2_000
      });
    `
  );

  return {
    run: (overrides: NodeJS.ProcessEnv): Promise<ProcessResult> =>
      runNode(
        ["--import", deadlineAcceleratorPath, bundledCliPath, workflow],
        {
          ...process.env,
          ...overrides,
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          ENSEMBLE_FAKE_CODEX_CAPTURE: capturePath,
          ENSEMBLE_CODEX_SCHEMA_CLI: schemaCodexPath,
          ENSEMBLE_RUN_RECORD: "1",
          ENSEMBLE_RUN_RECORD_DIR: recordStore,
          ENSEMBLE_POST_PROMISE_DEADLINE_MS: "250",
          ENSEMBLE_STATUS: "0",
          XDG_DATA_HOME: path.join(directory, "data")
        },
        3_000
      ),
    onlyAttempt: async (): Promise<RecordedAttempt> => {
      const recordPath = await findOnlyFile(recordStore, "agent.json");
      const agent = JSON.parse(await readFile(recordPath, "utf8")) as { attempts: RecordedAttempt[] };
      assert.equal(agent.attempts.length, 1);
      return agent.attempts[0] as RecordedAttempt;
    },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function findOnlyFile(root: string, basename: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const matches = entries.filter((entry) => path.basename(entry) === basename);
  assert.equal(matches.length, 1, `expected one ${basename}, found ${matches.length}`);
  return path.join(root, matches[0] ?? "");
}

async function runNode(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
