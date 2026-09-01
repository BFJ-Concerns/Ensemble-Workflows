/* global process */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { HoldRejectedError } from "../../../dist/src/errors.js";
import { HoldManager } from "../../../dist/src/holds.js";

test("a seeded assertion failure closes its pending hold", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-failed-hold-test-"));
  const holds = new HoldManager({
    dir: directory,
    runId: "failed-hold-test",
    cwd: process.cwd(),
    scope: null,
    pollIntervalMs: 5
  });
  const decision = holds.raise({ content: "must fail red", verdicts: ["ok"] });
  const rejected = assert.rejects(decision, HoldRejectedError);
  context.after(async () => {
    holds.close();
    await rejected;
    await rm(directory, { recursive: true, force: true });
  });

  assert.fail("seeded assertion failure");
});
