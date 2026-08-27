import assert from "node:assert/strict";
import test from "node:test";

import {
  assertValidStripOption,
  effectiveStrip,
  resolveStripEnforcement,
  STRIPPABLE_CAPABILITIES
} from "../../src/capability-stripping.js";
import { CapabilityStripUnsupportedError, InvalidAgentOptionValueError } from "../../src/errors.js";

import type { EngineCapabilityTable } from "../../src/capability-stripping.js";

test("the strip option accepts known capabilities and rejects everything else", () => {
  assertValidStripOption([]);
  assertValidStripOption([...STRIPPABLE_CAPABILITIES]);
  assertValidStripOption(["skills", "skills"]);
  assert.throws(() => assertValidStripOption("skills"), InvalidAgentOptionValueError);
  assert.throws(() => assertValidStripOption(["shells"]), InvalidAgentOptionValueError);
  assert.throws(() => assertValidStripOption([42]), InvalidAgentOptionValueError);
});

test("the effective strip is the deduplicated union of run-wide and per-call lists", () => {
  assert.deepEqual(effectiveStrip(undefined, undefined), []);
  assert.deepEqual(effectiveStrip(["agents"], undefined), ["agents"]);
  assert.deepEqual(effectiveStrip(undefined, ["skills"]), ["skills"]);
  assert.deepEqual(effectiveStrip(["agents"], ["skills", "agents"]), ["agents", "skills"]);
});

test("enforcement resolution returns routes for config and absent, and fails loud otherwise", () => {
  const table: EngineCapabilityTable = {
    skills: { route: "config", detail: "settings deny rules" },
    agents: { route: "unsupported", detail: "no measured route" }
  };
  assert.deepEqual(resolveStripEnforcement("claude", table, ["skills"]), {
    skills: { route: "config", detail: "settings deny rules" }
  });
  assert.throws(() => resolveStripEnforcement("claude", table, ["skills", "agents"]), CapabilityStripUnsupportedError);
  // No declared table fails closed: an adapter that never considered
  // stripping must not dispatch an unrestricted worker under a restriction.
  assert.throws(() => resolveStripEnforcement("opencode", undefined, ["skills"]), CapabilityStripUnsupportedError);
});
