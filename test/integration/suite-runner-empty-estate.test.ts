import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertNotInsideSuiteSpawningTest, runNode, SUITE_SPAWNING_TEST_MARKER } from "./estate-process.js";

const runnerPath = path.resolve("scripts/run-test-suite.mjs");

test("suite runner rejects an empty test tree after its real Node test consumer reports zero tests", async () => {
  assertNotInsideSuiteSpawningTest();
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-empty-suite-estate-"));
  const emptyTree = path.join(directory, "empty");
  try {
    await mkdir(emptyTree);
    const result = await runNode([runnerPath, path.join(emptyTree, "**/*.test.js")], {
      NODE_TEST_CONTEXT: undefined,
      FORCE_COLOR: "3",
      [SUITE_SPAWNING_TEST_MARKER]: "suite-runner-empty-estate.test"
    });

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /(?:^|\n)# tests 0(?:\n|$)/);
    assert.equal(result.stderr, "Test suite matched no tests\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
