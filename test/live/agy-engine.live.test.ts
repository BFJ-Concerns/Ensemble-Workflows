import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { removeTestDirectory } from "../failure-evidence.js";
import { createRuntime } from "../../src/index.js";
import { liveAgyModel } from "./live-models.js";

const isLive = process.env.ENSEMBLE_LIVE === "1";
const skip = !isLive ? "ENSEMBLE_LIVE must be 1" : liveAgyModel === undefined ? "ENSEMBLE_LIVE_AGY_MODEL is unset" : false;

// Every turn here spends the operator's own agy subscription, so the leg is
// two turns of one held worker at `low`. Assertions read the records, never
// the wording of a reply beyond the schema's own values.
test("a held agy worker answers on the named model and level, remembers its first turn, and accounts its usage", { skip, timeout: 300_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-agy-live-"));
  let passed = false;
  t.after(() => removeTestDirectory(dir, !passed));
  const runtime = await createRuntime({ cwd: dir, defaultMaxAttempts: 2 });
  t.after(() => runtime.close());
  const session = runtime.createWorkerSession({ engine: "agy", model: liveAgyModel!, effort: "low" });
  t.after(() => session.close());

  const first = await session.send("Remember the word 'cobalt'. Reply with the single word: ready. Use no tools.");
  assert.equal(typeof first, "string");
  const opening = runtime.lastAgentRecord();
  assert.equal(opening?.resolvedModel, liveAgyModel);
  assert.equal(opening?.resolvedEffort, "low");

  const schema = {
    type: "object", required: ["word"], additionalProperties: false,
    properties: { word: { type: "string", enum: ["cobalt"] } }
  };
  assert.deepEqual(await session.send("Which word did I ask you to remember? Use no tools.", { schema }), { word: "cobalt" });
  assert.ok(runtime.budget.spent("agy") > 0, "agy's usage reaches the budget");
  // agy's own counts beside the breakdown they were mapped to, for reconciling the usage rule.
  for (const { event } of runtime.budget.events) t.diagnostic(JSON.stringify({ agy: event.raw.usage, last: event.last }));
  passed = true;
});
