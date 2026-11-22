import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { StopUnconfirmedError } from "../../src/errors.js";
import {
  NoWorkerScopes,
  SystemdWorkerScopes,
  cgroupEmpty,
  containingSlice,
  createWorkerScopes,
  isLive,
  parentSlice,
  processTree,
  unitObjectPath
} from "../../src/worker-scopes.js";

import { waitForCondition as waitFor } from "../wait-for-condition.js";

const execFileAsync = promisify(execFile);

test("containingSlice names the nearest slice below the user manager and nothing above it", () => {
  const userManager = "/user.slice/user-1000.slice/user@1000.service";
  assert.equal(containingSlice(`0::${userManager}/agents.slice/claude-daemon-4173082.scope\n`), "agents.slice");
  assert.equal(containingSlice(`0::${userManager}/app.slice/app-foot.slice/pane.scope\n`), "app-foot.slice");
  assert.equal(containingSlice(`0::${userManager}/agents.slice\n`), "agents.slice");
  // Directly in the user manager: the slices above it are the system manager's, never the answer.
  assert.equal(containingSlice(`0::${userManager}/init.scope\n`), "-.slice");
  assert.equal(containingSlice(`0::${userManager}\n`), "-.slice");
  // Outside any user manager, or an unreadable file.
  assert.equal(containingSlice("0::/system.slice/foo.service\n"), null);
  assert.equal(containingSlice("0::/\n"), null);
  assert.equal(containingSlice(""), null);
});

test("parentSlice follows systemd's nesting-by-name", () => {
  assert.equal(parentSlice("agents-run1.slice"), "agents.slice");
  assert.equal(parentSlice("app-foot-bar.slice"), "app-foot.slice");
  assert.equal(parentSlice("agents.slice"), "-.slice");
  assert.equal(parentSlice("app.slice"), "-.slice");
  assert.equal(parentSlice("-.slice"), "-.slice");
});

test("unit names carry the label and group made unit-name safe", () => {
  const scopes = new SystemdWorkerScopes({ label: "run 7" });
  assert.equal(scopes.unitFor("worker-3"), "ensemble-run_7-worker-3.scope");
  assert.equal(scopes.unitFor("agent/α β"), "ensemble-run_7-agent____.scope");
});

test("place puts live processes in one delegated scope per group under the launcher's slice, and close ends them", async () => {
  const slice = await ownSlice();
  const scopes = new SystemdWorkerScopes({ slice, label: `test-${process.pid}` });
  const first = sleeper();
  const second = sleeper();
  const other = sleeper();
  try {
    const placed = await scopes.place("worker-1", [first.pid!]);
    assert.equal(placed.kind, "placed", JSON.stringify(placed));
    assert.ok(placed.kind === "placed");
    assert.equal(placed.unit, scopes.unitFor("worker-1"));
    assert.equal(await cgroupUnit(first.pid!), placed.unit);

    // A later member joins the same scope: the manager migrates into it only because it is delegated.
    const joined = await scopes.place("worker-1", [second.pid!]);
    assert.ok(joined.kind === "placed", JSON.stringify(joined));
    assert.equal(await cgroupUnit(second.pid!), placed.unit);

    const elsewhere = await scopes.place("worker-2", [other.pid!]);
    assert.ok(elsewhere.kind === "placed", JSON.stringify(elsewhere));
    assert.notEqual(elsewhere.unit, placed.unit);
    assert.equal(await cgroupUnit(other.pid!), elsewhere.unit);

    const shown = await execFileAsync("systemctl", ["--user", "show", placed.unit, "-p", "Slice,Delegate,ActiveState,CollectMode"]);
    assert.match(shown.stdout, /^Delegate=yes$/m);
    assert.match(shown.stdout, /^CollectMode=inactive-or-failed$/m, "failed worker scopes must be collected by the user manager");
    assert.match(shown.stdout, /^ActiveState=active$/m);
    if (slice !== null) {
      assert.match(shown.stdout, new RegExp(`^Slice=${slice.replace(".", "\\.")}$`, "m"));
    }

    await scopes.close();
    await waitFor(() => !isLive(first.pid!) && !isLive(second.pid!) && !isLive(other.pid!), "scope members ended by close()");
    assert.deepEqual(await scopes.place("worker-3", [process.pid]), { kind: "refused", reason: "the scope manager is closed" });
  } finally {
    for (const child of [first, second, other]) {
      child.kill("SIGKILL");
    }
    await scopes.close();
  }
});

test("close stops a scope whose placement was still pending when close began", async () => {
  // The manager's bus call is held in flight by a busctl that reports when
  // it has started and waits to be released: close() begins only once the
  // call is known to be in flight, and the call is released only once
  // close() has begun. The race is established by handshake, not timing —
  // the placement cannot complete before close starts, and close cannot
  // start before the placement is at the manager. The hold has a ceiling
  // only so a hung test ends; reaching it fails the call rather than
  // making it, since a call made without the release would let the
  // placement complete before close began and the test pass on a product
  // that never waited.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-held-busctl-"));
  const heldBusctl = path.join(dir, "busctl");
  const inFlight = path.join(dir, "in-flight");
  const release = path.join(dir, "release");
  await writeFile(
    heldBusctl,
    [
      "#!/bin/sh",
      `touch "${inFlight}"`,
      "i=0",
      `while [ ! -e "${release}" ]; do`,
      "  if [ $i -ge 1200 ]; then",
      '    echo "held busctl: not released within 60 s; the call was not made" >&2',
      "    exit 1",
      "  fi",
      "  sleep 0.05",
      "  i=$((i+1))",
      "done",
      'exec busctl "$@"',
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  const scopes = new SystemdWorkerScopes({ slice: await ownSlice(), label: `drain-${process.pid}`, busctlBin: heldBusctl });
  const member = sleeper();
  try {
    const pending = scopes.place("late", [member.pid!]);
    await waitFor(() => existsSync(inFlight), "the placement's bus call to be in flight");
    const closing = scopes.close();
    await writeFile(release, "");
    await closing;
    const outcome = await pending;
    // The manager accepted the placement after close began, so close must
    // have waited for it and stopped the scope it produced: the member is
    // ended and the scope is not left active.
    assert.equal(outcome.kind, "placed", JSON.stringify(outcome));
    await waitFor(() => !isLive(member.pid!), "a process placed while close ran to be ended by it");
    const shown = await execFileAsync("systemctl", ["--user", "show", scopes.unitFor("late"), "-p", "ActiveState"]);
    assert.doesNotMatch(shown.stdout, /^ActiveState=active$/m, "the scope created during close was left active");
  } finally {
    member.kill("SIGKILL");
    await scopes.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop ends one group's scope, confirms it empty and releases the group, leaving every other group running", async () => {
  const scopes = new SystemdWorkerScopes({ slice: await ownSlice(), label: `test-${process.pid}-stop` });
  const stopped = sleeper();
  const kept = sleeper();
  try {
    const first = await scopes.place("worker-1", [stopped.pid!]);
    const second = await scopes.place("worker-2", [kept.pid!]);
    assert.ok(first.kind === "placed" && second.kind === "placed", JSON.stringify([first, second]));
    const stoppedScope = await cgroupDirectory(stopped.pid!);
    const keptScope = await cgroupDirectory(kept.pid!);

    // What stop and close promise is read from the scope's cgroup the moment
    // they return. Whether the process still answers a signal is not: the
    // kernel empties the cgroup before the process becomes a zombie, and the
    // zombie answers until this test's event loop reaps it, which a loaded
    // machine can delay past the return.
    assert.deepEqual(await scopes.stop("worker-1"), { kind: "stopped" });
    assert.equal(await cgroupEmpty(stoppedScope), true, "stopped is an observation: the scope is empty when stop returns");
    await waitFor(() => !isLive(stopped.pid!), "the stopped scope's process to be reaped");
    assert.equal(isLive(kept.pid!), true);
    assert.equal(await cgroupUnit(kept.pid!), second.unit);
    assert.equal(await cgroupEmpty(keptScope), false);
    // A group with no scope has nothing of the manager's to stop, whether it was released or never placed.
    assert.deepEqual(await scopes.stop("worker-1"), { kind: "stopped" });
    assert.deepEqual(await scopes.stop("never-placed"), { kind: "stopped" });

    await scopes.close();
    assert.equal(await cgroupEmpty(keptScope), true, "close returns only once every scope is empty");
    await waitFor(() => !isLive(kept.pid!), "the closed scope's process to be reaped");
  } finally {
    for (const child of [stopped, kept]) {
      child.kill("SIGKILL");
    }
    await scopes.close();
  }
});

test("a scope whose emptiness cannot be observed is reported unconfirmed, stays owned, and fails close by name", async () => {
  // `false` stands in for a systemctl that cannot reach the manager: the
  // stop has no cgroup to read, and says so instead of assuming the best.
  const scopes = new SystemdWorkerScopes({ slice: await ownSlice(), label: `test-${process.pid}-unconfirmed`, systemctlBin: "false" });
  const member = sleeper();
  try {
    const placed = await scopes.place("worker-1", [member.pid!]);
    assert.ok(placed.kind === "placed", JSON.stringify(placed));

    const outcome = await scopes.stop("worker-1", { stopGraceMs: 50, confirmMs: 50 });
    assert.equal(outcome.kind, "unconfirmed", JSON.stringify(outcome));
    assert.ok(outcome.kind === "unconfirmed");
    assert.match(outcome.reason, new RegExp(`^the manager did not report the processes of ${placed.unit.replaceAll(".", "\\.")}: `));
    assert.equal(isLive(member.pid!), true, "nothing was signalled on the strength of a guess");

    await assert.rejects(scopes.close(), (error: unknown) => {
      assert.ok(error instanceof StopUnconfirmedError);
      assert.deepEqual(error.unconfirmed.map(({ owner }) => owner), [placed.unit]);
      return true;
    });
  } finally {
    member.kill("SIGKILL");
  }
});

test("place refuses processes that already exited and drops them from a mixed list", async () => {
  const scopes = new SystemdWorkerScopes({ slice: await ownSlice(), label: `exit-${process.pid}` });
  const gone = sleeper();
  const live = sleeper();
  try {
    gone.kill("SIGKILL");
    await new Promise<void>((resolve) => gone.once("exit", () => resolve()));

    assert.deepEqual(await scopes.place("dead", [gone.pid!]), {
      kind: "refused",
      reason: "every process to place had already exited"
    });
    const mixed = await scopes.place("mixed", [gone.pid!, live.pid!]);
    assert.ok(mixed.kind === "placed", JSON.stringify(mixed));
    assert.deepEqual(mixed.pids, [live.pid]);
    assert.equal(await cgroupUnit(live.pid!), mixed.unit);
  } finally {
    live.kill("SIGKILL");
    await scopes.close();
  }
});

test("a process that exits while a new scope's job moves the list never leaves the placement in a failed scope", async () => {
  // The user manager answers StartTransientUnit before its job moves the
  // processes; a listed process that exits inside that job fails the scope
  // ("Failed to add PIDs to scope's control group: No such process") with
  // the processes that did arrive still in it. The kernel's window for that
  // exit cannot be hit on demand, so a stand-in manager plays the job: on
  // the first creation it ends the listed victim, moves the survivor and
  // reports the unit failed, as the real manager did. Later creations move
  // the list and report the unit active.
  const manager = await standInManager({ failEveryStart: false });
  const victim = sleeper();
  const survivor = sleeper();
  try {
    await writeFile(manager.victimFile, String(victim.pid));
    const scopes = new SystemdWorkerScopes({ label: "race", busctlBin: manager.busctl, systemctlBin: manager.systemctl, procDir: manager.procDir, cgroupRoot: manager.cgroupRoot });
    const outcome = await scopes.place("worker-1", [victim.pid!, survivor.pid!]);

    assert.equal(isLive(victim.pid!), false, "the stand-in ended a listed process during the move");
    const failed = scopes.unitFor("worker-1");
    assert.equal(outcome.kind, "placed", JSON.stringify(outcome));
    assert.ok(outcome.kind === "placed");
    assert.notEqual(outcome.unit, failed, "the placement named the scope the manager failed");
    assert.equal(outcome.unit, "ensemble-race-worker-1:1.scope");
    assert.deepEqual(outcome.pids, [survivor.pid]);
    assert.equal(await manager.state(outcome.unit), "active");
    assert.equal(await manager.cgroupUnit(survivor.pid!), outcome.unit);
    assert.deepEqual(await manager.calls(), [
      `start ${failed} ${victim.pid} ${survivor.pid}`,
      `start ${outcome.unit} ${survivor.pid}`
    ]);

    // The group's later members join the replacement, not the failed scope.
    const later = sleeper();
    try {
      const joined = await scopes.place("worker-1", [later.pid!]);
      assert.deepEqual(joined, { kind: "placed", unit: outcome.unit, pids: [later.pid] });
      assert.equal((await manager.calls()).at(-1), `attach ${outcome.unit} ${later.pid}`);

      await scopes.close();
      assert.equal(isLive(survivor.pid!), false, "close ended the replacement scope's processes");
      assert.equal(isLive(later.pid!), false);
    } finally {
      later.kill("SIGKILL");
    }
  } finally {
    victim.kill("SIGKILL");
    survivor.kill("SIGKILL");
    await rm(manager.dir, { recursive: true, force: true });
  }
});

test("a placement whose every scope the manager fails is refused, never placed, and its failed scopes stay owned", async () => {
  const manager = await standInManager({ failEveryStart: true });
  const member = sleeper();
  const other = sleeper();
  try {
    const scopes = new SystemdWorkerScopes({ label: "doomed", busctlBin: manager.busctl, systemctlBin: manager.systemctl, procDir: manager.procDir, cgroupRoot: manager.cgroupRoot });
    const outcome = await scopes.place("worker-1", [member.pid!]);
    assert.deepEqual(outcome, { kind: "refused", reason: "the manager left ensemble-doomed-worker-1:2.scope failed after moving its processes" });
    assert.equal((await manager.calls()).length, 3, "each attempt created a scope of its own name");
    assert.equal(new Set(await manager.calls()).size, 3);
    assert.equal(isLive(member.pid!), true, "a refused placement signals nothing");

    // The member is left in the last scope the manager failed, which the
    // scope manager still owns: stopping the group ends it.
    assert.equal(await manager.cgroupUnit(member.pid!), "ensemble-doomed-worker-1:2.scope");
    assert.deepEqual(await scopes.stop("worker-1", { stopGraceMs: 2_000, confirmMs: 2_000 }), { kind: "stopped" });
    assert.equal(isLive(member.pid!), false, "stop ended the process left in a failed scope");

    // Close reaches a refused group's failed scopes as well.
    assert.equal((await scopes.place("worker-2", [other.pid!])).kind, "refused");
    await scopes.close();
    assert.equal(isLive(other.pid!), false, "close ended the process left in a failed scope");
  } finally {
    member.kill("SIGKILL");
    other.kill("SIGKILL");
    await rm(manager.dir, { recursive: true, force: true });
  }
});

test("unitObjectPath escapes a unit name as the manager's bus labels do", () => {
  assert.equal(unitObjectPath("default.target"), "/org/freedesktop/systemd1/unit/default_2etarget");
  assert.equal(unitObjectPath("ensemble-7-run:1.scope"), "/org/freedesktop/systemd1/unit/ensemble_2d7_2drun_3a1_2escope");
  assert.equal(unitObjectPath("1x.scope"), "/org/freedesktop/systemd1/unit/_31x_2escope");
});

test("concurrent first placements for one group share one scope", async () => {
  const scopes = new SystemdWorkerScopes({ slice: await ownSlice(), label: `race-${process.pid}` });
  const members = [sleeper(), sleeper(), sleeper()];
  try {
    const outcomes = await Promise.all(members.map((member) => scopes.place("run", [member.pid!])));
    for (const outcome of outcomes) {
      assert.ok(outcome.kind === "placed", JSON.stringify(outcome));
      assert.equal(outcome.unit, scopes.unitFor("run"));
    }
    for (const member of members) {
      assert.equal(await cgroupUnit(member.pid!), scopes.unitFor("run"));
    }
  } finally {
    for (const member of members) {
      member.kill("SIGKILL");
    }
    await scopes.close();
  }
});

test("launch runs a command outside the launcher's slice with its streams, environment and exit status intact", async () => {
  const slice = await ownSlice();
  const scopes = new SystemdWorkerScopes({ slice, label: `launch-${process.pid}` });
  const probe = `read x; echo "in=$x probe=$ENSEMBLE_LAUNCH_PROBE"; cat /proc/self/cgroup; echo oops >&2; exit 3`;
  const child = await scopes.launch("sh", ["-c", probe], {
    env: { ...process.env, ENSEMBLE_LAUNCH_PROBE: "seen" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const result = await collect(child, "hello\n");
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stderr.trim(), "oops");
  const [echoed, cgroup] = result.stdout.trim().split("\n");
  assert.equal(echoed, "in=hello probe=seen");
  const ownCgroup = (await readFile("/proc/self/cgroup", "utf8")).trim();
  assert.notEqual(cgroup, ownCgroup, "the command ran in the launcher's own cgroup");
  assert.doesNotMatch(cgroup ?? "", /ensemble-/, "the command landed in a worker scope the manager owns");
  // Outside the box the launcher's slice draws: a sibling scope inside that
  // slice would still share its memory limit and die with it. The command
  // lands in the parent slice instead (the user manager's root for a
  // top-level slice, where the path has no slice segment at all).
  const segments = (cgroup ?? "").split("/");
  if (slice !== null) {
    assert.ok(!segments.includes(slice), `the command stayed inside the launcher's slice ${slice}: ${cgroup}`);
    const parent = parentSlice(slice);
    assert.ok(
      parent === "-.slice" ? segments.at(-2)?.endsWith(".service") : segments.includes(parent),
      `the command did not land in ${parent}: ${cgroup}`
    );
  }
  await scopes.close();
});

test("launch hands back the command's own process, so signalling it reaches the command and nothing else", async () => {
  // `systemd-run --scope` execs the command in place. Cancellation
  // (`runOwnedCommand`) signals this pid alone and relies on it being the
  // command's: were the wrapper to fork instead, signalling it would leave
  // the command running.
  const scopes = new SystemdWorkerScopes({ slice: await ownSlice(), label: `exec-${process.pid}` });
  // The command's own pid is the first field of its stat file; no `$` in the
  // arguments, which systemd-run would expand.
  const child = await scopes.launch("cat", ["/proc/self/stat"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const result = await collect(child, "");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(Number(result.stdout.split(" ")[0]), child.pid);
  await scopes.close();
});

test("without a reachable user manager, placement is unavailable and launch runs the command in place", async () => {
  // No bus address and no runtime directory: busctl cannot find the user manager.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const scopes = await createWorkerScopes({ env });
  assert.equal(scopes.constructor, NoWorkerScopes);
  assert.equal(scopes.slice, null);
  assert.deepEqual(await scopes.place("worker-1", [process.pid]), { kind: "unavailable" });
  const child = await scopes.launch("cat", ["/proc/self/cgroup"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const result = await collect(child, "");
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), (await readFile("/proc/self/cgroup", "utf8")).trim());
  await scopes.close();
});

test("createWorkerScopes discovers the launcher's slice where the user manager answers", async () => {
  const scopes = await createWorkerScopes();
  assert.equal(scopes.constructor, SystemdWorkerScopes);
  // Read independently of containingSlice: the last slice segment below the
  // user manager's service in this process's own cgroup path. Direct children
  // of the user manager belong to its root slice.
  const segments = (await readFile("/proc/self/cgroup", "utf8")).trim().slice("0::".length).split("/");
  const managerIndex = segments.findIndex((segment) => /^user@\d+\.service$/.test(segment));
  const below = managerIndex < 0 ? [] : segments.slice(managerIndex + 1);
  const expected = managerIndex < 0 ? null : below.filter((segment) => segment.endsWith(".slice")).at(-1) ?? "-.slice";
  assert.equal(scopes.slice, expected);
});

test("root-slice launchers keep workers and control commands in the root slice", async () => {
  const moduleUrl = new URL("../../src/worker-scopes.js", import.meta.url).href;
  const script = `
    import { createWorkerScopes } from ${JSON.stringify(moduleUrl)};
    import { spawn, execFile } from "node:child_process";
    import { once } from "node:events";
    import { readFile } from "node:fs/promises";
    import { promisify } from "node:util";
    const scopes = await createWorkerScopes();
    const worker = spawn("sleep", ["infinity"], { stdio: "ignore" });
    try {
      const placement = await scopes.place("root", [worker.pid]);
      if (placement.kind !== "placed") throw new Error(JSON.stringify(placement));
      const workerSlice = await promisify(execFile)("systemctl", ["--user", "show", placement.unit, "--property=Slice", "--value"]);
      const control = await scopes.launch("cat", ["/proc/self/cgroup"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let controlCgroup = "", controlError = "";
      control.stdout.setEncoding("utf8").on("data", chunk => { controlCgroup += chunk; });
      control.stderr.setEncoding("utf8").on("data", chunk => { controlError += chunk; });
      const [controlCode] = await once(control, "close");
      console.log(JSON.stringify({
        launcherCgroup: await readFile("/proc/self/cgroup", "utf8"),
        workerCgroup: await readFile("/proc/" + worker.pid + "/cgroup", "utf8"),
        workerSlice: workerSlice.stdout.trim(), controlCgroup, controlCode, controlError
      }));
    } finally {
      await scopes.close();
      worker.kill("SIGKILL");
    }
  `;
  const result = await execFileAsync("systemd-run", [
    "--user", "--scope", "--quiet", "--collect", "--slice=-.slice", "--",
    process.execPath, "--input-type=module", "-e", script
  ]);
  const observed = JSON.parse(result.stdout) as {
    launcherCgroup: string; workerCgroup: string; workerSlice: string;
    controlCgroup: string; controlCode: number; controlError: string;
  };
  assert.equal(observed.workerSlice, "-.slice", "the worker escaped the root slice into the manager's default slice");
  assert.equal(containingSlice(observed.launcherCgroup), "-.slice");
  assert.equal(containingSlice(observed.workerCgroup), "-.slice");
  assert.equal(observed.controlCode, 0, observed.controlError);
  assert.equal(containingSlice(observed.controlCgroup), "-.slice");
  assert.notEqual(observed.controlCgroup, observed.launcherCgroup, "the control command ran in the launcher's own scope");
});

test("processTree lists a process with every live descendant", async () => {
  const parent = spawn("sh", ["-c", "sleep infinity & sleep infinity & wait"], { stdio: "ignore" });
  try {
    let tree: number[] = [];
    await waitFor(async () => (tree = await processTree(parent.pid!)).length === 3, "two sleep children");
    assert.equal(tree[0], parent.pid);
    const children = await execFileAsync("pgrep", ["-P", String(parent.pid)]);
    assert.deepEqual(
      tree.slice(1).sort((a, b) => a - b),
      children.stdout.trim().split("\n").map(Number).sort((a, b) => a - b)
    );
  } finally {
    await execFileAsync("pkill", ["-KILL", "-P", String(parent.pid)]).catch(() => undefined);
    parent.kill("SIGKILL");
  }
});

/**
 * A stand-in for the user manager, driven through the `busctl` and
 * `systemctl` seams, with its own proc directory for the cgroup lines it
 * writes and its own cgroup root, where each unit's `cgroup.events` says
 * whether a live process still names it. It keeps each unit's
 * `ActiveState`, ends a unit's processes on `KillUnit`, and logs every
 * creation and attachment as `start|attach <unit> <pids…>`. A process whose pid is in `victimFile` is
 * killed inside the first creation that lists it, and that unit is failed
 * with the rest moved into it; with `failEveryStart`, every creation fails
 * so. An attachment to a unit that is not active is refused, as the manager
 * refuses one.
 */
async function standInManager(options: { failEveryStart: boolean }) {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-stand-in-manager-"));
  const procDir = path.join(dir, "proc");
  const states = path.join(dir, "states");
  const log = path.join(dir, "calls");
  const victimFile = path.join(dir, "victim");
  const busctl = path.join(dir, "busctl");
  const systemctl = path.join(dir, "systemctl");
  const cgroupRoot = path.join(dir, "cgroup");
  await writeFile(
    systemctl,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const unit = process.argv.at(-1);
if (process.argv.includes("--property=ControlGroup") && fs.existsSync(path.join(${JSON.stringify(states)}, unit))) {
  process.stdout.write("/stand-in.slice/" + unit + "\\n");
}
`,
    { mode: 0o755 }
  );
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const [, , ...args] = process.argv;
const method = args[2] === "get-property" ? "get-property" : args[6];
const states = ${JSON.stringify(states)};
const live = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const move = (unit, pids) => {
  for (const pid of pids.filter(live)) {
    fs.mkdirSync(path.join(${JSON.stringify(procDir)}, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(${JSON.stringify(procDir)}, String(pid), "cgroup"), "0::/stand-in.slice/" + unit + "\\n");
  }
};
const state = (unit) => { try { return fs.readFileSync(path.join(states, unit), "utf8"); } catch { return "inactive"; } };
const members = (unit) => fs.readdirSync(${JSON.stringify(procDir)}).map(Number).filter((pid) => live(pid) &&
  fs.readFileSync(path.join(${JSON.stringify(procDir)}, String(pid), "cgroup"), "utf8").trim().endsWith("/" + unit));
const refresh = () => {
  for (const unit of fs.existsSync(states) ? fs.readdirSync(states) : []) {
    const dir = path.join(${JSON.stringify(cgroupRoot)}, "stand-in.slice", unit);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cgroup.events"), "populated " + (members(unit).length > 0 ? 1 : 0) + "\\n");
  }
};
const reaped = (pid) => {
  const until = Date.now() + 10000;
  while (live(pid) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
};
if (method === "get-property") {
  const unit = args[4].slice("/org/freedesktop/systemd1/unit/".length).replace(/_([0-9a-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  process.stdout.write('s "' + state(unit) + '"\\n');
} else if (method === "StartTransientUnit") {
  const unit = args[8];
  const count = Number(args[13]);
  const pids = args.slice(14, 14 + count).map(Number);
  fs.appendFileSync(${JSON.stringify(log)}, ["start", unit, ...pids].join(" ") + "\\n");
  let victim = null;
  try { victim = Number(fs.readFileSync(${JSON.stringify(victimFile)}, "utf8")); } catch {}
  let fail = ${options.failEveryStart};
  if (victim !== null && pids.includes(victim)) {
    process.kill(victim, "SIGKILL");
    reaped(victim);
    fs.rmSync(${JSON.stringify(victimFile)});
    fail = true;
  }
  move(unit, pids);
  fs.mkdirSync(states, { recursive: true });
  fs.writeFileSync(path.join(states, unit), fail ? "failed" : "active");
  refresh();
  process.stdout.write('o "/org/freedesktop/systemd1/job/1"\\n');
} else if (method === "AttachProcessesToUnit") {
  const unit = args[8];
  const pids = args.slice(11, 11 + Number(args[10])).map(Number);
  fs.appendFileSync(${JSON.stringify(log)}, ["attach", unit, ...pids].join(" ") + "\\n");
  if (state(unit) !== "active") {
    process.stderr.write("Call failed: Unit " + unit + " is not active, refusing.\\n");
    process.exit(1);
  }
  move(unit, pids);
  refresh();
} else if (method === "KillUnit") {
  for (const pid of members(args[8])) {
    process.kill(pid, Number(args[10]));
    reaped(pid);
  }
  refresh();
} else {
  process.stderr.write("stand-in manager: unexpected call " + args.join(" ") + "\\n");
  process.exit(1);
}
`;
  await writeFile(busctl, script, { mode: 0o755 });
  return {
    dir,
    busctl,
    systemctl,
    cgroupRoot,
    procDir,
    victimFile,
    calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0),
    state: async (unit: string) => readFile(path.join(states, unit), "utf8"),
    cgroupUnit: async (pid: number) => {
      const line = (await readFile(path.join(procDir, String(pid), "cgroup"), "utf8")).trim();
      return line.slice(line.lastIndexOf("/") + 1);
    }
  };
}

async function ownSlice(): Promise<string | null> {
  return containingSlice(await readFile("/proc/self/cgroup", "utf8"));
}

function sleeper(): ChildProcess {
  return spawn("sleep", ["infinity"], { stdio: "ignore" });
}

/** The directory of the cgroup a process sits in, under the cgroup mount. */
async function cgroupDirectory(pid: number): Promise<string> {
  const line = (await readFile(`/proc/${pid}/cgroup`, "utf8")).split("\n").find((entry) => entry.startsWith("0::"));
  assert.ok(line !== undefined, `process ${pid} has no cgroup v2 line`);
  return path.join("/sys/fs/cgroup", line.slice("0::".length));
}

async function cgroupUnit(pid: number): Promise<string> {
  const line = (await readFile(`/proc/${pid}/cgroup`, "utf8")).trim();
  return line.slice(line.lastIndexOf("/") + 1);
}

function collect(child: ChildProcess, input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    // A command that never reads stdin can exit before the write lands; its exit status is the result, not the EPIPE.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}
