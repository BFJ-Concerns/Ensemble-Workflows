import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { HoldManager, defaultHoldsDirectory, enumerateHolds } from "../../src/holds.js";
import { HoldRejectedError, HoldTimeoutError } from "../../src/errors.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { EngineRegistry } from "../../src/engines.js";

import type { HoldFileRecord } from "../../src/holds.js";
import type { RuntimeEvent } from "../../src/types.js";

async function withHoldsDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-holds-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function manager(
  dir: string,
  events: RuntimeEvent[],
  options: { open?: string[]; settled?: string[] } = {}
): HoldManager {
  return new HoldManager({
    dir,
    runId: "run-test",
    cwd: "/fake/cwd",
    pollIntervalMs: 5,
    onEvent: (event) => events.push(event),
    onOpen: (hold) => options.open?.push(hold.id),
    onSettled: (id) => options.settled?.push(id)
  });
}

async function publishedHold(dir: string): Promise<HoldFileRecord> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const holds = await enumerateHolds(dir);
    if (holds.length > 0 && holds[0] !== undefined) {
      return holds[0].record;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("hold file never appeared");
}

test("a hold is answered by a process that writes the nonce-correlated decision file", async () => {
  await withHoldsDir(async (dir) => {
    const events: RuntimeEvent[] = [];
    const holds = manager(dir, events);
    const decision = holds.raise({ content: "merge the release branch?", verdicts: ["approve", "reject"] });

    const record = await publishedHold(dir);
    assert.equal(record.run_id, "run-test");
    assert.equal(record.content, "merge the release branch?");
    assert.deepEqual(record.verdicts, ["approve", "reject"]);
    // The decider is any process: the answer is a plain file write at the
    // path the published record itself names.
    await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "approve", note: "ship it" }));

    assert.deepEqual(await decision, { verdict: "approve", note: "ship it" });
    // Settled holds leave the listing — both files are consumed.
    assert.deepEqual(await enumerateHolds(dir), []);
    assert.deepEqual(await readdir(dir), []);
    assert.deepEqual(
      events.map((event) => event.method),
      ["hold/raised", "hold/answered"]
    );
  });
});

test("a stale nonce and an unlisted verdict are rejected — the hold keeps waiting", async () => {
  await withHoldsDir(async (dir) => {
    const events: RuntimeEvent[] = [];
    const holds = manager(dir, events);
    const decision = holds.raise({ content: "which route?", verdicts: ["a", "b"] });
    const record = await publishedHold(dir);

    await writeFile(record.decision_path, JSON.stringify({ nonce: "not-the-nonce", verdict: "a" }));
    await waitForEvent(events, "hold/answerRejected");
    // The hold is still open and answerable: the rejected file was consumed.
    assert.equal((await enumerateHolds(dir)).length, 1);

    await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "c" }));
    await waitForEvent(events, "hold/answerRejected", 2);

    await writeFile(record.decision_path, "not json");
    await waitForEvent(events, "hold/answerRejected", 3);

    await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "b" }));
    assert.deepEqual(await decision, { verdict: "b", note: null });
    assert.deepEqual(
      events.filter((event) => event.method === "hold/answerRejected").map((event) => event.params.reason),
      ["stale-nonce", "invalid-verdict", "malformed"]
    );
  });
});

test("an unanswered hold with a timeout rejects with HoldTimeoutError and leaves the listing", async () => {
  await withHoldsDir(async (dir) => {
    const events: RuntimeEvent[] = [];
    const settled: string[] = [];
    const holds = manager(dir, events, { settled });

    await assert.rejects(holds.raise({ content: "anyone there?", verdicts: ["yes"], timeoutMs: 20 }), HoldTimeoutError);
    assert.deepEqual(await enumerateHolds(dir), []);
    assert.deepEqual(settled, ["run-test-1"]);
    assert.ok(events.some((event) => event.method === "hold/timedOut"));
  });
});

test("close() abandons open holds: the wait rejects and the file is removed", async () => {
  await withHoldsDir(async (dir) => {
    const events: RuntimeEvent[] = [];
    const holds = manager(dir, events);
    const decision = holds.raise({ content: "left open at run end", verdicts: ["ok"] });
    await publishedHold(dir);

    holds.close();
    await assert.rejects(decision, HoldRejectedError);
    assert.deepEqual(await enumerateHolds(dir), []);
    await assert.rejects(holds.raise({ content: "too late", verdicts: ["ok"] }), HoldRejectedError);
  });
});

test("hold options are validated before anything is published", async () => {
  await withHoldsDir(async (dir) => {
    const holds = manager(dir, []);
    await assert.rejects(holds.raise({ content: "", verdicts: ["ok"] }), HoldRejectedError);
    await assert.rejects(holds.raise({ content: "x", verdicts: [] }), HoldRejectedError);
    await assert.rejects(holds.raise({ content: "x", verdicts: ["a", "a"] }), HoldRejectedError);
    await assert.rejects(
      holds.raise({ content: "x", verdicts: ["ok"], timeoutMs: 0 }),
      HoldRejectedError
    );
    await assert.rejects(
      holds.raise({ content: "x", verdicts: ["ok"], surprise: true } as never),
      HoldRejectedError
    );
    // Nothing was ever published: the directory was never even created.
    assert.deepEqual(await enumerateHolds(dir), []);
  });
});

test("the cross-run listing carries liveness evidence: a dead raiser reads orphaned", async () => {
  await withHoldsDir(async (dir) => {
    // A hold file left by a killed run: same shape, provably dead pid.
    const orphan: HoldFileRecord = {
      schema_version: 1,
      kind: "ensemble_hold",
      run_id: "run-dead",
      hold_id: "run-dead-1",
      nonce: "dead-nonce",
      content: "abandoned question",
      verdicts: ["ok"],
      raised_at: new Date(0).toISOString(),
      timeout_at: null,
      cwd: "/nowhere",
      pid: 2 ** 30,
      decision_path: path.join(dir, "run-dead-1.decision.json")
    };
    await writeFile(path.join(dir, "run-dead-1.json"), JSON.stringify(orphan));

    const events: RuntimeEvent[] = [];
    const holds = manager(dir, events);
    const decision = holds.raise({ content: "live question", verdicts: ["ok"] });
    await waitForEvent(events, "hold/raised");

    const listed = await enumerateHolds(dir);
    assert.equal(listed.length, 2);
    const byId = new Map(listed.map((hold) => [hold.record.hold_id, hold]));
    assert.equal(byId.get("run-dead-1")?.live, false);
    assert.equal(byId.get("run-test-1")?.live, true);

    holds.close();
    await assert.rejects(decision, HoldRejectedError);
  });
});

test("the runtime surfaces holds in the live snapshot and archives their events", async () => {
  await withHoldsDir(async (dir) => {
    const runtime = new EnsembleRuntime({
      engines: new EngineRegistry([]),
      defaultMaxAttempts: 1,
      holdsDir: dir,
      holdPollIntervalMs: 5
    });
    const holdEvents: Array<{ method: string }> = [];
    runtime.setRunRecorder({
      recordHoldEvent: async (event: RuntimeEvent) => {
        holdEvents.push({ method: event.method });
      }
    } as never);

    const decision = runtime.raiseHold({ content: "proceed?", verdicts: ["yes", "no"] });
    const record = await publishedHold(dir);
    // The open hold is visible to a status poller while the run waits.
    const openSnapshot = runtime.progress.snapshot();
    assert.equal(openSnapshot.holds.length, 1);
    assert.equal(openSnapshot.holds[0]?.id, record.hold_id);
    assert.deepEqual(openSnapshot.holds[0]?.verdicts, ["yes", "no"]);

    await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "yes" }));
    assert.deepEqual(await decision, { verdict: "yes", note: null });
    assert.equal(runtime.progress.snapshot().holds.length, 0);
    assert.deepEqual(
      holdEvents.map((event) => event.method),
      ["hold/raised", "hold/answered"]
    );
    await runtime.close();
  });
});

test("the default holds directory lives under the ensemble data home", () => {
  const dir = defaultHoldsDirectory({ XDG_DATA_HOME: "/data/home" });
  assert.equal(dir, path.join("/data/home", "ensemble", "holds"));
});

async function waitForEvent(events: RuntimeEvent[], method: string, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (events.filter((event) => event.method === method).length >= count) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`event ${method} (x${count}) never arrived`);
}
