import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { executablePath, runNode } from "./estate-process.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const fixture = path.resolve("test/fixtures/codex/recording-app-server.mjs");
const consumer = path.resolve("test/consumers/read-live-agent-records.mjs");

test("an independent reader follows queued, retried and held workers through the built CLI archive", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp("/mnt/ai-data/scratch/ensemble-live-records-estate-");
  const processes: Array<Promise<unknown>> = [];
  try {
    const store = path.join(directory, "records");
    const bin = path.join(directory, "bin");
    const workflow = path.join(directory, "workflow.mjs");
    const turnStarted = path.join(directory, "turn-started");
    const acknowledgements = path.join(directory, "observed");
    await writeFile(acknowledgements, "");
    await mkdir(store);
    await mkdir(bin);
    await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node\nimport ${JSON.stringify(fixture)};\n`);
    await chmod(path.join(bin, "codex"), 0o755);
    await writeFile(workflow, `
      export const meta = { name: "live-archive-records" };
      await parallel([
        () => agent("first", { engine: "codex", label: "first", maxAttempts: 1 }),
        () => agent("queued", { engine: "codex", label: "queued", maxAttempts: 2,
          schema: { type: "object", required: ["answer"], additionalProperties: false,
            properties: { answer: { type: "string" } } } })
      ]);
      const held = session({ engine: "codex", label: "held", maxAttempts: 1 });
      try {
        await held.send("held first");
        await held.send("held second");
      } finally { await held.close(); }
      return "complete";
    `);
    const answers = ["first", "invalid JSON", '{"answer":"yes"}', "held first", "held second"];
    const owners = [[1, 1], [2, 1], [2, 2], [3, 1], [4, 1]];
    const notifications = answers.map((answer, index) => [
      { method: "item/agentMessage/delta", params: { itemId: "message", delta: answer.slice(0, 2) }, afterFirstDeltaControl: index === 0 ? "parent-read-start" : `observed:${owners[index]!.join(":")}:started` },
      { method: "item/agentMessage/delta", params: { itemId: "message", delta: answer.slice(2) }, afterFirstDeltaControl: `observed:${owners[index]!.join(":")}:output` },
      { method: "turn/completed", params: { turn: { id: `turn-${index + 1}`, items: [], status: "completed" } }, afterFirstDeltaControl: `observed:${owners[index]!.join(":")}:grown` }
    ]);
    const schemaCli = await executablePath("codex");
    const runProcess = runNode([bundle, workflow], {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        ENSEMBLE_CODEX_SCHEMA_CLI: schemaCli,
        ENSEMBLE_FAKE_CODEX_TURN_START_MARKER: turnStarted,
        ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: store, ENSEMBLE_STATUS: "0",
        ENSEMBLE_CONCURRENCY_CODEX: "1",
        ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify(notifications),
        ENSEMBLE_FAKE_CODEX_FIRST_DELTA_CONTROL: acknowledgements,
        ENSEMBLE_FAKE_CODEX_STALL_AFTER_NOTIFICATION_SEQUENCE: "1",
        XDG_CONFIG_HOME: path.join(directory, "config")
      }, 45_000);
    const readProcess = runNode([consumer, store, "4", "45000", acknowledgements], {}, 50_000);
    processes.push(runProcess, readProcess);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const marker = await readFile(turnStarted, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (marker !== null) break;
      assert.ok(Date.now() < deadline, "fixture never accepted a turn");
      await delay(10);
    }
    const entries = await readdir(store, { recursive: true });
    const recordPath = entries.find((entry) => entry.endsWith("agents/000001/agent.json"));
    assert.ok(recordPath, "executing worker has no archive record");
    const running = JSON.parse(await readFile(path.join(store, recordPath), "utf8"));
    assert.ok(running.current_attempt, "executing worker has no current-attempt start before its first output");
    assert.equal(running.current_attempt.attempt, 1);
    await appendFile(acknowledgements, "parent-read-start\n");
    const [run, read] = await Promise.all([runProcess, readProcess]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout), "complete");
    assert.equal(read.code, 0, read.stderr);
    const observations = JSON.parse(read.stdout) as Array<{
      id: number; label: string; queued: boolean;
      attempts: Array<{ attempt: number; transcript: string; sizes: number[]; readable: boolean }>;
    }>;
    assert.equal(observations.length, 4);
    assert.equal(observations.find((agent) => agent.label === "queued")?.queued, true);
    assert.deepEqual(observations.find((agent) => agent.label === "queued")?.attempts.map((attempt) => attempt.attempt), [1, 2]);
    for (const observation of observations) {
      assert.ok(observation.attempts.length > 0, `never observed agent ${observation.id} executing`);
      for (const attempt of observation.attempts) {
        assert.equal(attempt.readable, true);
        assert.ok(attempt.sizes.length > 1, `never observed transcript growth for agent ${observation.id}`);
      }
    }
    assert.equal(new Set(observations.flatMap((agent) => agent.attempts.map((attempt) => attempt.transcript))).size, 5);
  } finally {
    await Promise.allSettled(processes);
    await rm(directory, { recursive: true, force: true });
  }
});
