import assert from "node:assert/strict";
import test from "node:test";

import { runNode } from "./estate-process.js";

test("the disabled live suite publishes a reason for every TAP skip", async () => {
  const result = await runNode([
    "--test", "--test-reporter=tap", "dist/test/live/**/*.live.test.js"
  ], { NODE_TEST_CONTEXT: undefined }, 60_000);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const skips = result.stdout.split("\n").filter(line => /# SKIP\b/.test(line));
  assert.ok(skips.length > 0, result.stdout);
  for (const line of skips) assert.match(line, /# SKIP \S.+/, line);
  assert.match(result.stdout, /partial opencode text.*# SKIP ENSEMBLE_LIVE must be 1/);
});

test("partial-output live skips explain the destructive opt-in even with models set", async () => {
  const result = await runNode([
    "--test", "--test-reporter=tap", "dist/test/live/failure-evidence.live.test.js"
  ], {
    NODE_TEST_CONTEXT: undefined, ENSEMBLE_LIVE: "1",
    ENSEMBLE_LIVE_CODEX_MODEL: "diagnostic-codex-model",
    ENSEMBLE_LIVE_OPENCODE_MODEL: "diagnostic-opencode-model"
  }, 10_000);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  for (const engine of ["claude", "opencode"]) {
    assert.match(result.stdout, new RegExp(`partial ${engine} text.*# SKIP ENSEMBLE_LIVE_FAILURE_EVIDENCE must be 1`));
  }
});

test("an opted-in opencode partial-output skip names the missing model", async () => {
  const result = await runNode([
    "--test", "--test-reporter=tap", "--test-name-pattern=partial opencode text",
    "dist/test/live/failure-evidence.live.test.js"
  ], {
    NODE_TEST_CONTEXT: undefined, ENSEMBLE_LIVE: "1", ENSEMBLE_LIVE_FAILURE_EVIDENCE: "1"
  }, 10_000);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /partial opencode text.*# SKIP ENSEMBLE_LIVE_OPENCODE_MODEL is unset/);
});

for (const model of [undefined, "   "]) {
  test(`live Codex prerequisites skip consistently with ${model === undefined ? "an unset" : "a blank"} model`, async () => {
    const result = await runNode([
      "--test", "--test-reporter=tap",
      "--test-name-pattern=built launcher scopes: (?!direct claude$|unreachable manager claude$)|live codex status alone|current Codex model",
      "dist/test/live/worker-scopes.live.test.js",
      "dist/test/live/live-status.live.test.js",
      "dist/test/live/script-surface.live.test.js"
    ], {
      NODE_TEST_CONTEXT: undefined, ENSEMBLE_LIVE: "1", ENSEMBLE_LIVE_CODEX_MODEL: model
    }, 15_000);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const skipped = result.stdout.split("\n").filter(line => /# SKIP ENSEMBLE_LIVE_CODEX_MODEL is unset/.test(line));
    assert.equal(skipped.length, 10, result.stdout);
    assert.doesNotMatch(result.stdout, /UNPROVEN|not ok/);
  });
}
