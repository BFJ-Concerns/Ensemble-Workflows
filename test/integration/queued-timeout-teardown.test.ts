import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readArchiveIntegrity } from "../archive-integrity-reader.js";
import { assertSalvageEnvelope, findOnlyFile, hermeticEstateEnvironment } from "./estate-process.js";

const deadlinePreload = path.resolve("test/fixtures/codex/release-workflow-timeout.mjs");
const launcher = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const signal of [null, "SIGINT", "SIGTERM"] as const) {
  test(`a timed-out admission backlog seals${signal === null ? "" : ` with ${signal} during teardown`}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-queued-timeout-"));
    const records = path.join(directory, "records");
    const bin = path.join(directory, "bin");
    const status = path.join(directory, "status");
    const config = path.join(directory, "config");
    await mkdir(bin);
    await mkdir(status);
    await mkdir(path.join(config, "ensemble"), { recursive: true });
    await writeFile(path.join(config, "ensemble", "config.json"), '{"schema_version":1}');
    const control = path.join(directory, "deadline-control");
    const started = path.join(directory, "codex-started");
    await writeFile(control, "");
    // With one admission slot, the first worker's app-server starting means
    // the script body has issued every call and the rest wait in the
    // backlog. That start, not host speed, releases the 25 ms run deadline;
    // the fixture never answers, so the slot stays held until teardown.
    await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("codex fixture"); process.exit(0); }
appendFileSync(${JSON.stringify(started)}, process.pid + "\\n");
appendFileSync(${JSON.stringify(control)}, "ready\\n");
process.stdin.resume();
`);
    await chmod(path.join(bin, "codex"), 0o755);
    const script = path.join(directory, "workflow.js");
    const count = signal === null ? 10_000 : 1_000;
    await writeFile(script, `export const meta = { name: "queued-timeout" };
await Promise.all(Array.from({ length: ${count} }, () => agent("pending", { engine: "codex", maxAttempts: 1 })));`);
    let stdout = "";
    let stderr = "";
    let signalSent = false;
    let watchdogFired = false;
    const child = spawn(process.execPath, ["--import", deadlinePreload, launcher, "--timeout", "25", "--agent-ceiling", "1", script], {
      env: hermeticEstateEnvironment({
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: directory, XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(directory, "data"),
        ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: records,
        ENSEMBLE_STATUS: "1", ENSEMBLE_STATUS_DIR: status,
        ENSEMBLE_WORKFLOW_TIMEOUT_CONTROL: control
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const watchdog = setTimeout(() => { watchdogFired = true; child.kill("SIGKILL"); }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (signal !== null && !signalSent && stderr.includes("[teardown] stopping workers")) {
        signalSent = child.kill(signal);
      }
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(watchdogFired, false, `teardown exceeded its watchdog: ${stderr}`);
      assert.equal(code, 1, stderr);
      assert.equal(signalSent, signal !== null, stderr);
      const deadlines = await readFile(control, "utf8");
      assert.match(deadlines, /^armed:workflow:\d+:25$/m);
      assert.match(deadlines, /^ready$/m, "the deadline fired before the backlog formed");
      assertSalvageEnvelope(stdout, "timed-out", []);
      const manifestPath = await findOnlyFile(records, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.status, "timed-out");
      assert.equal(manifest.result.exit_code, 1);
      assert.equal(manifest.files.filter((file: { path: string }) => file.path.endsWith("/agent.json")).length, count);
      const sentinel = JSON.parse(await readFile(await findOnlyFile(records, "completion-sentinel.json"), "utf8"));
      assert.equal(sentinel.outcome, "timed-out");
      assert.equal(sentinel.exit_code, 1);
      const integrity = await readArchiveIntegrity(path.dirname(manifestPath));
      assert.equal(integrity.manifestVerified, true);
      assert.equal(integrity.agentRecordsVerified, count);
      assert.equal(integrity.sentinelAttestsManifest, true);
      const statusPath = stderr.match(/\[status-file\] (.+)/);
      assert.ok(statusPath, stderr);
      await assert.rejects(readFile(JSON.parse(statusPath[1]!).status_path), { code: "ENOENT" });
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
      }
      for (const pid of (await readFile(started, "utf8").catch(() => "")).split("\n").filter(Boolean)) {
        try { process.kill(Number(pid), "SIGKILL"); } catch { /* Already reaped. */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
