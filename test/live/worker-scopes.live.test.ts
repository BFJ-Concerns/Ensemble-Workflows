import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { assertFixedClaudeVersion, daemonStatus, selectClaudeExecutable, supervisorLifecycle, supervisorSnapshot } from "./claude-proof-support.js";

import { resolveAmbientSettings } from "../../src/ambient-settings.js";
import { ClaudeCliControlPlane, type ClaudeSessionHandle } from "../../src/claude-control-plane.js";
import { readProcessStartTicks } from "../../src/process-owner-evidence.js";
import { SystemdWorkerScopes, containingSlice, processTree } from "../../src/worker-scopes.js";
import { heldProbeFollowUpPrompt, heldProbePrompt, probePaths, waitForPath, type HeldProbe } from "./held-worker-probes.js";

const exec = promisify(execFile);
const launcher = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const live = process.env.ENSEMBLE_LIVE === "1";
const claudeModel = process.env.ENSEMBLE_LIVE_CLAUDE_MODEL ?? "haiku";

type Grouping = "worker" | "run";
interface Scenario {
  name: string;
  expected: Grouping;
  config?: Grouping;
  environment?: Grouping;
  flag?: Grouping;
  direct?: "claude" | "codex";
  fallback?: boolean;
  interrupt?: boolean;
  followUp?: boolean;
}

const scenarios: Scenario[] = [
  { name: "worker default", expected: "worker" },
  { name: "machine run grouping", config: "run", expected: "run" },
  { name: "environment overrides machine grouping", config: "run", environment: "worker", expected: "worker" },
  { name: "CLI overrides environment grouping", config: "worker", environment: "worker", flag: "run", expected: "run" },
  { name: "held-session follow-up", expected: "worker", followUp: true },
  { name: "interrupted teardown", expected: "worker", interrupt: true },
  ...(["claude", "codex"] as const).flatMap((direct): Scenario[] => [
    { name: `direct ${direct}`, expected: "worker", direct },
    { name: `unreachable manager ${direct}`, expected: "worker", direct, fallback: true }
  ])
];

for (const scenario of scenarios) {
  test(`built launcher scopes: ${scenario.name}`, { skip: !live ? "ENSEMBLE_LIVE must be 1" : false, timeout: 1_200_000 }, async (t) => {
    assert.ok(process.env.ENSEMBLE_LIVE_CODEX_MODEL || scenario.direct === "claude",
      "UNPROVEN: ENSEMBLE_LIVE_CODEX_MODEL is required for real Codex dispatch");
    await exec("systemctl", ["--user", "show-environment"]).catch((error: unknown) => {
      throw new Error("UNPROVEN: a reachable systemd user manager is required", { cause: error });
    });
    const machineEnvironment = resolveAmbientSettings({ env: process.env, cwd: process.cwd() }).workerEnvironment;
    const claude = scenario.direct === "codex" ? undefined : await selectClaudeExecutable("claude", tmpdir());
    t.after(async () => { await claude?.dispose(); });
    const root = await mkdtemp(path.join(tmpdir(), "ensemble-worker-scopes-live-"));
    const config = path.join(root, "claude");
    const xdg = path.join(root, "config");
    const id = randomUUID().replaceAll("-", "");
    const parent = `ensembleproof${id}.slice`;
    const slice = `ensembleproof${id}-workers.slice`;
    const box = `ensemble-proof-${id}.scope`;
    const engines = scenario.direct ? [scenario.direct] : ["claude", "claude", "codex", "codex"] as const;
    const probes = engines.map((_, index): HeldProbe => ({
      paths: probePaths(root, `first-${index}`), evidence: { kind: "cgroup" }, token: `RELEASED_${randomUUID()}`
    }));
    const follow = engines.map((_, index): HeldProbe => ({
      paths: probePaths(root, `follow-${index}`), evidence: { kind: "cgroup" }, token: `FOLLOW_${randomUUID()}`
    }));
    const sibling: HeldProbe = { paths: probePaths(root, "outside-sibling"), evidence: { kind: "cgroup" }, token: `SIBLING_${randomUUID()}` };
    const units = new Set<string>();
    const observations: Record<string, unknown> = claude ? { claudeExecutable: claude.executable, selectedClaudeVersion: claude.version } : {};
    let run: ReturnType<typeof launch> | undefined;
    let supervisor: number | null = null;
    let supervisorState: Awaited<ReturnType<typeof supervisorSnapshot>> | undefined;
    let siblingScopes: SystemdWorkerScopes | undefined;
    let siblingPlane: ClaudeCliControlPlane | undefined;
    let siblingHandle: ClaudeSessionHandle | undefined;
    const env: NodeJS.ProcessEnv = {
      ...(claude?.env ?? process.env), CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SANDBOXED: "1",
      XDG_CONFIG_HOME: xdg, ENSEMBLE_RUN_RECORD: "on", ENSEMBLE_CONCURRENCY_CLAUDE: "2", ENSEMBLE_CONCURRENCY_CODEX: "2", ENSEMBLE_RUN_RECORD_DIR: path.join(root, "records"),
      ENSEMBLE_STATUS_DIR: path.join(root, "status")
    };
    delete env.ENSEMBLE_WORKER_SCOPE;
    if (scenario.environment) env.ENSEMBLE_WORKER_SCOPE = scenario.environment;
    try {
      await mkdir(config, { mode: 0o700 });
      await mkdir(path.join(root, "status"));
      await mkdir(path.join(xdg, "ensemble"), { recursive: true });
      await writeFile(path.join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
      await writeFile(path.join(config, "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }), { mode: 0o600 });
      await writeFile(path.join(xdg, "ensemble", "config.json"), JSON.stringify({
        schema_version: 1,
        ...(scenario.config ? { worker_scope: scenario.config } : {}),
        worker_environment: {
          ...machineEnvironment,
          ...(claude ? { claude: { ...machineEnvironment.claude, CLAUDE_CONFIG_DIR: config, PATH: claude.env.PATH! } } : {})
        }
      }), { mode: 0o600 });
      if (claude) assert.equal((await daemonStatus(claude.executable, env)).pid, null, "the private config directory already had a daemon");
      const flags = scenario.flag ? [`--worker-scope=${scenario.flag}`] : [];
      let args: string[];
      if (scenario.direct) {
        args = ["agent", `--engine=${scenario.direct}`, `--model=${scenario.direct === "claude" ? claudeModel : process.env.ENSEMBLE_LIVE_CODEX_MODEL}`, ...flags, heldProbePrompt(probes[0]!)];
      } else {
        const script = path.join(root, "workflow.js");
        const calls = engines.map((engine, index) => {
          const options = JSON.stringify({ engine, model: engine === "claude" ? claudeModel : process.env.ENSEMBLE_LIVE_CODEX_MODEL, cwd: root, label: `scope-${index}`, maxAttempts: 1, timeoutMs: 600_000 });
          if (!scenario.followUp) return `agent(${JSON.stringify(heldProbePrompt(probes[index]!))}, ${options})`;
          return `(async () => { const worker = session(${options}); try { const first = await worker.send(${JSON.stringify(heldProbePrompt(probes[index]!))}); const second = await worker.send(${JSON.stringify(heldProbeFollowUpPrompt(follow[index]!))}); return { first, second }; } finally { await worker.close(); } })()`;
        });
        await writeFile(script, `export const meta = { name: "live-worker-scopes" };\nreturn await Promise.all([${calls.join(",\n")}]);\n`);
        args = [...flags, script];
      }
      // The outer systemd client keeps its working bus. Only the launcher and
      // its descendants receive the unreachable address in fallback scenarios.
      const childEnv = scenario.fallback ? ["env", `DBUS_SESSION_BUS_ADDRESS=unix:path=${root}/missing-bus`, `XDG_RUNTIME_DIR=${root}/missing-runtime`] : [];
      run = launch(["--user", "--scope", "--quiet", "--collect", `--unit=${box}`, `--slice=${slice}`, "--", ...childEnv, process.execPath, launcher, ...args], env);
      const firstPaths = await observe(probes, run, engines, env, slice, box, scenario.fallback === true, units);
      observations.first = firstPaths;
      if (claude && engines.includes("claude") && !scenario.fallback) {
        supervisorState = await supervisorSnapshot(claude.executable, env);
        observations.supervisorStartStatus = supervisorState;
        supervisor = supervisorState.identity.pid;
        assert.ok(supervisor !== null, "the launcher did not start the private supervisor");
        assert.equal(supervisorState.selectedVersion, claude.version);
        assertFixedClaudeVersion(supervisorState, supervisorState, "private supervisor startup");
        observations.supervisorBeforeSibling = await knownProcess(supervisor);
        observations.lifecycleBeforeSibling = await supervisorLifecycle(config);
        // An on-demand supervisor intentionally exits after its last client
        // settles. Keep a sibling outside this run alive so teardown must
        // preserve a supervisor that is still serving another session.
        siblingScopes = new SystemdWorkerScopes({ slice: parent, label: `sibling-${id}` });
        siblingPlane = new ClaudeCliControlPlane({
          scopes: siblingScopes,
          claudeBin: claude.executable,
          workerEnv: { ...machineEnvironment.claude, CLAUDE_CONFIG_DIR: config, PATH: claude.env.PATH! },
          projectsDir: path.join(config, "projects")
        });
        siblingHandle = await siblingPlane.dispatch({
          prompt: heldProbePrompt(sibling), name: `sibling-${id}`, cwd: root, model: claudeModel
        });
        await waitForPath(sibling.paths.ready, 420_000);
        const siblingGroup = (await readFile(sibling.paths.evidence, "utf8")).trim().slice(3);
        assert.equal(containingSlice(`0::${siblingGroup}`), parent, "the sibling is inside the tested run's slice");
        const afterSibling = await supervisorSnapshot(claude.executable, env);
        observations.supervisorAfterSibling = afterSibling;
        observations.originalSupervisorAfterSibling = await knownProcess(supervisor);
        observations.afterSiblingTransition = assertFixedClaudeVersion(supervisorState, afterSibling, "starting the outside sibling");
        supervisorState = afterSibling;
        assert.equal(containingSlice(supervisorState.identity.cgroup!), parent, "the supervisor is inside the tested run's slice");
        observations.supervisorBeforeTeardown = supervisorState;
        observations.outsideSibling = { sessionId: siblingHandle.sessionId, cgroup: siblingGroup };
        assert.equal(run.settled, false, "launcher settled before supervisor observation");
      }
      if (claude && engines.includes("claude") && scenario.fallback) {
        const fallbackSupervisor = await supervisorSnapshot(claude.executable, env);
        observations.fallbackSupervisor = fallbackSupervisor;
        assert.equal(fallbackSupervisor.selectedVersion, claude.version);
        assertFixedClaudeVersion(fallbackSupervisor, fallbackSupervisor, "fallback supervisor startup");
      }
      if (scenario.direct === undefined) assert.equal(new Set(firstPaths).size, scenario.expected === "run" ? 1 : 3);
      if (scenario.interrupt) {
        // Signal the launcher, not systemd-run's wrapper or the workers.
        const members = (await readFile(`/sys/fs/cgroup${await property(box, "ControlGroup")}/cgroup.procs`, "utf8")).trim().split(/\s+/).map(Number);
        const launcherPid = await findNode(members);
        process.kill(launcherPid, "SIGINT");
      } else {
        await Promise.all(probes.map((probe) => writeFile(probe.paths.release, "")));
        if (scenario.followUp) {
          const next = await observe(follow, run, engines, env, slice, box, false, units);
          observations.followUp = next;
          assert.deepEqual(next, firstPaths, "held sessions changed scope between turns");
          await Promise.all(follow.map((probe) => writeFile(probe.paths.release, "")));
        }
      }
      const result = await run.result;
      observations.result = result;
      if (scenario.interrupt) assert.notEqual(result.code, 0, JSON.stringify(result));
      else {
        assert.equal(result.code, 0, JSON.stringify(result));
        for (const probe of [...probes, ...(scenario.followUp ? follow : [])]) assert.ok(result.stdout.includes(probe.token), JSON.stringify(result));
      }
      const recordStore = path.join(root, "records");
      const manifests = (await readdir(recordStore, { recursive: true })).filter(entry => path.basename(entry) === "manifest.json");
      assert.equal(manifests.length, 1, "the launcher must write one real run manifest");
      const manifest = JSON.parse(await readFile(path.join(recordStore, manifests[0]!), "utf8")) as {
        schema_version: number;
        worker_scope: { value: Grouping; layer: string };
        cli_flags: { workerScope?: Grouping };
      };
      assert.equal(manifest.schema_version, 4);
      assert.deepEqual(manifest.worker_scope, {
        value: scenario.expected,
        layer: scenario.flag ? "flag" : scenario.environment ? "env" : scenario.config ? "config-file" : "default"
      });
      if (scenario.flag) assert.equal(manifest.cli_flags.workerScope, scenario.flag);
      else assert.equal(Object.hasOwn(manifest.cli_flags, "workerScope"), false);
      observations.manifestSettings = { schema_version: manifest.schema_version, worker_scope: manifest.worker_scope, cli_flags: manifest.cli_flags };
      for (const unit of units) await waitInactive(unit);
      if (claude && supervisor !== null) {
        const after = await supervisorSnapshot(claude.executable, env);
        observations.supervisorAfterTeardown = after;
        observations.afterTeardownTransition = assertFixedClaudeVersion(supervisorState!, after, "worker teardown");
        supervisorState = after;
        assert.equal(containingSlice(after.identity.cgroup!), parent, "the supervisor moved into the tested run's slice");
        const { stdout } = await exec(claude.executable, ["agents", "--json"], { env, maxBuffer: 32 * 1024 * 1024 });
        const rows = JSON.parse(stdout) as { sessionId?: string; pid?: number }[];
        assert.ok(Array.isArray(rows), "the surviving supervisor cannot serve its roster");
        const siblingRow = rows.find((row) => row.sessionId === siblingHandle!.sessionId);
        assert.ok(typeof siblingRow?.pid === "number", "worker teardown lost the outside sibling");
        const siblingGroup = (await readFile(`/proc/${siblingRow.pid}/cgroup`, "utf8")).trim().slice(3);
        assert.equal(containingSlice(`0::${siblingGroup}`), parent, "the outside sibling moved into the tested run");
        assert.equal((await siblingPlane!.poll(siblingHandle!)).state, "working", "worker teardown settled the outside sibling");
        const afterRoster = await supervisorSnapshot(claude.executable, env);
        observations.supervisorAfterRoster = afterRoster;
        observations.afterRosterTransition = assertFixedClaudeVersion(supervisorState, afterRoster, "roster access");
        supervisorState = afterRoster;
        assert.equal(containingSlice(afterRoster.identity.cgroup!), parent, "the supervisor moved into the tested run's slice");
      }
    } finally {
      // Capture before releasing held workers or stopping proof-owned units:
      // teardown would otherwise hide why the original supervisor ended.
      if (claude && supervisor !== null) {
        observations.supervisorBeforeCleanup = await daemonStatus(claude.executable, env);
        observations.originalSupervisorBeforeCleanup = await knownProcess(supervisor);
        observations.lifecycleBeforeCleanup = await supervisorLifecycle(config);
        observations.upgradeRestarts = (observations.lifecycleBeforeCleanup as Record<string, string>[]).filter(row => row.event === "shutdown" && row.cause === "upgrade");
      }
      await Promise.all([...probes, ...follow, sibling].map((probe) => writeFile(probe.paths.release, "")));
      await exec("systemctl", ["--user", "stop", box, slice, ...units]).catch(() => undefined);
      if (run) observations.result = await run.result;
      if (siblingPlane && siblingHandle) await siblingPlane.stop(siblingHandle);
      if (siblingScopes) await siblingScopes.close();
      if (claude) await exec(claude.executable, ["daemon", "stop", "--any"], { env }).catch(() => undefined);
      await exec("systemctl", ["--user", "stop", slice, parent]).catch(() => undefined);
      t.diagnostic(JSON.stringify(observations));
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function observe(probes: HeldProbe[], run: ReturnType<typeof launch>, engines: readonly string[], env: NodeJS.ProcessEnv, slice: string, box: string, fallback: boolean, units: Set<string>): Promise<string[]> {
  await Promise.all(probes.map(async (probe) => {
    const deadline = Date.now() + 420_000;
    for (;;) {
      if (run.settled) throw new Error(`launcher settled before handshake: ${JSON.stringify(await run.result)}`);
      try {
        await waitForPath(probe.paths.ready, 250);
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
    }
  }));
  assert.equal(run.settled, false, "worker settled before release");
  const raw = await Promise.all(probes.map((probe) => readFile(probe.paths.evidence, "utf8")));
  const groups = raw.map((value) => {
    assert.match(value, /^0::\/\S+\n?$/);
    return value.trim().slice(3);
  });
  for (const group of groups) {
    assert.equal(containingSlice(`0::${group}`), slice);
    const unit = path.basename(group);
    if (fallback) {
      assert.match(unit, /^ensemble-proof-.*\.scope$/, "fallback unexpectedly created a worker scope");
      continue;
    }
    units.add(unit);
    assert.match(unit, /^ensemble-\d+-.*\.scope$/);
    assert.equal(await property(unit, "Slice"), slice);
    assert.equal(await property(unit, "ControlGroup"), group);
    assert.equal(await property(unit, "Delegate"), "yes");
    assert.equal(await property(unit, "ActiveState"), "active");
  }
  if (engines.includes("claude")) {
    const { stdout } = await exec("claude", ["agents", "--json"], { env, maxBuffer: 32 * 1024 * 1024 });
    const rows = JSON.parse(stdout) as { pid?: number; kind?: string }[];
    const memberships = await Promise.all(rows.filter((row) => row.kind === "background" && typeof row.pid === "number").map(async (row) => ({ pid: row.pid!, group: (await readFile(`/proc/${row.pid}/cgroup`, "utf8")).trim().slice(3) })));
    assert.ok(memberships.length >= engines.filter((engine) => engine === "claude").length, "roster is missing concurrent Claude workers");
    for (const [index, engine] of engines.entries()) {
      if (engine === "claude") assert.ok(memberships.some((row) => row.group === groups[index]), `roster does not witness ${groups[index]}: ${JSON.stringify(memberships)}`);
    }
    if (!fallback && new Set(groups).size > 1) assert.notEqual(groups[0], groups[1], "Claude workers share a worker scope");
  }
  if (engines.includes("codex")) {
    const members = (await readFile(`/sys/fs/cgroup${await property(box, "ControlGroup")}/cgroup.procs`, "utf8")).trim().split(/\s+/).map(Number);
    const descendants = await processTree(await findNode(members));
    const codexGroups: string[] = [];
    for (const pid of descendants) {
      const comm = (await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")).trim();
      if (comm === "codex") codexGroups.push((await readFile(`/proc/${pid}/cgroup`, "utf8")).trim().slice(3));
    }
    assert.ok(codexGroups.includes(groups[engines.indexOf("codex")]!), `no launcher-owned Codex process witnesses worker evidence: ${JSON.stringify(codexGroups)}`);
  }
  if (engines.filter((engine) => engine === "codex").length === 2) assert.equal(groups[2], groups[3], "Codex threads do not share their app-server scope");
  return groups;
}

async function property(unit: string, name: string): Promise<string> {
  return (await exec("systemctl", ["--user", "show", unit, `--property=${name}`, "--value"])).stdout.trim();
}

async function findNode(pids: number[]): Promise<number> {
  for (const pid of pids) if (await readlink(`/proc/${pid}/exe`).catch(() => "") === process.execPath) return pid;
  throw new Error(`no launcher node process in box: ${pids}`);
}

async function waitInactive(unit: string): Promise<void> {
  // This is a hang guard, not a ten-second stop deadline: systemd may wait
  // for its configured TimeoutStopSec before terminating remaining members.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const state = await property(unit, "ActiveState").catch(() => "not-found");
    if (["inactive", "failed", "not-found"].includes(state)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${unit} survived launcher teardown`);
}

function launch(args: string[], env: NodeJS.ProcessEnv): { settled: boolean; result: Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> } {
  const child = spawn("systemd-run", args, { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const run = { settled: false, result: Promise.resolve({ code: null as number | null, signal: null as string | null, stdout: "", stderr: "" }) };
  run.result = new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { run.settled = true; resolve({ code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}` }); });
    child.on("close", (code, signal) => { run.settled = true; resolve({ code, signal, stdout, stderr }); });
  });
  return run;
}

/** Identity and membership of an already identified supervisor, never PID discovery. */
async function knownProcess(pid: number): Promise<{ startTicks: string | null; cgroup: string | null }> {
  const [startTicks, cgroup] = await Promise.all([
    readProcessStartTicks("/proc", pid),
    readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => null)
  ]);
  return { startTicks, cgroup };
}
