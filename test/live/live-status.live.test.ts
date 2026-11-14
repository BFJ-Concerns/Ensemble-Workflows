import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { removeTestDirectory } from "../failure-evidence.js";
import { runNode, runProcess } from "../integration/estate-process.js";
import type { ProcessResult } from "../integration/estate-process.js";
import { heldProbeFollowUpPrompt, heldProbePrompt, probePaths } from "./held-worker-probes.js";
import type { HeldProbe } from "./held-worker-probes.js";
import { liveCodexModel } from "./live-models.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const consumer = path.resolve("test/consumers/read-live-status.mjs");

for (const engine of ["claude", "codex"] as const) {
  test(`live ${engine} status alone supervises queued, isolated and held workers`, {
    skip: process.env.ENSEMBLE_LIVE !== "1" ? "ENSEMBLE_LIVE must be 1"
      : engine === "codex" && liveCodexModel === undefined ? "ENSEMBLE_LIVE_CODEX_MODEL is unset" : false,
    timeout: 1_200_000
  }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-status-"));
    const repo = path.join(directory, "repo");
    const probes: HeldProbe[] = ["first", "queued", "held-first", "held-second"].map((name) => ({
      paths: probePaths(directory, name), evidence: { kind: "marker", content: `${name}_${randomUUID()}` },
      token: `RELEASED_${randomUUID()}`
    }));
    let reader: Promise<ProcessResult> | undefined;
    let testFailed = false;
    try {
      await mkdir(repo);
      const init = await runProcess("git", ["-C", repo, "init", "--initial-branch=main"]);
      assert.equal(init.code, 0, init.stderr);
      const commit = await runProcess("git", ["-C", repo, "-c", "user.name=Ensemble test", "-c", "user.email=ensemble@example.invalid", "commit", "--allow-empty", "-m", "initialise test repository"]);
      assert.equal(commit.code, 0, commit.stderr);
      // Exercise status under the data home with and without a project namespace.
      if (engine === "claude") await mkdir(path.join(repo, ".claude"));
      const dataHome = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME!, ".local", "share");
      const statusDirectory = path.join(dataHome, "ensemble", "status");
      await mkdir(statusDirectory, { recursive: true });
      const acknowledgements = path.join(directory, "observed");
      const releaseFile = path.join(directory, "finish");
      const unplaceable = path.join(directory, "not-a-repository");
      await mkdir(unplaceable);
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
        ${placementFailureStep(options, prompts[0]!, unplaceable)}
        const fs = require("node:fs");
        while (!fs.existsSync(${JSON.stringify(releaseFile)})) await new Promise(resolve => setTimeout(resolve, 10));
        return "complete";
      `);
      const spec = path.join(directory, "spec.json");
      await writeFile(spec, JSON.stringify({ bundle, workflow, cwd: repo, releaseFile, acknowledgements, timeoutMs: 1_100_000,
        workers: [1, 2, 3, 4].map((id) => ({ id, state: "done", requestedModel: model ?? null,
          requestedEffort: "medium", live: true, queued: id === 2, worktree: id === 1, growth: true })).concat([{ id: 5, state: "failed", requestedModel: model ?? null,
          requestedEffort: "medium", live: false, queued: false, worktree: false, growth: false }])
      }));
      // Keep the machine configuration that routes/authenticates the engines.
      // Do not relocate XDG_DATA_HOME: Claude's supervisor can outlive a run.
      reader = runNode([consumer, spec], {
        ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"),
        ENSEMBLE_STATUS: "1", ENSEMBLE_STATUS_DIR: statusDirectory,
        ENSEMBLE_CONCURRENCY_CODEX: "1", ENSEMBLE_CONCURRENCY_CLAUDE: "1"
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
      assert.equal(path.dirname(report.announcement.status_path), statusDirectory);
      if (engine === "claude") {
        assert.ok((await readdir(path.join(repo, ".claude"))).every((name) => !name.startsWith("ensemble.")));
      } else {
        await assert.rejects(access(path.join(repo, ".claude")), { code: "ENOENT" });
      }
      assert.equal(report.snapshot.totals.done, 4);
      assert.equal(report.snapshot.totals.failed, 1);
      assert.deepEqual(report.workers.find(([id]: [number]) => id === 5)[1].latest.failure, placementFailure(unplaceable));
      const held = report.workers.filter(([id]: [number]) => id === 3 || id === 4);
      assert.equal(held.length, 2);
      if (engine === "claude") assert.equal(held[0][1].latest.transcript, held[1][1].latest.transcript);
      else assert.notEqual(held[0][1].latest.transcript, held[1][1].latest.transcript);
    } catch (error) {
      testFailed = true;
      throw error;
    } finally {
      await Promise.all(probes.map((probe) => writeFile(probe.paths.release, "")));
      if (reader) await Promise.allSettled([reader]);
      await removeTestDirectory(directory, testFailed);
    }
  });
}

// Placement fails after admission, before either engine is contacted. This
// exercises the same failure step as the native workflows without credentials.
for (const engine of ["claude", "codex"] as const) {
  test(`${engine} placement failure is retained with its harness kind and message`, { timeout: 35_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-status-placement-"));
    let testFailed = false;
    try {
      const repo = path.join(directory, "not-a-repository");
      await mkdir(repo);
      const releaseFile = path.join(directory, "finish");
      const workflow = path.join(directory, "workflow.mjs");
      const options = { engine, effort: "medium", maxAttempts: 1 };
      const prompt = heldProbePrompt({ paths: probePaths(directory, "unused"),
        evidence: { kind: "marker", content: "unused" }, token: "unused" });
      await writeFile(workflow, `
        export const meta = { name: "status-placement-failure" };
        ${placementFailureStep(options, prompt, repo)}
        const fs = require("node:fs");
        while (!fs.existsSync(${JSON.stringify(releaseFile)})) await new Promise(resolve => setTimeout(resolve, 10));
        return "complete";
      `);
      const spec = path.join(directory, "spec.json");
      await writeFile(spec, JSON.stringify({ bundle, workflow, cwd: repo, releaseFile, timeoutMs: 20_000,
        workers: [{ id: 1, state: "failed", requestedModel: null, requestedEffort: "medium",
          resolvedModel: null, resolvedEffort: null, transcript: null, spent: null, failure: placementFailure(repo) }]
      }));
      const result = await runNode([consumer, spec], {
        ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"),
        XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data")
      }, 30_000);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.snapshot.totals.failed, 1);
      assert.equal(report.snapshot.totals.done, 0);
    } catch (error) {
      testFailed = true;
      throw error;
    } finally { await removeTestDirectory(directory, testFailed); }
  });
}

function placementFailure(cwd: string) {
  return { kind: "WorktreePlacementRejectedError",
    message: `isolation:'worktree' requires cwd to be inside a git repository: ${cwd}` };
}

function placementFailureStep(options: object, prompt: string, cwd: string): string {
  return `try {
    await agent(${JSON.stringify(prompt)}, { ...${JSON.stringify(options)}, label: "placement-failure",
      cwd: ${JSON.stringify(cwd)}, isolation: "worktree" });
  } catch (error) {
    if (error.name !== "WorktreePlacementRejectedError") throw error;
  }`;
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
