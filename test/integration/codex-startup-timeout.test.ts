import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readArchiveIntegrity } from "../archive-integrity-reader.js";
import { assertSalvageEnvelope, findOnlyFile, hermeticEstateEnvironment } from "./estate-process.js";

const deadlinePreload = path.resolve("test/fixtures/codex/release-workflow-timeout.mjs");
const launcher = path.resolve("plugin/skills/ensemble-workflow/scripts/ensemble.mjs");

for (const mode of ["silent-startup", "serial-failures"] as const) {
  test(`the built CLI seals a timed-out run with ${mode}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), `ensemble-${mode}-`));
    const records = path.join(directory, "records");
    const capture = path.join(directory, "codex-events.jsonl");
    const control = path.join(directory, "deadline-control");
    await writeFile(control, "");
    const bin = path.join(directory, "bin");
    const config = path.join(directory, "config");
    await mkdir(bin);
    await mkdir(path.join(config, "ensemble"), { recursive: true });
    await writeFile(path.join(config, "ensemble", "config.json"), '{"schema_version":1}');
    await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) { console.log("codex fixture"); process.exit(0); }
const capture = ${JSON.stringify(capture)};
const record = (event) => appendFileSync(capture, JSON.stringify({ event, pid: process.pid, at: Date.now() }) + "\\n");
record("started");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let thread = 0;
let turns = 0;
const ready = () => {
  record("ready");
  appendFileSync(${JSON.stringify(control)}, "ready\\n");
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    record("initialize");
    // Deliberately take longer than the nominal 25 ms run deadline.
    // Readiness, rather than host speed, must decide when that deadline fires.
    setTimeout(() => {
      if (${JSON.stringify(mode)} === "silent-startup") ready();
      else send({ id: message.id, result: {} });
    }, 100);
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-" + ++thread } } });
  } else if (message.method === "turn/start") {
    record("turn");
    // The sole admission slot proves both earlier failures have settled
    // before this third turn. Hold it so the remaining backlog cannot drain.
    if (++turns === 3) ready();
    else send({ id: message.id, error: { code: -32000, message: "serial fixture failure" } });
  }
});
`);
    await chmod(path.join(bin, "codex"), 0o755);
    const count = mode === "silent-startup" ? 1 : 12;
    const script = path.join(directory, "workflow.js");
    await writeFile(script, `export const meta = { name: ${JSON.stringify(mode)} };
await Promise.allSettled(Array.from({ length: ${count} }, () => agent("pending", { engine: "codex", maxAttempts: 1 })));
return "all workers settled";`);
    let stdout = "";
    let stderr = "";
    let teardownStarted = false;
    let teardownWatchdog: NodeJS.Timeout | undefined;
    let watchdogFired = false;
    const child = spawn(process.execPath, ["--import", deadlinePreload, launcher, "--timeout", "25", "--agent-ceiling", "1", script], {
      env: hermeticEstateEnvironment({
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: directory, XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(directory, "data"),
        ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: records, ENSEMBLE_STATUS: "0",
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
      if (!teardownStarted && stderr.includes("[teardown] stopping workers")) {
        teardownStarted = true;
        clearTimeout(watchdog);
        teardownWatchdog = setTimeout(() => { watchdogFired = true; child.kill("SIGKILL"); }, 20_000);
      }
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(watchdogFired, false, `teardown exceeded its watchdog: ${stderr}`);
      assert.equal(code, 1, stderr);
      assert.equal(teardownStarted, true, stderr);
      assert.match(stderr, /Workflow timed out after 25ms/);
      const deadlines = await readFile(control, "utf8");
      assert.match(deadlines, /^armed:workflow:\d+:25$/m);
      assert.match(deadlines, /^ready$/m);
      assertSalvageEnvelope(stdout, "timed-out", []);
      const events = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.event === "started").length, 1);
      assert.equal(events.filter(event => event.event === "initialize").length, 1, "deadline fired before initialize");
      const initialized = events.find(event => event.event === "initialize");
      const ready = events.find(event => event.event === "ready");
      assert.ok(ready, "deadline fired before the required worker state");
      assert.ok(ready.at - initialized.at > 25, "fixture did not delay beyond the nominal deadline");
      const turns = events.filter(event => event.event === "turn");
      if (mode === "silent-startup") {
        assert.equal(turns.length, 0);
      } else {
        assert.equal(turns.length, 3, "two failed workers must precede the pending turn");
        assert.ok(turns.length < count, "no admission backlog remained at timeout");
      }
      const manifestPath = await findOnlyFile(records, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.status, "timed-out");
      assert.equal(manifest.result.exit_code, 1);
      const agentPaths = manifest.files.filter((file: { path: string }) => file.path.endsWith("/agent.json"));
      assert.equal(agentPaths.length, count);
      if (mode === "serial-failures") {
        let failed = 0;
        for (const file of agentPaths) {
          const agent = JSON.parse(await readFile(path.join(path.dirname(manifestPath), file.path), "utf8"));
          if (agent.attempts.some((attempt: { failure: { message: string } | null }) =>
            attempt.failure?.message.includes("serial fixture failure"))) failed++;
        }
        assert.ok(failed >= 2, `only ${failed} serial worker failures were archived`);
      }
      const sentinel = JSON.parse(await readFile(await findOnlyFile(records, "completion-sentinel.json"), "utf8"));
      assert.equal(sentinel.outcome, "timed-out");
      assert.equal(sentinel.exit_code, 1);
      const integrity = await readArchiveIntegrity(path.dirname(manifestPath));
      assert.equal(integrity.manifestVerified, true);
      assert.equal(integrity.agentRecordsVerified, count);
      assert.equal(integrity.sentinelAttestsManifest, true);
      for (const event of events.filter(event => event.event === "started")) {
        assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" }, "app-server survived teardown");
      }
    } finally {
      clearTimeout(watchdog);
      clearTimeout(teardownWatchdog);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
      }
      const events = await readFile(capture, "utf8").catch(() => "");
      for (const line of events.trim().split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.event === "started") {
          try { process.kill(event.pid, "SIGKILL"); } catch { /* Already reaped. */ }
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
