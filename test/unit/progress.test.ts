import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RunProgress, workerDisposition } from "../../src/progress.js";
import { StatusFileWriter } from "../../src/status-file.js";
import { documentedSchemaVersion } from "../documented-schema-versions.js";

import type { AdmissionView, BudgetView, DispositionEvidence, ShutdownStatus, WorkerDisposition } from "../../src/progress.js";
import type { SnapshotOwnerEvidence } from "../../src/status-file.js";
import type { AdmissionWaitSnapshot, EngineName } from "../../src/types.js";

class StubBudget implements BudgetView {
  spentByEngine: Partial<Record<EngineName, number>> = { codex: 0, claude: 0, opencode: 0 };
  ceilings: Partial<Record<EngineName, number | null>> = { codex: null, claude: null, opencode: null };

  spent(engine: EngineName): number {
    return this.spentByEngine[engine] ?? 0;
  }

  remaining(engine: EngineName): number {
    const ceiling = this.ceilings[engine] ?? null;
    return ceiling === null ? Number.POSITIVE_INFINITY : Math.max(0, ceiling - this.spent(engine));
  }
}

/** Admission's account as a test sets it; the progress model reads it at each snapshot. */
class StubAdmission implements AdmissionView {
  ceiling: number | null = null;
  ceilingActive = 0;
  waiting = new Map<number, AdmissionWaitSnapshot>();

  snapshot(): ReturnType<AdmissionView["snapshot"]> {
    return { ceilingActive: this.ceilingActive, waiting: this.waiting };
  }
}

function progressAt(
  clock: () => number,
  budget: BudgetView = new StubBudget(),
  admission: AdmissionView = new StubAdmission()
): RunProgress {
  const progress = new RunProgress({ runId: "run-1", budget, admission, now: clock, pid: 4242 });
  progress.registerEngine("codex", 4);
  progress.registerEngine("claude", 8);
  progress.registerEngine("opencode", 2);
  return progress;
}

function documentedStatusSchemaSection(): string {
  const reference = readFileSync("docs/run-records.md", "utf8");
  const start = reference.indexOf("### `ensemble.<run-uuid>.local.json` schema");
  const end = reference.indexOf("Example:", start);
  assert.notEqual(start, -1, "docs/run-records.md must document the status file schema");
  assert.notEqual(end, -1, "docs/run-records.md schema section must end before the example");
  return reference.slice(start, end);
}

function documentedTopLevelFields(section: string): string[] {
  return [...section.matchAll(/^- `([^`]+)`:/gm)].map((match) => fieldName(match));
}

function documentedBullet(section: string, field: string): string {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(new RegExp(`^- \`${escaped}\`:[\\s\\S]*?(?=\\n- \`|\\n\\n)`, "m"));
  assert.ok(match !== null, `docs/run-records.md must document ${field}`);
  return match[0];
}

function documentedNestedFields(section: string, field: string): string[] {
  return [...documentedBullet(section, field).matchAll(/`([^`]+)`/g)]
    .map((match) => fieldName(match))
    .filter((name) => name !== field);
}

function fieldName(match: RegExpMatchArray): string {
  const value = match[1];
  assert.ok(value !== undefined);
  return value.replace(/^"|"$/g, "");
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

test("queue → start → settle tracks per-engine and total counts", () => {
  const clock = 1_000;
  const progress = progressAt(() => clock);
  const id = progress.queueAgent({ engine: "codex", label: "find", phase: null });
  let snapshot = progress.snapshot();
  assert.equal(snapshot.engines.codex?.queued, 1);
  assert.equal(snapshot.engines.codex?.active, 0);
  assert.equal(snapshot.totals.queued, 1);
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.agents[0]?.state, "queued");
  assert.equal(snapshot.engines.codex?.cap, 4);
  assert.equal(snapshot.pid, 4242);

  progress.startAgent(id);
  snapshot = progress.snapshot();
  assert.equal(snapshot.engines.codex?.queued, 0);
  assert.equal(snapshot.engines.codex?.active, 1);
  assert.equal(snapshot.agents[0]?.state, "running");

  progress.settleAgent(id, "done");
  snapshot = progress.snapshot();
  assert.equal(snapshot.engines.codex?.active, 0);
  assert.equal(snapshot.engines.codex?.done, 1);
  assert.equal(snapshot.totals.done, 1);
  assert.equal(snapshot.agents[0]?.state, "done");
});

test("documented status file schema stays in sync with published snapshots", async () => {
  const clock = 1_000;
  const budget = new StubBudget();
  budget.ceilings.codex = 100;
  budget.spentByEngine.codex = 25;
  const progress = progressAt(() => clock, budget);
  progress.setWorkflow("doc-sync");
  progress.setPhase("Verify");
  const id = progress.queueAgent({ engine: "codex", label: "scan", phase: null });
  progress.startAgent(id);

  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-status-docs-"));
  const writer = new StatusFileWriter({ progress, dir });
  try {
    assert.equal(await writer.ready(), true);
    const snapshot = JSON.parse(await readFile(writer.path, "utf8")) as ReturnType<RunProgress["snapshot"]> & { owner: SnapshotOwnerEvidence };
    const section = documentedStatusSchemaSection();

    assert.deepEqual(documentedTopLevelFields(section).sort(), sortedKeys(snapshot));
    assert.equal(documentedSchemaVersion("Live status"), snapshot.schema);
    assert.doesNotMatch(
      documentedBullet(section, "schema"),
      /`\d+`/,
      "the schema bullet must refer to the Schema versions table, which alone states the number"
    );
    assert.deepEqual(
      documentedNestedFields(section, "owner").filter((field) => field !== "null").sort(),
      sortedKeys(snapshot.owner)
    );
    assert.deepEqual(documentedNestedFields(section, "totals").sort(), sortedKeys(snapshot.totals));
    assert.deepEqual(
      documentedNestedFields(section, "agentCeiling").filter((field) => field !== "null").sort(),
      sortedKeys(snapshot.agentCeiling)
    );
    assert.deepEqual(["claude", "codex", "opencode"], sortedKeys(snapshot.engines));
    assert.deepEqual(
      documentedNestedFields(section, "engines")
        .filter((field) => !["codex", "claude", "opencode"].includes(field))
        .filter((field) => field !== "null")
        .sort(),
      sortedKeys(snapshot.engines.codex ?? {})
    );
    assert.deepEqual(
      documentedNestedFields(section, "agents")
        .filter((field) => !["codex", "claude", "opencode", "queued", "running", "done", "failed"].includes(field))
        .filter((field) => field !== "null")
        .sort(),
      sortedKeys(snapshot.agents[0] ?? {})
    );
  } finally {
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("phase is captured at queue time, with an explicit phase overriding the current one", () => {
  const clock = 1_000;
  const progress = progressAt(() => clock);
  progress.setPhase("collect");

  const inherited = progress.queueAgent({ engine: "codex", label: null, phase: null });
  const explicit = progress.queueAgent({ engine: "claude", label: null, phase: "verify" });

  const snapshot = progress.snapshot();
  const byId = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  assert.equal(snapshot.currentPhase, "collect");
  assert.equal(byId.get(inherited)?.phase, "collect");
  assert.equal(byId.get(explicit)?.phase, "verify");
});

test("settling a running agent as failed tallies failed and frees the slot", () => {
  const clock = 1_000;
  const progress = progressAt(() => clock);
  const id = progress.queueAgent({ engine: "claude", label: null, phase: null });
  progress.startAgent(id);
  progress.settleAgent(id, "failed");

  const snapshot = progress.snapshot();
  assert.equal(snapshot.engines.claude?.failed, 1);
  assert.equal(snapshot.engines.claude?.active, 0);
  assert.equal(snapshot.totals.failed, 1);
});

test("snapshot reflects per-engine budget spend, ceiling, and remaining without summing", () => {
  const clock = 1_000;
  const budget = new StubBudget();
  budget.ceilings.codex = 100;
  budget.spentByEngine.codex = 30;
  const progress = progressAt(() => clock, budget);

  const snapshot = progress.snapshot();
  assert.equal(snapshot.engines.codex?.spent, 30);
  assert.equal(snapshot.engines.codex?.ceiling, 100);
  assert.equal(snapshot.engines.codex?.remaining, 70);
  // Claude is unbounded: ceiling and remaining both serialise as null, not Infinity.
  assert.equal(snapshot.engines.claude?.ceiling, null);
  assert.equal(snapshot.engines.claude?.remaining, null);
});

test("the agent ceiling and its active count are admission's own, read afresh at each snapshot", () => {
  const admission = new StubAdmission();
  const progress = progressAt(() => 1_000, new StubBudget(), admission);
  // No ceiling is published as a null limit, never by leaving the field out.
  assert.deepEqual(progress.snapshot().agentCeiling, { limit: null, active: 0 });

  admission.ceiling = 6;
  admission.ceilingActive = 6;
  const id = progress.queueAgent({ engine: "codex", label: null, phase: null });
  progress.startAgent(id);
  // Admission's count, not the model's: one worker is executing and six slots are held.
  assert.equal(progress.snapshot().totals.active, 1);
  assert.deepEqual(progress.snapshot().agentCeiling, { limit: 6, active: 6 });

  // The model holds no copy: a change in admission's account shows at the
  // next snapshot, and markChanged is what asks a writer to take one.
  let changes = 0;
  progress.onChange(() => {
    changes += 1;
  });
  admission.ceilingActive = 5;
  progress.markChanged();
  assert.equal(changes, 1);
  assert.deepEqual(progress.snapshot().agentCeiling, { limit: 6, active: 5 });
});

test("noteAttempt updates the live agent's attempt number", () => {
  const clock = 1_000;
  const progress = progressAt(() => clock);
  const id = progress.queueAgent({ engine: "codex", label: null, phase: null });
  progress.startAgent(id);
  progress.noteAttempt(id, 2);

  assert.equal(progress.snapshot().agents[0]?.attempt, 2);
});

test("finish stamps the finished state and updatedAt tracks the clock", () => {
  let clock = 1_000;
  const progress = progressAt(() => clock);
  assert.equal(progress.snapshot().startedAt, 1_000);
  assert.equal(progress.snapshot().updatedAt, 1_000);

  clock = 1_500;
  progress.setPhase("a");
  assert.equal(progress.snapshot().updatedAt, 1_500);
  assert.equal(progress.snapshot().startedAt, 1_000);

  clock = 2_000;
  progress.finish();
  const snapshot = progress.snapshot();
  assert.equal(snapshot.state, "finished");
  assert.equal(snapshot.finishedAt, 2_000);
});

test("onChange fires on transitions and stops after unsubscribe", () => {
  const clock = 1_000;
  const progress = progressAt(() => clock);
  let changes = 0;
  const off = progress.onChange(() => {
    changes += 1;
  });

  progress.setPhase("x");
  progress.noteEngineSpend("codex");
  assert.equal(changes, 2);

  off();
  progress.setPhase("y");
  assert.equal(changes, 2);
});

test("new engine spend republishes the live snapshot once while an agent is running", () => {
  const clock = 1_000;
  const budget = new StubBudget();
  const progress = progressAt(() => clock, budget);
  const agent = progress.queueAgent({ engine: "codex", label: "spend", phase: null });
  progress.startAgent(agent);
  const observed: number[] = [];
  progress.onChange(() => {
    observed.push(progress.snapshot().engines.codex?.spent ?? -1);
  });

  budget.spentByEngine.codex = 41;
  progress.noteEngineSpend("codex");
  progress.noteEngineSpend("codex");

  assert.deepEqual(observed, [41]);
  assert.equal(progress.snapshot().agents[0]?.state, "running");
});

test("the live agent list retains all workers and lists running agents before queued ones", () => {
  const clock = 1_000;
  const progress = progressAt(() => clock);

  const running = progress.queueAgent({ engine: "codex", label: null, phase: null });
  progress.startAgent(running);
  const queued = progress.queueAgent({ engine: "codex", label: null, phase: null });

  let snapshot = progress.snapshot();
  assert.equal(snapshot.agents[0]?.id, running);
  assert.equal(snapshot.agents[0]?.state, "running");
  assert.equal(snapshot.agents[1]?.id, queued);

  for (let index = 0; index < 100; index += 1) {
    const id = progress.queueAgent({ engine: "codex", label: null, phase: null });
    progress.startAgent(id);
  }
  snapshot = progress.snapshot();
  assert.equal(snapshot.totals.active, 101);
  assert.equal(snapshot.agents.length, 102);
  assert.equal(snapshot.totals.queued, 1);
  assert.deepEqual(snapshot.agents.map((agent) => agent.id).sort((a, b) => a - b),
    Array.from({ length: 102 }, (_, index) => index + 1));
  assert.equal(snapshot.agents.at(-1)?.id, queued);
});

test("what a worker is waiting on rides the live agent snapshot, last report winning, cleared on a fresh attempt", () => {
  const progress = progressAt(() => 5_000);
  const id = progress.queueAgent({ engine: "claude", label: null, phase: null });
  progress.startAgent(id);
  assert.equal(progress.snapshot().agents[0]?.waitingOn, null);

  const wait = { kind: "background-task" as const, taskId: "bya9z1l44", description: "Wait 45 seconds in background", sinceMs: 4_900 };
  progress.noteAgentWaiting(id, wait);
  assert.deepEqual(progress.snapshot().agents[0]?.waitingOn, wait);

  // The task ended: the engine reports nothing outstanding.
  progress.noteAgentWaiting(id, null);
  assert.equal(progress.snapshot().agents[0]?.waitingOn, null);

  // A retry is a fresh dispatch: whatever the last attempt waited on is gone.
  progress.noteAgentWaiting(id, wait);
  progress.noteAttempt(id, 2);
  assert.equal(progress.snapshot().agents[0]?.waitingOn, null);
});

test("liveness stamps ride the live agent snapshot, earliest evidence winning", () => {
  let clock = 1_000;
  const progress = progressAt(() => (clock += 1));
  const id = progress.queueAgent({ engine: "claude", label: null, phase: null });
  let agent = progress.snapshot().agents[0];
  assert.equal(agent?.startedAtMs, null);
  assert.equal(agent?.firstEvidenceAtMs, null);

  progress.startAgent(id);
  const startedAt = progress.snapshot().agents[0]?.startedAtMs;
  assert.equal(typeof startedAt, "number");

  progress.noteAgentEvidence(id);
  const firstEvidence = progress.snapshot().agents[0]?.firstEvidenceAtMs;
  assert.equal(typeof firstEvidence, "number");
  assert.ok((firstEvidence ?? 0) > (startedAt ?? 0));

  // Engines may report on every attempt; the earliest observation is kept.
  progress.noteAgentEvidence(id);
  agent = progress.snapshot().agents[0];
  assert.equal(agent?.firstEvidenceAtMs, firstEvidence);
});

test("producer evidence survives settlement and unknowns stay null", () => {
  let clock = 100;
  const progress = progressAt(() => clock);
  const id = progress.queueAgent({ engine: "codex", label: null, phase: null });
  assert.equal(progress.snapshot().agents[0]?.spent, null);
  progress.setArchiveDir("/archive/run");
  progress.noteAgentIdentity(id, { requestedModel: "wanted", requestedEffort: "high" });
  progress.noteAgentWorktree(id, "/worktree");
  progress.startAgent(id);
  progress.noteAgentIdentity(id, { resolvedModel: "served", resolvedEffort: "medium" });
  progress.noteAgentTranscript(id, "agents/1/live.jsonl");
  progress.noteAgentSpend(id, 25);
  progress.noteAgentEvidence(id);
  clock = 200;
  progress.noteAttempt(id, 2);
  progress.noteAgentEvidence(id);
  assert.equal(progress.snapshot().agents[0]?.firstEvidenceAtMs, 100);
  assert.equal(progress.snapshot().agents[0]?.lastEvidenceAtMs, 200);
  progress.requeueAgent(id, "claude");
  const queued = progress.snapshot().agents[0];
  assert.equal(queued?.startedAtMs, null);
  assert.equal(queued?.lastEvidenceAtMs, null);
  assert.equal(queued?.resolvedModel, null);
  assert.equal(queued?.transcript, null);
  assert.equal(queued?.requestedModel, "wanted");
  assert.equal(queued?.spent, 25);
  progress.startAgent(id);
  progress.noteAgentIdentity(id, { resolvedModel: "fallback" });
  progress.noteAgentTranscript(id, "/session.jsonl");
  const failure = { kind: "timeout", message: "deadline expired" };
  progress.settleAgent(id, "failed", failure);
  failure.message = "changed";
  progress.settleAgent(id, "done");
  progress.noteAgentEvidence(id);
  const snapshot = progress.snapshot();
  assert.equal(snapshot.archiveDir, "/archive/run");
  assert.equal(snapshot.totals.failed, 1);
  assert.equal(snapshot.totals.done, 0);
  assert.equal(snapshot.agents[0]?.finishedAtMs, 200);
  assert.equal(snapshot.agents[0]?.failure?.message, "deadline expired");
  assert.equal(snapshot.agents[0]?.worktree, "/worktree");
  assert.equal(snapshot.agents[0]?.transcript, "/session.jsonl");
});

test("all finished evidence survives alongside queued and running workers until run completion", () => {
  let clock = 100;
  const progress = progressAt(() => clock);
  const expected = [];
  for (let index = 0; index < 100; index += 1) {
    const id = progress.queueAgent({ engine: "codex", label: `worker-${index}`, phase: "build" });
    progress.noteAgentIdentity(id, {
      requestedModel: "wanted", requestedEffort: "high",
      resolvedModel: "served", resolvedEffort: "medium"
    });
    progress.noteAgentTranscript(id, `/transcripts/${id}`);
    progress.noteAgentWorktree(id, `/worktrees/${id}`);
    progress.noteAgentSpend(id, id * 10);
    progress.startAgent(id);
    progress.noteAgentEvidence(id);
    clock += 1;
    progress.noteAgentEvidence(id);
    progress.settleAgent(id, index % 2 === 0 ? "done" : "failed",
      { kind: "timeout", message: `expired-${id}` });
    expected.push(progress.snapshot().agents.find((agent) => agent.id === id));
  }
  const queued = progress.queueAgent({ engine: "claude", label: null, phase: null });
  const running = progress.queueAgent({ engine: "claude", label: null, phase: null });
  progress.startAgent(running);
  progress.noteAgentEvidence(running);
  const snapshot = progress.snapshot();
  assert.equal(snapshot.agents.length, 102);
  assert.deepEqual(snapshot.agents.map((agent) => agent.id).sort((a, b) => a - b),
    Array.from({ length: 102 }, (_, index) => index + 1));
  assert.equal(snapshot.agents[0]?.id, running);
  assert.equal(snapshot.agents[1]?.id, queued);
  assert.deepEqual(snapshot.agents.slice(2), expected.reverse());
  assert.deepEqual(snapshot.totals, { active: 1, queued: 1, done: 50, failed: 50, cutShort: 0, unsettled: 0 });
  assert.equal(snapshot.engines.codex?.done, 50);
  assert.equal(snapshot.engines.codex?.failed, 50);
  assert.equal(snapshot.engines.codex?.active, 0);
  assert.equal(snapshot.engines.codex?.queued, 0);
  assert.equal(snapshot.engines.claude?.active, 1);
  assert.equal(snapshot.engines.claude?.queued, 1);

  clock += 1;
  progress.settleAgent(1, "failed", { kind: "late", message: "duplicate" });
  progress.settleAgent(2, "done");
  assert.deepEqual(progress.snapshot(), snapshot);
  progress.finish();
  const finished = progress.snapshot();
  assert.equal(finished.state, "finished");
  assert.deepEqual(finished.agents, snapshot.agents);
  assert.deepEqual(finished.totals, snapshot.totals);
});

test("workerDisposition maps a record's status and cause to one disposition", () => {
  const cause = (kind: string) => ({ kind });
  const cases: Array<[DispositionEvidence, ShutdownStatus | null, WorkerDisposition | null]> = [
    [{ status: "in-progress", terminationCause: null }, "interrupted", null],
    [{ status: "complete", terminationCause: null }, null, "done"],
    // Settling successfully while the run shuts down keeps the worker's own account.
    [{ status: "complete", terminationCause: null }, "interrupted", "done"],
    [{ status: "failed", terminationCause: cause("turn-failed") }, null, "failed"],
    [{ status: "timed-out", terminationCause: cause("turn-timeout") }, "timed-out", "failed"],
    // The run's own ending names the run's status; the record status alone cannot tell.
    [{ status: "failed", terminationCause: cause("run-failed") }, "failed", "cut-short"],
    [{ status: "interrupted", terminationCause: cause("run-interrupted") }, "interrupted", "cut-short"],
    [{ status: "timed-out", terminationCause: cause("run-timed-out") }, "timed-out", "cut-short"],
    // A run-<status> cause that does not name the closing run's status is not this run's ending.
    [{ status: "failed", terminationCause: cause("run-failed") }, null, "failed"],
    [{ status: "failed", terminationCause: cause("run-failed") }, "interrupted", "failed"],
    [{ status: "abandoned", terminationCause: cause("run-interrupted") }, "interrupted", "unsettled"]
  ];
  for (const [record, shutdownStatus, expected] of cases) {
    assert.equal(workerDisposition(record, shutdownStatus), expected, JSON.stringify([record, shutdownStatus]));
  }
});

test("each disposition is published at settlement under its own state and count", () => {
  let clock = 1_000;
  const progress = progressAt(() => clock);
  const done = progress.queueAgent({ engine: "codex", label: "done", phase: null });
  const failed = progress.queueAgent({ engine: "codex", label: "failed", phase: null });
  const cutShort = progress.queueAgent({ engine: "claude", label: "cut-short", phase: null });
  const unsettled = progress.queueAgent({ engine: "claude", label: "unsettled", phase: null });
  for (const id of [done, failed, cutShort]) progress.startAgent(id);

  clock += 1;
  const runEnding = { kind: "run-interrupted", message: "the run ended (interrupted) while the turn was in flight" };
  progress.settleAgent(done, "done");
  progress.settleAgent(failed, "failed", { kind: "turn-failed", message: "engine refused" });
  progress.settleAgent(cutShort, "cut-short", runEnding);
  progress.settleAgent(unsettled, "unsettled", runEnding);
  const snapshot = progress.snapshot();

  assert.equal(snapshot.schema, 5);
  assert.deepEqual(snapshot.totals, { active: 0, queued: 0, done: 1, failed: 1, cutShort: 1, unsettled: 1 });
  const counts = (engine: EngineName) => {
    const entry = snapshot.engines[engine];
    return [entry?.done, entry?.failed, entry?.cutShort, entry?.unsettled];
  };
  assert.deepEqual(counts("codex"), [1, 1, 0, 0]);
  assert.deepEqual(counts("claude"), [0, 0, 1, 1]);
  const byId = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.get(done)?.state, "done");
  assert.equal(byId.get(done)?.failure, null);
  assert.equal(byId.get(failed)?.state, "failed");
  assert.equal(byId.get(cutShort)?.state, "cut-short");
  assert.deepEqual(byId.get(cutShort)?.failure, runEnding);
  assert.equal(byId.get(unsettled)?.state, "unsettled");
  assert.deepEqual(byId.get(unsettled)?.failure, runEnding);
  for (const agent of snapshot.agents) assert.equal(agent.finishedAtMs, clock);

  // The first settlement is final: a later one never reclassifies a published worker.
  progress.settleAgent(cutShort, "failed", { kind: "late", message: "after teardown" });
  assert.deepEqual(progress.snapshot(), snapshot);
});


test("queued admission waits are read once with the ceiling and never override running background waits", () => {
  const admission = new StubAdmission();
  let reads = 0;
  const view: AdmissionView = {
    ceiling: 1,
    snapshot: () => { reads += 1; return admission.snapshot(); }
  };
  const progress = progressAt(() => 1_000, new StubBudget(), view);
  const id = progress.queueAgent({ engine: "codex", label: null, phase: null });
  admission.ceilingActive = 1;
  admission.waiting.set(id, { kind: "admission", gate: "agent-ceiling", sinceMs: 900 });
  const first = progress.snapshot();
  assert.equal(reads, 1);
  assert.deepEqual(first.agentCeiling, { limit: 1, active: 1 });
  assert.deepEqual(first.agents[0]?.waitingOn, { kind: "admission", gate: "agent-ceiling", sinceMs: 900 });
  admission.waiting.set(id, { kind: "admission", gate: "engine-cap", sinceMs: 900 });
  assert.equal(progress.snapshot().agents[0]?.waitingOn?.kind, "admission");
  assert.deepEqual(first.agents[0]?.waitingOn, { kind: "admission", gate: "agent-ceiling", sinceMs: 900 });

  progress.startAgent(id);
  const background = { kind: "background-task" as const, taskId: "command", description: "Building", sinceMs: 950 };
  progress.noteAgentWaiting(id, background);
  assert.deepEqual(progress.snapshot().agents[0]?.waitingOn, background);
  progress.settleAgent(id, "done");
  assert.equal(progress.snapshot().agents[0]?.waitingOn, null);
});
