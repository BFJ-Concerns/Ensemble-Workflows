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
      ENSEMBLE_POST_PROMISE_DEADLINE_MS: "500"
    });

    assert.equal(result.code, 1, result.stderr);
    const turnStartedAt = await fixture.turnStartedAt();
    assert.ok(
      result.finishedAt - turnStartedAt < 1_500,
      "first-output deadline must win over the 2s turn timeout after the deadline starts"
    );
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
      ENSEMBLE_POST_PROMISE_DEADLINE_MS: "500",
      ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify([[
        {
          method: "item/agentMessage/delta",
          params: { itemId: "late-message", delta: "late but healthy" },
          afterMs: 200
        }
      ]]),
      ENSEMBLE_FAKE_CODEX_COMPLETION_DELAY_MS: "550"
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '"worker-ok"\n');
    const attempt = await fixture.onlyAttempt();
    assert.ok((attempt.first_delta_ms ?? Infinity) < 500, "the client must ingest the first delta before expiry");
    assert.ok(
      result.finishedAt - (await fixture.turnStartedAt()) > 500,
      "completion must follow the first-output deadline to prove the client disarmed it"
    );
  });
});

test("built consumer treats a correlated non-delta frame as first output", async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run({
      ENSEMBLE_POST_PROMISE_DEADLINE_MS: "500",
      ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify([[
        {
          method: "item/completed",
          params: {
            item: { id: "completed-message", type: "agentMessage", text: "whole answer" },
            completedAtMs: 0
          },
          afterMs: 200
        }
      ]]),
      ENSEMBLE_FAKE_CODEX_COMPLETION_DELAY_MS: "550"
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '"worker-ok"\n');
    const attempt = await fixture.onlyAttempt();
    assert.equal(attempt.first_delta_ms, null);
    assert.ok(
      result.finishedAt - (await fixture.turnStartedAt()) > 500,
      "the non-delta frame must disarm the deadline until completion"
    );
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
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          ENSEMBLE_FAKE_CODEX_CAPTURE: capturePath,
          ENSEMBLE_FAKE_CODEX_TURN_START_MARKER: turnStartMarker,
          ENSEMBLE_CODEX_SCHEMA_CLI: schemaCodexPath,
          ENSEMBLE_RUN_RECORD: "1",
          ENSEMBLE_RUN_RECORD_DIR: recordStore,
          ENSEMBLE_POST_PROMISE_DEADLINE_MS: "250",
          ENSEMBLE_STATUS: "0",
          XDG_DATA_HOME: path.join(directory, "data"),
          ...overrides
        },
        3_000
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
