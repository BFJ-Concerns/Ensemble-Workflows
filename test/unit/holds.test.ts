import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HoldManager,
  answerHold,
  defaultHoldsDirectory,
  enumerateHolds,
  holdListingState,
  holdScopeSegment,
  resolveHoldScope
} from "../../src/holds.js";
import { HoldRejectedError, HoldTimeoutError } from "../../src/errors.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { EngineRegistry } from "../../src/engines.js";
import { RunRecordWriter, reapAbandonedRuns } from "../../src/run-record.js";

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

test("a rejected hold remains waiting and reaches the runtime archive", async () => {
  await withHoldsDir(async (dir) => {
    const store = await mkdtemp(path.join(tmpdir(), "ensemble-hold-rejection-record-"));
    const writer = await RunRecordWriter.start({
      storeDir: store,
      cwd: process.cwd(),
      runUuid: "hold-rejection",
      workflowPath: path.join(process.cwd(), "test", "unit", "holds.test.ts"),
      workflowSource: "export const meta = { name: 'hold-rejection' };\nreturn null;\n",
      args: [],
      cliFlags: { jsonArgs: false }
    });
    const runtime = new EnsembleRuntime({
      engines: new EngineRegistry([]),
      defaultMaxAttempts: 1,
      holdsDir: dir,
      holdPollIntervalMs: 5
    });
    runtime.setRunRecorder(writer);

    try {
      let settled = false;
      const decision = runtime.raiseHold({ content: "take the release route?", verdicts: ["yes"] });
      void decision.then(
        () => { settled = true; },
        () => { settled = true; }
      );
      const record = await publishedHold(dir);

      await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "no", answered_by: "lead", note: "wait" }));
      await waitForArchiveHoldEvent(writer.archiveDir, "answer-rejected");

      // The rejection is consumed, but it is not a decision: the caller is
      // still waiting and the live hold remains answerable.
      await Promise.resolve();
      assert.equal(settled, false);
      assert.equal((await enumerateHolds(dir)).holds.length, 1);
      assert.equal((await enumerateHolds(dir)).holds[0]?.record.answer_rejection?.answered_by, "lead");
      assert.equal((await enumerateHolds(dir)).holds[0]?.record.answer_rejection?.note, "wait");
      const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
        hold_events: Array<{ event: string; reason: string | null; attempted_verdict: string | null; answered_by: string | null; note: string | null }>;
      };
      assert.deepEqual(
        manifest.hold_events.map(({ event, reason, attempted_verdict, answered_by, note }) => ({ event, reason, attempted_verdict, answered_by, note })),
        [
          { event: "raised", reason: null, attempted_verdict: null, answered_by: null, note: null },
          { event: "answer-rejected", reason: "invalid-verdict", attempted_verdict: "no", answered_by: "lead", note: "wait" }
        ]
      );

      await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "yes" }));
      assert.deepEqual(await decision, { verdict: "yes", note: null });
    } finally {
      await runtime.close();
      await writer.finish({ status: "complete", exitCode: 0, result: null });
      await rm(store, { recursive: true, force: true });
    }
  });
});

test("a concurrent hold-file reader sees only complete records through rejection publication", async () => {
  await withHoldsDir(async (dir) => {
    const events: RuntimeEvent[] = [];
    const holds = manager(dir, events);
    const decision = holds.raise({ content: "x".repeat(1_048_576), verdicts: ["yes"] });
    try {
      const record = await publishedHold(dir);
      const holdPath = path.join(dir, holdScopeSegment(null), `${record.hold_id}.json`);
      let readerStarted: (() => void) | undefined;
      const readerHasOpenedRecord = new Promise<void>((resolve) => {
        readerStarted = resolve;
      });
      const reader = readCompleteHoldAcrossPublication(holdPath, "invalid-verdict", () => readerStarted?.());
      await Promise.race([readerHasOpenedRecord, reader]);

      // This answer is parseable, so the decision poller consumes it on its
      // first read; the reader loops over the published record until it sees
      // the resulting rejection. It must encounter either complete version,
      // never an absent path or a truncated JSON document.
      await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "no" }));
      await Promise.all([reader, waitForEvent(events, "hold/answerRejected")]);
      await assertRepublishedRejection(dir, {
        reason: "invalid-verdict",
        attempted_verdict: "no",
        attempted_verdict_state: "submitted"
      });

      await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "yes" }));
      assert.deepEqual(await decision, { verdict: "yes", note: null });
    } finally {
      holds.close();
      await decision.catch(() => undefined);
    }
  });
});

test("an unanswered hold with a timeout rejects with HoldTimeoutError and leaves the listing", async () => {
  await withHoldsDir(async (dir) => {
    const events: RuntimeEvent[] = [];
    const settled: string[] = [];
    const holds = manager(dir, events, { settled });

    await requireRejectionWithin(
      assert.rejects(holds.raise({ content: "anyone there?", verdicts: ["yes"], timeoutMs: 20 }), HoldTimeoutError),
      "the unanswered hold did not time out",
      async () => holds.close()
    );
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
    const rejected = assert.rejects(decision, HoldRejectedError);

    try {
      const record = await publishedHold(dir);

      holds.close();
      await requireRejectionWithin(rejected, "close() did not reject the open hold", async () => {
        await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "ok" }));
      });
      assert.deepEqual((await enumerateHolds(dir)).holds, []);
      await requireRejectionWithin(
        assert.rejects(holds.raise({ content: "too late", verdicts: ["ok"] }), HoldRejectedError),
        "close() did not reject a later hold",
        noTeardownNeeded
      );
    } finally {
      holds.close();
      await requireRejectionWithin(rejected, "close() did not reject the open hold", noTeardownNeeded);
    }
  });
});

test("hold options are validated before anything is published", async () => {
  await withHoldsDir(async (dir) => {
    const holds = manager(dir, []);
    await requireRejectionWithin(assert.rejects(holds.raise({ content: "", verdicts: ["ok"] }), HoldRejectedError), "empty hold content did not reject", noTeardownNeeded);
    await requireRejectionWithin(assert.rejects(holds.raise({ content: "x", verdicts: [] }), HoldRejectedError), "empty verdicts did not reject", noTeardownNeeded);
    await requireRejectionWithin(assert.rejects(holds.raise({ content: "x", verdicts: ["a", "a"] }), HoldRejectedError), "duplicate verdicts did not reject", noTeardownNeeded);
    await requireRejectionWithin(
      assert.rejects(holds.raise({ content: "x", verdicts: ["ok"], timeoutMs: 0 }), HoldRejectedError),
      "zero timeout did not reject",
      noTeardownNeeded
    );
    await requireRejectionWithin(
      assert.rejects(holds.raise({ content: "x", verdicts: ["ok"], surprise: true } as never), HoldRejectedError),
      "unknown hold option did not reject",
      noTeardownNeeded
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

async function noTeardownNeeded(): Promise<void> {}

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
      assert.deepEqual((await readdir(scopeDir)).sort(), ["run-dead-1.retired.json", "run-unknown-1.json"]);
      const machineWide = await enumerateHolds(dir, { procDir: proc });
      assert.deepEqual(machineWide.retired, enumeration.retired);
      assert.equal(enumeration.retired[0]?.state, "retired");
      assert.equal(enumeration.retired[0]?.retirement_reason, "dead-raiser");
      assert.ok(enumeration.retired[0]?.retired_at);
      await requireRejectionWithin(assert.rejects(stat(deadHold.decision_path)), "the retired decision file remained", noTeardownNeeded);
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
      const rejected = assert.rejects(decision, HoldRejectedError);

      try {
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

        const record = listed[0]?.record;
        assert.ok(record, "the fresh hold must remain listed before close");
        holds.close();
        await requireRejectionWithin(rejected, "close() did not reject the swept-scope hold", async () => {
          await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: record.verdicts[0] }));
        });
      } finally {
        holds.close();
        await requireRejectionWithin(rejected, "close() did not reject the swept-scope hold", noTeardownNeeded);
      }
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
    decision.catch(() => undefined);
    try {
      const record = await publishedHold(dir);
      assert.equal(record.scope, "runtime-scope");
      // The open hold is visible to a status poller while the run waits.
      const openSnapshot = runtime.progress.snapshot();
      assert.equal(openSnapshot.holds.length, 1);
      assert.equal(openSnapshot.holds[0]?.hold_id, record.hold_id);
      assert.deepEqual(openSnapshot.holds[0]?.verdicts, ["yes", "no"]);

      await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "yes" }));
      assert.deepEqual(await decision, { verdict: "yes", note: null });
      assert.equal(runtime.progress.snapshot().holds.length, 0);
      assert.deepEqual(
        holdEvents.map((event) => event.method),
        ["hold/raised", "hold/answered"]
      );
    } finally {
      await runtime.close();
    }
  });
});

test("a raise carries the run's identity card, and the archive's answered event names the answerer and note", async () => {
  await withHoldsDir(async (dir) => {
    const store = await mkdtemp(path.join(tmpdir(), "ensemble-hold-answerer-record-"));
    const writer = await RunRecordWriter.start({
      storeDir: store,
      cwd: process.cwd(),
      runUuid: "hold-answerer",
      workflowPath: path.join(process.cwd(), "test", "unit", "holds.test.ts"),
      workflowSource: "export const meta = { name: 'hold-answerer' };\nreturn null;\n",
      args: [],
      cliFlags: { jsonArgs: false }
    });
    const runtime = new EnsembleRuntime({
      engines: new EngineRegistry([]),
      defaultMaxAttempts: 1,
      holdsDir: dir,
      holdPollIntervalMs: 5
    });
    runtime.setRunRecorder(writer);
    runtime.progress.setWorkflow("release-gate");
    runtime.progress.setPhase("review");
    // Real progress in the raising runtime, each total distinct, so the card
    // is proven to read the run's own counts rather than any constant.
    const ids = Array.from({ length: 10 }, () => runtime.progress.queueAgent({ engine: "codex", label: null, phase: null }));
    ids.slice(0, 9).forEach((id) => runtime.progress.startAgent(id));
    ids.slice(0, 4).forEach((id) => runtime.progress.settleAgent(id, "done"));
    ids.slice(4, 6).forEach((id) => runtime.progress.settleAgent(id, "failed"));
    try {
      const first = runtime.raiseHold({ content: "merge?", verdicts: ["yes", "no"] });
      // A failing assertion closes the runtime, rejecting this wait: keep that
      // teardown rejection from masking the assertion's own failure.
      first.catch(() => undefined);
      const record = await publishedHold(dir);
      // Captured at raise from the raising runtime itself, display-only.
      assert.deepEqual(record.run_identity, {
        workflow: "release-gate",
        phase: "review",
        archive_path: writer.archiveDir,
        totals: { active: 3, queued: 1, done: 4, failed: 2 }
      });
      assert.equal(record.poll_interval_ms, 5);
      const outcome = await answerHold({ dir, holdId: record.hold_id, verdict: "yes", note: "ship it", answeredBy: "lead-7" });
      assert.deepEqual(outcome, { outcome: "consumed", hold_id: record.hold_id, verdict: "yes" });
      assert.deepEqual(await first, { verdict: "yes", note: "ship it" });

      // A hand-authored answer naming no answerer records none — never a guess.
      const second = runtime.raiseHold({ content: "tag?", verdicts: ["yes"] });
      const secondRecord = await publishedHold(dir);
      await writeFile(secondRecord.decision_path, JSON.stringify({ nonce: secondRecord.nonce, verdict: "yes" }));
      await second;
      await waitForArchiveHoldEvent(writer.archiveDir, "answered", 2);
      const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
        hold_events: Array<{ event: string; answered_by: string | null; note: string | null }>;
      };
      assert.deepEqual(
        manifest.hold_events
          .filter((entry) => entry.event === "answered")
          .map(({ answered_by, note }) => ({ answered_by, note })),
        [
          { answered_by: "lead-7", note: "ship it" },
          { answered_by: null, note: null }
        ]
      );
    } finally {
      await runtime.close();
      await writer.finish({ status: "complete", exitCode: 0, result: null });
      await rm(store, { recursive: true, force: true });
    }
  });
});

test("answerHold reports a bounce with its reason, and never claims an unread answer as accepted", async () => {
  await withHoldsDir(async (dir) => {
    const events: RuntimeEvent[] = [];
    const holds = manager(dir, events);
    const decision = holds.raise({ content: "deploy?", verdicts: ["go"] });
    // A failing assertion must not leave the raise polling for ever.
    decision.catch(() => undefined);
    try {
      const record = await publishedHold(dir);

      const bounced = await answerHold({ dir, holdId: record.hold_id, verdict: "later", answeredBy: "me" });
      assert.equal(bounced.outcome, "bounced");
      assert.equal(bounced.outcome === "bounced" ? bounced.rejection.reason : null, "invalid-verdict");
      // The hold keeps waiting, now listed as bounced.
      assert.equal((await enumerateHolds(dir)).holds.length, 1);
      const [listed] = (await enumerateHolds(dir)).holds;
      assert.equal(listed !== undefined && holdListingState(listed.record), "bounced");
      const accepted = await answerHold({ dir, holdId: record.hold_id, verdict: "go", answeredBy: "me" });
      assert.equal(accepted.outcome, "consumed");
      assert.deepEqual(await decision, { verdict: "go", note: null });

      // A live raiser that is not polling (a hand-built record owned by this
      // very process): the answer stays unread, and the report says so.
      const scopeDir = path.join(dir, holdScopeSegment(null));
      const idle = holdRecord("run-idle-1", null, {
        host: hostname(),
        pid: process.pid,
        start_ticks: null,
        decisionDir: scopeDir
      });
      await writeFile(path.join(scopeDir, "run-idle-1.json"), JSON.stringify(idle));
      assert.equal(holdListingState(idle), "open");
      const unread = await answerHold({ dir, holdId: "run-idle-1", verdict: "ok", answeredBy: "me", waitMs: 30, checkIntervalMs: 5 });
      assert.equal(unread.outcome, "not-consumed");
      assert.deepEqual(Object.entries(JSON.parse(await readFile(idle.decision_path, "utf8")) as Record<string, string>)
        .filter(([key]) => key !== "submission_id"), [["nonce", idle.nonce], ["verdict", "ok"], ["answered_by", "me"]]);
      assert.equal((await answerHold({ dir, holdId: "no-such-hold", verdict: "ok", answeredBy: "me" })).outcome, "not-found");
    } finally {
      holds.close();
    }
  });
});

test("answerHold reports an unattributable outcome when the hold times out before reading its answer", async () => {
  await withHoldsDir(async (dir) => {
    let parkedDecision: string | null = null;
    let decisionPath: string | null = null;
    const holds = new HoldManager({
      dir, runId: "run-timeout", cwd: "/fake/cwd", scope: null,
      pollIntervalMs: 500,
      onEvent: (event) => {
        if (event.method === "hold/timedOut" && parkedDecision !== null && decisionPath !== null) {
          renameSync(parkedDecision, decisionPath);
        }
      }
    });
    const decision = holds.raise({ content: "deploy?", verdicts: ["go"], timeoutMs: 40 });
    decision.catch(() => undefined);
    try {
      const record = await publishedHold(dir);
      decisionPath = record.decision_path;
      const answering = answerHold({ dir, holdId: record.hold_id, verdict: "go", answeredBy: "me", waitMs: 1000, checkIntervalMs: 5 });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await stat(record.decision_path);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      }
      parkedDecision = `${record.decision_path}.parked`;
      renameSync(record.decision_path, parkedDecision);
      const outcome = await answering;
      assert.deepEqual(outcome, { outcome: "not-attributable", hold_id: record.hold_id, verdict: "go" });
      await assert.rejects(decision, HoldTimeoutError);
      assert.equal((await enumerateHolds(dir)).retired[0]?.retirement_reason, "timed-out");
    } finally {
      holds.close();
    }
  });
});

test("a rejected submission remains attributable after its deadline removes the hold", async () => {
  await withHoldsDir(async (dir) => {
    let now = 0;
    const events: RuntimeEvent[] = [];
    const holds = new HoldManager({
      dir, runId: "deadline-rejection", cwd: "/fake/cwd", scope: null,
      pollIntervalMs: 5, now: () => now,
      onEvent: (event) => { events.push(event); if (event.method === "hold/answerRejected") now = 100; }
    });
    const decision = holds.raise({ content: "deploy?", verdicts: ["go"], timeoutMs: 50 });
    decision.catch(() => undefined);
    try {
      const record = await publishedHold(dir);
      const answering = answerHold({ dir, holdId: record.hold_id, verdict: "later", answeredBy: "lead", note: "wait",
        waitMs: 1000, checkIntervalMs: 100 });
      await waitForEvent(events, "hold/timedOut");
      const outcome = await answering;
      assert.equal(outcome.outcome, "bounced");
      if (outcome.outcome === "bounced") {
        assert.equal(outcome.rejection.reason, "invalid-verdict");
        assert.equal(outcome.rejection.answered_by, "lead");
        assert.equal(outcome.rejection.note, "wait");
      }
      await assert.rejects(decision, HoldTimeoutError);
      assert.equal((await enumerateHolds(dir)).retired[0]?.retirement_reason, "timed-out");
    } finally {
      holds.close();
    }
  });
});

test("concurrent answerers report only their own submission's outcome", async () => {
  await withHoldsDir(async (dir) => {
    const holds = new HoldManager({ dir, runId: "racing-answers", cwd: "/fake/cwd", scope: null, pollIntervalMs: 300 });
    const decision = holds.raise({ content: "deploy?", verdicts: ["go"] });
    decision.catch(() => undefined);
    try {
      const record = await publishedHold(dir);
      const first = answerHold({ dir, holdId: record.hold_id, verdict: "bad", answeredBy: "first", waitMs: 700, checkIntervalMs: 5 });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const pending = JSON.parse(await readFile(record.decision_path, "utf8")) as { answered_by?: string };
          if (pending.answered_by === "first") break;
        } catch { /* Wait for the first publish. */ }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const second = answerHold({ dir, holdId: record.hold_id, verdict: "go", answeredBy: "second", waitMs: 700, checkIntervalMs: 5 });
      const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
      assert.equal(firstOutcome.outcome, "not-attributable");
      assert.equal(secondOutcome.outcome, "consumed");
      assert.deepEqual(await decision, { verdict: "go", note: null });
    } finally {
      holds.close();
    }
  });
});

test("answerHold checks its receipt again after an in-flight hold read finds no file", async () => {
  await withHoldsDir(async (dir) => {
    const holds = new HoldManager({ dir, runId: "receipt-race", cwd: "/fake/cwd", scope: null, pollIntervalMs: 300 });
    const decision = holds.raise({ content: "proceed?", verdicts: ["go"] });
    decision.catch(() => undefined);
    let releaseRead: (() => void) | undefined;
    const blockedRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    let observedRead: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => { observedRead = resolve; });
    try {
      const record = await publishedHold(dir);
      const answering = answerHold({ dir, holdId: record.hold_id, verdict: "go", answeredBy: "lead",
        readHoldFile: async (holdPath) => {
          observedRead?.();
          await blockedRead;
          return readFile(holdPath, "utf8");
        } });
      await Promise.race([readStarted, new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("answerer never reached the delayed hold read")), 2000);
      })]);
      assert.deepEqual(await decision, { verdict: "go", note: null });
      releaseRead?.();
      assert.deepEqual(await answering, { outcome: "consumed", hold_id: record.hold_id, verdict: "go" });
      assert.deepEqual((await readdir(path.dirname(record.decision_path))).filter((name) => name.endsWith(".receipt.json")), []);
    } finally {
      releaseRead?.();
      holds.close();
    }
  });
});

for (const archiveCase of ["missing raised event", "missing archive"] as const) {
  test(`dead hold remains retired when its ${archiveCase} prevents archival`, async () => {
    await withHoldsDir(async (dir) => {
      const store = await mkdtemp(path.join(tmpdir(), "ensemble-retirement-failure-"));
      const proc = await mkdtemp(path.join(tmpdir(), "ensemble-retirement-proc-"));
      try {
        await writeProcStat(proc, process.pid, "1111");
        const scopeDir = path.join(dir, holdScopeSegment("lead"));
        await mkdir(scopeDir, { recursive: true });
        const record = holdRecord(`retirement-${archiveCase.replaceAll(" ", "-")}`, "lead", {
          host: hostname(), pid: 999999, start_ticks: "3333", decisionDir: scopeDir
        });
        const writer = archiveCase === "missing raised event" ? await RunRecordWriter.start({
          storeDir: store, cwd: process.cwd(), runUuid: record.run_id,
          workflowPath: path.join(process.cwd(), "test", "unit", "holds.test.ts"),
          workflowSource: "export const meta = { name: 'retirement' };\nreturn null;\n",
          args: [], cliFlags: { jsonArgs: false }
        }) : null;
        record.run_identity = { workflow: null, phase: null,
          archive_path: writer?.archiveDir ?? path.join(store, "absent"),
          totals: { active: 0, queued: 0, done: 0, failed: 0 } };
        await writeFile(path.join(scopeDir, `${record.hold_id}.json`), JSON.stringify(record));
        await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: "go" }));
        const first = await enumerateHolds(dir, { scope: "lead", procDir: proc });
        assert.deepEqual(first.retired.map((entry) => entry.hold_id), [record.hold_id]);
        assert.equal(first.holds.length, 0);
        assert.match(first.retired[0]?.archive_error ?? "", archiveCase === "missing archive" ? /ENOENT/ : /does not belong/);
        await assert.rejects(stat(record.decision_path));
        const again = await enumerateHolds(dir, { procDir: proc });
        assert.deepEqual(again.retired, first.retired);
        assert.deepEqual((await readdir(scopeDir)), [`${record.hold_id}.retired.json`]);
      } finally {
        await rm(store, { recursive: true, force: true });
        await rm(proc, { recursive: true, force: true });
      }
    });
  });
}

test("retirement reaches the killed raiser's manifest before and after reaping", async () => {
  await withHoldsDir(async (dir) => {
    const store = await mkdtemp(path.join(tmpdir(), "ensemble-retirement-record-"));
    const proc = await mkdtemp(path.join(tmpdir(), "ensemble-retirement-proc-"));
    try {
      await writeProcStat(proc, process.pid, "1111");
      const writer = await RunRecordWriter.start({
        storeDir: store, cwd: process.cwd(), runUuid: "dead-raiser",
        workflowPath: path.join(process.cwd(), "test", "unit", "holds.test.ts"),
        workflowSource: "export const meta = { name: 'dead-raiser' };\nreturn null;\n",
        args: [], cliFlags: { jsonArgs: false }
      });
      const scopeDir = path.join(dir, holdScopeSegment("lead"));
      await mkdir(scopeDir, { recursive: true });
      const record = holdRecord("dead-raiser-1", "lead", {
        host: hostname(), pid: 999999, start_ticks: "3333", decisionDir: scopeDir
      });
      record.run_identity = { workflow: null, phase: null, archive_path: writer.archiveDir,
        totals: { active: 0, queued: 0, done: 0, failed: 0 } };
      await writer.recordHoldEvent({ method: "hold/raised", params: { holdId: record.hold_id }, receivedAt: 0 });
      await writeFile(path.join(scopeDir, `${record.hold_id}.json`), JSON.stringify(record));
      const scoped = await enumerateHolds(dir, { scope: "lead", procDir: proc });
      assert.equal(scoped.retired[0]?.retirement_reason, "dead-raiser");
      const before = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
        status: string; hold_events: Array<{ event: string; reason: string | null }>
      };
      assert.equal(before.status, "in-progress");
      assert.deepEqual(before.hold_events.map((event) => event.event), ["raised", "retired"]);
      assert.equal(before.hold_events[1]?.reason, "dead-raiser");
      const all = await enumerateHolds(dir, { procDir: proc });
      assert.deepEqual(all.retired, scoped.retired);
      await reapAbandonedRuns({ namespaceDir: path.dirname(writer.archiveDir), skipRunUuid: "other",
        procDir: proc, observer: { pid: process.pid, runUuid: "other" } });
      const after = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as typeof before;
      assert.equal(after.status, "abandoned");
      assert.deepEqual(after.hold_events, before.hold_events);
    } finally {
      await rm(store, { recursive: true, force: true });
      await rm(proc, { recursive: true, force: true });
    }
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

async function waitForArchiveHoldEvent(archiveDir: string, event: string, count = 1): Promise<void> {
  const manifestPath = path.join(archiveDir, "manifest.json");
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      hold_events: Array<{ event: string }>;
    };
    if (manifest.hold_events.filter((entry) => entry.event === event).length >= count) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`archive hold event ${event} never appeared`);
}

async function readCompleteHoldAcrossPublication(
  holdPath: string,
  expectedReason: string,
  onFirstRecord: () => void
): Promise<void> {
  let firstRecord = true;
  for (let attempt = 0; attempt < 20_000; attempt += 1) {
    let raw: string;
    try {
      raw = await readFile(holdPath, "utf8");
    } catch (error) {
      throw new Error(`concurrent reader saw no hold record: ${error instanceof Error ? error.message : String(error)}`);
    }
    let record: HoldFileRecord;
    try {
      record = JSON.parse(raw) as HoldFileRecord;
    } catch (error) {
      throw new Error(`concurrent reader saw a partial hold record: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert.equal(record.kind, "ensemble_hold");
    if (firstRecord) {
      firstRecord = false;
      onFirstRecord();
    }
    if (record.answer_rejection?.reason === expectedReason) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("concurrent reader never observed the republished hold record");
}
