import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  establishSuiteClaudeDaemon,
  publishSuiteClaudeDaemon,
  suiteClaudeEnvironment,
  type SuiteClaudeDaemonHandle
} from "./suite-claude-daemon.js";

/**
 * The live suite's lifetime: what must exist before the first test file
 * starts and outlive the last. Node's test runner evaluates this module
 * once, in the process that spawns the test files, calling `globalSetup`
 * before any of them and `globalTeardown` after all of them
 * (`--test-global-setup`). `scripts/run-test-suite.mjs` passes it whenever
 * ENSEMBLE_LIVE is 1, for the whole suite and for a single file alike.
 *
 * A fixture belongs here only when parallel test files share it and none
 * of them can own it. Each one publishes what it established as a record
 * the test files read, tears down only what it started, and reports a
 * resource it could not establish in that record instead of throwing, so
 * the tests that do not need it still run.
 */
let scratch: string | undefined;
let claudeDaemon: SuiteClaudeDaemonHandle | undefined;

export async function globalSetup(): Promise<void> {
  try {
    scratch = await mkdtemp(path.join(tmpdir(), "ensemble-live-suite-"));
    claudeDaemon = await establishSuiteClaudeDaemon({ env: suiteClaudeEnvironment(), cwd: process.cwd(), scratch });
    await publishSuiteClaudeDaemon(claudeDaemon.record, scratch);
    const { record } = claudeDaemon;
    report("claude daemon", {
      home: record.home,
      origin: record.origin,
      ...(record.origin === "unavailable" ? { attempt: record.attempt } : { identity: record.baseline.identity })
    });
  } catch (error) {
    // Node runs no teardown after a failed setup.
    await globalTeardown();
    throw error;
  }
}

export async function globalTeardown(): Promise<void> {
  try {
    if (claudeDaemon !== undefined) report("claude daemon released", await claudeDaemon.release());
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  }
}

/** One stderr line per event, so a suite's own capture says what it started and what it stopped. */
function report(event: string, detail: unknown): void {
  process.stderr.write(`[live-suite] ${event}: ${JSON.stringify(detail)}\n`);
}
