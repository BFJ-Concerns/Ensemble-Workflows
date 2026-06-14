import assert from "node:assert/strict";
import test from "node:test";

import { parallel, pipeline } from "../../src/hooks.js";

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
