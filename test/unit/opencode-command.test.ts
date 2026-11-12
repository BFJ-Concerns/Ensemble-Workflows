import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CommandContainment, type CommandStop } from "../../src/contained-command.js";
import { OpenCodeCliRunner } from "../../src/opencode-engine.js";
import { NoWorkerScopes } from "../../src/worker-scopes.js";

for (const ending of ["abort", "deadline", "exit", "export"] as const) {
  test(`opencode ${ending} stops containment before settling, even when close arrives first`, async (t) => {
    const child = new ChildProcess();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
    const commands = new CommandContainment(new NoWorkerScopes());
    let stopped!: () => void;
    const observation: CommandStop = { outcome: { kind: "stopped" }, attemptAccount: { owner: "fixture worker", reason: "controlled incomplete reach" } };
    const stopping = new Promise<CommandStop>((resolve) => { stopped = () => resolve(observation); });
    const observed: CommandStop[] = [];
    const stop = t.mock.fn(() => stopping);
    const contain = t.mock.method(commands, "contain", async () => ({ child, reach: { kind: "scope", unit: "fixture.scope" }, stop }));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const abort = new AbortController();
    const runner = new OpenCodeCliRunner(undefined, { commands });
    const pending = ending === "export"
      ? runner.exportSession("fixture-session", process.cwd(), abort.signal, (stop) => observed.push(stop))
      : runner.run({ prompt: "fixture", cwd: process.cwd(), providerModel: "fixture/model", timeoutMs: 100, signal: abort.signal, onCommandStop: (stop) => observed.push(stop) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.stdout!.emit("data", "partial output");
    child.stderr!.emit("data", "engine diagnostic");
    if (ending === "abort" || ending === "export") abort.abort();
    if (ending === "deadline") t.mock.timers.tick(100);
    if (ending === "exit") child.emit("exit", 0, null);
    assert.equal(stop.mock.callCount(), 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    child.emit("close", ending === "exit" ? 0 : null, ending === "exit" ? null : "SIGTERM");
    await Promise.resolve();
    assert.equal(settled, false, "pipe close alone cannot confirm the command's end");
    stopped();
    const result = await pending;
    assert.deepEqual(observed, [observation]);
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(contain.mock.calls[0]?.arguments[0], `opencode ${ending === "export" ? "export" : "run"}`);
    if ("deadlineExpired" in result) {
      assert.equal(result.deadlineExpired, ending === "deadline");
      assert.equal(result.stdout, "partial output");
      assert.equal(result.stderr, "engine diagnostic");
    }
    t.mock.timers.reset();
  });
}

test("opencode bounds pipe drainage after an unconfirmed stop without losing collected output", async (t) => {
  const child = new ChildProcess();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
  const commands = new CommandContainment(new NoWorkerScopes());
  const stop = t.mock.fn(async (): Promise<CommandStop> => ({ outcome: { kind: "unconfirmed", reason: "controlled refusal" }, attemptAccount: { owner: "fixture worker", reason: "controlled refusal" } }));
  t.mock.method(commands, "contain", async () => ({ child, reach: { kind: "scope", unit: "fixture.scope" }, stop }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const abort = new AbortController();
  const pending = new OpenCodeCliRunner(undefined, { commands }).run({ prompt: "fixture", cwd: process.cwd(), providerModel: "fixture/model", signal: abort.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  child.stdout!.emit("data", "retained");
  abort.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1_000);
  const result = await pending;
  assert.equal(result.stdout, "retained");
  assert.equal(child.stdout!.destroyed, true);
  assert.equal(child.stderr!.destroyed, true);
  assert.equal(stop.mock.callCount(), 1);
  t.mock.timers.reset();
});

test("opencode settles and preserves the signal when containment hands back an already closed command", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-early-exit-"));
  const fixture = path.join(dir, "opencode");
  await writeFile(fixture, "#!/bin/sh\nexec sleep 120\n");
  await chmod(fixture, 0o755);
  const commands = new CommandContainment(new NoWorkerScopes());
  const contain = commands.contain.bind(commands);
  let handoff!: () => void;
  const handedOff = new Promise<void>((resolve) => { handoff = resolve; });
  t.mock.method(commands, "contain", async (...args: Parameters<CommandContainment["contain"]>) => {
    const command = await contain(...args);
    const closed = once(command.child, "close");
    command.child.kill("SIGKILL");
    await closed;
    assert.equal(command.child.signalCode, "SIGKILL");
    assert.equal(command.child.stdout?.closed, true);
    assert.equal(command.child.stderr?.closed, true);
    handoff();
    return command;
  });
  const abort = new AbortController();
  const pending = new OpenCodeCliRunner(fixture, { commands }).run({
    prompt: "fixture", cwd: dir, providerModel: "fixture/model", signal: abort.signal
  });
  let result: Awaited<typeof pending> | undefined;
  const settled = pending.then((value) => { result = value; });
  try {
    await handedOff;
    // All hand-off and stop promises are now microtasks, with no process or
    // I/O left to wait for. Advancing a phase is independent of host speed.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(result, "an already closed child must settle without an abort or deadline");
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.exitCode, null);
    assert.equal(result.deadlineExpired, false);
  } finally {
    abort.abort();
    await settled;
    await commands.close();
    await rm(dir, { recursive: true, force: true });
  }
});
