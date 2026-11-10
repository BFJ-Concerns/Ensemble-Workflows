import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  NoWorkerScopes,
  SystemdWorkerScopes,
  containingSlice,
  createWorkerScopes,
  isLive,
  parentSlice,
  processTree
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

async function ownSlice(): Promise<string | null> {
  return containingSlice(await readFile("/proc/self/cgroup", "utf8"));
}

function sleeper(): ChildProcess {
  return spawn("sleep", ["infinity"], { stdio: "ignore" });
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
