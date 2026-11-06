import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { executablePath, runNode } from "./estate-process.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const consumer = path.resolve("test/consumers/read-live-status.mjs");
const fixture = path.resolve("test/fixtures/codex/recording-app-server.mjs");

async function setup() {
  const directory = await mkdtemp("/mnt/ai-data/scratch/ensemble-live-status-estate-");
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node\nimport ${JSON.stringify(fixture)};\n`);
  await chmod(path.join(bin, "codex"), 0o755);
  return { directory, env: {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    ENSEMBLE_CODEX_SCHEMA_CLI: await executablePath("codex"),
    ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"),
    XDG_CONFIG_HOME: path.join(directory, "config"),
    XDG_DATA_HOME: path.join(directory, "data")
  } };
}

function barrier(file: string): string {
  return `const fs = require("node:fs"); while (!fs.existsSync(${JSON.stringify(file)})) await new Promise(resolve => setTimeout(resolve, 10)); return "complete";`;
}

test("a separate status consumer follows queued, retried, failed and held workers through the built launcher", { timeout: 90_000 }, async () => {
  const { directory, env } = await setup();
  try {
    const releaseFile = path.join(directory, "release");
    const acknowledgements = path.join(directory, "observed");
    await writeFile(acknowledgements, "");
    const workflow = path.join(directory, "workflow.mjs");
    await writeFile(workflow, `
      export const meta = { name: "status-supervision" };
      const options = { engine: "codex", model: "requested-model", effort: "high", maxAttempts: 1 };
      await parallel([
        () => agent("first", { ...options, label: "first" }),
        () => agent("retry", { ...options, label: "retry", maxAttempts: 2,
          schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false } })
      ]);
      await agent("failure", { ...options, label: "failure" });
      const held = session({ ...options, label: "held" });
      try { await held.send("first held turn"); await held.send("second held turn"); }
      finally { await held.close(); }
      ${barrier(releaseFile)}
    `);
    const owners = [[1, 1], [2, 1], [2, 2], [3, 1], [4, 1], [5, 1]];
    const answers = ["first", "invalid JSON", '{"answer":"yes"}', "", "held first", "held second"];
    const usage = { cachedInputTokens: 0, inputTokens: 5, outputTokens: 2, totalTokens: 7 };
    const notifications = owners.map(([id, attempt], index) => [
      ...(answers[index] === "" ? [] : [
        { method: "item/agentMessage/delta", params: { itemId: "message", delta: answers[index]!.slice(0, 2) }, afterFirstDeltaControl: `${id}:attempt:${attempt}` },
        { method: "item/agentMessage/delta", params: { itemId: "message", delta: answers[index]!.slice(2) }, afterFirstDeltaControl: `${id}:${attempt}:evidence` }
      ]),
      { method: "thread/tokenUsage/updated", params: { tokenUsage: { last: usage, total: usage } },
        allowMalformed: "the generated Codex notification schema omits the runtime's established token-usage event", afterFirstDeltaControl: answers[index] === "" ? `${id}:running` : `${id}:${attempt}:growth` },
      { method: "turn/completed", params: { turn: { id: `turn-${index + 1}`, items: [], status: "completed" } } }
    ]);
    const spec = path.join(directory, "spec.json");
    await writeFile(spec, JSON.stringify({ bundle, workflow, cwd: directory, releaseFile, acknowledgements,
      workers: owners.filter(([, attempt]) => attempt === 1).map(([id]) => ({ id, state: id === 3 ? "failed" : "done",
        requestedModel: "requested-model", requestedEffort: "high", resolvedModel: "gpt-estate-recorder", resolvedEffort: "high",
        spent: id === 2 ? 14 : 7, queued: id === 2, growth: id !== 3 }))
    }));
    // Empty output cannot be requested reliably from a live model. The
    // schema-validated fixture supplies only that failure condition here;
    // the matching real-engine supervision journey lives in test/live/.
    const result = await runNode([consumer, spec], { ...env,
      ENSEMBLE_CONCURRENCY_CODEX: "1", ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify(notifications),
      ENSEMBLE_FAKE_CODEX_FIRST_DELTA_CONTROL: acknowledgements, ENSEMBLE_FAKE_CODEX_STALL_AFTER_NOTIFICATION_SEQUENCE: "1"
    }, 70_000);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stdout, "complete");
    assert.equal(report.snapshot.totals.done, 4);
    assert.equal(report.snapshot.totals.failed, 1);
    assert.deepEqual(report.workers.find(([id]: [number]) => id === 2)[1].attempts, [1, 2]);
    const held = report.workers.filter(([id]: [number]) => id === 4 || id === 5);
    assert.notEqual(held[0][1].latest.transcript, held[1][1].latest.transcript);
    assert.equal(report.announcement.status_path, path.join(directory, "data", "ensemble", "status", `ensemble.${report.announcement.run_id}.local.json`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("status disablement and explicit directories preserve discovery and independent concurrent files", { timeout: 90_000 }, async () => {
  const { directory, env } = await setup();
  const running: Array<Promise<unknown>> = [];
  try {
    const status = path.join(directory, "status");
    await mkdir(status);
    const specs = [];
    for (let index = 0; index < 2; index += 1) {
      const workflow = path.join(directory, `workflow-${index}.mjs`);
      const releaseFile = path.join(directory, `release-${index}`);
      const finishWhen = path.join(directory, `finish-${index}`);
      const readyFile = path.join(directory, `ready-${index}`);
      await writeFile(workflow, `export const meta = { name: "concurrent-status" }; ${barrier(releaseFile)}`);
      const spec = path.join(directory, `spec-${index}.json`);
      await writeFile(spec, JSON.stringify({ bundle, workflow, cwd: directory, releaseFile, finishWhen, readyFile, workers: [] }));
      const result = runNode([consumer, spec], { ...env, ENSEMBLE_STATUS_DIR: status }, 60_000);
      running.push(result);
      specs.push({ result, finishWhen, readyFile });
    }
    await Promise.all(specs.map((spec) => Promise.race([waitForFile(spec.readyFile), spec.result.then((result) => {
      assert.fail(`status reader exited before readiness: ${result.stderr}`);
    })])));
    const [first, second] = await Promise.all(specs.map(async (spec) => JSON.parse(await readFile(spec.readyFile, "utf8"))));
    assert.notEqual(first.status_path, second.status_path);
    assert.equal(path.dirname(first.status_path), status);
    await writeFile(specs[0]!.finishWhen, "");
    const finished = await specs[0]!.result;
    assert.equal(finished.code, 0, finished.stderr);
    await access(second.status_path);
    await writeFile(specs[1]!.finishWhen, "");
    const remaining = await specs[1]!.result;
    assert.equal(remaining.code, 0, remaining.stderr);
    const quick = path.join(directory, "quick.mjs");
    await writeFile(quick, 'export const meta = { name: "disabled-status" }; return true;');
    const disabled = await runNode([bundle, quick], { ...env, ENSEMBLE_STATUS: "off", ENSEMBLE_STATUS_DIR: path.join(directory, "absent") });
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.doesNotMatch(disabled.stderr, /\[status-file\]/);
    const invalid = await runNode([bundle, quick], { ...env, ENSEMBLE_STATUS_DIR: path.join(directory, "absent") });
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /Configured status directory/);
  } finally {
    await writeFile(path.join(directory, "finish-0"), "");
    await writeFile(path.join(directory, "finish-1"), "");
    await Promise.allSettled(running);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the built status surface bounds finished entries without losing totals", { timeout: 90_000 }, async () => {
  const { directory, env } = await setup();
  try {
    const releaseFile = path.join(directory, "release");
    const workflow = path.join(directory, "workflow.mjs");
    await writeFile(workflow, `export const meta = { name: "bounded-status" }; for (let index = 0; index < 70; index += 1) await agent("fixture", { engine: "codex" }); ${barrier(releaseFile)}`);
    const spec = path.join(directory, "spec.json");
    await writeFile(spec, JSON.stringify({ bundle, workflow, cwd: directory, releaseFile, workers: [], terminalTotals: 70, retainedCount: 64 }));
    const result = await runNode([consumer, spec], env, 60_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).snapshot.totals.done, 70);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await access(file); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  assert.fail(`consumer did not publish ${file}`);
}
