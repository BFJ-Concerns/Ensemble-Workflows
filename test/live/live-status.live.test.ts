import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runNode, runProcess } from "../integration/estate-process.js";
import type { ProcessResult } from "../integration/estate-process.js";
import { heldProbeFollowUpPrompt, heldProbePrompt, probePaths } from "./held-worker-probes.js";
import type { HeldProbe } from "./held-worker-probes.js";
import { liveCodexModel } from "./live-models.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const consumer = path.resolve("test/consumers/read-live-status.mjs");

for (const engine of ["claude", "codex"] as const) {
  test(`live ${engine} status alone supervises queued, isolated and held workers`, {
    skip: process.env.ENSEMBLE_LIVE !== "1" || (engine === "codex" && liveCodexModel === undefined),
    timeout: 1_200_000
  }, async () => {
    const directory = await mkdtemp("/mnt/ai-data/scratch/ensemble-live-status-");
    const repo = path.join(directory, "repo");
    const probes: HeldProbe[] = ["first", "queued", "held-first", "held-second"].map((name) => ({
      paths: probePaths(directory, name), evidence: { kind: "marker", content: `${name}_${randomUUID()}` },
      token: `RELEASED_${randomUUID()}`
    }));
    let reader: Promise<ProcessResult> | undefined;
    try {
      await mkdir(repo);
      const init = await runProcess("git", ["-C", repo, "init", "--initial-branch=main"]);
      assert.equal(init.code, 0, init.stderr);
      const commit = await runProcess("git", ["-C", repo, "-c", "user.name=Ensemble test", "-c", "user.email=ensemble@example.invalid", "commit", "--allow-empty", "-m", "initialise test repository"]);
      assert.equal(commit.code, 0, commit.stderr);
      const acknowledgements = path.join(directory, "observed");
      const releaseFile = path.join(directory, "finish");
      await writeFile(acknowledgements, "");
      const workflow = path.join(directory, "workflow.mjs");
      const model = engine === "codex" ? liveCodexModel : undefined;
      const options = { engine, cwd: repo, effort: "medium", ...(model ? { model } : {}), timeoutMs: 240_000, maxAttempts: 1 };
      // All model-facing text comes from the existing held-probe builders.
      const prompts = probes.map((probe, index) => index === 3 ? heldProbeFollowUpPrompt(probe) : heldProbePrompt(probe));
      await writeFile(workflow, `
        export const meta = { name: "live-status-supervision" };
        const options = ${JSON.stringify(options)};
        await parallel([
          () => agent(${JSON.stringify(prompts[0])}, { ...options, label: "first", isolation: "worktree" }),
          () => agent(${JSON.stringify(prompts[1])}, { ...options, label: "queued" })
        ]);
        const held = session({ ...options, label: "held" });
        try { await held.send(${JSON.stringify(prompts[2])}); await held.send(${JSON.stringify(prompts[3])}); }
        finally { await held.close(); }
        const fs = require("node:fs");
        while (!fs.existsSync(${JSON.stringify(releaseFile)})) await new Promise(resolve => setTimeout(resolve, 10));
        return "complete";
      `);
      const spec = path.join(directory, "spec.json");
      await writeFile(spec, JSON.stringify({ bundle, workflow, cwd: repo, releaseFile, acknowledgements, timeoutMs: 1_100_000,
        workers: [1, 2, 3, 4].map((id) => ({ id, state: "done", requestedModel: model ?? null,
          requestedEffort: "medium", live: true, queued: id === 2, worktree: id === 1, growth: true }))
      }));
      // Do not relocate XDG_DATA_HOME: Claude's supervisor can outlive a run.
      reader = runNode([consumer, spec], {
        ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"),
        ENSEMBLE_CONCURRENCY_CODEX: "1", ENSEMBLE_CONCURRENCY_CLAUDE: "1",
        XDG_CONFIG_HOME: path.join(directory, "config")
      }, 1_110_000);
      for (const [index, probe] of probes.entries()) {
        await waitForReady(probe.paths.ready, reader);
        assert.equal((await readFile(probe.paths.evidence, "utf8")).trimEnd(), probe.evidence.kind === "marker" ? probe.evidence.content : "");
        await waitForAcknowledgement(acknowledgements, `${index + 1}:growth`, reader);
        await waitForAcknowledgement(acknowledgements, `${index + 1}:usage`, reader);
        await waitForAcknowledgement(acknowledgements, `${index + 1}:matched`, reader);
        if (index === 0) {
          await waitForAcknowledgement(acknowledgements, "2:queued", reader);
          await waitForAcknowledgement(acknowledgements, "1:worktree", reader);
        }
        await writeFile(probe.paths.release, "");
      }
      const result = await reader;
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.stdout, "complete");
      const dataHome = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME!, ".local", "share");
      assert.equal(path.dirname(report.announcement.status_path), path.join(dataHome, "ensemble", "status"));
      assert.equal(report.snapshot.totals.done, 4);
      const held = report.workers.filter(([id]: [number]) => id === 3 || id === 4);
      assert.equal(held.length, 2);
      if (engine === "claude") assert.equal(held[0][1].latest.transcript, held[1][1].latest.transcript);
      else assert.notEqual(held[0][1].latest.transcript, held[1][1].latest.transcript);
    } finally {
      await Promise.all(probes.map((probe) => writeFile(probe.paths.release, "")));
      if (reader) await Promise.allSettled([reader]);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

async function rejectEarly(reader: Promise<ProcessResult>): Promise<never> {
  const result = await reader;
  assert.fail(`status reader exited before its observation: ${result.code}\n${result.stderr}`);
}

async function waitForAcknowledgement(file: string, marker: string, reader: Promise<ProcessResult>): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!(await readFile(file, "utf8")).split("\n").includes(marker)) {
    assert.ok(Date.now() < deadline, `status reader never acknowledged ${marker}`);
    await Promise.race([delay(100), rejectEarly(reader)]);
  }
}


async function waitForReady(file: string, reader: Promise<ProcessResult>): Promise<void> {
  const deadline = Date.now() + 210_000;
  for (;;) {
    try { await access(file); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    assert.ok(Date.now() < deadline, `probe never created ${file}`);
    await Promise.race([delay(100), rejectEarly(reader)]);
  }
}
