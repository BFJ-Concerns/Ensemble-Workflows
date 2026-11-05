import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ClaudeCliControlPlane, type ClaudeSessionHandle } from "../../src/claude-control-plane.js";
import { SystemdWorkerScopes, containingSlice, parentSlice } from "../../src/worker-scopes.js";

import { heldProbePrompt, probePaths, waitForPath, type HeldProbe } from "./held-worker-probes.js";

const execFileAsync = promisify(execFile);
const isLive = process.env.ENSEMBLE_LIVE === "1";
const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

/**
 * Two workers under a supervisor this test owns. The first stays alive
 * after placement while the supervisor starts its sibling; worker-written
 * cgroup files witness that both can execute in their assigned scopes.
 * The first launcher's box then ends while the sibling is still alive,
 * and the same supervisor serves the sibling through completion.
 */
test("the built launcher preserves an owned supervisor and sibling while moving workers", { skip: !isLive, timeout: 900_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ensemble-supervisor-boundary-"));
  const configDir = path.join(root, "claude-config");
  await mkdir(configDir, { mode: 0o700 });
  // Onboarding and bypass consent belong only to this proof's private daemon.
  await writeFile(path.join(configDir, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`, { mode: 0o600 });
  await writeFile(path.join(configDir, "settings.json"), `${JSON.stringify({ skipDangerousModePermissionPrompt: true })}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_SANDBOXED: "1",
    // Keep this placement journey in worker mode regardless of ambient run tuning.
    ENSEMBLE_WORKER_SCOPE: "worker"
  };
  const first: HeldProbe = { paths: probePaths(root, "first"), evidence: { kind: "cgroup" }, token: `FIRST_${randomUUID()}` };
  const sibling: HeldProbe = { paths: probePaths(root, "sibling"), evidence: { kind: "cgroup" }, token: `SIBLING_${randomUUID()}` };
  const ownCgroup = cgroupPath(await readFile("/proc/self/cgroup", "utf8"));
  const slice = containingSlice(`0::${ownCgroup}\n`);
  const operatorDaemon = await daemonPid(process.env);
  const observations: Record<string, unknown> = { ownCgroup, slice, operatorDaemonBefore: operatorDaemon };
  const boxes = [`ensemble-live-box-${process.pid}.scope`, `ensemble-live-box-${process.pid}-sibling.scope`];
  const runs: ReturnType<typeof launchInBox>[] = [];

  try {
    assert.equal(await daemonPid(env), null, "the private config directory already had a daemon");
    const run1 = launchInBox(boxes[0]!, slice, env, heldProbePrompt(first));
    runs.push(run1);
    const seen = await watchRoster(env, 120_000);
    observations.firstRegistration = seen;
    assert.ok(seen.registered !== null, "the worker never registered in the owned roster");
    assert.ok(seen.pid !== null, "the roster never named the worker's pid");
    assert.ok(seen.processIdentity !== null, "the roster pid did not name a live process");
    const workerCgroup = await waitForCgroup(seen.pid, (cgroup) => /\/ensemble-\d+-.*\.scope$/.test(cgroup), 30_000);
    observations.workerCgroup = workerCgroup;
    assert.ok(workerCgroup !== null, "the worker's process was never placed in an ensemble worker scope");
    assert.ok(!workerCgroup.includes(`/${boxes[0]}`), `the worker sits inside the box itself: ${workerCgroup}`);
    if (slice !== null) {
      assert.equal(containingSlice(`0::${workerCgroup}\n`), slice, "the worker is outside the launcher's containing slice");
    }
    await waitForPath(first.paths.ready, 420_000);
    assert.equal(run1.settled, false, "the first worker settled before observation");
    observations.firstShellCgroup = await readFile(first.paths.evidence, "utf8");
    assert.equal(cgroupPath(String(observations.firstShellCgroup)), workerCgroup, "the first worker's shell escaped its placement");

    const daemon = await daemonPid(env);
    assert.ok(daemon !== null, "the launcher's claude commands did not start the owned daemon");
    assert.notEqual(daemon, seen.pid, "the roster pid names the supervisor rather than the worker");
    const daemonCgroup = cgroupPath(await readFile(`/proc/${daemon}/cgroup`, "utf8"));
    observations.ownedDaemon = { pid: daemon, cgroup: daemonCgroup };
    assert.ok(!daemonCgroup.includes(`/${boxes[0]}`), `the daemon sits inside the box: ${daemonCgroup}`);
    if (slice !== null) {
      assert.ok(!daemonCgroup.split("/").includes(slice), `the daemon sits inside the launcher's slice ${slice}: ${daemonCgroup}`);
      const parent = parentSlice(slice);
      assert.ok(
        parent === "-.slice" ? daemonCgroup.split("/").at(-2)?.endsWith(".service") : daemonCgroup.split("/").includes(parent),
        `the daemon did not land in ${parent}: ${daemonCgroup}`
      );
    }

    // Starting and executing a sibling after moving the first worker
    // exercises the supervisor, not just its status endpoint.
    const run2 = launchInBox(boxes[1]!, slice, env, heldProbePrompt(sibling));
    runs.push(run2);
    const seen2 = await watchRoster(env, 120_000, seen.registered.sessionId);
    observations.siblingRegistration = seen2;
    assert.ok(seen2.pid !== null, "the sibling worker's pid was never named");
    assert.notEqual(seen2.pid, seen.pid, "the roster returned the first worker as its sibling");
    assert.notEqual(seen2.pid, daemon, "the sibling roster pid names the supervisor");
    const siblingCgroup = await waitForCgroup(seen2.pid, (cgroup) => /\/ensemble-\d+-.*\.scope$/.test(cgroup), 30_000);
    assert.ok(siblingCgroup !== null, "the sibling worker was never placed");
    assert.notEqual(siblingCgroup, workerCgroup, "different workers share a scope in worker mode");
    if (slice !== null) {
      assert.equal(containingSlice(`0::${siblingCgroup}\n`), slice);
    }
    await waitForPath(sibling.paths.ready, 420_000);
    assert.equal(run2.settled, false, "the sibling settled before observation");
    observations.siblingShellCgroup = await readFile(sibling.paths.evidence, "utf8");
    assert.equal(cgroupPath(String(observations.siblingShellCgroup)), siblingCgroup);
    assert.equal(await daemonPid(env), daemon, "moving a worker replaced its supervisor");

    await writeFile(first.paths.release, "");
    const result1 = await run1.result;
    observations.run1 = result1;
    assert.equal(result1.code, 0, result1.stderr);
    await execFileAsync("systemctl", ["--user", "stop", boxes[0]!]).catch((error: unknown) => {
      // --collect may already have removed an empty box when its launcher exited.
      if (!(error instanceof Error) || !/not loaded|not found/.test(error.message)) throw error;
    });
    assert.equal(await daemonPid(env), daemon, "the supervisor did not survive its launcher's box ending");
    const siblingRow = await waitForRow(env, seen2.registered!.sessionId, (row) => row.pid === seen2.pid, 30_000);
    assert.ok(siblingRow !== null, "the supervisor lost its sibling when the first box ended");
    assert.equal(run2.settled, false, "the sibling ended with the first launcher's box");
    assert.equal(cgroupPath(await readFile(`/proc/${seen2.pid}/cgroup`, "utf8")), siblingCgroup);
    observations.siblingAfterBox = { pid: seen2.pid, cgroup: siblingCgroup, daemon: await daemonPid(env) };

    await writeFile(sibling.paths.release, "");
    const result2 = await run2.result;
    observations.run2 = result2;
    assert.equal(result2.code, 0, result2.stderr);
    assert.equal(await daemonPid(env), daemon, "a second daemon replaced the owned one");
  } finally {
    await Promise.all([first, sibling].map((probe) => writeFile(probe.paths.release, "")));
    // Stop proof-owned boxes before their private supervisor. A failed
    // observation must not leave a launcher or polling probe behind.
    await Promise.all(boxes.map((box) => execFileAsync("systemctl", ["--user", "stop", box]).catch(() => undefined)));
    await Promise.all(runs.map((run) => run.result));
    if ((await daemonPid(env)) !== null) {
      await execFileAsync("claude", ["daemon", "stop", "--any"], { env });
    }
    observations.operatorDaemonAfter = await daemonPid(process.env);
    t.diagnostic(JSON.stringify(observations));
    await rm(root, { recursive: true, force: true });
    assert.equal(observations.operatorDaemonAfter, operatorDaemon, "the operator's daemon changed during the journey");
  }
});

/**
 * Replacement, measured on an owned supervisor through the control plane
 * that places sessions. `claude respawn <id>` makes the supervisor restart a
 * session: the row keeps its id and session id and names a new process,
 * forked in the supervisor's own cgroup; the control plane's next poll must
 * place that process in the session's scope. The control plane rather than
 * the built launcher drives this leg because a respawn interrupts the
 * session's turn and leaves it idle, so a launcher run could not carry a
 * respawned worker to completion.
 */
test("a session the owned supervisor restarts under a new pid is placed again at the next poll", { skip: !isLive, timeout: 300_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ensemble-supervisor-replacement-"));
  const configDir = path.join(root, "claude-config");
  await mkdir(configDir, { mode: 0o700 });
  await writeFile(path.join(configDir, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`, { mode: 0o600 });
  await writeFile(path.join(configDir, "settings.json"), `${JSON.stringify({ skipDangerousModePermissionPrompt: true })}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_SANDBOXED: "1" };
  const slice = containingSlice(await readFile("/proc/self/cgroup", "utf8"));
  const operatorDaemon = await daemonPid(process.env);
  const scopes = new SystemdWorkerScopes({ slice, label: `live-replacement-${process.pid}` });
  // The control plane's own `claude` commands run under the owned configuration; transcripts land under it too.
  const controlPlane = new ClaudeCliControlPlane({
    workerEnv: { CLAUDE_CONFIG_DIR: configDir },
    projectsDir: path.join(configDir, "projects"),
    scopes
  });
  const observations: Record<string, unknown> = { slice, operatorDaemonBefore: operatorDaemon };
  let handle: ClaudeSessionHandle | null = null;

  try {
    assert.equal(await daemonPid(env), null, "the private config directory already had a daemon");
    handle = await controlPlane.dispatch({
      prompt: "Reply with exactly the word done and nothing else.",
      name: `ensemble-replacement-${process.pid}`,
      cwd: root,
      model: "haiku"
    });
    const first = controlPlane.placementOf(handle);
    assert.ok(first !== null && first.kind === "placed", `the session was not placed at dispatch: ${JSON.stringify(first)}`);
    const firstPid = first.pids[0]!;
    const firstCgroup = cgroupPath(await readFile(`/proc/${firstPid}/cgroup`, "utf8"));
    observations.first = { id: handle.id, sessionId: handle.sessionId, pid: firstPid, unit: first.unit, cgroup: firstCgroup };
    assert.ok(firstCgroup.endsWith(`/${first.unit}`), `the session's process is not in its scope: ${firstCgroup}`);
    const daemon = await daemonPid(env);
    observations.ownedDaemon = daemon;
    assert.ok(daemon !== null, "the control plane's claude commands did not start the owned daemon");

    // The supervisor restarts the session: the same row, a new process.
    await execFileAsync("claude", ["respawn", handle.id], { env });
    const replaced = await waitForRow(env, handle.sessionId, (row) => typeof row.pid === "number" && row.pid !== firstPid, 30_000);
    assert.ok(replaced !== null && typeof replaced.pid === "number", "the roster never named a new pid for the restarted session");
    const replacedPid = replaced.pid;
    assert.equal(replaced.id, handle.id, "the restarted session changed its id");
    const beforePoll = cgroupPath(await readFile(`/proc/${replacedPid}/cgroup`, "utf8"));
    observations.replacement = { pid: replacedPid, cgroupBeforePoll: beforePoll, firstPidLive: processLives(firstPid) };
    assert.ok(
      !beforePoll.endsWith(`/${first.unit}`),
      `the supervisor started the new process already inside the worker scope, so re-placement has nothing to show: ${beforePoll}`
    );

    const status = await controlPlane.poll(handle);
    assert.equal(status.present, true, "the restarted session is absent from the roster");
    const again = controlPlane.placementOf(handle);
    assert.ok(
      again !== null && again.kind === "placed" && again.pids.includes(replacedPid),
      `the new pid was not placed at the poll: ${JSON.stringify(again)}`
    );
    assert.equal(again.unit, first.unit, "the restarted session was placed in a different scope");
    const afterPoll = cgroupPath(await readFile(`/proc/${replacedPid}/cgroup`, "utf8"));
    const daemonAfter = await daemonPid(env);
    observations.replacement = { ...(observations.replacement as object), cgroupAfterPoll: afterPoll, daemonAfter };
    assert.equal(daemonAfter, daemon, "re-placing a restarted worker changed its supervisor");
    assert.ok(afterPoll.endsWith(`/${first.unit}`), `the new process is not in the session's scope after the poll: ${afterPoll}`);
  } finally {
    if (handle !== null) {
      await controlPlane.stop(handle);
    }
    await scopes.close();
    await execFileAsync("claude", ["daemon", "stop", "--any"], { env }).catch((error: Error) => {
      observations.ownedDaemonStop = error.message.slice(0, 200);
    });
    observations.operatorDaemonAfter = await daemonPid(process.env);
    t.diagnostic(JSON.stringify(observations));
    await rm(root, { recursive: true, force: true });
    assert.equal(observations.operatorDaemonAfter, operatorDaemon, "the operator's daemon changed during the journey");
  }
});

function launchInBox(unit: string, slice: string | null, env: NodeJS.ProcessEnv, prompt: string): {
  settled: boolean;
  result: Promise<{ code: number | null; stdout: string; stderr: string }>;
} {
  const child = spawn(
    "systemd-run",
    [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${unit}`,
      ...(slice !== null ? [`--slice=${slice}`] : []),
      "--",
      process.execPath,
      bundledCliPath,
      "agent",
      "--engine=claude",
      "--model=haiku",
      prompt
    ],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] }
  );
  const run = { settled: false, result: Promise.resolve({ code: null as number | null, stdout: "", stderr: "" }) };
  run.result = new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      run.settled = true;
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      run.settled = true;
      resolve({ code, stdout, stderr });
    });
  });
  return run;
}

interface RosterWatch {
  registered: { sessionId: string; name: string; atMs: number; pid: number | null } | null;
  pid: number | null;
  pidAtMs: number | null;
  processIdentity: { comm: string; executable: string } | null;
}

/** Poll the owned roster until an ensemble worker registers and its pid is named: when each happened, and what the pid names. */
async function watchRoster(env: NodeJS.ProcessEnv, timeoutMs: number, ignoreSessionId?: string): Promise<RosterWatch> {
  const started = Date.now();
  const watch: RosterWatch = { registered: null, pid: null, pidAtMs: null, processIdentity: null };
  while (Date.now() - started < timeoutMs) {
    // The daemon is started by the launcher, never by this watcher: the roster is read only once the daemon exists.
    if ((await daemonPid(env)) !== null) {
      const { rows } = await roster(env);
      const row = rows.find((entry) => entry.kind === "background" && typeof entry.name === "string" && entry.name.startsWith("ensemble-") && entry.sessionId !== ignoreSessionId);
      if (row !== undefined && typeof row.sessionId === "string" && typeof row.name === "string") {
        watch.registered ??= { sessionId: row.sessionId, name: row.name, atMs: Date.now() - started, pid: typeof row.pid === "number" ? row.pid : null };
        if (typeof row.pid === "number") {
          watch.pid = row.pid;
          watch.pidAtMs = Date.now() - started;
          watch.processIdentity = {
            comm: (await readFile(`/proc/${row.pid}/comm`, "utf8")).trim(),
            executable: await readlink(`/proc/${row.pid}/exe`)
          };
          return watch;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return watch;
}

async function waitForCgroup(pid: number, accept: (cgroup: string) => boolean, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await readFile(`/proc/${pid}/cgroup`, "utf8").then(cgroupPath).catch(() => null);
    if (last !== null && accept(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last !== null && accept(last) ? last : null;
}

/** Poll the owned roster until the session's row satisfies `accept`, or the time runs out. */
async function waitForRow(env: NodeJS.ProcessEnv, sessionId: string, accept: (row: RosterRow) => boolean, timeoutMs: number): Promise<RosterRow | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await roster(env);
    const row = rows.find((entry) => entry.sessionId === sessionId);
    if (row !== undefined && accept(row)) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function processLives(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface RosterRow {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  sessionId?: unknown;
  pid?: unknown;
}

async function roster(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; rows: RosterRow[] }> {
  try {
    const { stdout } = await execFileAsync("claude", ["agents", "--json"], { env, maxBuffer: 32 * 1024 * 1024 });
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? { ok: true, rows: parsed as RosterRow[] } : { ok: false, rows: [] };
  } catch {
    return { ok: false, rows: [] };
  }
}

/** The daemon's pid as `claude daemon status` reports it, or null when none is running. Read-only: status never starts a daemon. */
async function daemonPid(env: NodeJS.ProcessEnv): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("claude", ["daemon", "status"], { env });
    const match = /^pid:\s+(\d+)/m.exec(stdout);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function cgroupPath(cgroupFile: string): string {
  const line = cgroupFile.split("\n").find((entry) => entry.startsWith("0::")) ?? "0::";
  return line.slice("0::".length).trim();
}
