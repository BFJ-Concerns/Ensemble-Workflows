import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executablePath, findOnlyFile, hermeticEstateEnvironment, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const recordingAppServerPath = path.resolve("test/fixtures/codex/recording-app-server.mjs");
const sentinelReaderPath = path.resolve("test/consumers/read-completion-sentinel.mjs");
const archiveReaderPath = path.resolve("test/consumers/read-archive-integrity.mjs");
const livenessReaderPath = path.resolve("test/consumers/read-archive-liveness.mjs");

test("terminal sentinel and durable record agree on a handled terminal error", async () => {
  await withEstate(async (estate) => {
    const workflow = await estate.workflow(`export const meta = { name: "terminal-error-equivalence" }; throw new Error("ESTATE_TERMINAL_ERROR");`);
    const run = await estate.run([workflow]);
    assert.equal(run.code, 1);
    const sentinel = await estate.readSentinel(run.stderr);
    const archive = await estate.archive();
    const manifest = await json<{ error: unknown }>(path.join(archive, "manifest.json"));
    const result = await json<{ error: unknown }>(path.join(archive, "result.json"));
    const stdout = JSON.parse(run.stdout);
    assert.deepEqual(sentinel.error, manifest.error);
    assert.deepEqual(sentinel.error, result.error);
    assert.equal(stdout.reason, "failed");
    assert.equal(sentinel.outcome, "failed");
    assert.equal(sentinel.exit_code, 1);
  });
});

test("supervisor reader sees unsettled work after a controlled timeout", async () => {
  await withEstate(async (estate) => {
    const workflow = await estate.workflow(`
      export const meta = { name: "positive-unsettled" };
      return await parallel([
        () => agent("first hanging worker", { engine: "codex", maxAttempts: 1 }),
        () => agent("second hanging worker", { engine: "codex", maxAttempts: 1 })
      ]);
    `);
    const marker = path.join(estate.directory, "turn-started");
    const run = await estate.runInterrupted([workflow], marker, { ENSEMBLE_FAKE_CODEX_STALL_AFTER_TURN_START: "1", ENSEMBLE_FAKE_CODEX_TURN_START_MARKER: marker });
    assert.equal(run.code, 1, run.stderr);
    const sentinel = await estate.readSentinel(run.stderr);
    assert.equal(sentinel.outcome, "interrupted");
    assert.ok(sentinel.workers.unsettled > 0, JSON.stringify(sentinel));
  });
});

test("cold archive reader retains failed-attempt duration and per-attempt retry resolutions", async () => {
  await withEstate(async (estate) => {
    const workflow = await estate.workflow(`
      export const meta = { name: "retry-resolution-history" };
      return await agent("retry with distinct served values", { engine: "codex", maxAttempts: 2, schema: { type: "number" } });
    `);
    const run = await estate.run([workflow], {
      ENSEMBLE_FAKE_CODEX_RESPONSES: JSON.stringify(["not a number", "2"]),
      ENSEMBLE_FAKE_CODEX_THREAD_RESOLUTIONS: JSON.stringify([
        { model: "gpt-first", effort: "low" },
        { model: "gpt-second", effort: "high" }
      ])
    });
    assert.equal(run.code, 0, run.stderr);
    const archive = await estate.archive();
    const agent = await json<{ attempts: Array<{ status: string; duration_ms: number | null; resolved_model: string | null; resolved_effort: string | null }> }>(await findOnlyFile(archive, "agent.json"));
    assert.equal(agent.attempts.length, 2);
    const firstAttempt = agent.attempts[0];
    assert.ok(firstAttempt);
    assert.equal(firstAttempt.status, "failed");
    assert.equal(typeof firstAttempt.duration_ms, "number");
    assert.ok(firstAttempt.duration_ms !== null && firstAttempt.duration_ms >= 0);
    assert.deepEqual(agent.attempts.map((attempt) => [attempt.resolved_model, attempt.resolved_effort]), [
      ["gpt-first", "low"],
      ["gpt-second", "high"]
    ]);
  });
});

test("sentinel reader rejects a tamper and malformed content, while recording-off remains attested", async () => {
  await withEstate(async (estate) => {
    const workflow = await estate.workflow(`export const meta = { name: "sentinel-integrity" }; return "ok";`);
    const run = await estate.run([workflow]);
    assert.equal(run.code, 0, run.stderr);
    const sentinelPath = sentinelPathFrom(run.stderr);
    const original = await readFile(sentinelPath, "utf8");
    await writeFile(sentinelPath, original.replace('"outcome": "complete"', '"outcome": "failed"'));
    const tampered = await runNode([sentinelReaderPath, sentinelPath]);
    assert.notEqual(tampered.code, 0, "reader accepted a tampered sentinel");
    await writeFile(sentinelPath, "not json\n");
    const malformed = await runNode([sentinelReaderPath, sentinelPath]);
    assert.notEqual(malformed.code, 0, "reader accepted malformed sentinel content");

    const off = await estate.run([workflow], { ENSEMBLE_RUN_RECORD: "0" }, "off");
    assert.equal(off.code, 0, off.stderr);
    const offSentinel = await estate.readSentinel(off.stderr);
    assert.deepEqual(offSentinel.manifest, { unavailable: "recording-disabled" });
  });
});

test("cold archive reader reconciles a non-complete record and distinguishes absent from unreadable proc evidence", async () => {
  await withEstate(async (estate) => {
    const workflow = await estate.workflow(`
      export const meta = { name: "non-complete-reconciliation" };
      const { readdir, rm } = await import("node:fs/promises");
      const path = (await import("node:path")).default;
      const entries = await readdir(process.env.ENSEMBLE_RUN_RECORD_DIR, { recursive: true });
      const manifest = entries.find((entry) => path.basename(entry) === "manifest.json");
      await rm(path.join(process.env.ENSEMBLE_RUN_RECORD_DIR, path.dirname(manifest), "workflow.js"));
      return "ok";
    `);
    const run = await estate.run([workflow]);
    assert.equal(run.code, 0, run.stderr);
    const archive = await estate.archive();
    const read = await runNode([archiveReaderPath, archive]);
    assert.equal(read.code, 0, read.stderr);
    const integrity = JSON.parse(read.stdout);
    assert.equal(integrity.status, "incomplete");
    assert.deepEqual(integrity.filesLost, [{ path: "workflow.js", reason: "missing" }]);
    const result = await json<{ status: string }>(path.join(archive, "result.json"));
    assert.equal(result.status, "complete");

    const livenessManifest = path.join(estate.directory, "liveness-manifest.json");
    const manifest = await json<{ status: string; owner: unknown }>(path.join(archive, "manifest.json"));
    manifest.status = "in-progress";
    manifest.owner = { pid: 999999, start_ticks: "123", host: hostname() };
    await writeFile(livenessManifest, `${JSON.stringify(manifest)}\n`);
    const absent = await runNode([livenessReaderPath, livenessManifest, "/proc", hostname()]);
    assert.equal(absent.code, 0, absent.stderr);
    assert.deepEqual(JSON.parse(absent.stdout), { verdict: "dead", reason: "owner-process-gone" });
    const unreadable = await runNode([livenessReaderPath, livenessManifest, path.join(estate.directory, "missing-proc"), hostname()]);
    assert.equal(unreadable.code, 0, unreadable.stderr);
    assert.deepEqual(JSON.parse(unreadable.stdout), { verdict: "undecidable", reason: null });
  });
});

async function withEstate(body: (estate: Awaited<ReturnType<typeof createEstate>>) => Promise<void>): Promise<void> {
  const estate = await createEstate();
  try { await body(estate); } finally { await rm(estate.directory, { recursive: true, force: true }); }
}

async function createEstate() {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-sentinel-record-estate-"));
  const bin = path.join(directory, "bin");
  const store = path.join(directory, "records");
  await mkdir(bin);
  await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node\nimport ${JSON.stringify(recordingAppServerPath)};\n`);
  await chmod(path.join(bin, "codex"), 0o755);
  const schemaCli = await executablePath("codex");
  const environment = (overrides: NodeJS.ProcessEnv = {}, lane = "on") => ({
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    ENSEMBLE_CODEX_SCHEMA_CLI: schemaCli,
    ENSEMBLE_RUN_RECORD: "1",
    ENSEMBLE_RUN_RECORD_DIR: path.join(store, lane),
    ENSEMBLE_STATUS: "0",
    XDG_DATA_HOME: path.join(directory, "data", lane),
    ...overrides
  });
  return {
    directory,
    workflow: async (source: string) => { const file = path.join(directory, `workflow-${workflowNumber++}.js`); await writeFile(file, source); return file; },
    run: (args: string[], overrides: NodeJS.ProcessEnv = {}, lane = "on") => runNode([bundledCliPath, ...args], environment(overrides, lane), 15_000),
    runInterrupted: (args: string[], marker: string, overrides: NodeJS.ProcessEnv = {}) => interruptAfterMarker([bundledCliPath, ...args], marker, environment(overrides)),
    archive: async () => path.dirname(await findOnlyFile(store, "manifest.json")),
    readSentinel: async (stderr: string) => {
      const read = await runNode([sentinelReaderPath, sentinelPathFrom(stderr)]);
      assert.equal(read.code, 0, read.stderr);
      return JSON.parse(read.stdout);
    }
  };
}

function sentinelPathFrom(stderr: string): string {
  const match = stderr.match(/^\[sentinel\] will write (\S+) when the run ends$/m);
  assert.ok(match, `missing sentinel announcement:\n${stderr}`);
  return match[1]!;
}

async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }
let workflowNumber = 0;
async function interruptAfterMarker(args: string[], marker: string, environment: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: hermeticEstateEnvironment(environment), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk)); child.stderr.on("data", (chunk: string) => (stderr += chunk));
  await waitForFile(marker);
  child.kill("SIGINT");
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stdout, stderr };
}

async function waitForFile(file: string): Promise<void> {
  try { await access(file); return; } catch { /* wait for the fixture's deterministic marker */ }
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(path.dirname(file), async () => {
      try { await access(file); watcher.close(); resolve(); } catch { /* another directory event */ }
    });
    watcher.once("error", reject);
  });
}
