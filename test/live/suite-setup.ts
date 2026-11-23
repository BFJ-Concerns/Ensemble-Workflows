import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveAmbientSettings } from "../../src/ambient-settings.js";
import { CodexAppServerTransport } from "../../src/app-server.js";

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
 * of them can own it. The setup tears down only what it started and
 * reports unavailable resources so tests for other engines can still run.
 */
let scratch: string | undefined;
let claudeDaemon: SuiteClaudeDaemonHandle | undefined;

export async function globalSetup(): Promise<void> {
  try {
    scratch = await mkdtemp(path.join(tmpdir(), "ensemble-live-suite-"));
    await initialiseCodexState();
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

async function initialiseCodexState(): Promise<void> {
  // The live files open independent app-servers against the same home.
  // Finish the first SQLite initialisation before they can contend for it.
  // The handshake needs neither a thread nor a model request.
  const cwd = process.cwd();
  const workerEnv = resolveAmbientSettings({ env: process.env, cwd }).workerEnvironment.codex;
  try {
    const transport = await CodexAppServerTransport.start({
      cwd,
      codexBin: "codex",
      ...(workerEnv !== undefined ? { workerEnv } : {}),
      clientName: "ensemble-live-suite",
      clientVersion: "1",
      requestTimeoutMs: 15_000
    });
    await transport.close();
    report("codex state", { outcome: "ready" });
  } catch (error) {
    // Codex tests still report their own startup errors. This event can
    // reach logs even for a Claude-only run, so omit raw engine output.
    report("codex state", { outcome: "unavailable", error: error instanceof Error ? error.name : "unknown" });
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
