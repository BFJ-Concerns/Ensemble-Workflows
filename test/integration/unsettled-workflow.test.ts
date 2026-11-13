import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertSalvageEnvelope, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const timeoutMs of [undefined, 250]) {
  for (const composed of [false, true]) {
    test(`an unsettled ${composed ? "composed" : "root"} workflow is accounted for ${timeoutMs === undefined ? "without a deadline" : "at its deadline"}`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "ensemble-unsettled-workflow-"));
      try {
        await mkdir(path.join(directory, "status"));
        const script = path.join(directory, "pending.js");
        const body = `log("BODY_STARTED " + Date.now()); await new Promise(() => {});`;
        await writeFile(script, `export const meta = { name: "pending" };\n${composed ? `await workflow({ scriptPath: ${JSON.stringify(path.join(directory, "child.js"))} });` : body}`);
        if (composed) {
          await writeFile(path.join(directory, "child.js"), `export const meta = { name: "child" };\n${body}`);
        }
        const result = await runNode(
          [bundledCliPath, ...(timeoutMs === undefined ? [] : [`--timeout=${timeoutMs}`]), script],
          {
            ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"),
            ENSEMBLE_RUN_RECORD: "1",
            ENSEMBLE_STATUS: "1",
            ENSEMBLE_STATUS_DIR: path.join(directory, "status")
          },
          20_000
        );
        const endedAt = Date.now();
        const outcome = timeoutMs === undefined ? "failed" : "timed-out";
        assert.equal(result.code, 1, result.stderr);
        assert.doesNotMatch(result.stderr, /Detected unsettled top-level await/);
        const envelope = assertSalvageEnvelope(result.stdout, outcome);
        assert.equal(envelope.error.kind, timeoutMs === undefined ? "WorkflowUnsettledError" : "WorkflowTimeoutError");
        if (timeoutMs === undefined) {
          assert.match(envelope.error.message, /pending\.js.*promise.*event loop/);
        } else {
          const bodyStarted = result.stderr.match(/BODY_STARTED (\d+)/);
          assert.ok(bodyStarted, result.stderr);
          assert.ok(endedAt - Number(bodyStarted[1]) >= timeoutMs, "must wait for the configured deadline");
        }
        const announced = result.stderr.match(/\[sentinel\] will write (.+) when the run ends/);
        assert.ok(announced, result.stderr);
        const sentinel = JSON.parse(await readFile(announced[1]!, "utf8")) as { outcome: string; exit_code: number };
        assert.equal(sentinel.outcome, outcome);
        assert.equal(sentinel.exit_code, 1);
        const archive = path.dirname(announced[1]!);
        const manifest = JSON.parse(await readFile(path.join(archive, "manifest.json"), "utf8")) as {
          status: string; ended_at: string | null; error: unknown;
        };
        assert.equal(manifest.status, outcome);
        assert.ok(manifest.ended_at);
        assert.deepEqual(manifest.error, envelope.error);
        const status = result.stderr.match(/\[status-file\] (.+)/);
        assert.ok(status, result.stderr);
        const statusPath = (JSON.parse(status[1]!) as { status_path: string }).status_path;
        await assert.rejects(readFile(statusPath), { code: "ENOENT" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

test("a workflow awaiting live work can complete without a deadline", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-settling-workflow-"));
  try {
    const script = path.join(directory, "settles.js");
    await writeFile(script, `export const meta = { name: "settles" }; await new Promise(resolve => setTimeout(resolve, 25)); return "settled";`);
    const result = await runNode([bundledCliPath, script], {
      ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"), ENSEMBLE_STATUS: "0"
    }, 20_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '"settled"\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const timeout of [[], ["--timeout=60000"]]) {
  test(`an interrupted embedded CLI releases its ${timeout.length === 0 ? "idle listener" : "deadline handle"}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-unsettled-interrupt-"));
    try {
      const script = path.join(directory, "interrupt.js");
      const entry = path.join(directory, "entry.mjs");
      await writeFile(script, `export const meta = { name: "interrupt" }; setTimeout(() => process.kill(process.pid, "SIGTERM"), 25); await new Promise(() => {});`);
      await writeFile(entry, `
        import { runEnsembleCli } from ${JSON.stringify(new URL("../../src/cli.js", import.meta.url).href)};
        const before = process.listenerCount("beforeExit");
        process.exitCode = await runEnsembleCli(${JSON.stringify([...timeout, script])});
        if (process.listenerCount("beforeExit") !== before) throw new Error("idle listener leaked");
      `);
      const result = await runNode([entry], {
        ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"), ENSEMBLE_STATUS: "0"
      }, 20_000);
      assert.equal(result.code, 143, result.stderr);
      assertSalvageEnvelope(result.stdout, "interrupted");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
