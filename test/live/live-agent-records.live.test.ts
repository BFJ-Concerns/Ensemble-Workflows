import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runNode } from "../integration/estate-process.js";
import { heldProbeFollowUpPrompt, heldProbePrompt, probePaths, waitForPath } from "./held-worker-probes.js";

import type { HeldProbe } from "./held-worker-probes.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const consumer = path.resolve("test/consumers/read-live-agent-records.mjs");

for (const engine of ["claude", "codex"] as const) {
  test(`live ${engine} archive reader follows running, queued and held turns through settlement`, {
    skip: process.env.ENSEMBLE_LIVE !== "1", timeout: 1_200_000
  }, async () => {
    const directory = await mkdtemp(path.resolve(`.live-agent-records-${engine}-`));
    const processes: Array<Promise<unknown>> = [];
    const probes: HeldProbe[] = ["first", "queued", "held-first", "held-second"].map((name) => ({
      paths: probePaths(directory, name),
      evidence: { kind: "marker", content: `${name}_${randomUUID()}` },
      token: `RELEASED_${randomUUID()}`
    }));
    try {
      const store = path.join(directory, "records");
      const acknowledgements = path.join(directory, "observed");
      const workflow = path.join(directory, "workflow.mjs");
      await mkdir(store);
      await writeFile(acknowledgements, "");
      const prompts = probes.map((probe, index) => index === 3 ? heldProbeFollowUpPrompt(probe) : heldProbePrompt(probe));
      await writeFile(workflow, `
        export const meta = { name: "live-agent-records-${engine}" };
        const options = ${JSON.stringify({ engine, cwd: directory, timeoutMs: 240_000, maxAttempts: 1 })};
        await parallel([
          () => agent(${JSON.stringify(prompts[0])}, { ...options, label: "first" }),
          () => agent(${JSON.stringify(prompts[1])}, { ...options, label: "queued" })
        ]);
        const held = session({ ...options, label: "held" });
        try {
          await held.send(${JSON.stringify(prompts[2])});
          await held.send(${JSON.stringify(prompts[3])});
        } finally { await held.close(); }
        return "complete";
      `);
      let settled = false;
      const runProcess = runNode([bundle, workflow], {
        ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: store, ENSEMBLE_STATUS: "0",
        ENSEMBLE_CONCURRENCY_CODEX: "1", ENSEMBLE_CONCURRENCY_CLAUDE: "1",
        XDG_CONFIG_HOME: path.join(directory, "config")
      }, 1_100_000).finally(() => { settled = true; });
      const readProcess = runNode([consumer, store, "4", "1100000", acknowledgements], {}, 1_110_000);
      processes.push(runProcess, readProcess);
      for (const [index, probe] of probes.entries()) {
        await waitForPath(probe.paths.ready, 210_000);
        assert.equal(settled, false, "workflow settled while its probe was held");
        assert.equal((await readFile(probe.paths.evidence, "utf8")).trimEnd(),
          probe.evidence.kind === "marker" ? probe.evidence.content : "");
        await waitForAcknowledgement(acknowledgements, `observed:${index + 1}:1:started`);
        // Growth after the reader's first open proves a scrolling live file.
        await waitForAcknowledgement(acknowledgements, `growth:${index + 1}:1`);
        if (index === 0) await waitForAcknowledgement(acknowledgements, "queued:queued");
        assert.equal(settled, false, "workflow settled before release");
        await writeFile(probe.paths.release, "");
      }
      const [run, read] = await Promise.all([runProcess, readProcess]);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout), "complete");
      assert.equal(read.code, 0, read.stderr);
      const observations = JSON.parse(read.stdout) as Array<{
        queued: boolean; label: string; session: { id: number; turn: number } | null;
        attempts: Array<{ transcript: string; sizes: number[]; readable: boolean }>;
      }>;
      assert.equal(observations.length, 4);
      assert.equal(observations.find((agent) => agent.label === "queued")?.queued, true);
      const held = observations.filter((agent) => agent.label === "held");
      assert.equal(held.length, 2);
      assert.ok(held[0]!.session);
      assert.deepEqual(held.map((agent) => agent.session), [
        { id: held[0]!.session.id, turn: 1 }, { id: held[0]!.session.id, turn: 2 }
      ]);
      for (const observation of observations) {
        assert.equal(observation.attempts.length, 1);
        const attempt = observation.attempts[0]!;
        assert.equal(attempt.readable, true);
        assert.ok(attempt.sizes.length > 1);
        assert.equal(path.isAbsolute(attempt.transcript), engine === "claude");
      }
      if (engine === "codex") {
        assert.equal(new Set(observations.map((agent) => agent.attempts[0]!.transcript)).size, 4);
      } else {
        assert.equal(held[0]!.attempts[0]!.transcript, held[1]!.attempts[0]!.transcript);
      }
    } finally {
      // Release every possible hold even when an observation fails.
      await Promise.all(probes.map((probe) => writeFile(probe.paths.release, "")));
      await Promise.allSettled(processes);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

async function waitForAcknowledgement(file: string, marker: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!(await readFile(file, "utf8")).split("\n").includes(marker)) {
    assert.ok(Date.now() < deadline, `independent reader never acknowledged ${marker}`);
    await delay(100);
  }
}
