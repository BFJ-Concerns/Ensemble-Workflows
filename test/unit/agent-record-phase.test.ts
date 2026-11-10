import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { CodexEngineAdapter, EngineRegistry } from "../../src/engines.js";
import { RunRecordWriter } from "../../src/run-record.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import type { RuntimeTransport } from "../../src/types.js";

test("archived phases capture queue-time run phases for agents and held-session turns", async () => {
  const store = await mkdtemp("/mnt/ai-data/scratch/ensemble-agent-phases-");
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const expected = [null, "Research", "explicit", "", "Draft", "Verify", "fixed", "fixed", "Failure"];
  let invocation = 0;
  let writer: RunRecordWriter;
  const transport: RuntimeTransport = {
    cwd: process.cwd(),
    openThread: async () => "thread",
    runTurn: async (_threadId, prompt) => {
      const id = ++invocation;
      // The archive already exposes the phase before an engine answers.
      const record = JSON.parse(await readFile(agentPath(id), "utf8"));
      assert.equal(record.phase, expected[id - 1]);
      assert.equal(record.status, "in-progress");
      if (prompt === "block") {
        entered();
        await blocked;
      }
      if (prompt === "fail") throw new Error("terminal engine failure");
      return { text: "done", deltaText: "done", durationMs: 1, firstDeltaMs: 1, items: {}, tokenUsageEvents: [] };
    },
    close: async () => undefined
  };
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new CodexEngineAdapter({ transport, concurrency: 1 })]),
    defaultMaxAttempts: 1
  });
  const agentPath = (id: number): string => path.join(writer.archiveDir, "agents", String(id).padStart(6, "0"), "agent.json");
  try {
    writer = await RunRecordWriter.start({
      storeDir: store, cwd: process.cwd(), runUuid: "phases",
      workflowPath: path.join(store, "workflow.js"), workflowSource: "return true;",
      args: [], cliFlags: { jsonArgs: false }
    });
    runtime.setRunRecorder(writer);
    const first = runtime.agent("block", { engine: "codex" });
    await started;
    runtime.notePhase("Research");
    const queued = runtime.agent("queued", { engine: "codex" });
    assert.equal(runtime.progress.snapshot().agents.find((agent) => agent.id === 2)?.phase, "Research");
    runtime.notePhase("Later");
    release();
    assert.deepEqual(await Promise.all([first, queued]), ["done", "done"]);
    assert.equal(await runtime.agent("override", { engine: "codex", phase: "explicit" }), "done");
    assert.equal(await runtime.agent("empty override", { engine: "codex", phase: "" }), "done");

    // A session captures the run phase on each send, not at creation.
    const session = runtime.createWorkerSession({ engine: "codex" });
    runtime.notePhase("Draft");
    assert.equal(await session.send("draft"), "done");
    runtime.notePhase("Verify");
    assert.equal(await session.send("verify"), "done");
    const pinned = runtime.createWorkerSession({ engine: "codex", phase: "fixed" });
    assert.equal(await pinned.send("pinned first"), "done");
    runtime.notePhase("Changed");
    assert.equal(await pinned.send("pinned second"), "done");

    runtime.notePhase("Failure");
    assert.equal(await runtime.agent("fail", { engine: "codex" }), null);
    runtime.notePhase("Finished");
    await runtime.close();
    await writer.finish({ status: "complete", exitCode: 0, result: null });
    const archived = await Promise.all(expected.map(async (_, index) => JSON.parse(await readFile(agentPath(index + 1), "utf8"))));
    assert.deepEqual(archived.map((record) => record.phase), expected);
    assert.deepEqual(archived.map((record) => record.status), [...expected.slice(0, -1).map(() => "complete"), "failed"]);
    const live = runtime.progress.snapshot().agents;
    for (const record of archived) {
      assert.equal(live.find((agent) => agent.id === record.id)?.phase, record.phase);
    }
  } finally {
    release();
    await runtime.close();
    await rm(store, { recursive: true, force: true });
  }
});
