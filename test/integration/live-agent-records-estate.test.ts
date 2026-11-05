import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { executablePath, runNode } from "./estate-process.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const fixture = path.resolve("test/fixtures/codex/recording-app-server.mjs");
const consumer = path.resolve("test/consumers/read-live-agent-records.mjs");

test("an independent reader follows queued, retried and held workers through the built CLI archive", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp("/mnt/ai-data/scratch/ensemble-live-records-estate-");
  try {
    const store = path.join(directory, "records");
    const bin = path.join(directory, "bin");
    const workflow = path.join(directory, "workflow.mjs");
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
    const notifications = answers.map((answer, index) => [
      { method: "item/agentMessage/delta", params: { itemId: "message", delta: answer.slice(0, 2) }, afterMs: 60 },
      { method: "item/agentMessage/delta", params: { itemId: "message", delta: answer.slice(2) }, afterMs: 100 },
      { method: "turn/completed", params: { turn: { id: `turn-${index + 1}`, items: [], status: "completed" } }, afterMs: 120 }
    ]);
    const schemaCli = await executablePath("codex");
    const [run, read] = await Promise.all([
      runNode([bundle, workflow], {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        ENSEMBLE_CODEX_SCHEMA_CLI: schemaCli,
        ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: store, ENSEMBLE_STATUS: "0",
        ENSEMBLE_CONCURRENCY_CODEX: "1",
        ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify(notifications),
        ENSEMBLE_FAKE_CODEX_STALL_AFTER_NOTIFICATION_SEQUENCE: "1",
        XDG_CONFIG_HOME: path.join(directory, "config")
      }, 45_000),
      runNode([consumer, store, "4"], {}, 50_000)
    ]);
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
    await rm(directory, { recursive: true, force: true });
  }
});
