import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertEffortSettings,
  BUILT_IN_SERVED_LEVELS,
  CANONICAL_EFFORT_DOMAIN,
  CLAUDE_CLI_EFFORT_LEVELS,
  effortTargetKeys,
  nearestServedLevel,
  resolveEffort,
  servedLevelsFromReport
} from "../../src/effort-resolution.js";

import type { EffortSettings, ServedEffortLevels, ServedEffortReport } from "../../src/effort-resolution.js";

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
  // max sits two above high, xhigh between.
  assert.equal(nearestServedLevel("max", served), "high");
  // medium is equidistant from low and high: the cheaper neighbour wins.
  assert.equal(nearestServedLevel("medium", served), "low");
  assert.throws(() => nearestServedLevel("low", {}), /at least one level/);
});

/** An engine report for the named model, or the absence of one. */
function reporting(model: string, ...levels: string[]): () => Promise<ServedEffortReport | null> {
  return async () => ({ model, levels: servedLevelsFromReport(levels) });
}

const NO_REPORT = async (): Promise<ServedEffortReport | null> => null;

/** An engine that must not be asked: the test fails on the round trip. */
const NEVER_ASKED = (): Promise<ServedEffortReport | null> => {
  throw new Error("the engine was asked for a report the machine map already answered");
};

test("a machine bound moves the request, the most specific key supplying both bounds", async () => {
  const settings: EffortSettings = {
    "*": { ceiling: "xhigh" },
    "codex:gpt-6-luna": { floor: "medium" }
  };
  const report = reporting("gpt-6-luna", "low", "medium", "high", "xhigh", "max");

  // The wildcard ceiling applies to a model with no key of its own.
  const ceilinged = await resolveEffort({ requested: "max", engine: "codex", model: "gpt-6-sol", settings, engineReport: report, builtIn: NO_TABLE });
  assert.deepEqual(ceilinged.bound, { rule: "ceiling", key: "*", level: "xhigh" });
  assert.equal(ceilinged.dispatched, "xhigh");

  // The model key replaces the wildcard pair: its floor applies and the
  // wildcard ceiling no longer does, so max reaches the model unbounded.
  const floored = await resolveEffort({ requested: "low", engine: "codex", model: "gpt-6-luna", settings, engineReport: report, builtIn: NO_TABLE });
  assert.deepEqual(floored.bound, { rule: "floor", key: "codex:gpt-6-luna", level: "medium" });
  assert.equal(floored.dispatched, "medium");
  const unbounded = await resolveEffort({ requested: "max", engine: "codex", model: "gpt-6-luna", settings, engineReport: report, builtIn: NO_TABLE });
  assert.equal(unbounded.bound, null);
  assert.equal(unbounded.dispatched, "max");

  // Within the bounds nothing moves.
  const inside = await resolveEffort({ requested: "high", engine: "codex", model: "gpt-6-luna", settings, engineReport: report, builtIn: NO_TABLE });
  assert.equal(inside.bound, null);
});

test("served levels come from the machine map, else the engine's report, else the built-in table, else pass through", async () => {
  const machine: EffortSettings = { "codex:gpt-6-luna": { levels: { none: "none", low: "low" } } };
  const report = reporting("gpt-6-luna", "low", "medium", "high");
  const table: EffortSettings = { codex: { levels: { medium: "medium" } } };

  // The machine map wins over the engine's own report, which is not even
  // asked for: a mapped model costs no round trip.
  const fromMachine = await resolveEffort({ requested: "none", engine: "codex", model: "gpt-6-luna", settings: machine, engineReport: NEVER_ASKED, builtIn: table });
  assert.deepEqual(fromMachine.served, { source: "machine", level: "none" });
  assert.equal(fromMachine.dispatched, "none");

  // Without a map, the engine's report; a level it lacks clamps to its nearest.
  const fromEngine = await resolveEffort({ requested: "none", engine: "codex", model: "gpt-6-luna", settings: {}, engineReport: report, builtIn: table });
  assert.deepEqual(fromEngine.served, { source: "engine", level: "low" });

  // Without a report, the table — an engine-wide row covering the model. A
  // report that lists the model but names no level the vocabulary can ask
  // for is no report either.
  const fromTable = await resolveEffort({ requested: "max", engine: "codex", model: "gpt-6-luna", settings: {}, engineReport: NO_REPORT, builtIn: table });
  assert.deepEqual(fromTable.served, { source: "built-in", level: "medium" });
  assert.equal(fromTable.dispatched, "medium");
  const fromTableAfterEmptyReport = await resolveEffort({ requested: "max", engine: "codex", model: "gpt-6-luna", settings: {}, engineReport: reporting("gpt-6-luna", "ultra"), builtIn: table });
  assert.deepEqual(fromTableAfterEmptyReport.served, { source: "built-in", level: "medium" });

  // Known to none: the bounded level is passed through for the engine to judge.
  const passthrough = await resolveEffort({ requested: "xhigh", engine: "codex", model: "gpt-unknown", settings: {}, engineReport: NO_REPORT, builtIn: NO_TABLE });
  assert.deepEqual(passthrough.served, { source: "none", level: null });
  assert.equal(passthrough.dispatched, "xhigh");
  assert.equal(passthrough.requested, "xhigh");
});

test("an unpinned dispatch takes the keys of the model the engine reports as its default", async () => {
  const settings: EffortSettings = {
    codex: { levels: { low: "low", high: "high" } },
    "codex:gpt-6-luna": { ceiling: "medium", levels: { low: "low", medium: "medium" } }
  };
  // The engine is asked even though an engine-wide map exists, because only
  // its answer says which model the dispatch runs on; that model's own
  // bound and map then apply.
  const resolved = await resolveEffort({ requested: "max", engine: "codex", model: undefined, settings, engineReport: reporting("gpt-6-luna", "low", "medium", "high"), builtIn: NO_TABLE });
  assert.deepEqual(resolved, {
    requested: "max",
    bound: { rule: "ceiling", key: "codex:gpt-6-luna", level: "medium" },
    served: { source: "machine", level: "medium" },
    dispatched: "medium"
  });
  // With no report the dispatch has no model key: the engine-wide map resolves it.
  const unknown = await resolveEffort({ requested: "max", engine: "codex", model: undefined, settings, engineReport: NO_REPORT, builtIn: NO_TABLE });
  assert.equal(unknown.bound, null);
  assert.deepEqual(unknown.served, { source: "machine", level: "high" });
});

test("the dispatched name is the served map's native spelling, after the bound", async () => {
  const settings: EffortSettings = {
    "*": { ceiling: "high" },
    "codex:gpt-custom": { levels: { low: "fast", high: "deep" } }
  };
  const resolved = await resolveEffort({ requested: "max", engine: "codex", model: "gpt-custom", settings, engineReport: NEVER_ASKED, builtIn: NO_TABLE });
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

test("the built-in table covers the Claude CLI engine-wide and the measured Codex lineup", async () => {
  // Claude: none and minimal clamp to low; max is native; the row is the
  // CLI's own accepted set.
  const claude = await resolveEffort({ requested: "none", engine: "claude", model: "opus", settings: {}, engineReport: NO_REPORT });
  assert.deepEqual(claude.served, { source: "built-in", level: "low" });
  assert.equal((await resolveEffort({ requested: "max", engine: "claude", model: undefined, settings: {}, engineReport: NO_REPORT })).dispatched, "max");
  assert.deepEqual(Object.keys(BUILT_IN_SERVED_LEVELS.claude?.levels ?? {}), [...CLAUDE_CLI_EFFORT_LEVELS]);
  // Codex: the 2026-10-26 listing served low through max on gpt-6-luna.
  const luna = await resolveEffort({ requested: "minimal", engine: "codex", model: "gpt-6-luna", settings: {}, engineReport: NO_REPORT });
  assert.deepEqual(luna.served, { source: "built-in", level: "low" });
  assert.equal((await resolveEffort({ requested: "max", engine: "codex", model: "gpt-5.5", settings: {}, engineReport: NO_REPORT })).dispatched, "xhigh");
  assert.ok(Object.keys(BUILT_IN_SERVED_LEVELS).every((key) => key === "claude" || key.startsWith("codex:")));
});

test("the settings validator refuses what the resolver cannot read, naming the path", () => {
  const refused = (settings: unknown): string => {
    try {
      assertEffortSettings(settings, (path, message) => {
        throw new Error(`${path}: ${message}`);
      });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("accepted");
  };
  assert.doesNotThrow(() =>
    assertEffortSettings({ "*": { ceiling: "high" }, "codex:gpt-6-luna": { floor: "low", levels: { low: "low" } }, claude: { levels: { max: "max" } } }, () => {
      throw new Error("refused");
    })
  );
  assert.match(refused({ "*": { levels: { low: "low" } } }), /^\*\.levels: served levels belong to an engine/);
  assert.match(refused({ codex: { levels: {} } }), /^codex\.levels: must be a non-empty/);
  assert.match(refused({ codex: { ceiling: "medium", floor: "high" } }), /^codex: floor high is above ceiling medium/);
  assert.match(refused({ codex: { ceiling: "ultra" } }), /^codex\.ceiling: must be one of/);
  assert.match(refused({ codex: { ceilng: "high" } }), /^codex\.ceilng: unknown field/);
  assert.match(refused({ "codex:": {} }), /^codex:: an engine:model key must name its model/);
  assert.match(refused({ gemini: {} }), /^gemini: target keys are/);
  // A map may not send Claude a name its CLI would silently default on.
  assert.match(refused({ claude: { levels: { high: "bogus" } } }), /^claude\.levels\.high: the Claude CLI runs an unknown --effort at its default/);
  // opencode is dispatched as given, so a key for it configures nothing.
  assert.match(refused({ opencode: { ceiling: "high" } }), /^opencode: opencode dispatches are not resolved/);
  assert.match(refused({ "opencode:glm": { levels: { low: "fast" } } }), /^opencode:glm: opencode dispatches are not resolved/);
});
