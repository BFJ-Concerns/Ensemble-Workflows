import assert from "node:assert/strict";
import test from "node:test";

import { RunProgress } from "../../src/progress.js";

import type { BudgetView } from "../../src/progress.js";
import type { EngineName } from "../../src/types.js";

class StubBudget implements BudgetView {
  spentByEngine: Record<EngineName, number> = { codex: 0, claude: 0 };
  ceilings: Record<EngineName, number | null> = { codex: null, claude: null };

  spent(engine: EngineName): number {
    return this.spentByEngine[engine];
  }

  remaining(engine: EngineName): number {
    const ceiling = this.ceilings[engine];
    return ceiling === null ? Number.POSITIVE_INFINITY : Math.max(0, ceiling - this.spentByEngine[engine]);
  }
}

function progressAt(clock: () => number, budget: BudgetView = new StubBudget()): RunProgress {
  return new RunProgress({ runId: "run-1", budget, now: clock, pid: 4242 });
}

test("queue → start → settle tracks per-engine and total counts", () => {
  const clock = 1_000;
  const progress = progressAt(() => clock);
  progress.registerEngine("codex", 4);
  progress.registerEngine("claude", 8);

  const id = progress.queueAgent({ engine: "codex", label: "find", phase: null });
  let snapshot = progress.snapshot();
  assert.equal(snapshot.engines.codex.queued, 1);
  assert.equal(snapshot.engines.codex.active, 0);
  assert.equal(snapshot.totals.queued, 1);
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.agents[0]?.state, "queued");
  assert.equal(snapshot.engines.codex.cap, 4);
  assert.equal(snapshot.pid, 4242);

  progress.startAgent(id);
  snapshot = progress.snapshot();
  assert.equal(snapshot.engines.codex.queued, 0);
  assert.equal(snapshot.engines.codex.active, 1);
  assert.equal(snapshot.agents[0]?.state, "running");

  progress.settleAgent(id, "done");
  snapshot = progress.snapshot();
  assert.equal(snapshot.engines.codex.active, 0);
  assert.equal(snapshot.engines.codex.done, 1);
  assert.equal(snapshot.totals.done, 1);
  assert.equal(snapshot.agents.length, 0);
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
  assert.equal(snapshot.engines.claude.failed, 1);
  assert.equal(snapshot.engines.claude.active, 0);
  assert.equal(snapshot.totals.failed, 1);
});

test("snapshot reflects per-engine budget spend, ceiling, and remaining without summing", () => {
  const clock = 1_000;
  const budget = new StubBudget();
  budget.ceilings.codex = 100;
  budget.spentByEngine.codex = 30;
  const progress = progressAt(() => clock, budget);

  const snapshot = progress.snapshot();
  assert.equal(snapshot.engines.codex.spent, 30);
  assert.equal(snapshot.engines.codex.ceiling, 100);
  assert.equal(snapshot.engines.codex.remaining, 70);
  // Claude is unbounded: ceiling and remaining both serialise as null, not Infinity.
  assert.equal(snapshot.engines.claude.ceiling, null);
  assert.equal(snapshot.engines.claude.remaining, null);
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
  progress.markChanged();
  assert.equal(changes, 2);

  off();
  progress.setPhase("y");
  assert.equal(changes, 2);
});

test("the live agent list is bounded and lists running agents before queued ones", () => {
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
  assert.equal(snapshot.agents.length, 64);
  assert.ok(snapshot.agents.every((agent) => agent.state === "running"));
});
