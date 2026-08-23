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
  finishedAt: number;
}

interface RecordedAttempt {
  status: string;
  failure: { kind?: string; message?: string } | null;
  first_delta_ms: number | null;
}

test("built consumer terminalises a turn with no output before its ordinary timeout", async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run({
      ENSEMBLE_FAKE_CODEX_STALL_AFTER_TURN_START: "1",
      ENSEMBLE_FAKE_CODEX_RELEASE_FIRST_DELTA_AFTER_ARM: "1",
      // 1000 ms is only the accelerated deadline's hang guard; the fixture
      // releases it solely after the client writes armed:<id>.
      ENSEMBLE_POST_PROMISE_DEADLINE_MS: "1000"
    });

    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, '{"partial":true,"reason":"failed","completed":[]}\n');
    assert.match(result.stderr, /AppServerFirstOutputTimeoutError/);
    const attempt = await fixture.onlyAttempt();
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.failure?.kind, "AppServerFirstOutputTimeoutError");
  });
});

test("built consumer accepts a first delta that arrives late but inside the deadline", async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run({
      // 1000 ms is a hang guard; the delta is released by armed:<id> and
      // completion by the client-written disarmed:<id>, never elapsed time.
      ENSEMBLE_POST_PROMISE_DEADLINE_MS: "1000",
      ENSEMBLE_FAKE_CODEX_COMPLETE_AFTER_FIRST_DELTA_DISARM: "1",
      ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify([[
        {
          method: "item/agentMessage/delta",
          params: { itemId: "late-message", delta: "late but healthy" },
          afterFirstDeltaControl: "armed:"
        }
      ]])
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '"worker-ok"\n');
    const attempt = await fixture.onlyAttempt();
    assert.ok((attempt.first_delta_ms ?? Infinity) >= 0, "the client must ingest the first delta");
  });
});

test("built consumer treats a correlated non-delta frame as first output", async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run({
      // 1000 ms is a hang guard; the fixture waits on client-written markers.
      ENSEMBLE_POST_PROMISE_DEADLINE_MS: "1000",
      ENSEMBLE_FAKE_CODEX_COMPLETE_AFTER_FIRST_DELTA_DISARM: "1",
      ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify([[
        {
          method: "item/completed",
          params: {
            item: { id: "completed-message", type: "agentMessage", text: "whole answer" },
            completedAtMs: 0
          },
          afterFirstDeltaControl: "armed:"
        }
      ]])
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '"worker-ok"\n');
    const attempt = await fixture.onlyAttempt();
    assert.equal(attempt.first_delta_ms, null);
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
  const turnStartMarker = path.join(directory, "turn-started-at");
  const firstDeltaControl = path.join(directory, "first-delta-control");
  await mkdir(binDirectory);
  await writeFile(capturePath, "");
  await writeFile(firstDeltaControl, "");
  await writeFile(fakeCodex, `#!/usr/bin/env node\nimport ${JSON.stringify(appServerFixturePath)};\n`);
  await chmod(fakeCodex, 0o755);
  await writeFile(
    workflow,
    `
      export const meta = { name: "first-delta-liveness-signal" };
      return await agent("exercise first-output liveness", {
        engine: "codex",
        maxAttempts: 1,
        timeoutMs: 5_000
      });
    `
  );

  return {
    run: (overrides: NodeJS.ProcessEnv): Promise<ProcessResult> =>
      runNode(
        ["--import", deadlineAcceleratorPath, bundledCliPath, workflow],
        {
          ...process.env,
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          ENSEMBLE_FAKE_CODEX_CAPTURE: capturePath,
          ENSEMBLE_FAKE_CODEX_TURN_START_MARKER: turnStartMarker,
          ENSEMBLE_FAKE_CODEX_FIRST_DELTA_CONTROL: firstDeltaControl,
          ENSEMBLE_POST_PROMISE_DEADLINE_CONTROL: firstDeltaControl,
          ENSEMBLE_CODEX_SCHEMA_CLI: schemaCodexPath,
          ENSEMBLE_RUN_RECORD: "1",
          ENSEMBLE_RUN_RECORD_DIR: recordStore,
          ENSEMBLE_POST_PROMISE_DEADLINE_MS: "250",
          ENSEMBLE_STATUS: "0",
          XDG_DATA_HOME: path.join(directory, "data"),
          ...overrides
        },
        6_000 // Harness hang guard, not an assertion deadline.
      ),
    onlyAttempt: async (): Promise<RecordedAttempt> => {
      const recordPath = await findOnlyFile(recordStore, "agent.json");
      const agent = JSON.parse(await readFile(recordPath, "utf8")) as { attempts: RecordedAttempt[] };
      assert.equal(agent.attempts.length, 1);
      return agent.attempts[0] as RecordedAttempt;
    },
    turnStartedAt: async (): Promise<number> => Number(await readFile(turnStartMarker, "utf8")),
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
    child.once("exit", (code) => resolve({ code, stdout, stderr, finishedAt: Date.now() }));
  });
}
