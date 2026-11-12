import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runEnsembleCli } from "../../src/cli.js";
import { EngineRegistry } from "../../src/engines.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { rollupViewOfArchivedRecord } from "../../src/run-record.js";
import { buildCostRollup } from "../../src/cost-rollup.js";

import type { EngineAdapter } from "../../src/engines.js";
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

