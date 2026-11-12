import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { classifySupervisorTransition, daemonPid, supervisorLifecycle, supervisorSnapshot } from "../live/claude-proof-support.js";
import {
  SUITE_CLAUDE_DAEMON_RECORD_ENV,
  establishSuiteClaudeDaemon,
  publishSuiteClaudeDaemon,
  suiteClaudeDaemon
} from "../live/suite-claude-daemon.js";
import { waitForCondition } from "../wait-for-condition.js";

/**
 * The daemon commands of the Claude CLI the suite fixture uses, over a real
 * process: `daemon run` is a foreground process that logs its start, serves
 * until SIGTERM and logs its shutdown, and `daemon status` reports its pid
 * while it lives. A `refuse-start` file in the home makes `daemon run` fail.
 */
const standInClaude = `#!/bin/sh
home="$CLAUDE_CONFIG_DIR"
case "$*" in
  --version) printf '2.1.322 (Claude Code)\\n' ;;
  "daemon status")
    pid=$(cat "$home/daemon.pid" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      printf 'pid:     %s\\n' "$pid"
    else
      printf 'not running\\n'
      exit 1
    fi ;;
  "daemon run")
    [ -e "$home/refuse-start" ] && exit 3
    printf '[now] [supervisor] daemon start version=2.1.322 pid=%s origin=foreground\\n' "$$" >> "$home/daemon.log"
    printf '%s' "$$" > "$home/daemon.pid"
    trap 'printf "[now] [supervisor] shutting down (cause=signal, uptime=1s, leases=0, live_workers=0)\\n" >> "$home/daemon.log"; exit 0' TERM
    while :; do sleep 0.05; done ;;
esac
`;

interface Machine {
  root: string;
  home: string;
  executable: string;
  env: NodeJS.ProcessEnv;
}

async function machine(run: (machine: Machine) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "suite-claude-daemon-test-"));
  const home = path.join(root, "claude-home");
  const bin = path.join(root, "bin");
  const executable = path.join(bin, "claude");
  await mkdir(home);
  await mkdir(bin);
  await writeFile(executable, standInClaude, { mode: 0o755 });
  try {
    await run({ root, home, executable, env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, CLAUDE_CONFIG_DIR: home } });
  } finally {
    delete process.env[SUITE_CLAUDE_DAEMON_RECORD_ENV];
    await rm(root, { recursive: true, force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a home with no daemon gets one the suite starts, a consumer reads its baseline, and release ends that process", async () => {
  await machine(async ({ root, home, executable, env }) => {
    const suite = await establishSuiteClaudeDaemon({ env, cwd: root, scratch: root });
    try {
      await publishSuiteClaudeDaemon(suite.record, root);

      // A consumer, in a test file of its own, starts from the published
      // record: it never starts a daemon for this home or reads a first
      // identity of its own.
      const daemon = await suiteClaudeDaemon();
      assert.ok(daemon.origin === "started", JSON.stringify(daemon));
      assert.equal(daemon.home, home);
      assert.equal(isRunning(daemon.baseline.identity.pid), true);
      // Its later observations continue the baseline's own log offset, so
      // both ends of a comparison read the same lifecycle rows.
      const later = await supervisorSnapshot(executable, env, daemon.baseline.offset);
      assert.equal(
        classifySupervisorTransition(daemon.baseline.identity, later.identity, daemon.baseline.lifecycle, later.lifecycle),
        "unchanged"
      );
      assert.equal(later.lifecycle.filter((row) => row.event === "start").length, 1, "the home saw more than one startup");

      assert.deepEqual(await suite.release(), { outcome: "stopped", exit: { code: 0, signal: null, error: null } });
      assert.equal(isRunning(daemon.baseline.identity.pid), false);
      assert.equal((await supervisorLifecycle(home)).at(-1)?.cause, "signal");
    } finally {
      await suite.release();
    }
  });
});

test("a daemon already serving the home is the operator's: recorded as existing, never restarted and never stopped", async () => {
  await machine(async ({ root, home, executable, env }) => {
    const operator = spawn(executable, ["daemon", "run"], { env, stdio: "ignore" });
    const operatorExited = new Promise((resolve) => operator.once("exit", resolve));
    try {
      await waitForCondition(async () => (await daemonPid(executable, env)) !== null, "the operator's daemon to serve", 20_000);

      const suite = await establishSuiteClaudeDaemon({ env, cwd: root, scratch: root });
      assert.ok(suite.record.origin === "existing", JSON.stringify(suite.record));
      assert.equal(suite.record.baseline.identity.pid, operator.pid);
      assert.deepEqual(await suite.release(), { outcome: "not-owned" });
      assert.equal(operator.exitCode, null, "releasing the suite ended the operator's daemon");
      assert.equal((await supervisorLifecycle(home)).filter((row) => row.event === "start").length, 1, "the suite attempted a startup of its own");
    } finally {
      operator.kill("SIGTERM");
      await operatorExited;
    }
  });
});

test("a daemon that cannot be established is recorded with the attempt's evidence, not as an identity", async () => {
  await machine(async ({ root, home, env }) => {
    await writeFile(path.join(home, "refuse-start"), "");
    const failed = await establishSuiteClaudeDaemon({ env, cwd: root, scratch: root });
    assert.ok(failed.record.origin === "unavailable", JSON.stringify(failed.record));
    assert.deepEqual(failed.record.attempt.exit, { code: 3, signal: null, error: null });
    assert.equal(failed.record.attempt.status?.code, 1);
    assert.equal(failed.record.attempt.status?.pid, null);
    assert.deepEqual(await failed.release(), { outcome: "not-owned" });

    const absent = await establishSuiteClaudeDaemon({ env: { ...env, PATH: root }, cwd: root, scratch: root });
    assert.ok(absent.record.origin === "unavailable", JSON.stringify(absent.record));
    assert.match(absent.record.attempt.reason, /claude not found on PATH/);
    assert.equal(absent.record.attempt.status, null);
  });
});

test("a consumer with no published record is told how the suite establishes one", async () => {
  delete process.env[SUITE_CLAUDE_DAEMON_RECORD_ENV];
  await assert.rejects(suiteClaudeDaemon(), /run-test-suite\.mjs with ENSEMBLE_LIVE=1/);
});
