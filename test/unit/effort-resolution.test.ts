import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUILT_IN_SERVED_LEVELS,
  CANONICAL_EFFORT_DOMAIN,
  effortTargetKeys,
  nearestServedLevel,
  resolveEffort,
  servedLevelsFromReport
} from "../../src/effort-resolution.js";

import type { EffortSettings, ServedEffortLevels } from "../../src/effort-resolution.js";

const NO_TABLE: EffortSettings = {};

test("the canonical vocabulary names every level some shipped engine serves, in ascending order", () => {
  assert.deepEqual([...CANONICAL_EFFORT_DOMAIN], ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("target keys run most specific first, and an unpinned model has no model key", () => {
  assert.deepEqual(effortTargetKeys("codex", "gpt-6-luna"), ["codex:gpt-6-luna", "codex", "*"]);
  assert.deepEqual(effortTargetKeys("claude", undefined), ["claude", "*"]);
});

test("the nearest served level is the level itself where served, else the closest, a tie going lower", () => {
  const served: ServedEffortLevels = { low: "low", high: "high" };
  assert.equal(nearestServedLevel("high", served), "high");
  // minimal sits one below low and three below high.
  assert.equal(nearestServedLevel("minimal", served), "low");
  // max sits one above high.
  assert.equal(nearestServedLevel("max", served), "high");
  // medium is equidistant from low and high: the cheaper neighbour wins.
  assert.equal(nearestServedLevel("medium", served), "low");
  assert.throws(() => nearestServedLevel("low", {}), /at least one level/);
});

test("a machine bound moves the request, the most specific key supplying both bounds", () => {
  const settings: EffortSettings = {
    "*": { ceiling: "xhigh" },
    "codex:gpt-6-luna": { floor: "medium" }
  };
  const report = servedLevelsFromReport(["low", "medium", "high", "xhigh", "max"]);

  // The wildcard ceiling applies to a model with no key of its own.
  const ceilinged = resolveEffort({ requested: "max", engine: "codex", model: "gpt-6-sol", settings, engineReport: report, builtIn: NO_TABLE });
  assert.deepEqual(ceilinged.bound, { rule: "ceiling", key: "*", level: "xhigh" });
  assert.equal(ceilinged.dispatched, "xhigh");

  // The model key replaces the wildcard pair: its floor applies and the
  // wildcard ceiling no longer does, so max reaches the model unbounded.
  const floored = resolveEffort({ requested: "low", engine: "codex", model: "gpt-6-luna", settings, engineReport: report, builtIn: NO_TABLE });
  assert.deepEqual(floored.bound, { rule: "floor", key: "codex:gpt-6-luna", level: "medium" });
  assert.equal(floored.dispatched, "medium");
  const unbounded = resolveEffort({ requested: "max", engine: "codex", model: "gpt-6-luna", settings, engineReport: report, builtIn: NO_TABLE });
  assert.equal(unbounded.bound, null);
  assert.equal(unbounded.dispatched, "max");

  // Within the bounds nothing moves.
  const inside = resolveEffort({ requested: "high", engine: "codex", model: "gpt-6-luna", settings, engineReport: report, builtIn: NO_TABLE });
  assert.equal(inside.bound, null);
});

test("served levels come from the machine map, else the engine's report, else the built-in table, else pass through", () => {
  const machine: EffortSettings = { "codex:gpt-6-luna": { levels: { none: "none", low: "low" } } };
  const report = servedLevelsFromReport(["low", "medium", "high"]);
  const table: EffortSettings = { codex: { levels: { medium: "medium" } } };

  // The machine map wins even over the engine's own report.
  const fromMachine = resolveEffort({ requested: "none", engine: "codex", model: "gpt-6-luna", settings: machine, engineReport: report, builtIn: table });
  assert.deepEqual(fromMachine.served, { source: "machine", level: "none" });
  assert.equal(fromMachine.dispatched, "none");

  // Without a map, the engine's report; a level it lacks clamps to its nearest.
  const fromEngine = resolveEffort({ requested: "none", engine: "codex", model: "gpt-6-luna", settings: {}, engineReport: report, builtIn: table });
  assert.deepEqual(fromEngine.served, { source: "engine", level: "low" });

  // Without a report, the table — an engine-wide row covering the model.
  const fromTable = resolveEffort({ requested: "max", engine: "codex", model: "gpt-6-luna", settings: {}, engineReport: null, builtIn: table });
  assert.deepEqual(fromTable.served, { source: "built-in", level: "medium" });
  assert.equal(fromTable.dispatched, "medium");

  // Known to none: the bounded level is passed through for the engine to judge.
  const passthrough = resolveEffort({ requested: "xhigh", engine: "codex", model: "gpt-unknown", settings: {}, engineReport: null, builtIn: NO_TABLE });
  assert.deepEqual(passthrough.served, { source: "none", level: null });
  assert.equal(passthrough.dispatched, "xhigh");
  assert.equal(passthrough.requested, "xhigh");
});

test("the dispatched name is the served map's native spelling, after the bound", () => {
  const settings: EffortSettings = {
    "*": { ceiling: "high" },
    "opencode:glm": { levels: { low: "fast", high: "deep" } }
  };
  const resolved = resolveEffort({ requested: "max", engine: "opencode", model: "glm", settings, engineReport: null, builtIn: NO_TABLE });
  assert.deepEqual(resolved, {
    requested: "max",
    bound: { rule: "ceiling", key: "*", level: "high" },
    served: { source: "machine", level: "high" },
    dispatched: "deep"
  });
});

test("an engine report keeps only canonical names and an empty one is no report", () => {
  // `ultra` is a level the vocabulary cannot ask for, so it is dropped.
  assert.deepEqual(servedLevelsFromReport(["low", "ultra", "max"]), { low: "low", max: "max" });
  assert.equal(servedLevelsFromReport(["ultra"]), null);
  assert.equal(servedLevelsFromReport([]), null);
});

test("the built-in table covers the Claude CLI engine-wide and the measured Codex lineup", () => {
  // Claude: none and minimal clamp to low; max is native.
  const claude = resolveEffort({ requested: "none", engine: "claude", model: "opus", settings: {}, engineReport: null });
  assert.deepEqual(claude.served, { source: "built-in", level: "low" });
  assert.equal(resolveEffort({ requested: "max", engine: "claude", model: undefined, settings: {}, engineReport: null }).dispatched, "max");
  // Codex: the 2026-10-26 listing served low through max on gpt-6-luna.
  const luna = resolveEffort({ requested: "minimal", engine: "codex", model: "gpt-6-luna", settings: {}, engineReport: null });
  assert.deepEqual(luna.served, { source: "built-in", level: "low" });
  assert.equal(resolveEffort({ requested: "max", engine: "codex", model: "gpt-5.5", settings: {}, engineReport: null }).dispatched, "xhigh");
  assert.ok(Object.keys(BUILT_IN_SERVED_LEVELS).every((key) => key === "claude" || key.startsWith("codex:")));
});
