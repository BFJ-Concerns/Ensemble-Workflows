import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { promisify } from "node:util";

import { removeTestDirectory } from "../failure-evidence.js";
import { assertFixedClaudeVersion, classifySupervisorTransition, daemonPid, selectClaudeExecutable, supervisorLifecycle, supervisorSnapshot } from "./claude-proof-support.js";
import { suiteClaudeDaemon, suiteClaudeEnvironment } from "./suite-claude-daemon.js";

import { resolveAmbientSettings } from "../../src/ambient-settings.js";
import { containingSlice, parentSlice } from "../../src/worker-scopes.js";

import { heldProbePrompt, probePaths, waitForPath, type HeldProbe } from "./held-worker-probes.js";

const execFileAsync = promisify(execFile);
const isLive = process.env.ENSEMBLE_LIVE === "1";
const claudeModel = process.env.ENSEMBLE_LIVE_CLAUDE_MODEL ?? "haiku";
const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

let claude: Awaited<ReturnType<typeof selectClaudeExecutable>>;
after(async () => { await claude?.dispose(); });

/**
 * Two workers under a supervisor this test owns. The first stays alive
 * after placement while the supervisor starts its sibling; worker-written
 * cgroup files witness that both can execute in their assigned scopes.
 * The first launcher's box then ends while the sibling is still alive,
 * and the supervisor serves the sibling through completion. Only a logged
 * upgrade may explain a replacement supervisor.
 */
test("the built launcher preserves an owned supervisor and sibling while moving workers", { skip: !isLive ? "ENSEMBLE_LIVE must be 1" : false, timeout: 900_000 }, async (t) => {
  const shared = await suiteClaudeDaemon();
  assert.ok(shared.origin !== "unavailable", `UNPROVEN: shared Claude daemon unavailable: ${JSON.stringify(shared)}`);
  claude ??= await selectClaudeExecutable("claude", tmpdir(), suiteClaudeEnvironment());
  const operatorDaemon = shared.baseline;
  const root = await mkdtemp(path.join(tmpdir(), "ensemble-supervisor-boundary-"));
  const env = await ownedSupervisorEnvironment(root);
  const first: HeldProbe = { paths: probePaths(root, "first"), evidence: { kind: "cgroup" }, token: `FIRST_${randomUUID()}` };
  const sibling: HeldProbe = { paths: probePaths(root, "sibling"), evidence: { kind: "cgroup" }, token: `SIBLING_${randomUUID()}` };
  const ownCgroup = cgroupPath(await readFile("/proc/self/cgroup", "utf8"));
  const slice = containingSlice(`0::${ownCgroup}\n`);
  const observations: Record<string, unknown> = { ownCgroup, slice, claudeExecutable: claude.executable, selectedClaudeVersion: claude.version, operatorDaemonHome: shared.home, operatorDaemonOrigin: shared.origin, operatorDaemonBefore: operatorDaemon };
  const boxes = [`ensemble-live-box-${process.pid}.scope`, `ensemble-live-box-${process.pid}-sibling.scope`];
  const runs: ReturnType<typeof launchInBox>[] = [];

  let testFailed = false;
  try {
    assert.equal(await daemonPid(claude.executable, env), null, "the private config directory already had a daemon");
    const run1 = launchInBox(boxes[0]!, slice, env, heldProbePrompt(first));
    runs.push(run1);
    const seen = await watchRoster(env, 120_000, undefined, () => run1.settled);
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

    let supervisorState = await supervisorSnapshot(claude.executable, env);
    const daemon = supervisorState.identity.pid;
    observations.ownedSupervisorBefore = supervisorState;
    assert.ok(daemon !== null, "the launcher's claude commands did not start the owned daemon");
    assert.equal(supervisorState.selectedVersion, claude.version);
    assertFixedClaudeVersion(supervisorState, supervisorState, "owned supervisor startup");
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
    const seen2 = await watchRoster(env, 120_000, seen.registered.sessionId, () => run2.settled);
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
    const afterSibling = await supervisorSnapshot(claude.executable, env);
    observations.afterSibling = afterSibling;
    observations.afterSiblingTransition = assertFixedClaudeVersion(supervisorState, afterSibling, "afterSibling");
    supervisorState = afterSibling;
    assert.equal(containingSlice(afterSibling.identity.cgroup!), slice === null ? null : parentSlice(slice), "the supervisor moved into the launcher's slice");

    await writeFile(first.paths.release, "");
    const result1 = await run1.result;
    observations.run1 = result1;
    assert.equal(result1.code, 0, result1.stderr);
    await execFileAsync("systemctl", ["--user", "stop", boxes[0]!]).catch((error: unknown) => {
      // --collect may already have removed an empty box when its launcher exited.
      if (!(error instanceof Error) || !/not loaded|not found/.test(error.message)) throw error;
    });
    const afterBox = await supervisorSnapshot(claude.executable, env);
    observations.afterBox = afterBox;
    observations.afterBoxTransition = assertFixedClaudeVersion(supervisorState, afterBox, "afterBox");
    supervisorState = afterBox;
    assert.equal(containingSlice(afterBox.identity.cgroup!), slice === null ? null : parentSlice(slice), "the supervisor moved into the launcher's slice");
    const siblingRow = await waitForRow(env, seen2.registered!.sessionId, (row) => row.pid === seen2.pid, 30_000);
    assert.ok(siblingRow !== null, "the supervisor lost its sibling when the first box ended");
    assert.equal(run2.settled, false, "the sibling ended with the first launcher's box");
    assert.equal(cgroupPath(await readFile(`/proc/${seen2.pid}/cgroup`, "utf8")), siblingCgroup);
    observations.siblingAfterBox = { pid: seen2.pid, cgroup: siblingCgroup, daemon: await daemonPid(claude.executable, env) };

    await writeFile(sibling.paths.release, "");
    const result2 = await run2.result;
    observations.run2 = result2;
    assert.equal(result2.code, 0, result2.stderr);
    const afterCompletion = await supervisorSnapshot(claude.executable, env);
    observations.afterCompletion = afterCompletion;
    observations.afterCompletionTransition = assertFixedClaudeVersion(supervisorState, afterCompletion, "afterCompletion");
    supervisorState = afterCompletion;
    assert.equal(containingSlice(afterCompletion.identity.cgroup!), slice === null ? null : parentSlice(slice), "the supervisor moved into the launcher's slice");
    assert.equal((await supervisorLifecycle(env.CLAUDE_CONFIG_DIR!)).filter(row => row.event === "start").length, 1, "the private home had more than one daemon startup");
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await Promise.all([first, sibling].map((probe) => writeFile(probe.paths.release, "")));
    // Stop proof-owned boxes before their private supervisor. A failed
    // observation must not leave a launcher or polling probe behind.
    await Promise.all(boxes.map((box) => execFileAsync("systemctl", ["--user", "stop", box]).catch(() => undefined)));
    observations.runResults = await Promise.all(runs.map((run) => run.result));
    observations.ownedLifecycleBeforeStop = await supervisorLifecycle(env.CLAUDE_CONFIG_DIR!);
    observations.upgradeRestarts = (observations.ownedLifecycleBeforeStop as Record<string, string>[]).filter(row => row.event === "shutdown" && row.cause === "upgrade");
    if ((await daemonPid(claude.executable, env)) !== null) {
      await execFileAsync(claude.executable, ["daemon", "stop", "--any"], { env });
    }
    const operatorAfter = await supervisorSnapshot(claude.executable, suiteClaudeEnvironment(), operatorDaemon.offset);
    observations.operatorDaemonAfter = operatorAfter;
    observations.operatorTransition = classifySupervisorTransition(operatorDaemon.identity, operatorAfter.identity, operatorDaemon.lifecycle, operatorAfter.lifecycle);
    t.diagnostic(JSON.stringify(observations));
    await removeTestDirectory(root, testFailed);
    assert.notEqual(observations.operatorTransition, "unexplained", "the operator's daemon changed without a recorded upgrade");
  }
});

/** A held session remains owned after its last turn, so its replacement must
 * move without a new send() or a test calling a control-plane poll. */
test("the built launcher re-places an idle held session after respawn without another turn", { skip: !isLive ? "ENSEMBLE_LIVE must be 1" : false, timeout: 600_000 }, async (t) => {
  const shared = await suiteClaudeDaemon();
  assert.ok(shared.origin !== "unavailable", `UNPROVEN: shared Claude daemon unavailable: ${JSON.stringify(shared)}`);
  claude ??= await selectClaudeExecutable("claude", tmpdir(), suiteClaudeEnvironment());
  const operatorDaemon = shared.baseline;
  const root = await mkdtemp(path.join(tmpdir(), "ensemble-supervisor-replacement-"));
  const env = await ownedSupervisorEnvironment(root);
  const slice = containingSlice(await readFile("/proc/self/cgroup", "utf8"));
  const probe: HeldProbe = { paths: probePaths(root, "replacement"), evidence: { kind: "cgroup" }, token: `REPLACEMENT_${randomUUID()}` };
  const idle = path.join(root, "idle");
  const close = path.join(root, "close");
  const workflow = path.join(root, "workflow.js");
  const box = `ensemble-live-idle-${process.pid}.scope`;
  const observations: Record<string, unknown> = { slice, claudeExecutable: claude.executable, selectedClaudeVersion: claude.version, operatorDaemonHome: shared.home, operatorDaemonOrigin: shared.origin, operatorDaemonBefore: operatorDaemon };
  let run: ReturnType<typeof launchCliInBox> | undefined;
  let testFailed = false;
  try {
    await writeFile(workflow, `export const meta = { name: "idle-session-replacement" };
      const { access, writeFile } = await import("node:fs/promises");
      const worker = session(${JSON.stringify({engine:"claude",model:claudeModel,cwd:root,maxAttempts:1,timeoutMs:420_000})});
      try {
        const reply = await worker.send(${JSON.stringify(heldProbePrompt(probe))});
        await writeFile(${JSON.stringify(idle)}, "idle");
        while (!(await access(${JSON.stringify(close)}).then(() => true, () => false))) await new Promise(resolve => setTimeout(resolve, 50));
        return reply;
      } finally { await worker.close(); }
    `);
    assert.equal(await daemonPid(claude.executable, env), null, "the private config directory already had a daemon");
    run = launchCliInBox(box, slice, env, [workflow]);
    const seen = await watchRoster(env, 120_000, undefined, () => run!.settled);
    assert.ok(seen.registered !== null && seen.pid !== null, run.settled ? JSON.stringify(await run.result) : "the owned session never registered a process");
    await waitForPath(probe.paths.ready, 420_000);
    const initialGroup = cgroupPath(await readFile(probe.paths.evidence, "utf8"));
    assert.ok(initialGroup.endsWith(".scope") && /\/ensemble-\d+-/.test(initialGroup), "worker shell was not placed");
    const initialSupervisor = await supervisorSnapshot(claude.executable, env);
    observations.initialSupervisor = initialSupervisor;
    assert.equal(initialSupervisor.selectedVersion, claude.version);
    assertFixedClaudeVersion(initialSupervisor, initialSupervisor, "held supervisor startup");
    await writeFile(probe.paths.release, "");
    await waitForPath(idle, 420_000);
    const first = await waitForRow(env, seen.registered.sessionId, row => row.state === "idle" || row.status === "idle" || row.state === "done", 60_000);
    assert.ok(first && typeof first.pid === "number", "the completed turn did not leave an owned idle session");
    assert.equal(typeof first.id, "string", "the owned idle session has no native identifier");
    observations.first = { sessionId: first.sessionId, pid: first.pid, cgroup: initialGroup };
    assert.equal(run.settled, false, "the launcher ended instead of holding the idle session");
    // A native respawn, rather than killing a process: killed sessions leave
    // the roster on supported Claude versions and do not supply a replacement.
    const beforeRespawn = await supervisorSnapshot(claude.executable, env);
    observations.beforeRespawn = beforeRespawn;
    observations.beforeRespawnTransition = assertFixedClaudeVersion(initialSupervisor, beforeRespawn, "before native respawn");
    await execFileAsync(claude.executable, ["respawn", first.id as string], { env });
    const replaced = await waitForRow(env, seen.registered.sessionId, row => typeof row.pid === "number" && row.pid !== first.pid, 60_000);
    assert.ok(replaced && typeof replaced.pid === "number", "the supervisor never supplied a replacement PID");
    observations.replacement = { pid: replaced.pid, cgroupInitiallyObserved: cgroupPath(await readFile(`/proc/${replaced.pid}/cgroup`, "utf8")) };
    // Only OS observation here: the launcher owns the watch. No poll(),
    // control-plane instance or second worker turn can perform the move.
    const deadline = Date.now() + 60_000;
    let placed: { pid: number; cgroup: string } | null = null;
    while (Date.now() < deadline) {
      const rows = (await roster(env)).rows;
      const current = rows.find(row => row.sessionId === seen.registered!.sessionId && typeof row.pid === "number" && row.pid !== first.pid);
      if (current && typeof current.pid === "number") {
        const group = await readFile(`/proc/${current.pid}/cgroup`, "utf8").then(cgroupPath, () => null);
        observations.latestReplacement = { pid: current.pid, cgroup: group };
        if (group === initialGroup) { placed = { pid: current.pid, cgroup: group }; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(placed !== null, "idle replacement stayed outside its worker scope without another turn");
    const afterRespawn = await supervisorSnapshot(claude.executable, env);
    observations.afterRespawn = afterRespawn;
    observations.afterRespawnTransition = assertFixedClaudeVersion(beforeRespawn, afterRespawn, "after native respawn");
    observations.replacement = { ...(observations.replacement as object), placed };
    assert.equal(run.settled, false, "the launcher ended during idle replacement observation");
    await writeFile(close, "");
    const result = await run.result; observations.result = result;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(probe.token), "the launcher lost the completed first turn");
    assert.equal((await supervisorLifecycle(env.CLAUDE_CONFIG_DIR!)).filter(row => row.event === "start").length, 1, "the private home had more than one daemon startup");
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await writeFile(probe.paths.release, ""); await writeFile(close, "");
    await execFileAsync("systemctl", ["--user", "stop", box]).catch(() => undefined);
    if (run) observations.result = await run.result;
    observations.ownedLifecycleBeforeStop = await supervisorLifecycle(env.CLAUDE_CONFIG_DIR!);
    observations.upgradeRestarts = (observations.ownedLifecycleBeforeStop as Record<string, string>[]).filter(row => row.event === "shutdown" && row.cause === "upgrade");
    await execFileAsync(claude.executable, ["daemon", "stop", "--any"], { env }).catch((error: Error) => { observations.ownedDaemonStop = error.message.slice(0, 200); });
    const operatorAfter = await supervisorSnapshot(claude.executable, suiteClaudeEnvironment(), operatorDaemon.offset);
    observations.operatorDaemonAfter = operatorAfter;
    observations.operatorTransition = classifySupervisorTransition(operatorDaemon.identity, operatorAfter.identity, operatorDaemon.lifecycle, operatorAfter.lifecycle);
    t.diagnostic(JSON.stringify(observations));
    await removeTestDirectory(root, testFailed);
    assert.notEqual(observations.operatorTransition, "unexplained", "the operator's daemon changed without a recorded upgrade");
  }
});

async function ownedSupervisorEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const configDir = path.join(root, "claude-config");
  await mkdir(configDir, { mode: 0o700 });
  // Onboarding and bypass consent belong only to this proof's private daemon.
  await writeFile(path.join(configDir, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`, { mode: 0o600 });
  await writeFile(path.join(configDir, "settings.json"), `${JSON.stringify({ skipDangerousModePermissionPrompt: true })}\n`, { mode: 0o600 });
  const machineEnvironment = resolveAmbientSettings({ env: process.env, cwd: process.cwd() }).workerEnvironment;
  const xdg = path.join(root, "config");
  await mkdir(path.join(root, "status"));
  await mkdir(path.join(xdg, "ensemble"), { recursive: true });
  await writeFile(path.join(xdg, "ensemble", "config.json"), JSON.stringify({
    schema_version: 1,
    worker_environment: { ...machineEnvironment, claude: { ...machineEnvironment.claude, CLAUDE_CONFIG_DIR: configDir, PATH: claude.env.PATH! } }
  }), { mode: 0o600 });
  return {
    ...claude.env,
    XDG_CONFIG_HOME: xdg,
    ENSEMBLE_RUN_RECORD_DIR: path.join(root, "records"),
    ENSEMBLE_STATUS_DIR: path.join(root, "status"),
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_SANDBOXED: "1",
    // Keep this placement journey in worker mode regardless of ambient run tuning.
    ENSEMBLE_WORKER_SCOPE: "worker"
  };
}

function launchInBox(unit: string, slice: string | null, env: NodeJS.ProcessEnv, prompt: string): ReturnType<typeof launchCliInBox> {
  return launchCliInBox(unit, slice, env, ["agent", "--engine=claude", `--model=${claudeModel}`, prompt]);
}

function launchCliInBox(unit: string, slice: string | null, env: NodeJS.ProcessEnv, args: string[]): {
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
      ...args
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
async function watchRoster(env: NodeJS.ProcessEnv, timeoutMs: number, ignoreSessionId?: string, ended?: () => boolean): Promise<RosterWatch> {
  const started = Date.now();
  const watch: RosterWatch = { registered: null, pid: null, pidAtMs: null, processIdentity: null };
  while (Date.now() - started < timeoutMs && !ended?.()) {
    // The daemon is started by the launcher, never by this watcher: the roster is read only once the daemon exists.
    if ((await daemonPid(claude.executable, env)) !== null) {
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

interface RosterRow {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  sessionId?: unknown;
  pid?: unknown;
  status?: unknown;
  state?: unknown;
}

async function roster(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; rows: RosterRow[] }> {
  try {
    const { stdout } = await execFileAsync(claude.executable, ["agents", "--json"], { env, maxBuffer: 32 * 1024 * 1024 });
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? { ok: true, rows: parsed as RosterRow[] } : { ok: false, rows: [] };
  } catch {
    return { ok: false, rows: [] };
  }
}

function cgroupPath(cgroupFile: string): string {
  const line = cgroupFile.split("\n").find((entry) => entry.startsWith("0::")) ?? "0::";
  return line.slice("0::".length).trim();
}
