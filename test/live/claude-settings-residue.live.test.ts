import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { removeTestDirectory } from "../failure-evidence.js";
import { resolveAmbientSettings } from "../../src/ambient-settings.js";
import { readProcessStartTicks } from "../../src/process-owner-evidence.js";
import { hermeticEstateEnvironment } from "../integration/estate-process.js";

const exec = promisify(execFile);
const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const live = process.env.ENSEMBLE_LIVE === "1";
interface Identity { pid: number; start: string; cwd: string; comm: string }
interface Run { child: ChildProcess; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }
interface Session { id: string; pid?: number; cwd: string }

// The settings sweep deliberately does not stop the daemon's orphaned sessions.
// Observe that boundary independently of process ancestry: the daemon, tmux and
// their workers can all outlive the launcher and reparent to the user manager.
test("Claude settings sweep preserves live owners and handled dispatch teardown leaves only the deliberately killed session", {
  skip: live ? false : "ENSEMBLE_LIVE must be 1", timeout: 300_000
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-settings-residue-"));
  const work = path.join(root, "work");
  const config = path.join(root, "claude");
  const xdg = path.join(root, "config");
  const temporary = path.join(root, "tmp");
  const bin = path.join(root, "bin");
  const runs: Run[] = [];
  let daemon: { pid: number; start: string } | undefined;
  const machine = resolveAmbientSettings({ env: process.env, cwd: process.cwd() });
  const workerEnv = { ...machine.workerEnvironment.claude, CLAUDE_CONFIG_DIR: config,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
  const env = hermeticEstateEnvironment({
    ...workerEnv, XDG_CONFIG_HOME: xdg, TMPDIR: temporary,
    ENSEMBLE_STATUS: "0", ENSEMBLE_RUN_RECORD: "0"
  });
  const workerProcesses = async (): Promise<Identity[]> => (await processes(work)).filter(row => daemon === undefined || row.pid !== daemon.pid || row.start !== daemon.start);
  const roster = async (): Promise<Session[]> => JSON.parse((await exec("claude", ["agents", "--json"], { env, timeout: 20_000 })).stdout) as Session[];
  let testFailed = false;
  try {
    for (const directory of [work, config, temporary, bin, path.join(xdg, "ensemble")]) await mkdir(directory, { recursive: true });
    await writeFile(path.join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
    await writeFile(path.join(config, "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }), { mode: 0o600 });
    await writeFile(path.join(xdg, "ensemble/config.json"), JSON.stringify({ schema_version: 1, worker_environment: { claude: workerEnv } }), { mode: 0o600 });
    const realTmux = (await exec("which", ["tmux"])).stdout.trim();
    // Hold one native valve after its server and attach client exist. A signal
    // then lands inside dispatch deterministically, rather than racing a poll.
    await writeFile(path.join(bin, "tmux"), `#!${process.execPath}
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2);
try { process.stdout.write(execFileSync(${JSON.stringify(realTmux)}, args)); }
catch (error) { process.exit(typeof error.status === 'number' ? error.status : 1); }
if (args.includes('new-session') && process.env.ENSEMBLE_TEST_VALVE_READY) {
  fs.writeFileSync(process.env.ENSEMBLE_TEST_VALVE_READY, 'ready');
  setInterval(() => {}, 1000);
}
`, { mode: 0o700 });
    assert.deepEqual(await roster(), [], "the private home already has sessions");
    const launch = async (name: string, holdValve = false): Promise<{ run: Run; cwd: string; ready: string }> => {
      const cwd = path.join(work, name);
      await mkdir(cwd);
      const ready = path.join(cwd, "registered");
      const script = path.join(cwd, "held.js");
      // The fixed opening is copied unchanged from the external re-drive.
      await writeFile(script, `export const meta = { name: "settings-residue" };
const worker = session({ engine: "claude", model: "claude-opus-5-5", effort: "low" });
await worker.send("Do not read or change files. Reply with exactly HELD_OK.");
require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'registered');
await new Promise(resolve => setTimeout(resolve, 60000));
await worker.close();
`);
      const child = spawn(process.execPath, [bundle, script], { cwd, env: {
        ...env, ...(holdValve ? { ENSEMBLE_TEST_VALVE_READY: path.join(cwd, "valve-ready") } : {})
      }, stdio: "ignore", detached: true });
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      const run = { child, exit };
      runs.push(run);
      return { run, cwd, ready };
    };
    const settings = async (): Promise<string[]> => {
      const directories = (await readdir(temporary)).filter(name => name.startsWith("ensemble-claude-env-"));
      const present: string[] = [];
      for (const directory of directories) {
        const file = path.join(temporary, directory, "settings.json");
        if (await exists(file)) present.push(file);
      }
      return present;
    };
    const first = await launch("killed");
    await until(() => exists(first.ready), "first Claude turn did not complete");
    const status = (await exec("claude", ["daemon", "status"], { env, timeout: 20_000 })).stdout;
    const daemonPid = Number(/^pid:\s+(\d+)/m.exec(status)?.[1]);
    assert.ok(daemonPid > 0, "the private daemon has no PID");
    const daemonStart = await readProcessStartTicks("/proc", daemonPid);
    assert.ok(daemonStart, "the private daemon has no readable start identity");
    daemon = { pid: daemonPid, start: daemonStart };
    const firstSettings = await settings();
    assert.equal(firstSettings.length, 1);
    const firstRow = (await roster()).find(row => row.cwd === first.cwd);
    assert.ok(firstRow?.pid, "the first session has no process identity");
    const firstProcesses = (await workerProcesses()).filter(row => row.pid !== first.run.child.pid);
    const firstIdentity = firstProcesses.find(row => row.pid === firstRow.pid);
    assert.ok(firstIdentity);
    first.run.child.kill("SIGKILL");
    assert.equal((await first.run.exit).signal, "SIGKILL");
    assert.ok(await exists(firstSettings[0]!));
    assert.ok((await workerProcesses()).some(row => same(row, firstIdentity)));

    const second = await launch("overlap", true);
    await until(() => exists(path.join(second.cwd, "valve-ready")), "second dispatch did not open its native valve");
    const secondSettings = await settings();
    assert.equal(secondSettings.length, 1);
    assert.ok(!await exists(firstSettings[0]!), "dead owner's settings were not swept");
    assert.ok((await workerProcesses()).some(row => same(row, firstIdentity)), "settings sweep unexpectedly stopped the orphaned session");
    const third = await launch("other-owner", true);
    await until(async () => (await settings()).length === 2, "overlapping dispatch did not create settings");
    assert.ok(await exists(secondSettings[0]!), "a live owner's settings were swept");
    for (const run of [third.run, second.run]) {
      run.child.kill("SIGTERM");
      const result = await boundedExit(run);
      assert.deepEqual(result, { code: 143, signal: null }, "handled shutdown did not finish before the fixture's safety bound");
    }
    const residue = await workerProcesses();
    t.diagnostic(JSON.stringify({ deliberatelyKilled: firstProcesses, residue }));
    assert.ok(residue.some(row => same(row, firstIdentity)));
    assert.deepEqual(residue.filter(row => !firstProcesses.some(known => same(row, known))), [], "handled dispatch leaked a Claude process or tmux server");
    // A cancelled launch not yet visible in the daemon roster retains its
    // settings conservatively until the next launcher sweeps the dead owner.
    t.diagnostic(JSON.stringify({ retainedSettingsAfterShutdown: (await settings()).length }));
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    // Fixture cleanup is independent of product teardown. In particular, the
    // session whose launcher received SIGKILL is still ours to stop explicitly.
    for (const run of runs) {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        run.child.kill("SIGTERM");
        await boundedExit(run).catch(() => undefined);
      }
    }
    for (const row of await roster().catch(() => [])) {
      if (!row.cwd.startsWith(`${work}${path.sep}`)) continue;
      await exec("claude", ["stop", row.id], { env, timeout: 20_000 }).catch(() => undefined);
      await exec("claude", ["rm", row.id], { env, timeout: 20_000 }).catch(() => undefined);
    }
    await exec("claude", ["daemon", "stop", "--any"], { env, timeout: 20_000 }).catch(() => undefined);
    // A failed assertion must not leave the deliberately blocked native valve.
    for (const row of await workerProcesses()) await signalIdentity(row, "SIGTERM");
    await until(async () => (await workerProcesses()).length === 0, "fixture residue did not end", 5_000).catch(async () => {
      for (const row of await workerProcesses()) await signalIdentity(row, "SIGKILL");
      await until(async () => (await workerProcesses()).length === 0, "fixture residue survived SIGKILL", 5_000);
    });
    if (daemon) {
      const owned = daemon;
      const gone = async (): Promise<boolean> => await readProcessStartTicks("/proc", owned.pid) !== owned.start;
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (await gone()) break;
        await signalStartIdentity(owned, signal);
        await until(gone, "private daemon did not stop", 5_000).catch(() => undefined);
      }
      assert.ok(await gone(), "the fixture's private daemon survived cleanup");
    }
    const finalResidue = await workerProcesses();
    t.diagnostic(JSON.stringify({ fixtureCleanupResidue: finalResidue }));
    assert.deepEqual(finalResidue, []);
    await removeTestDirectory(root, testFailed);
  }
});

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function until(check: () => Promise<boolean>, message: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(message);
}
async function boundedExit(run: Run): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const timer = setTimeout(() => run.child.kill("SIGKILL"), 30_000);
  try { return await run.exit; } finally { clearTimeout(timer); }
}
function same(left: Identity, right: Identity): boolean { return left.pid === right.pid && left.start === right.start; }
async function processes(root: string): Promise<Identity[]> {
  const found: Identity[] = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);
      if (!cwd.startsWith(`${root}${path.sep}`)) continue;
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") continue;
      found.push({ pid: Number(pid), start: fields[19]!, cwd, comm: (await readFile(`/proc/${pid}/comm`, "utf8")).trim() });
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return found;
}
async function signalIdentity(identity: Identity, signal: NodeJS.Signals): Promise<void> {
  if (!(await processes(path.dirname(identity.cwd))).some(row => same(row, identity))) return;
  try { process.kill(identity.pid, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function signalStartIdentity(identity: { pid: number; start: string }, signal: NodeJS.Signals): Promise<void> {
  if (await readProcessStartTicks("/proc", identity.pid) !== identity.start) return;
  try { process.kill(identity.pid, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
