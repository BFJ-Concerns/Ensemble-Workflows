import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { executablePath, findOnlyFile, hermeticEstateEnvironment, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/scripts/ensemble.mjs");
const recordingAppServerPath = path.resolve("test/fixtures/codex/recording-app-server.mjs");
const archiveReaderPath = path.resolve("test/consumers/read-archived-agents.mjs");

interface ArchivedAgent {
  status: string;
  abandonment?: {
    reason: string;
    observed_at: string;
    observed_by: { pid: number; run_uuid: string };
  };
}

test("the cold archive consumer sees a real killed run's agent record preserved and abandoned after reaping", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-reaper-agent-record-estate-"));
  let run: ReturnType<typeof spawn> | null = null;
  try {
    const recordStore = path.join(directory, "records");
    const binDirectory = path.join(directory, "bin");
    const workflowPath = path.join(directory, "held-worker.mjs");
    const reaperTriggerPath = path.join(directory, "reaper-trigger.mjs");
    const turnStartMarker = path.join(directory, "turn-started");
    await mkdir(binDirectory);
    await writeFile(path.join(binDirectory, "codex"), `#!/usr/bin/env node\nimport ${JSON.stringify(recordingAppServerPath)};\n`);
    await chmod(path.join(binDirectory, "codex"), 0o755);
    await writeFile(workflowPath, `
      export const meta = { name: "reaper-preserves-agent-record" };
      return await agent("remain in progress until the launcher is killed", { engine: "codex", maxAttempts: 1 });
    `);
    await writeFile(reaperTriggerPath, `export const meta = { name: "reaper-trigger" };\nreturn "triggered";\n`);

    const environment = hermeticEstateEnvironment({
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      ENSEMBLE_CODEX_SCHEMA_CLI: await executablePath("codex"),
      ENSEMBLE_FAKE_CODEX_STALL_AFTER_TURN_START: "1",
      ENSEMBLE_FAKE_CODEX_TURN_START_MARKER: turnStartMarker,
      ENSEMBLE_RUN_RECORD: "1",
      ENSEMBLE_RUN_RECORD_DIR: recordStore,
      ENSEMBLE_STATUS: "0",
      XDG_DATA_HOME: path.join(directory, "data")
    });
    const markerWritten = waitForCreatedFile(directory, path.basename(turnStartMarker));
    run = spawn(process.execPath, [bundledCliPath, workflowPath], {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "ignore", "ignore"]
    });
    await markerWritten;

    // This observation earns its place only by showing that the production
    // writer had already persisted the dispatch record before the kill.
    const agentPath = await findOnlyFile(recordStore, "agent.json");
    const beforeKill = JSON.parse(await readFile(agentPath, "utf8")) as { status: string };
    assert.equal(beforeKill.status, "in-progress");

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      run?.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(run.kill("SIGKILL"), true);
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
    run = null;

    // Starting another real built-bundle run is the product's normal reap
    // trigger. It writes no agent record, leaving one unambiguous target for
    // the cold consumer below.
    const trigger = await runNode([bundledCliPath, reaperTriggerPath], environment, 30_000);
    assert.equal(trigger.code, 0, trigger.stderr);

    const consumer = await runNode([archiveReaderPath, recordStore]);
    assert.equal(consumer.code, 0, consumer.stderr);
    const agents = JSON.parse(consumer.stdout) as ArchivedAgent[];
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.status, "abandoned");
    assert.equal(agents[0]?.abandonment?.reason, "owner-process-gone");
    assert.ok(agents[0]?.abandonment?.observed_at);
    assert.ok(agents[0]?.abandonment?.observed_by.run_uuid);
  } finally {
    if (run !== null && !run.killed) {
      run.kill("SIGKILL");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForCreatedFile(directory: string, filename: string): Promise<void> {
  const watcher = watch(directory);
  try {
    for await (const event of watcher) {
      if (event.eventType === "rename" && event.filename === filename) {
        return;
      }
    }
  } finally {
    await watcher.return?.();
  }
}
