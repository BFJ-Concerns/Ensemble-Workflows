import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CommandContainment } from "../../src/contained-command.js";
import { EngineRegistry, type EngineAdapter } from "../../src/engines.js";
import { StopUnconfirmedError } from "../../src/errors.js";
import { presentOperationalError } from "../../src/operator-diagnosis.js";
import { NoWorkerScopes, SystemdWorkerScopes, containingSlice, isLive, type WorkerScopes } from "../../src/worker-scopes.js";

import { waitForCondition as waitFor } from "../wait-for-condition.js";

// What a worker's command does when it starts a command of its own the way
// an agent harness does: the inner command leads a session of its own and
// inherits the worker's stdout, its pid is recorded, and the worker waits.
// Ending the worker's process — or its process group — leaves the inner
// command running and holding the pipe.
const WORKER_WITH_OWN_SESSION_COMMAND = 'setsid sleep infinity & echo $! > "$1"; wait';

test("a contained command runs in its own scope from its first instruction, and stopping it ends a descendant in another session and releases its pipes", async () => {
  const scopes = new SystemdWorkerScopes({ slice: await ownSlice(), label: `test-${process.pid}` });
  const commands = new CommandContainment(scopes);
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-contained-"));
  const marker = path.join(dir, "inner.pid");
  let inner: number | null = null;
  try {
    const command = await commands.contain("fixture worker", "sh", ["-c", `cat /proc/self/cgroup; ${WORKER_WITH_OWN_SESSION_COMMAND}`, "sh", marker], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    assert.ok(command.reach.kind === "scope", JSON.stringify(command.reach));
    const unit = command.reach.unit;

    let stdout = "";
    command.child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const closed = new Promise<void>((resolve) => command.child.once("close", () => resolve()));

    await waitFor(async () => (await readFile(marker, "utf8").catch(() => "")).trim().length > 0, "the inner command's pid");
    const innerPid = Number((await readFile(marker, "utf8")).trim());
    inner = innerPid;
    await waitFor(async () => (await sessionOf(innerPid)) === innerPid, "the inner command in a session of its own");
    assert.notEqual(await sessionOf(innerPid), await sessionOf(command.child.pid!));
    assert.equal(await cgroupUnit(innerPid), unit, "a process the command starts is born in its scope");
    assert.ok(stdout.trim().endsWith(`/${unit}`), `the command ran in its scope from its first instruction: ${stdout}`);

    // The engine's part: stop the command it no longer needs. The stop is
    // what ends the pipe holder, so the engine's own wait on the streams
    // returns without waiting for the run's close.
    assert.deepEqual(await command.stop(), { kind: "stopped" });
    assert.equal(isLive(innerPid), false, "stopped is an observation: the inner command is gone");
    await closed;

    // The run's part: nothing is left to establish.
    await commands.close();
  } finally {
    if (inner !== null && isLive(inner)) process.kill(inner, "SIGKILL");
    await commands.close().catch(() => undefined);
    await scopes.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("the run's close stops a command no engine stopped, and leaves the manager's other scopes alone", async () => {
  const scopes = new SystemdWorkerScopes({ slice: await ownSlice(), label: `test-${process.pid}-sweep` });
  const commands = new CommandContainment(scopes);
  // A scope the manager holds for someone else: a worker another engine placed.
  const bystander = spawn("sleep", ["infinity"], { stdio: "ignore" });
  try {
    const placed = await scopes.place("worker-1", [bystander.pid!]);
    assert.equal(placed.kind, "placed", JSON.stringify(placed));
    const command = await commands.contain("fixture worker", "sleep", ["infinity"], { stdio: ["ignore", "ignore", "ignore"] });
    assert.equal(command.reach.kind, "scope", JSON.stringify(command.reach));

    await commands.close();
    assert.equal(isLive(command.child.pid!), false, "close returns only once the unstopped command is gone");
    assert.equal(isLive(bystander.pid!), true, "a scope the containment did not create is the manager's to stop");
    await assert.rejects(commands.contain("late", "true", [], { stdio: ["ignore", "ignore", "ignore"] }), /containment is closed; late was not started/);
  } finally {
    await scopes.close().catch(() => undefined);
    bystander.kill("SIGKILL");
  }
});

test("a command that cannot be found rejects as a bare spawn would, starting nothing", async () => {
  for (const scopes of [new SystemdWorkerScopes({ slice: await ownSlice(), label: `test-${process.pid}-missing` }), new NoWorkerScopes()]) {
    const commands = new CommandContainment(scopes);
    await assert.rejects(commands.contain("fixture worker", "ensemble-no-such-command", ["--flag"], { stdio: ["ignore", "ignore", "ignore"] }), {
      code: "ENOENT",
      syscall: "spawn ensemble-no-such-command",
      message: "spawn ensemble-no-such-command ENOENT"
    });
    await commands.close();
    await scopes.close();
  }
});

for (const [why, scopes, reason] of [
  ["no user manager answers", new NoWorkerScopes(), "no systemd user manager is reachable"],
  ["the manager refuses the scope", refusingScopes(), "the manager gave the command no scope: controlled scope refusal"]
] as const) {
  test(`where ${why}, a command reaches its process group only, and the run's close names one cut short there`, async () => {
    const commands = new CommandContainment(scopes);
    const dir = await mkdtemp(path.join(tmpdir(), "ensemble-contained-"));
    const marker = path.join(dir, "inner.pid");
    let inner: number | null = null;
    try {
      const finished = await commands.contain("finished worker", "true", [], { stdio: ["ignore", "ignore", "ignore"] });
      await new Promise((resolve) => finished.child.once("exit", resolve));
      const command = await commands.contain("fixture worker", "sh", ["-c", WORKER_WITH_OWN_SESSION_COMMAND, "sh", marker], {
        stdio: ["ignore", "ignore", "ignore"]
      });
      assert.deepEqual(command.reach, { kind: "process-group", reason });
      await waitFor(async () => (await readFile(marker, "utf8").catch(() => "")).trim().length > 0, "the inner command's pid");
      const innerPid = Number((await readFile(marker, "utf8")).trim());
      inner = innerPid;
      await waitFor(async () => (await sessionOf(innerPid)) === innerPid, "the inner command in a session of its own");

      // The stop reaches the group and observes it empty …
      assert.deepEqual(await command.stop(), { kind: "stopped" });
      assert.equal(isLive(command.child.pid!), false);
      // … and what left the group is exactly what it could not see.
      assert.equal(isLive(innerPid), true);

      // So the run does not report the cut-short command's work stopped. A
      // command that ended by itself is taken at its exit and is not named.
      await assert.rejects(commands.close(), (error: unknown) => {
        assert.ok(error instanceof StopUnconfirmedError);
        assert.deepEqual(error.unconfirmed, [
          {
            owner: `fixture worker in process group ${command.child.pid}`,
            reason: `cut short without a scope (${reason}): its process group ended, and a process it started outside that group was never visible to the run`
          }
        ]);
        return true;
      });
    } finally {
      if (inner !== null && isLive(inner)) process.kill(inner, "SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("the registry closes what the engines share after every engine, in the order given, and rethrows what a close could not confirm", async () => {
  const order: string[] = [];
  const engine: EngineAdapter = {
    name: "opencode",
    concurrency: 1,
    schedule: async (run) => run(),
    createInvocation: () => {
      throw new Error("this registry dispatches nothing");
    },
    async close() {
      // An engine stops its own commands and settles without the shared
      // resources: they are still open while it closes.
      order.push("engine");
    }
  };
  const unconfirmed = new StopUnconfirmedError([{ owner: "fixture worker in ensemble-test.scope", reason: "pids 7 outlived SIGTERM by 1ms and SIGKILL by 1ms" }]);
  const registry = new EngineRegistry(
    [engine],
    [
      {
        async close() {
          order.push("commands");
          throw unconfirmed;
        }
      },
      {
        async close() {
          order.push("scopes");
        }
      }
    ]
  );
  await assert.rejects(registry.close(), (error: unknown) => error === unconfirmed);
  assert.deepEqual(order, ["engine", "commands", "scopes"], "a failed close stops nothing after it from closing");
  assert.equal(
    presentOperationalError(unconfirmed),
    "run-owned processes may still be running: fixture worker in ensemble-test.scope (pids 7 outlived SIGTERM by 1ms and SIGKILL by 1ms)",
    "the operator reads the names, not a stack"
  );
});

/** A manager that answers and will not place: the refusal a contained command must survive and report. */
function refusingScopes(): WorkerScopes {
  const direct = new NoWorkerScopes();
  return {
    slice: null,
    async place() {
      return { kind: "refused", reason: "controlled scope refusal" };
    },
    launch: direct.launch.bind(direct),
    stop: direct.stop.bind(direct),
    close: direct.close.bind(direct)
  };
}

async function ownSlice(): Promise<string | null> {
  return containingSlice(await readFile("/proc/self/cgroup", "utf8"));
}

async function cgroupUnit(pid: number): Promise<string> {
  const line = (await readFile(`/proc/${pid}/cgroup`, "utf8")).trimEnd();
  return line.slice(line.lastIndexOf("/") + 1);
}

async function sessionOf(pid: number): Promise<number> {
  // Fields after the parenthesised command name: state, ppid, pgrp, session.
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
}
