import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveAmbientSettings } from "../../src/ambient-settings.js";
import { launchEnvironment } from "../../src/engine-environment.js";
import { claudeConfigDirectory } from "../../src/engine-resources.js";

import { daemonStatus, selectClaudeExecutable, supervisorSnapshot } from "./claude-proof-support.js";

/**
 * The live suite's shared Claude daemon.
 *
 * Live test files run in parallel, and several dispatch Claude workers
 * through the machine's ambient Claude config home. Claude Code starts that
 * home's daemon on demand, so with none serving, each file's launcher races
 * the others to start one, and a test observing the home sees startup
 * attempts it cannot tell from a replacement. The suite therefore settles
 * the home's daemon once, before any test file starts (`suite-setup.ts`),
 * and publishes what it found as a record every test file reads with
 * `suiteClaudeDaemon()`:
 *
 * - `existing`: a daemon was already serving the home. It is the
 *   operator's. The suite never signals or stops it.
 * - `started`: none was serving, so the suite started one and keeps it for
 *   the whole run. This is the only daemon the suite owns, and `release()`
 *   ends that one process and nothing else.
 * - `unavailable`: no serving daemon could be established. The record
 *   carries the attempt's evidence. It is not a daemon identity, so it is
 *   never a baseline, and a test that needs one fails on it by name.
 *
 * Ownership is the child process the suite spawned, never the home: a
 * daemon that replaces the suite's own (an upgrade restart, a later
 * on-demand start) is not the suite's and is left running.
 *
 * A proof whose subject is daemon startup itself, such as where a
 * launcher-started supervisor is placed, uses a private config home of its
 * own. The suite touches only the ambient home, so that proof's launcher
 * still performs the startup it measures, and the proof stops its own
 * daemon.
 */
export type SuiteClaudeDaemon =
  | { home: string; origin: "existing" | "started"; baseline: ServingDaemonSnapshot }
  | { home: string; origin: "unavailable"; attempt: DaemonStartAttempt };

type DaemonSnapshot = Awaited<ReturnType<typeof supervisorSnapshot>>;

/**
 * A snapshot that names a live daemon process: its pid, the start ticks
 * that tell it from a later process reusing the pid, and its cgroup. The
 * version is the daemon's own start line in its log and is empty where the
 * log no longer holds that line.
 */
export type ServingDaemonSnapshot = DaemonSnapshot & { identity: { pid: number; startTicks: string; cgroup: string } };

/** A snapshot with no pid, or one whose process was gone before it could be read, identifies nothing. */
export function isServingSnapshot(snapshot: DaemonSnapshot): snapshot is ServingDaemonSnapshot {
  return snapshot.identity.pid !== null && snapshot.identity.startTicks !== null && snapshot.identity.cgroup !== null;
}

/** How a process the suite spawned ended; `error` is set where it could not be spawned at all. */
export interface DaemonProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
}

/** What is known about an attempt that established no serving daemon. */
export interface DaemonStartAttempt {
  reason: string;
  /** The last `claude daemon status` read, with its exit status and output; null where no executable was found to ask. */
  status: Awaited<ReturnType<typeof daemonStatus>> | null;
  /** How the suite's own `claude daemon run` ended; null where it was never spawned. */
  exit: DaemonProcessExit | null;
}

/** What `release()` did. Only a `started` daemon is ever signalled. */
export type SuiteClaudeDaemonRelease =
  | { outcome: "not-owned" }
  | { outcome: "stopped" | "killed" | "exited-earlier"; exit: DaemonProcessExit };

export interface SuiteClaudeDaemonHandle {
  record: SuiteClaudeDaemon;
  /** Ends the daemon process this handle started, if it started one and that process still runs. */
  release(): Promise<SuiteClaudeDaemonRelease>;
}

/** Names the published record's file in every test file's environment. */
export const SUITE_CLAUDE_DAEMON_RECORD_ENV = "ENSEMBLE_LIVE_SUITE_CLAUDE_DAEMON";

const startPollMilliseconds = 50;
const defaultStartTimeoutMilliseconds = 20_000;
const stopGraceMilliseconds = 15_000;

/**
 * The environment the product's own `claude` commands run in on this
 * machine: the inherited one under the machine configuration's Claude
 * worker declarations. The ambient config home is the one this environment
 * resolves, so the suite and every consumer read the same daemon.
 */
export function suiteClaudeEnvironment(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): NodeJS.ProcessEnv {
  return launchEnvironment("claude", resolveAmbientSettings({ env, cwd }).workerEnvironment.claude, env);
}

/**
 * Settles the daemon for the config home `env` resolves, once. A daemon
 * that cannot be established is a record, not an error, so one missing
 * engine never stops the other engines' tests from running.
 *
 * `scratch` is a directory the caller owns. The started daemon is a child
 * in the caller's process group, with no pipe to it, so ending that group
 * ends the daemon and the daemon never holds the caller's output open.
 */
export async function establishSuiteClaudeDaemon(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  scratch: string;
  startTimeoutMs?: number;
}): Promise<SuiteClaudeDaemonHandle> {
  const { env, cwd } = options;
  const home = claudeConfigDirectory(env, cwd);
  const unavailable = (attempt: DaemonStartAttempt): SuiteClaudeDaemonHandle => ({
    record: { home, origin: "unavailable", attempt },
    release: () => Promise.resolve({ outcome: "not-owned" })
  });

  let executable: string;
  try {
    const selected = await selectClaudeExecutable("claude", options.scratch, env);
    await selected.dispose();
    executable = selected.executable;
  } catch (error) {
    return unavailable({ reason: error instanceof Error ? error.message : String(error), status: null, exit: null });
  }

  let status = await daemonStatus(executable, env);
  let spawned: { child: ChildProcess; exited: Promise<DaemonProcessExit> } | null = null;
  let exit: DaemonProcessExit | null = null;
  if (servingPid(status) === null) {
    // The one startup this home gets. A foreground `claude daemon run` is
    // itself the serving process, so the pid status reports says whether
    // this child won the home or another daemon did.
    const child = spawn(executable, ["daemon", "run"], { env, cwd, stdio: "ignore" });
    const exited = new Promise<DaemonProcessExit>((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
      child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
    });
    spawned = { child, exited };
    const deadline = Date.now() + (options.startTimeoutMs ?? defaultStartTimeoutMilliseconds);
    while (servingPid(status) === null && exit === null && Date.now() < deadline) {
      exit = await within(exited, startPollMilliseconds);
      // Read after the wait, so a child that has ended is judged on a
      // status taken once its outcome was final.
      status = await daemonStatus(executable, env);
    }
  }

  const serving = servingPid(status);
  const owned = spawned !== null && serving !== null && serving === spawned.child.pid ? spawned : null;
  if (spawned !== null && owned === null) {
    // The suite's child serves nothing: it lost the home to another daemon,
    // failed, or never came up. It is the suite's own process either way.
    exit = (await endProcess(spawned.child, spawned.exited)).exit;
  }
  if (serving === null) {
    return unavailable({
      reason: exit === null ? "claude daemon run was not serving within the start timeout" : "claude daemon run ended without serving",
      status,
      exit
    });
  }

  const baseline = await supervisorSnapshot(executable, env, "current");
  if (!isServingSnapshot(baseline) || baseline.identity.pid !== serving) {
    if (owned !== null) exit = (await endProcess(owned.child, owned.exited)).exit;
    return unavailable({ reason: "the serving daemon ended or changed before its identity was read", status, exit });
  }
  if (owned === null) {
    return { record: { home, origin: "existing", baseline }, release: () => Promise.resolve({ outcome: "not-owned" }) };
  }
  return {
    record: { home, origin: "started", baseline },
    release: async () => {
      if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
        return { outcome: "exited-earlier", exit: await owned.exited };
      }
      const ended = await endProcess(owned.child, owned.exited);
      return { outcome: ended.forced ? "killed" : "stopped", exit: ended.exit };
    }
  };
}

/** Writes the record into `directory` and names it for every process started after this call. */
export async function publishSuiteClaudeDaemon(record: SuiteClaudeDaemon, directory: string): Promise<void> {
  const file = path.join(directory, "claude-daemon.json");
  await writeFile(file, `${JSON.stringify(record)}\n`);
  process.env[SUITE_CLAUDE_DAEMON_RECORD_ENV] = file;
}

/**
 * The record the suite published before this test file started. Call it
 * inside the test that needs it, so a file's other tests still run where
 * no suite established one.
 */
export async function suiteClaudeDaemon(): Promise<SuiteClaudeDaemon> {
  const file = process.env[SUITE_CLAUDE_DAEMON_RECORD_ENV];
  if (file === undefined) {
    throw new Error(
      `${SUITE_CLAUDE_DAEMON_RECORD_ENV} is unset: no live suite established the shared Claude daemon. ` +
        "Run live test files through scripts/run-test-suite.mjs with ENSEMBLE_LIVE=1, which establishes it before the first file starts."
    );
  }
  return JSON.parse(await readFile(file, "utf8")) as SuiteClaudeDaemon;
}

function servingPid(status: Awaited<ReturnType<typeof daemonStatus>>): number | null {
  return status.code === 0 ? status.pid : null;
}

/** SIGTERM, then SIGKILL after the grace period. For processes this module spawned only. */
async function endProcess(child: ChildProcess, exited: Promise<DaemonProcessExit>): Promise<{ exit: DaemonProcessExit; forced: boolean }> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const graceful = await within(exited, stopGraceMilliseconds);
  if (graceful !== null) return { exit: graceful, forced: false };
  child.kill("SIGKILL");
  return { exit: await exited, forced: true };
}

/** The promise's value, or null once `milliseconds` pass first. Leaves no timer behind. */
function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), milliseconds);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
