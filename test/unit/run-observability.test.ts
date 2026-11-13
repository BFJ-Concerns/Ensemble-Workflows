import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runEnsembleCli } from "../../src/cli.js";
import { EngineRegistry } from "../../src/engines.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { rollupViewOfArchivedRecord } from "../../src/run-record.js";
import { buildCostRollup } from "../../src/cost-rollup.js";

import type { EngineAdapter, EngineAttemptResult } from "../../src/engines.js";
import type { EngineName } from "../../src/types.js";

class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.text += chunk.toString();
    callback();
  }
}

function announcement(stderr: Capture, prefix: string): Record<string, string> {
  const line = stderr.text.split("\n").find((entry) => entry.startsWith(prefix));
  assert.ok(line, stderr.text);
  return JSON.parse(line.slice(prefix.length));
}

function answer(text: string): EngineAttemptResult {
  return { text, deltaText: text, durationMs: 1, firstDeltaMs: 1, items: {}, tokenUsageEvents: [] };
}

for (const ending of ["failed", "timed-out", "interrupted"] as const) {
  test(`partial results retain answers settling during ${ending} teardown on every engine`, { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-settling-answers-"));
    try {
      const stdout = new Capture();
      const stderr = new Capture();
      const engines: EngineName[] = ["codex", "claude", "opencode"];
      const releases: Array<() => void> = [];
      const started = Promise.withResolvers<void>();
      const adapters: EngineAdapter[] = engines.map((name) => ({
        name, concurrency: 4, schedule: async (run) => run(),
        createInvocation: (prompt) => ({
          runAttempt: async () => {
            if (prompt === "barrier") {
              await started.promise;
              return answer("barrier finished");
            }
            return new Promise<EngineAttemptResult>((resolve) => {
              // Active native workers own handles until their reply settles.
              const liveWorker = setInterval(() => {}, 60_000);
              releases.push(() => {
                clearInterval(liveWorker);
                resolve(answer("null"));
              });
              if (releases.length === engines.length) started.resolve();
            });
          }
        }),
        close: async () => { for (const release of releases) release(); }
      }));
      let runtime: EnsembleRuntime | undefined;
      const script = path.join(directory, "workflow.js");
      await writeFile(script, `
        export const meta = { name: "settling-answers" };
        const calls = ["codex", "claude", "opencode"].map(engine =>
          agent("finish at shutdown", { engine, label: engine, schema: { type: "null" } })
        );
        ${ending === "failed" ? 'await agent("barrier", { engine: "codex", label: "barrier" }); throw new Error("body failed with workers running");' : 'await parallel(calls.map(call => () => call));'}
      `);
      const run = runEnsembleCli([script], {
        cwd: directory, stdout, stderr, statusDir: null,
        runRecordDir: path.join(directory, "records"),
        ...(ending === "timed-out" ? { timeoutMs: 500 } : {}),
        createRuntime: async (options) => {
          runtime = new EnsembleRuntime({ ...options, engines: new EngineRegistry(adapters), defaultMaxAttempts: 1 });
          return runtime;
        }
      });
      await started.promise;
      // The workers cannot answer until close begins. The script's body
      // therefore cannot win the race, regardless of engine scheduling.
      if (ending === "interrupted") process.emit("SIGINT");
      const code = await run;
      assert.equal(code, ending === "interrupted" ? 130 : 1, stderr.text);
      const envelope = JSON.parse(stdout.text);
      assert.equal(envelope.reason, ending);
      const expected = engines.map((engine, index) => ({
        id: index + 1, engine, label: engine, phase: null, output: null
      }));
      assert.deepEqual(envelope.completed, [
        ...(ending === "failed" ? [{ id: 4, engine: "codex", label: "barrier", phase: null, output: "barrier finished" }] : []),
        ...expected
      ]);
      assert.equal(runtime?.shutdownTally()?.done, expected.length + (ending === "failed" ? 1 : 0));
      const archive = announcement(stderr, "[run-record-archive] ").archive_path!;
      const result = JSON.parse(await readFile(path.join(archive, "result.json"), "utf8"));
      assert.deepEqual(result.value, envelope);
      const sentinel = JSON.parse(await readFile(path.join(archive, "completion-sentinel.json"), "utf8"));
      assert.equal(sentinel.workers.done, envelope.completed.length);
      for (const completed of envelope.completed) {
        const record = JSON.parse(await readFile(path.join(archive, "agents", String(completed.id).padStart(6, "0"), "agent.json"), "utf8"));
        assert.equal(record.status, "complete");
        assert.equal(record.validated_output, completed.output);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("resource preflight refusals on every engine record known absence and complete spend", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-refused-records-"));
  try {
    const denied = path.join(directory, "not-a-directory");
    await writeFile(denied, "file");
    const stdout = new Capture();
    const stderr = new Capture();
    const engines: EngineName[] = ["codex", "claude", "opencode"];
    const adapters: EngineAdapter[] = engines.map((name) => ({
      name, concurrency: 1, schedule: async (run) => run(),
      createInvocation: () => ({ runAttempt: async () => { throw new Error("must refuse before calling the engine"); } }),
      close: async () => {}
    }));
    const script = path.join(directory, "workflow.js");
    await writeFile(script, `
      export const meta = { name: "refused-records" };
      for (const engine of ["codex", "claude", "opencode"]) {
        try { await agent("refused", { engine }); } catch {}
      }
    `);
    assert.equal(await runEnsembleCli([script], {
      cwd: directory, stdout, stderr, statusDir: null, runRecordDir: path.join(directory, "records"),
      createRuntime: async (options) => new EnsembleRuntime({
        ...options,
        defaultMaxAttempts: 1,
        engines: new EngineRegistry(adapters, [], (owner) => [{
          owner, role: "engine home", access: "create-entries", path: denied,
          location: { kind: "fixed", rule: "test resource" }
        }])
      })
    }), 0, stderr.text);
    const archive = announcement(stderr, "[run-record-archive] ").archive_path!;
    const manifest = JSON.parse(await readFile(path.join(archive, "manifest.json"), "utf8"));
    for (const [index, engine] of engines.entries()) {
      const record = JSON.parse(await readFile(path.join(archive, "agents", String(index + 1).padStart(6, "0"), "agent.json"), "utf8"));
      assert.equal(record.attempts[0].failure.kind, "ResourcePreflightRefusedError");
      assert.deepEqual(record.usage, { unavailable: "substrate-never-started" });
      assert.equal(record.transcripts_unavailable, "substrate-never-started");
      const expected = {
        tokens: { unavailable: "substrate-never-started" },
        cost: { unavailable: "no-provider-cost-reported" }, complete: true, unobserved: []
      };
      assert.deepEqual(manifest.cost_rollup[engine].unresolved, expected);
      // The abandoned-run reader uses the same absence evidence as the
      // live writer, rather than reconstructing potentially missing spend.
      const view = rollupViewOfArchivedRecord(record);
      assert.ok(view);
      assert.deepEqual(buildCostRollup([view])[engine]?.unresolved, expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const setting of ["XDG_DATA_HOME", "ENSEMBLE_STATUS_DIR"] as const) {
  test(`status announcement is absolute and readable with relative ${setting}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-relative-status-"));
    try {
      const stdout = new Capture();
      const stderr = new Capture();
      const relative = path.relative(process.cwd(), path.join(directory, "relative"));
      await mkdir(path.join(directory, "relative"));
      let observed = false;
      const engine: EngineAdapter = {
        name: "codex", concurrency: 1, schedule: async (run) => run(),
        createInvocation: () => ({ runAttempt: async () => {
          const file = announcement(stderr, "[status-file] ").status_path!;
          assert.equal(path.isAbsolute(file), true, file);
          const snapshot = JSON.parse(await readFile(file, "utf8"));
          assert.equal(typeof snapshot.runId, "string");
          observed = true;
          return answer("done");
        } }),
        close: async () => {}
      };
      const script = path.join(directory, "workflow.js");
      await writeFile(script, 'export const meta = { name: "relative-status" }; return await agent("read status", { engine: "codex" });');
      assert.equal(await runEnsembleCli([script], {
        cwd: directory, stdout, stderr, runRecordDir: null,
        env: { XDG_CONFIG_HOME: directory, XDG_DATA_HOME: path.join(directory, "data"), [setting]: relative },
        createRuntime: async (options) => new EnsembleRuntime({ ...options, engines: new EngineRegistry([engine]), defaultMaxAttempts: 1 })
      }), 0, stderr.text);
      assert.equal(observed, true, stderr.text);
      const file = announcement(stderr, "[status-file] ").status_path!;
      assert.equal(path.dirname(file), path.join(directory, "relative", ...(setting === "XDG_DATA_HOME" ? ["ensemble", "status"] : [])));
      await assert.rejects(readFile(file));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
