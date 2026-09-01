/* global clearTimeout, process, setTimeout */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  const record = await waitForOpenHold(directory);
  assert.equal(record.content, "must fail red", "the fixture must publish the manufactured open hold before it fails");
  context.after(async () => {
    const rejected = assert.rejects(decision, HoldRejectedError);
    try {
      holds.close();
      await requireRejectionWithin(rejected, record);
      const marker = process.env.ENSEMBLE_FAILED_HOLD_CLEANUP_MARKER;
      if (marker !== undefined) await writeFile(marker, "published-and-rejected\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  assert.fail("seeded assertion failure");
});

async function waitForOpenHold(directory) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      const names = await readdir(path.join(directory, "shared"));
      const hold = names.find((name) => name.endsWith(".json") && !name.endsWith(".decision.json"));
      if (hold !== undefined) return JSON.parse(await readFile(path.join(directory, "shared", hold), "utf8"));
    } catch {
      // The asynchronous raise has not published its decision file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("the fixture did not publish its manufactured open hold within 500ms");
}

async function requireRejectionWithin(expected, record) {
  let timer;
  try {
    await Promise.race([
      expected,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("close() did not reject the manufactured open hold within 500ms")), 500);
      })
    ]);
  } catch (error) {
    await writeFile(record.decision_path, JSON.stringify({ nonce: record.nonce, verdict: record.verdicts[0] }));
    await expected.catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
