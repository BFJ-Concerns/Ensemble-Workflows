import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeCliControlPlane } from "../../src/claude-control-plane.js";
import { ClaudeEngineAdapter } from "../../src/engines.js";
import { EngineShutdownError } from "../../src/errors.js";
import type { CommandBounds } from "../../src/owned-command.js";
import type { RuntimeEvent } from "../../src/types.js";
import { isLive } from "../../src/worker-scopes.js";
import { waitForCondition } from "../wait-for-condition.js";

// A cancelled launch is judged by three oracles: the caller's wait ends
// within the command bounds of its abort, the launch command itself is gone
// within the same bound, and whatever the supervisor registers under the
// dispatch's name — before close() or never — is stopped and removed by
// close() or reported by it. The stub `claude` stands in for both the launch
// command and the supervisor's roster; no real daemon is involved.

const bounds: CommandBounds = { stopGraceMs: 300, drainMs: 200 };
const slackMs = 1_500;

interface Stub {
  dir: string;
  claude: string;
  /** Present once the stub's `--bg` launch has started; holds its pid. */
  launchPid: string;
  /** Written by a test to make the stub's roster list a session under the name it holds. */
  registered: string;
  calls: string;
}

/**
 * A `claude` whose `--bg` launch never returns and whose roster lists a
 * session only once a test writes the dispatch name into `registered`, as a
 * supervisor answering a launch late would. `stop` and `rm` are recorded;
 * `rm` takes the session off the roster.
 */
async function installStub(): Promise<Stub> {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-launch-cancel-"));
  const stub: Stub = {
    dir,
    claude: path.join(dir, "claude.mjs"),
    launchPid: path.join(dir, "launch-pid"),
    registered: path.join(dir, "registered"),
    calls: path.join(dir, "calls")
  };
  const removed = path.join(dir, "removed");
  await writeFile(stub.claude, `#!/usr/bin/env node
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(stub.calls)}, JSON.stringify(args) + "\\n");
    if (args[0] === "--bg") {
      writeFileSync(${JSON.stringify(stub.launchPid)}, String(process.pid));
      setInterval(() => undefined, 1_000);
    } else if (args[0] === "agents") {
      const listed = existsSync(${JSON.stringify(stub.registered)}) && !existsSync(${JSON.stringify(removed)});
      const name = listed ? readFileSync(${JSON.stringify(stub.registered)}, "utf8") : "";
      console.log(JSON.stringify(listed
        ? [{ id: "late", sessionId: "late-session", name, kind: "background", status: "idle", state: "done", cwd: ${JSON.stringify(dir)} }]
        : []));
    } else if (args[0] === "rm") {
      writeFileSync(${JSON.stringify(removed)}, "");
    }
  `);
  await chmod(stub.claude, 0o755);
  return stub;
}

async function calls(stub: Stub): Promise<string[][]> {
  const text = await readFile(stub.calls, "utf8").catch(() => "");
  return text.trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as string[]);
}

/** The settings file the launch was handed, read from its recorded argv. */
async function settingsDirOf(stub: Stub): Promise<string> {
  const launch = (await calls(stub)).find((args) => args[0] === "--bg");
  assert.ok(launch !== undefined, "no launch was recorded");
  return path.dirname(launch[launch.indexOf("--settings") + 1]!);
}

async function launchStarted(stub: Stub): Promise<number> {
  await waitForCondition(async () => (await readFile(stub.launchPid, "utf8").catch(() => "")).length > 0, "the launch to start", 10_000);
  return Number(await readFile(stub.launchPid, "utf8"));
}

function plane(stub: Stub, events: RuntimeEvent[]): ClaudeCliControlPlane {
  return new ClaudeCliControlPlane({
    claudeBin: stub.claude,
    projectsDir: stub.dir,
    commandBounds: bounds,
    reclaimTimeoutMs: 5_000,
    onEvent: (event) => events.push(event)
  });
}

const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false);

test("a stuck launch with an empty roster ends its caller's wait and its own command within the bound, and close reports what it cannot confirm", async () => {
  const stub = await installStub();
  let settingsDir: string | null = null;
  try {
    const events: RuntimeEvent[] = [];
    const controlPlane = plane(stub, events);
    const abort = new AbortController();
    const pending = controlPlane.dispatch({ prompt: "unused", name: "stuck-launch", cwd: stub.dir, signal: abort.signal });
    const launchPid = await launchStarted(stub);
    settingsDir = await settingsDirOf(stub);
    const abortedAt = Date.now();
    abort.abort(new Error("probe deadline"));
    await assert.rejects(pending, /probe deadline/);
    assert.ok(Date.now() - abortedAt <= bounds.stopGraceMs + bounds.drainMs + slackMs, "the caller's wait outlived the bound");
    await waitForCondition(() => !isLive(launchPid), "the launch command to end", bounds.stopGraceMs + bounds.drainMs + slackMs);

    await controlPlane.close();
    assert.deepEqual(events.map((event) => [event.method, event.params.name]), [["claude/launchUnreclaimed", "stuck-launch"]]);
    assert.match(String(events[0]!.params.reason), /no session had registered/);
    // A launch that might still be served keeps the settings it reads; the
    // next launcher's sweep removes them once this one has ended.
    assert.equal(await exists(settingsDir), true);
    assert.equal((await calls(stub)).some((args) => args[0] === "stop" || args[0] === "rm"), false);
  } finally {
    if (settingsDir !== null) await rm(settingsDir, { recursive: true, force: true });
    await rm(stub.dir, { recursive: true, force: true });
  }
});

test("a session that registers after its dispatch was cancelled is stopped and removed with its settings at close", async () => {
  const stub = await installStub();
  let settingsDir: string | null = null;
  try {
    const events: RuntimeEvent[] = [];
    const controlPlane = plane(stub, events);
    const abort = new AbortController();
    const pending = controlPlane.dispatch({ prompt: "unused", name: "late-session", cwd: stub.dir, signal: abort.signal });
    await launchStarted(stub);
    settingsDir = await settingsDirOf(stub);
    abort.abort(new Error("probe deadline"));
    await assert.rejects(pending, /probe deadline/);
    // The supervisor answers the launch only now, after the caller has gone.
    await writeFile(stub.registered, "late-session");
    assert.equal(await exists(settingsDir), true, "settings went while the launch could still read them");

    await controlPlane.close();
    const teardown = (await calls(stub)).filter((args) => args[0] === "stop" || args[0] === "rm");
    assert.deepEqual(teardown, [["stop", "late"], ["rm", "late"]]);
    assert.equal(await exists(settingsDir), false);
    assert.deepEqual(events, []);
  } finally {
    if (settingsDir !== null) await rm(settingsDir, { recursive: true, force: true });
    await rm(stub.dir, { recursive: true, force: true });
  }
});

test("closing the engine settles an attempt whose launch never returns, and ends the launch command", async () => {
  const stub = await installStub();
  let settingsDir: string | null = null;
  try {
    const events: RuntimeEvent[] = [];
    const adapter = new ClaudeEngineAdapter({ cwd: stub.dir, controlPlane: plane(stub, events), config: { pollIntervalMs: 10 } });
    const attempt = adapter.createInvocation("work", {}).runAttempt({ attempt: 1 }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    const launchPid = await launchStarted(stub);
    settingsDir = await settingsDirOf(stub);
    const closingAt = Date.now();
    await adapter.close();
    assert.ok(Date.now() - closingAt <= bounds.stopGraceMs + bounds.drainMs + slackMs, "engine close outlived the bound");
    const outcome = await attempt;
    assert.ok("error" in outcome && outcome.error instanceof EngineShutdownError, `the attempt settled as ${JSON.stringify(outcome)}`);
    assert.equal(isLive(launchPid), false, "the launch command survived engine close");
    assert.deepEqual(events.map((event) => event.method), ["claude/launchUnreclaimed"]);
  } finally {
    if (settingsDir !== null) await rm(settingsDir, { recursive: true, force: true });
    await rm(stub.dir, { recursive: true, force: true });
  }
});


test("a probe deadline cancels a stuck native launcher without a registered handle", { timeout: 15_000 }, async () => {
  const stub = await installStub();
  let settingsDir: string | null = null;
  const events: RuntimeEvent[] = [];
  const controlPlane = plane(stub, events);
  const abort = new AbortController();
  const reason = new Error("probe preparation deadline");
  const pending = controlPlane.probeToolSurface({
    cwd: stub.dir, permissionDenyRules: [], settingsEnv: {}, signal: abort.signal
  });
  // Attach the observer before triggering cancellation.
  const rejected = assert.rejects(pending, (error: unknown) => error === reason);
  try {
    const pid = await launchStarted(stub);
    settingsDir = await settingsDirOf(stub);
    const settings = JSON.parse(await readFile(path.join(settingsDir, "settings.json"), "utf8")) as { env: { ANTHROPIC_BASE_URL: string } };
    const abortedAt = Date.now();
    abort.abort(reason);
    await rejected;
    assert.ok(Date.now() - abortedAt <= bounds.stopGraceMs + bounds.drainMs + slackMs, "probe outlived its cancellation bound");
    await waitForCondition(() => !isLive(pid), "the probe's native command to end", bounds.stopGraceMs + bounds.drainMs + slackMs);
    await assert.rejects(fetch(settings.env.ANTHROPIC_BASE_URL), "the probe's capture provider stayed open");
    await controlPlane.close();
    assert.equal(events[0]?.method, "claude/launchUnreclaimed");
    assert.match(String(events[0]?.params.name), /^ensemble-tool-surface-/);
  } finally {
    abort.abort(reason);
    await controlPlane.close();
    if (settingsDir !== null) await rm(settingsDir, { recursive: true, force: true });
    await rm(stub.dir, { recursive: true, force: true });
  }
});

test("engine close cancels a strip preparation stuck in the native probe launch", { timeout: 15_000 }, async () => {
  const stub = await installStub();
  let settingsDir: string | null = null;
  const events: RuntimeEvent[] = [];
  const adapter = new ClaudeEngineAdapter({ controlPlane: plane(stub, events) });
  const preparation = adapter.prepareStrip(["agents"], { cwd: stub.dir });
  const rejected = assert.rejects(preparation, EngineShutdownError);
  try {
    const pid = await launchStarted(stub);
    settingsDir = await settingsDirOf(stub);
    await adapter.close();
    await rejected;
    assert.equal(isLive(pid), false, "the probe command survived engine close");
    assert.equal(events[0]?.method, "claude/launchUnreclaimed");
  } finally {
    await adapter.close();
    if (settingsDir !== null) await rm(settingsDir, { recursive: true, force: true });
    await rm(stub.dir, { recursive: true, force: true });
  }
});
