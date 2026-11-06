import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { hermeticEstateEnvironment } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

test("built CLI keeps two overlapping runs visible through their sentinel handoff", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-status-lifecycle-estate-"));
  const statusDir = path.join(directory, "status");
  const dataHome = path.join(directory, "data");
  await mkdir(statusDir);
  const children: Array<ReturnType<typeof spawn>> = [];

  try {
    const runs = await Promise.all([900, 1_200].map(async (duration, index) => {
      const script = path.join(directory, `run-${index}.js`);
      await writeFile(script, `
        export const meta = { name: "status-poll-${index}" };
        const fs = require("node:fs");
        const statusDir = ${JSON.stringify(statusDir)};
        const startVisible = fs.readdirSync(statusDir)
          .filter(name => name.startsWith("ensemble.") && name.endsWith(".local.json"))
          .some(name => JSON.parse(fs.readFileSync(statusDir + "/" + name, "utf8")).owner.pid === process.pid);
        await new Promise(resolve => setTimeout(resolve, ${duration}));
        return { index: ${index}, startVisible };
      `);
      const startedAt = Date.now();
      const child = spawn(process.execPath, [bundledCliPath, script], {
        cwd: directory,
        env: { ...hermeticEstateEnvironment(), ENSEMBLE_STATUS_DIR: statusDir, XDG_DATA_HOME: dataHome },
        stdio: ["ignore", "pipe", "pipe"]
      });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      const finished = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      return { child, startedAt, finished, stdout: () => stdout, stderr: () => stderr, firstPublicationMs: null as number | null, runId: null as string | null, gaps: 0 };
    }));

    let observedOverlap = false;
    while (runs.some((run) => run.child.exitCode === null)) {
      const names = (await readdir(statusDir)).filter((name) => name.startsWith("ensemble.") && name.endsWith(".local.json"));
      const snapshots = await Promise.all(names.map(async (name) => {
        try {
          return JSON.parse(await readFile(path.join(statusDir, name), "utf8")) as { pid: number; runId: string };
        } catch {
          return null;
        }
      }));
      observedOverlap ||= runs.every((run) => snapshots.some((item) => item?.pid === run.child.pid));
      for (const run of runs) {
        if (run.child.exitCode !== null) continue;
        const snapshot = snapshots.find((item) => item?.pid === run.child.pid);
        if (snapshot !== undefined && snapshot !== null) {
          run.runId = snapshot.runId;
          run.firstPublicationMs ??= Date.now() - run.startedAt;
          continue;
        }
        if (run.runId === null) continue;
        const sentinelPath = run.stderr().match(/\[sentinel\] will write (\S+) when the run ends/)?.[1];
        if (sentinelPath === undefined) continue;
        try {
          await readFile(sentinelPath, "utf8");
        } catch {
          run.gaps += 1;
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    for (const run of runs) {
      assert.equal(await run.finished, 0, run.stderr());
      assert.equal((JSON.parse(run.stdout()) as { startVisible: boolean }).startVisible, true, "the script body began with its own status file visible");
      assert.ok(run.runId !== null, `no status file observed for pid ${run.child.pid}`);
      assert.equal(run.gaps, 0, `a live pid lost status before its sentinel landed: ${run.stderr()}`);
      const sentinelPath = run.stderr().match(/\[sentinel\] will write (\S+) when the run ends/)?.[1];
      assert.ok(sentinelPath);
      await readFile(sentinelPath, "utf8");
      console.log(`pid ${run.child.pid}: first status publication ${run.firstPublicationMs} ms after spawn`);
    }
    assert.equal(observedOverlap, true, "the poller must see both run files at the same time");
    assert.deepEqual((await readdir(statusDir)).filter((name) => name.endsWith(".local.json")), []);
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
});
