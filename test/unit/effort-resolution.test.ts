import assert from "node:assert/strict";
import test from "node:test";

import type { EffortDispatch } from "../../src/effort-resolution.js";
import { builtInServedLevels } from "../../src/built-in-effort-levels.js";
import { assertEffortSection, effortPolicyKeys } from "../../src/effort-resolution.js";
import { EffortBoundsUnservedError, PreSpawnAuthorError } from "../../src/errors.js";

/** The section's refusal as a door would raise it: the path and the reason, in one message. */
function refusalOf(section: unknown): string | null {
  try {
    assertEffortSection(section, (path, detail) => {
      throw new Error(`${path}: ${detail}`);
    });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

test("a target's effort keys run from its model, through its engine, to every dispatch", () => {
  assert.deepEqual(effortPolicyKeys("codex", "gpt-6-luna"), ["codex:gpt-6-luna", "codex", "*"]);
  assert.deepEqual(effortPolicyKeys("claude", undefined), ["claude", "*"]);
});

test("an effort section of bounds and one model's levels is accepted as written", () => {
  assert.equal(
    refusalOf({
      "*": { ceiling: "xhigh" },
      codex: { floor: "low", ceiling: "low" },
      "opencode:local:coder": { levels: { low: "low", high: "think" } }
    }),
    null
  );
  assert.equal(refusalOf({}), null);
});

test("an effort section is refused at the path that breaks its shape", () => {
  const refused: Array<[unknown, RegExp]> = [
    [[], /^: must be a JSON object/],
    [{ gemini: {} }, /^gemini: target keys are/],
    [{ "*:model": {} }, /^\*:model: target keys are/],
    [{ "codex:": {} }, /^codex:: an engine:model key must name its model/],
    [{ codex: "high" }, /^codex: must be a JSON object/],
    [{ codex: { cap: "high" } }, /^codex\.cap: unknown field/],
    [{ codex: { ceiling: "ultra" } }, /^codex\.ceiling: must be one of/],
    [{ "*": { floor: "high", ceiling: "low" } }, /^\*: floor high is above ceiling low/],
    [{ codex: { levels: { low: "low" } } }, /^codex\.levels: served levels belong to one model/],
    [{ "codex:m": { levels: {} } }, /^codex:m\.levels: must be a non-empty JSON object/],
    [{ "codex:m": { levels: { ultra: "ultra" } } }, /^codex:m\.levels\.ultra: levels are keyed by canonical level/],
    [{ "codex:m": { levels: { low: "" } } }, /^codex:m\.levels\.low: must be the non-empty native name/]
  ];
  for (const [section, expected] of refused) {
    assert.match(refusalOf(section) ?? "accepted", expected, JSON.stringify(section));
  }
});

test("the built-in table does not know a model it has no row for", () => {
  assert.equal(builtInServedLevels("a-model-nobody-measured"), undefined);
  assert.equal(builtInServedLevels("constructor"), undefined);
});

test("an effort bounds refusal is a pre-spawn rejection naming each bound's key, the model and the file", () => {
  const error = new EffortBoundsUnservedError({
    engine: "codex",
    model: "gpt-6-luna",
    requested: "minimal",
    bounds: { ceiling: { level: "minimal", key: "*" }, floor: null },
    served: ["low", "medium", "high"],
    source: "/machine/ensemble/config.json"
  });
  assert.ok(error instanceof PreSpawnAuthorError);
  assert.equal(
    error.message,
    "effort \"minimal\" cannot be served on codex model \"gpt-6-luna\": the machine's ceiling minimal (effort key \"*\") " +
      "in /machine/ensemble/config.json admits none of the levels the model serves (low | medium | high). " +
      "The worker was not dispatched. Move the bound, or declare the model's served levels in the effort section."
  );
});

async function resolution(overrides: Partial<EffortDispatch> = {}) {
  const { resolveEffort } = await import("../../src/effort-resolution.js");
  return resolveEffort({ requested: "minimal", engine: "codex", model: "gpt-6-luna", identity: "gpt-6-luna", policy: null,
    engineReport: async () => { throw new Error("known model must not read the listing"); }, ...overrides });
}

test("the built-in table makes unlisted none reachable and clamps minimal down on a tie", async () => {
  for (const requested of ["none", "minimal"] as const) {
    const result = await resolution({ requested });
    assert.equal(result.dispatched, "none");
    assert.deepEqual(result.served, { source: "built-in-table", level: "none" });
  }
});

test("machine maps replace the built-in set whole and convert native names", async () => {
  const result = await resolution({ policy: { source: "machine.json", section: {
    "codex:gpt-6-luna": { levels: { low: "quiet", high: "think" } }
  } } });
  assert.equal(result.dispatched, "quiet");
  assert.deepEqual(result.served, { source: "machine-map", level: "low" });
});

test("a sparse served set is clamped inside independently inherited bounds", async () => {
  const result = await resolution({ requested: "max", policy: { source: "machine.json", section: {
    "*": { ceiling: "high", floor: "none" }, codex: { floor: "minimal" },
    "codex:gpt-6-luna": { floor: "medium", levels: { low: "quiet", medium: "normal", max: "all" } }
  } } });
  assert.equal(result.dispatched, "normal");
  assert.deepEqual(result.bounds, { ceiling: { key: "*", level: "high" }, floor: { key: "codex:gpt-6-luna", level: "medium" } });
});

test("impossible bounds refuse with model, file and both independent keys", async () => {
  await assert.rejects(resolution({ policy: { source: "machine.json", section: {
    "*": { ceiling: "minimal" }, "codex:gpt-6-luna": { floor: "low" }
  } } }), (error: unknown) => {
    assert.ok(error instanceof EffortBoundsUnservedError);
    for (const text of ["gpt-6-luna", "machine.json", '"*"', '"codex:gpt-6-luna"']) assert.ok(error.message.includes(text));
    return true;
  });
  await assert.rejects(resolution({ policy: { source: "machine.json", section: {
    "codex:gpt-6-luna": { floor: "minimal", ceiling: "minimal" }
  } } }), EffortBoundsUnservedError);
});

test("unknown models use engine reports, or bounded pass-through if unreported", async () => {
  const result = await resolution({ model: "unknown", identity: "unknown", engineReport: async () => ({ identity: "unknown", levels: { low: "quiet", high: "think" } }) });
  assert.equal(result.dispatched, "quiet");
  assert.deepEqual(result.served, { source: "engine-report", level: "low" });
  const pass = await resolution({ requested: "max", model: "unknown", identity: "unknown", engineReport: async () => null,
    policy: { source: "machine.json", section: { "*": { ceiling: "high" } } } });
  assert.equal(pass.dispatched, "high");
  assert.equal(pass.served, null);
});

test("unfixed and routed models use the built-in identity before the listing", async () => {
  const result = await resolution({ model: undefined, identity: undefined,
    engineReport: async () => ({ identity: "gpt-6-luna", levels: { high: "high" } }) });
  assert.equal(result.dispatched, "none");
  const routed = await resolution({ engine: "opencode", model: "route", identity: "gpt-6-luna" });
  assert.equal(routed.dispatched, "none");
});

test("ultra cannot enter through either a canonical key or a native map value", () => {
  assert.match(refusalOf({ "codex:m": { levels: { high: "ultra" } } }) ?? "accepted", /levels.high/);
});
