import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsPromises, { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runEnsembleCli } from "../../src/cli.js";
import { CommandContainment, unestablishedStopDiagnostics, type CommandStop } from "../../src/contained-command.js";
import { EngineRegistry, type EngineAdapter, type EngineAttemptResult } from "../../src/engines.js";
import { StopUnconfirmedError } from "../../src/errors.js";
import { presentOperationalError } from "../../src/operator-diagnosis.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import {
  NoWorkerScopes,
  SystemdWorkerScopes,
  containingSlice,
  isLive,
  type StopOutcome,
  type WorkerScopes
} from "../../src/worker-scopes.js";

import { waitForCondition as waitFor } from "../wait-for-condition.js";
import { ChainEngine } from "./chain-engine-fakes.js";

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
    // Its end is established, so the attempt has nothing to disclose.
    assert.deepEqual(await command.stop(), { outcome: { kind: "stopped" }, attemptAccount: null });
    assert.equal(await running(innerPid), false, "stopped is an observation: the inner command is gone");
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
    assert.equal(await running(command.child.pid!), false, "close returns only once the unstopped command is gone");
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
  ["no user manager answers", () => new NoWorkerScopes(), "no systemd user manager is reachable"],
  ["the manager refuses the scope", refusingScopes, "the manager gave the command no scope: controlled scope refusal"]
] as const) {
  const beyondReach = `cut short without a scope (${reason}): its process group ended, and a process it started outside that group was never visible to the run`;

  test(`where ${why}, a command an attempt cuts short puts what it could not see on the attempt's account, and the run's close has nothing to add`, async () => {
    const commands = new CommandContainment(scopes());
    const worker = await workerWithOwnSessionCommand(commands);
    try {
      assert.deepEqual(worker.command.reach, { kind: "process-group", reason });

      // The script is still running: this is the stop a turn's deadline
      // makes. It reaches the group and observes it empty, and what left
      // the group is exactly what it could not see …
      const stop = await worker.command.stop();
      assert.equal(await running(worker.command.child.pid!), false);
      assert.equal(await running(worker.innerPid), true);
      // … so the attempt is handed the entry its account must carry,
      const account = { owner: `fixture worker in process group ${worker.command.child.pid}`, reason: beyondReach };
      assert.deepEqual(stop, { outcome: { kind: "stopped" }, attemptAccount: account });
      // which the engine spreads into the attempt result's diagnostics.
      assert.deepEqual(unestablishedStopDiagnostics([stop]), { unestablishedStops: [account] });

      // The worker's failure was the script's to handle, and the run ends
      // as the script left it: the close has nothing of its own to name.
      await commands.close();
    } finally {
      await worker.cleanup();
    }
  });

  test(`where ${why}, a command the run's ending cuts short is the close's to name, and one that ended by itself is not`, async () => {
    const commands = new CommandContainment(scopes());
    const finished = await commands.contain("finished worker", "true", [], { stdio: ["ignore", "ignore", "ignore"] });
    await new Promise((resolve) => finished.child.once("exit", resolve));
    const worker = await workerWithOwnSessionCommand(commands);
    try {
      // Whoever ends the run says so before it cancels anything.
      commands.runEnding();

      // The engine stops its command as it does on any cancellation, and
      // is handed nothing to report: this stop is the run's teardown.
      assert.deepEqual(await worker.command.stop(), { outcome: { kind: "stopped" }, attemptAccount: null });
      assert.equal(await running(worker.innerPid), true);

      // So the run does not report the work it cut short as stopped.
      await assert.rejects(commands.close(), (error: unknown) => {
        assert.ok(error instanceof StopUnconfirmedError);
        assert.deepEqual(error.unconfirmed, [{ owner: `fixture worker in process group ${worker.command.child.pid}`, reason: beyondReach }]);
        return true;
      });
    } finally {
      await worker.cleanup();
    }
  });
}

test("the run's close returns to a command an attempt's stop left running within reach, and names it only if it is running still", async () => {
  // A manager whose scopes each resist their first stop; the second finds
  // one emptied and the other not.
  const scripted = new Map<string, StopOutcome[]>();
  const stillThere: StopOutcome = { kind: "unconfirmed", reason: "pids 7 outlived SIGTERM by 1ms and SIGKILL by 1ms" };
  const direct = new NoWorkerScopes();
  const scopes: WorkerScopes = {
    slice: null,
    async place(group, pids) {
      scripted.set(group, scripted.size === 0 ? [stillThere, { kind: "stopped" }] : [stillThere, stillThere]);
      return { kind: "placed", unit: `${group}.scope`, pids };
    },
    launch: direct.launch.bind(direct),
    async stop(group) {
      return scripted.get(group)!.shift()!;
    },
    close: direct.close.bind(direct)
  };
  const commands = new CommandContainment(scopes);
  const stdio = ["ignore", "ignore", "ignore"] as const;
  const gone = await commands.contain("first worker", "sleep", ["infinity"], { stdio });
  const left = await commands.contain("second worker", "sleep", ["infinity"], { stdio });
  try {
    // Each attempt's account says its processes outlived the stop …
    for (const command of [gone, left]) {
      assert.ok(command.reach.kind === "scope");
      const stop = await command.stop();
      assert.deepEqual(stop.outcome, stillThere);
      assert.deepEqual(stop.attemptAccount, { owner: `${command === gone ? "first" : "second"} worker in ${command.reach.unit}`, reason: stillThere.reason });
    }
    // … and the run still owns them, so its close stops each again and
    // answers for the one it cannot confirm.
    await assert.rejects(commands.close(), (error: unknown) => {
      assert.ok(error instanceof StopUnconfirmedError);
      assert.ok(left.reach.kind === "scope");
      assert.deepEqual(error.unconfirmed, [{ owner: `second worker in ${left.reach.unit}`, reason: stillThere.reason }]);
      return true;
    });
  } finally {
    gone.child.kill("SIGKILL");
    left.child.kill("SIGKILL");
  }
});

for (const unreadable of ["stat", "listing"] as const) {
  test(`a process-group stop still escalates when the proc ${unreadable} is unreadable`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "ensemble-contained-unreadable-"));
    const ready = path.join(dir, "ready");
    const commands = new CommandContainment(new NoWorkerScopes(), { stopBounds: { stopGraceMs: 1, confirmMs: 1 } });
    const command = await commands.contain("TERM-resistant worker", "sh", [
      "-c", 'trap "" TERM; : > "$1"; exec sleep infinity', "sh", ready
    ], { stdio: ["ignore", "ignore", "ignore"] });
    const exited = new Promise<void>((resolve) => command.child.once("exit", () => resolve()));
    const originalReadFile = fsPromises.readFile;
    const originalReaddir = fsPromises.readdir;
    const originalKill = process.kill;
    const signals: NodeJS.Signals[] = [];
    try {
      await waitFor(() => originalReadFile(ready).then(() => true, () => false), "the worker to ignore TERM");
      const denied = Object.assign(new Error(`controlled EACCES reading proc ${unreadable}`), { code: "EACCES" });
      t.mock.method(fsPromises, "readFile", (...args: Parameters<typeof readFile>) => {
        if (String(args[0]) === "/proc/1/stat") return Promise.reject(denied);
        return originalReadFile(...args);
      });
      t.mock.method(fsPromises, "readdir", (...args: Parameters<typeof readdir>) => {
        if (String(args[0]) === "/proc") {
          if (unreadable === "listing") return Promise.reject(denied);
          // An unrelated inaccessible entry must not prevent escalation
          // against the owned group; its order is controlled explicitly.
          return Promise.resolve(["1"]);
        }
        return originalReaddir(...args);
      });
      t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -command.child.pid!) {
          // Keep group metadata observable after KILL, as with unreaped
          // zombies. Its membership remains unreadable throughout stop.
          if (signal === 0) return true;
          if (typeof signal === "string") signals.push(signal);
        }
        return originalKill(pid, signal);
      });
      syncBuiltinESMExports();
      const stop = await command.stop({ stopGraceMs: 1, confirmMs: 1 });
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      await exited;
      assert.equal(command.child.signalCode, "SIGKILL", "escalation ends the real TERM-resistant child");
      assert.equal(stop.outcome.kind, "unconfirmed");
      assert.match(stop.attemptAccount?.reason ?? "", /controlled EACCES/);
      await assert.rejects(commands.close(), /controlled EACCES/);
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"], "close observes the earlier kill without signalling a reusable group ID again");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      command.child.kill("SIGKILL");
      await exited;
      await commands.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("a worker timeout the script handled ends the run complete at exit 0, its unestablished stop on the attempt record and on stderr", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-contained-"));
  const commands = new CommandContainment(new NoWorkerScopes());
  let stop: CommandStop | null = null;
  // The engine's part, as a runner writes it: the turn's deadline stops the
  // command the attempt contained, and whatever that stop hands the attempt
  // rides the attempt's result — here a failed one; a completed result and
  // one a thrown failure carries take it the same way.
  const timedOut = async (): Promise<EngineAttemptResult> => {
    const command = await commands.contain("fixture worker", "sleep", ["infinity"], { stdio: ["ignore", "ignore", "ignore"] });
    stop = await command.stop();
    return {
      text: "",
      deltaText: "",
      durationMs: 1,
      firstDeltaMs: null,
      items: {},
      tokenUsageEvents: [],
      attemptFailure: { kind: "opencode-run-error", message: "the turn's deadline expired" },
      diagnostics: { ...unestablishedStopDiagnostics([stop]) }
    };
  };
  try {
    const script = path.join(dir, "workflow.js");
    await writeFile(
      script,
      'export const meta = { name: "handled-timeout" };\nconst answer = await agent("work", { engine: "opencode", maxAttempts: 1 });\nreturn { handled: answer === null };'
    );
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const records = path.join(dir, "records");
    const exitCode = await runEnsembleCli([script], {
      cwd: dir,
      stdout,
      stderr,
      runRecordDir: records,
      statusDir: null,
      env: { XDG_CONFIG_HOME: path.join(dir, "config") },
      // The run's containment is one of the resources its engines share.
      createRuntime: async (options) =>
        new EnsembleRuntime({
          ...options,
          defaultMaxAttempts: 1,
          engines: new EngineRegistry([new ChainEngine("opencode", [timedOut])], [commands])
        })
    });

    assert.equal(exitCode, 0, stderr.text());
    assert.deepEqual(JSON.parse(stdout.text()), { handled: true });
    const account = (stop as CommandStop | null)?.attemptAccount;
    assert.ok(account, "the fixture's stop left the attempt something to disclose");
    assert.ok(
      stderr.text().includes(
        `[opencode] agent 1 attempt 1 stopped a command and could not establish that everything it started has ended: ${account.owner} (${account.reason})\n`
      ),
      stderr.text()
    );
    assert.doesNotMatch(stderr.text(), /failed to end cleanly/);

    const files = await readdir(records, { recursive: true });
    const read = async (name: string): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(path.join(records, files.find((file) => path.basename(file) === name)!), "utf8")) as Record<string, unknown>;
    const sentinel = await read("completion-sentinel.json");
    assert.deepEqual([sentinel.outcome, sentinel.exit_code, sentinel.teardown_error], ["complete", 0, null]);
    const attempts = (await read("agent.json")).attempts as Array<{ diagnostics: unknown }>;
    assert.deepEqual(attempts[0]!.diagnostics, { unestablishedStops: [account] });
  } finally {
    await commands.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("the registry tells what the engines share that the run is ending before any engine closes, closes them after every engine in the order given, and rethrows what a close could not confirm", async () => {
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
        runEnding() {
          order.push("commands told the run is ending");
        },
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
  assert.deepEqual(
    order,
    ["commands told the run is ending", "engine", "commands", "scopes"],
    "the ending is said before an engine cancels anything, and a failed close stops nothing after it from closing"
  );
  assert.equal(
    presentOperationalError(unconfirmed),
    "run-owned processes may still be running: fixture worker in ensemble-test.scope (pids 7 outlived SIGTERM by 1ms and SIGKILL by 1ms)",
    "the operator reads the names, not a stack"
  );
});

/**
 * A worker's command, contained and running, that has started a command of
 * its own in another session: the descendant a process group cannot reach.
 */
async function workerWithOwnSessionCommand(commands: CommandContainment) {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-contained-"));
  const marker = path.join(dir, "inner.pid");
  let innerPid: number | null = null;
  const cleanup = async (): Promise<void> => {
    if (innerPid !== null && isLive(innerPid)) process.kill(innerPid, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const command = await commands.contain("fixture worker", "sh", ["-c", WORKER_WITH_OWN_SESSION_COMMAND, "sh", marker], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    await waitFor(async () => (await readFile(marker, "utf8").catch(() => "")).trim().length > 0, "the inner command's pid");
    const inner = Number((await readFile(marker, "utf8")).trim());
    innerPid = inner;
    await waitFor(async () => (await sessionOf(inner)) === inner, "the inner command in a session of its own");
    return { command, innerPid: inner, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Whether a process is still running. One that was killed and not yet reaped
 * — an orphan waiting on its new parent — still answers a signal, so the
 * state is read: gone, or a zombie, is not running.
 */
async function running(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  });
  return stat !== null && !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
}

class CaptureStream extends Writable {
  #chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.#chunks.join("");
  }
}

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
