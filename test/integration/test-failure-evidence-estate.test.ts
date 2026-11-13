import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertNotInsideSuiteSpawningTest, runNode, SUITE_SPAWNING_TEST_MARKER } from "./estate-process.js";

for (const store of ["private", "suite"] as const) {
  for (const [failed, optedIn] of [[true, true], [true, false], [false, true]] as const) {
    test(`${store} test archives ${failed && optedIn ? "survive failure and later recovery" : "are cleaned"} (failed=${failed}, evidence=${optedIn})`, { timeout: 30_000 }, async () => {
      assertNotInsideSuiteSpawningTest();
      const directory = await mkdtemp(path.join(tmpdir(), "ensemble-failure-evidence-estate-"));
      try {
        const temporary = path.join(directory, "temporary");
        await mkdir(temporary);
        const env = {
          NODE_TEST_CONTEXT: undefined,
          TMPDIR: temporary,
          ENSEMBLE_RUN_RECORD_DIR: undefined,
          ENSEMBLE_LIVE_FAILURE_EVIDENCE: optedIn ? "1" : undefined,
          ENSEMBLE_TEST_EVIDENCE_ROOT: directory,
          ENSEMBLE_TEST_EVIDENCE_STORE: store,
          ENSEMBLE_TEST_EVIDENCE_FAIL: failed ? "1" : undefined,
          [SUITE_SPAWNING_TEST_MARKER]: "test-failure-evidence-estate.test"
        };
        const result = await runNode(["scripts/run-test-suite.mjs", "test/fixtures/test-failure-evidence.mjs"], env, 15_000);
        assert.equal(result.code, failed ? 1 : 0, result.stdout + result.stderr);
        const announcement = /\[run-record-archive\] (\{[^\n]+\})/.exec(result.stdout + result.stderr);
        assert.ok(announcement, result.stdout + result.stderr);
        const archive = (JSON.parse(announcement[1]!) as { archive_path: string }).archive_path;
        await assert.rejects(access(path.join(directory, "private", "private-settings.json")), { code: "ENOENT" });
        if (failed && optedIn) {
          assert.equal(await readFile(path.join(archive, "manifest.json"), "utf8"), '{"status":"failed"}\n');
          assert.equal(await readFile(path.join(archive, "transcript.jsonl"), "utf8"), "fixture transcript\n");
          // A later invocation's dead-suite sweep must respect retained evidence,
          // even when that invocation has not opted in to evidence retention.
          const recoveryRoot = path.join(directory, "recovery");
          await mkdir(recoveryRoot);
          const recovery = await runNode(["scripts/run-test-suite.mjs", "test/fixtures/test-failure-evidence.mjs"], {
            ...env, ENSEMBLE_TEST_EVIDENCE_ROOT: recoveryRoot, ENSEMBLE_TEST_EVIDENCE_STORE: "private",
            ENSEMBLE_TEST_EVIDENCE_FAIL: undefined, ENSEMBLE_LIVE_FAILURE_EVIDENCE: undefined
          }, 15_000);
          assert.equal(recovery.code, 0, recovery.stdout + recovery.stderr);
          assert.equal(await readFile(path.join(archive, "transcript.jsonl"), "utf8"), "fixture transcript\n");
        } else {
          await assert.rejects(access(archive), { code: "ENOENT" });
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
