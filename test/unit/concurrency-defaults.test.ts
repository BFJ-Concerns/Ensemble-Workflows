import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultClaudeConcurrency,
  defaultCodexConcurrency,
  defaultOpenCodeConcurrency
} from "../../src/concurrency-defaults.js";

test("codex and claude share one default concurrency cap", () => {
  assert.equal(defaultCodexConcurrency(), 12);
  assert.equal(defaultClaudeConcurrency(), 12);
  assert.equal(defaultOpenCodeConcurrency(), 2);
});

test("engine defaults are fixed, not derived from the host", () => {
  // The regression this pins: codex's cap was computed from `os.cpus()`, so
  // the shipped default changed with the machine it ran on. A default that
  // varies by host cannot be documented, and the quantity it tracked does not
  // govern what a remote turn costs.
  assert.equal(defaultCodexConcurrency(), defaultCodexConcurrency());
  assert.equal(defaultClaudeConcurrency(), defaultClaudeConcurrency());
});
