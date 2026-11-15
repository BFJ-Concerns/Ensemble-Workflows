import assert from "node:assert/strict";
import test from "node:test";

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
