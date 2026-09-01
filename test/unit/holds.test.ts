import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HoldManager,
  defaultHoldsDirectory,
  enumerateHolds,
  holdScopeSegment,
  resolveHoldScope
} from "../../src/holds.js";
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
  options: { open?: string[]; settled?: string[]; scope?: string | null; procDir?: string } = {}
): HoldManager {
  return new HoldManager({
    dir,
    runId: "run-test",
    cwd: "/fake/cwd",
    scope: options.scope ?? null,
    pollIntervalMs: 5,
    onEvent: (event) => events.push(event),
    onOpen: (hold) => options.open?.push(hold.id),
    onSettled: (id) => options.settled?.push(id),
    ...(options.procDir !== undefined ? { procDir: options.procDir } : {})
  });
}

async function publishedHold(dir: string): Promise<HoldFileRecord> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { holds } = await enumerateHolds(dir);
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
    // A keyless raise lands in the default shared scope's directory.
    assert.equal(record.scope, null);
    assert.equal(path.dirname(record.decision_path), path.join(dir, holdScopeSegment(null)));
    // The raiser's liveness evidence rides the record for the retirement check.
    assert.equal(record.owner.pid, process.pid);
    assert.equal(record.owner.host, hostname());
    // The decider is any process: the answer is a plain file write at the
    // path the published record itself names.
    await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "approve", note: "ship it" }));

    assert.deepEqual(await decision, { verdict: "approve", note: "ship it" });
    // Settled holds leave the listing — both files are consumed.
    assert.deepEqual(await enumerateHolds(dir), { holds: [], retired: [] });
    assert.deepEqual(await readdir(path.join(dir, holdScopeSegment(null))), []);
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
    assert.equal((await enumerateHolds(dir)).holds.length, 1);
    // Every rejection republishes onto the open record, so the decider who
    // wrote the bad file reads back why it bounced — checked after each arm,
    // since only the latest rejection is on the record at any moment.
    await assertRepublishedRejection(dir, {
      reason: "stale-nonce",
      attempted_verdict: "a",
      attempted_verdict_state: "submitted"
    });

    await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "c" }));
    await waitForEvent(events, "hold/answerRejected", 2);
    await assertRepublishedRejection(dir, {
      reason: "invalid-verdict",
      attempted_verdict: "c",
      attempted_verdict_state: "submitted"
    });

    await writeFile(record.decision_path, "not json");
    await waitForEvent(events, "hold/answerRejected", 3);
    await assertRepublishedRejection(dir, {
      reason: "malformed",
      attempted_verdict: null,
      attempted_verdict_state: "unparseable"
    });

    await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "b" }));
    assert.deepEqual(await decision, { verdict: "b", note: null });
    assert.deepEqual(
      events.filter((event) => event.method === "hold/answerRejected").map((event) => event.params.reason),
      ["stale-nonce", "invalid-verdict", "malformed"]
    );
    assert.deepEqual(
      events.filter((event) => event.method === "hold/answerRejected").map((event) => event.params.attemptedVerdict),
      ["a", "c", null]
    );
  });
});

test("a decision file caught mid-write is not consumed: the completed write still answers", async () => {
  await withHoldsDir(async (dir) => {
    const events: RuntimeEvent[] = [];
    const holds = manager(dir, events);
    const decision = holds.raise({ content: "slow writer", verdicts: ["ok"] });
    const record = await publishedHold(dir);

    // A non-atomic writer's partial bytes land first; the poller must give
    // them grace rather than classify-and-destroy, so the finished write
    // that follows still reaches the script.
    await writeFile(record.decision_path, '{"nonce":"');
    await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "ok" }));

    assert.deepEqual(await decision, { verdict: "ok", note: null });
    // The partial bytes were never judged malformed: no rejection event.
    assert.deepEqual(
      events.filter((event) => event.method === "hold/answerRejected"),
      []
    );
  });
});

test("an unanswered hold with a timeout rejects with HoldTimeoutError and leaves the listing", async () => {
  await withHoldsDir(async (dir) => {
    const events: RuntimeEvent[] = [];
    const settled: string[] = [];
    const holds = manager(dir, events, { settled });

    await assert.rejects(holds.raise({ content: "anyone there?", verdicts: ["yes"], timeoutMs: 20 }), HoldTimeoutError);
    assert.deepEqual((await enumerateHolds(dir)).holds, []);
    assert.deepEqual(settled, ["run-test-1"]);
    assert.ok(events.some((event) => event.method === "hold/timedOut"));
  });
});

test("close() abandons open holds: the wait rejects and the file is removed", async () => {
  await withHoldsDir(async (dir) => {
    const events: RuntimeEvent[] = [];
    const holds = manager(dir, events);
    const decision = holds.raise({ content: "left open at run end", verdicts: ["ok"] });
    const record = await publishedHold(dir);

    const rejected = assert.rejects(decision, HoldRejectedError);
    holds.close();
    await requireRejectionWithin(rejected, "close() did not reject the open hold", async () => {
      await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "ok" }));
    });
    assert.deepEqual((await enumerateHolds(dir)).holds, []);
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
    assert.deepEqual(await enumerateHolds(dir), { holds: [], retired: [] });
  });
});

test("holds publish under their launcher-supplied scope, and the two listing contracts hold", async () => {
  await withHoldsDir(async (dir) => {
    const events: RuntimeEvent[] = [];
    const leadA = manager(dir, events, { scope: "lead-a" });
    const shared = manager(dir, events, { scope: null });
    const decisionA = leadA.raise({ content: "lead a's question", verdicts: ["ok"] });
    const decisionShared = shared.raise({ content: "keyless question", verdicts: ["ok"] });
    // Register both rejections before an assertion can fail. The finally
    // closes every pending poll, so a real assertion failure stays red rather
    // than leaving a live raise() timer to hold the suite open.
    const abandoned = Promise.all([
      assert.rejects(decisionA, HoldRejectedError),
      assert.rejects(decisionShared, HoldRejectedError)
    ]);
    try {
      await waitForEvent(events, "hold/raised", 2);

      // The scoped listing is exactly the lead's own view: its hold, never
      // another scope's and never the default shared scope's.
      const scopedA = await enumerateHolds(dir, { scope: "lead-a" });
      assert.deepEqual(
        scopedA.holds.map((hold) => hold.record.content),
        ["lead a's question"]
      );
      assert.equal(scopedA.holds[0]?.record.scope, "lead-a");
      const scopedB = await enumerateHolds(dir, { scope: "lead-b" });
      assert.deepEqual(scopedB, { holds: [], retired: [] });

      // The machine-wide listing enumerates every scope, shared included.
      const machineWide = await enumerateHolds(dir);
      assert.deepEqual(
        machineWide.holds.map((hold) => hold.record.content).sort(),
        ["keyless question", "lead a's question"]
      );

      // An opaque key of hostile spelling maps to one directory, encoded.
      assert.equal(holdScopeSegment("a/b c"), "scope-a%2Fb%20c");
      assert.equal(holdScopeSegment(null), "shared");
    } finally {
      leadA.close();
      shared.close();
      await requireRejectionWithin(abandoned, "close() did not reject the scoped open holds", async () => {
        const { holds } = await enumerateHolds(dir);
        await Promise.all(
          holds.map(({ record }) => writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: record.verdicts[0] })))
        );
      });
    }
  });
});

async function requireRejectionWithin(
  expected: Promise<unknown>,
  message: string,
  releaseForTeardown: () => Promise<void>
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      expected,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} within 500ms`)), 500);
      })
    ]);
  } catch (error) {
    await releaseForTeardown();
    await expected.catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("the scope resolves explicit-over-environment, and neither means the shared scope", () => {
  assert.equal(resolveHoldScope("flag-scope", { ENSEMBLE_HOLD_SCOPE: "env-scope" }), "flag-scope");
  assert.equal(resolveHoldScope(undefined, { ENSEMBLE_HOLD_SCOPE: "env-scope" }), "env-scope");
  assert.equal(resolveHoldScope(undefined, { ENSEMBLE_HOLD_SCOPE: "   " }), null);
  assert.equal(resolveHoldScope(undefined, {}), null);
});

test("enumeration retires a dead raiser's hold and leaves the evidence-free one listed", async () => {
  await withHoldsDir(async (dir) => {
    const proc = await mkdtemp(path.join(tmpdir(), "ensemble-holds-proc-"));
    try {
      await writeProcStat(proc, process.pid, "1111");
      const scopeDir = path.join(dir, holdScopeSegment("lead-a"));
      await mkdir(scopeDir, { recursive: true });
      const host = hostname();
      const deadHold = holdRecord("run-dead-1", "lead-a", {
        host,
        pid: 999999,
        start_ticks: "3333",
        decisionDir: scopeDir
      });
      await writeFile(path.join(scopeDir, "run-dead-1.json"), JSON.stringify(deadHold));
      // A stale answer beside the dead hold goes with it.
      await writeFile(deadHold.decision_path, JSON.stringify({ nonce: "stale", verdict: "ok" }));
      const undecidable = holdRecord("run-unknown-1", "lead-a", {
        host,
        pid: 999998,
        start_ticks: null,
        decisionDir: scopeDir
      });
      await writeFile(path.join(scopeDir, "run-unknown-1.json"), JSON.stringify(undecidable));

      const enumeration = await enumerateHolds(dir, { scope: "lead-a", procDir: proc });
      // The dead raiser's hold is retired — removed, reported — and the
      // evidence-free one is never guessed at: it stays answerable.
      assert.deepEqual(
        enumeration.retired.map((record) => record.hold_id),
        ["run-dead-1"]
      );
      assert.deepEqual(
        enumeration.holds.map((hold) => hold.record.hold_id),
        ["run-unknown-1"]
      );
      assert.deepEqual((await readdir(scopeDir)).sort(), ["run-unknown-1.json"]);
      await assert.rejects(stat(deadHold.decision_path));
    } finally {
      await rm(proc, { recursive: true, force: true });
    }
  });
});

test("a raise sweeps its own scope first: the dead sibling is retired with an event", async () => {
  await withHoldsDir(async (dir) => {
    const proc = await mkdtemp(path.join(tmpdir(), "ensemble-holds-proc-"));
    try {
      await writeProcStat(proc, process.pid, "1111");
      const scopeDir = path.join(dir, holdScopeSegment("lead-a"));
      await mkdir(scopeDir, { recursive: true });
      const deadHold = holdRecord("run-dead-1", "lead-a", {
        host: hostname(),
        pid: 999999,
        start_ticks: "3333",
        decisionDir: scopeDir
      });
      await writeFile(path.join(scopeDir, "run-dead-1.json"), JSON.stringify(deadHold));

      const events: RuntimeEvent[] = [];
      const holds = manager(dir, events, { scope: "lead-a", procDir: proc });
      const decision = holds.raise({ content: "fresh question", verdicts: ["ok"] });
      await waitForEvent(events, "hold/raised");

      const retiredEvents = events.filter((event) => event.method === "hold/retired");
      assert.deepEqual(
        retiredEvents.map((event) => event.params.holdId),
        ["run-dead-1"]
      );
      const { holds: listed } = await enumerateHolds(dir, { scope: "lead-a", procDir: proc });
      assert.deepEqual(
        listed.map((hold) => hold.record.hold_id),
        ["run-test-1"]
      );

      holds.close();
      await assert.rejects(decision, HoldRejectedError);
    } finally {
      await rm(proc, { recursive: true, force: true });
    }
  });
});

test("the runtime surfaces holds in the live snapshot and archives their events", async () => {
  await withHoldsDir(async (dir) => {
    const runtime = new EnsembleRuntime({
      engines: new EngineRegistry([]),
      defaultMaxAttempts: 1,
      holdsDir: dir,
      holdScope: "runtime-scope",
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
    assert.equal(record.scope, "runtime-scope");
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

test("an explicitly blank runtime holdScope fails loud at construction", () => {
  assert.throws(
    () =>
      new EnsembleRuntime({
        engines: new EngineRegistry([]),
        defaultMaxAttempts: 1,
        holdScope: "  "
      }),
    HoldRejectedError
  );
});

test("the default holds directory lives under the ensemble data home", () => {
  const dir = defaultHoldsDirectory({ XDG_DATA_HOME: "/data/home" });
  assert.equal(dir, path.join("/data/home", "ensemble", "holds"));
});

function holdRecord(
  holdId: string,
  scope: string | null,
  options: { host: string; pid: number; start_ticks: string | null; decisionDir: string }
): HoldFileRecord {
  return {
    schema_version: 2,
    kind: "ensemble_hold",
    run_id: holdId.replace(/-\d+$/, ""),
    hold_id: holdId,
    nonce: `${holdId}-nonce`,
    scope,
    content: `question from ${holdId}`,
    verdicts: ["ok"],
    raised_at: new Date(0).toISOString(),
    timeout_at: null,
    cwd: "/nowhere",
    owner: { host: options.host, pid: options.pid, start_ticks: options.start_ticks },
    decision_path: path.join(options.decisionDir, `${holdId}.decision.json`)
  };
}

async function writeProcStat(procDir: string, pid: number, startTicks: string): Promise<void> {
  const dir = path.join(procDir, String(pid));
  await mkdir(dir, { recursive: true });
  // Fields 3–21 precede starttime (field 22); the comm field carries a
  // space so the parser's last-close-paren split is what the fixture tests.
  const before = ["S", "1", "1", "1", "0", "-1", "4194560", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1"];
  await writeFile(path.join(dir, "stat"), `${pid} (fa ke) ${before.join(" ")} ${startTicks} 0 0\n`);
}

/**
 * Read the open hold back off disk and assert the rejection feedback it now
 * carries. The manager republishes before it emits, so a read taken after the
 * arm's event is the feedback that arm produced — not a predecessor's.
 */
async function assertRepublishedRejection(
  dir: string,
  expected: { reason: string; attempted_verdict: string | null; attempted_verdict_state: string }
): Promise<void> {
  const republished = await publishedHold(dir);
  const rejection = republished.answer_rejection;
  assert.notEqual(rejection, undefined, `no rejection feedback republished for ${expected.reason}`);
  assert.equal(rejection?.reason, expected.reason);
  assert.equal(rejection?.attempted_verdict, expected.attempted_verdict);
  assert.equal(rejection?.attempted_verdict_state, expected.attempted_verdict_state);
  assert.equal(new Date(rejection?.rejected_at ?? "").toISOString(), rejection?.rejected_at);
}

async function waitForEvent(events: RuntimeEvent[], method: string, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (events.filter((event) => event.method === method).length >= count) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`event ${method} (x${count}) never arrived`);
}
