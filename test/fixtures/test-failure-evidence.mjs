import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { removeTestDirectory } from "../../dist/test/failure-evidence.js";

test("controlled archive evidence", async () => {
  const directory = path.join(process.env.ENSEMBLE_TEST_EVIDENCE_ROOT, "private");
  const store = process.env.ENSEMBLE_TEST_EVIDENCE_STORE === "suite"
    ? process.env.ENSEMBLE_RUN_RECORD_DIR : path.join(directory, "records");
  const archive = path.join(store, "fixture-run");
  let testFailed = false;
  try {
    await mkdir(archive, { recursive: true });
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "private-settings.json"), "fixture settings");
    await writeFile(path.join(archive, "manifest.json"), '{"status":"failed"}\n');
    await writeFile(path.join(archive, "transcript.jsonl"), "fixture transcript\n");
    process.stderr.write(`[run-record-archive] ${JSON.stringify({ run_id: "fixture-run", archive_path: archive })}\n`);
    if (process.env.ENSEMBLE_TEST_EVIDENCE_FAIL === "1") throw new Error("controlled test failure");
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await removeTestDirectory(directory, testFailed);
  }
});
