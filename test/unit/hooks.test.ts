import assert from "node:assert/strict";
import test from "node:test";

import { RemovedAgentOptionError } from "../../src/errors.js";
import { parallel, pipeline } from "../../src/hooks.js";
import { NestedWorkflowError, WorkflowResolutionError } from "../../src/workflow-registry.js";

test("parallel returns null for throwing thunks and logs the failure", async () => {
  const logs: string[] = [];

  const results = await parallel(
    [
      () => "first",
      () => {
        throw new Error("boom");
      },
      async () => "third"
    ],
    (message) => logs.push(message)
  );

  assert.deepEqual(results, ["first", null, "third"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /parallel thunk 1 failed: Error: boom/);
});

test("parallel propagates a rejected agent option", async () => {
  await assert.rejects(
    () =>
      parallel(
        [
          () => "first",
          () => {
            throw new RemovedAgentOptionError("sandbox");
          }
        ],
        () => {}
      ),
    RemovedAgentOptionError
  );
});

test("parallel propagates every pre-spawn author error, not only rejected options", async () => {
  // The exempt membership is the criterion — any rejection raised before a
  // worker spawns — so an unresolvable workflow() reference inside a
  // fan-out fails the run. Collapsed to null, a fan-out of identically
  // mistyped references would .filter(Boolean) into a silent empty success.
  await assert.rejects(
    () =>
      parallel(
        [
          () => "first",
          () => {
            throw new WorkflowResolutionError('workflow("mistyped-name") was not found');
          }
        ],
        () => {}
      ),
    WorkflowResolutionError
  );

  // The nesting violation is named by the contract as the same family.
  await assert.rejects(
    () =>
      parallel(
        [
          () => {
            throw new NestedWorkflowError();
          }
        ],
        () => {}
      ),
    NestedWorkflowError
  );
});

test("pipeline propagates an unresolvable workflow() reference", async () => {
  await assert.rejects(
    () =>
      pipeline(
        ["item"],
        [
          () => {
            throw new WorkflowResolutionError('workflow({ scriptPath }) could not read ./absent.js');
          }
        ],
        () => {}
      ),
    WorkflowResolutionError
  );
});

test("pipeline allows cross-item interleaving and drops only the failed item", async () => {
  const events: string[] = [];
  let releaseSlowItem!: () => void;
  const slowItemGate = new Promise<void>((resolve) => {
    releaseSlowItem = resolve;
  });

  const results = await pipeline(
    ["slow", "fast", "bad"],
    [
      async (_previous, item, index) => {
        events.push(`stage-0-start-${item}`);
        if (item === "slow") {
          await slowItemGate;
        }
        if (item === "bad") {
          throw new Error("stage broke");
        }
        events.push(`stage-0-end-${item}`);
        return `${item}:${index}`;
      },
      async (previous, item) => {
        events.push(`stage-1-${item}`);
        if (item === "fast") {
          releaseSlowItem();
        }
        return `${String(previous)}:done`;
      }
    ],
    (message) => events.push(`log:${message}`)
  );

  assert.deepEqual(results, ["slow:0:done", "fast:1:done", null]);
  assert.ok(events.indexOf("stage-1-fast") < events.indexOf("stage-0-end-slow"));
  assert.ok(!events.includes("stage-1-bad"));
  assert.ok(events.some((event) => /log:pipeline item 2 stage 0 failed: Error: stage broke/.test(event)));
});

test("pipeline propagates a rejected agent option", async () => {
  await assert.rejects(
    () =>
      pipeline(
        ["item"],
        [
          () => {
            throw new RemovedAgentOptionError("network");
          }
        ],
        () => {}
      ),
    RemovedAgentOptionError
  );
});

test("the budget hook is a read-only facade, not the live ledger", async () => {
  const { createWorkflowHooks } = await import("../../src/hooks.js");
  const { TokenBudget } = await import("../../src/budget.js");

  const budget = new TokenBudget({ codex: 100 });
  const hooks = createWorkflowHooks({
    runtime: {
      budget,
      worktrees: [],
      agent: (async () => "unused") as never,
      notePhase: () => {}
    },
    args: [],
    log: () => {},
    workflow: async () => null
  });

  assert.equal(hooks.budget.spent("codex"), 0);
  assert.equal(hooks.budget.remaining("codex"), 100);
  // The live TokenBudget's mutators must not cross into the sandbox.
  assert.equal("record" in hooks.budget, false);
  assert.equal("events" in hooks.budget, false);
});
