import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runLauncher } from "../live/launcher.js";
import { hermeticEstateEnvironment } from "./estate-process.js";

test("live launcher helper bounds a workflow that never returns", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "live-launcher-deadline-"));
  try {
    const script = path.join(directory, "workflow.js");
    await writeFile(script, 'export const meta = { name: "stalled" }; await new Promise(() => { setInterval(() => {}, 1000); });');
    const result = await runLauncher([script], {
      signal: t.signal,
      timeoutMs: 100,
      env: hermeticEstateEnvironment({ ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records") })
    });
    assert.notEqual(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reason, "timed-out");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live launcher helper reaps its child before cancellation settles", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "live-launcher-cancel-"));
  const controller = new AbortController();
  const signal = AbortSignal.any([t.signal, controller.signal]);
  let running: ReturnType<typeof runLauncher> | undefined;
  try {
    const script = path.join(directory, "workflow.js");
    const ready = path.join(directory, "ready");
    await writeFile(script, `export const meta = { name: "cancelled" };
      const fs = await import("node:fs/promises");
      await fs.writeFile(${JSON.stringify(ready)}, String(process.pid));
      await new Promise(() => { setInterval(() => {}, 1000); });`);
    running = runLauncher([script], {
      signal,
      env: hermeticEstateEnvironment({ ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records") })
    });
    // Attach the rejection handler before cancellation can reject the promise.
    const stopped = assert.rejects(running, { name: "AbortError" });
    let pid: number | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && pid === undefined) {
      const text = await readFile(ready, "utf8").catch(() => undefined);
      if (text !== undefined) pid = Number(text);
      else await delay(20, undefined, { signal: t.signal });
    }
    assert.ok(pid !== undefined, "launcher never reached its workflow");
    controller.abort();
    await stopped;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    controller.abort();
    await running?.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
