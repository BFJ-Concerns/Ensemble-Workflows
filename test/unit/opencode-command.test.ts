import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CommandContainment } from "../../src/contained-command.js";
import { OpenCodeCliRunner } from "../../src/opencode-engine.js";
import { NoWorkerScopes } from "../../src/worker-scopes.js";

for (const ending of ["abort", "deadline", "exit", "export"] as const) {
  test(`opencode ${ending} stops containment before settling, even when close arrives first`, async (t) => {
    const child = new ChildProcess();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
    const commands = new CommandContainment(new NoWorkerScopes());
    let stopped!: () => void;
    const stopping = new Promise<{ kind: "stopped" }>((resolve) => { stopped = () => resolve({ kind: "stopped" }); });
    const stop = t.mock.fn(() => stopping);
    const contain = t.mock.method(commands, "contain", async () => ({ child, reach: { kind: "scope", unit: "fixture.scope" }, stop }));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const abort = new AbortController();
    const runner = new OpenCodeCliRunner(undefined, { commands });
    const pending = ending === "export"
      ? runner.exportSession("fixture-session", process.cwd(), abort.signal)
      : runner.run({ prompt: "fixture", cwd: process.cwd(), providerModel: "fixture/model", timeoutMs: 100, signal: abort.signal });
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
  const stop = t.mock.fn(async () => ({ kind: "unconfirmed" as const, reason: "controlled refusal" }));
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
