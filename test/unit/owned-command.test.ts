import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runOwnedCommand, type CommandBounds } from "../../src/owned-command.js";
import { NoWorkerScopes, SystemdWorkerScopes, containingSlice, isLive, type WorkerScopes } from "../../src/worker-scopes.js";
import { waitForCondition } from "../wait-for-condition.js";

// Short enough to keep the suite quick, long enough that a missed bound is
// not hidden by scheduling noise.
const bounds: CommandBounds = { stopGraceMs: 300, drainMs: 200 };
/** Scheduling and systemd-run latency the bound does not promise to absorb. */
const slackMs = 1_500;

const routes: { name: string; scopes: () => Promise<WorkerScopes> }[] = [
  { name: "direct launch", scopes: async () => new NoWorkerScopes() },
  {
    name: "systemd scope launch",
    scopes: async () => new SystemdWorkerScopes({
      slice: containingSlice(await readFile("/proc/self/cgroup", "utf8")),
      label: `owned-${process.pid}`
    })
  }
];

/**
 * The shell script as a file, run as `sh <file>`. `systemd-run` expands `$`
 * in command arguments, so a script passed by `sh -c` would not reach the
 * shell intact on the scope route.
 */
async function script(dir: string, body: string): Promise<string[]> {
  const file = path.join(dir, "command.sh");
  await writeFile(file, `${body}\n`);
  return [file];
}

for (const route of routes) {
  test(`${route.name}: a command runs to its own end with input, streams and exit status`, async () => {
    const scopes = await route.scopes();
    const dir = await mkdtemp(path.join(tmpdir(), "owned-command-run-"));
    try {
      const result = await runOwnedCommand(scopes, "sh", await script(dir, "read x; echo \"in=$x\"; echo said >&2; exit 3"), {
        env: process.env, input: "hello\n", bounds
      });
      assert.deepEqual(result, { ok: false, stdout: "in=hello\n", stderr: "said\n", exitCode: 3, signal: null, ending: "completed" });
    } finally {
      await scopes.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${route.name}: a signal already aborted launches nothing`, async () => {
    const scopes = await route.scopes();
    const dir = await mkdtemp(path.join(tmpdir(), "owned-command-preaborted-"));
    try {
      const marker = path.join(dir, "ran");
      const result = await runOwnedCommand(scopes, "sh", await script(dir, `touch ${marker}`), {
        env: process.env, input: null, signal: AbortSignal.abort(new Error("before launch")), bounds
      });
      assert.equal(result.ending, "cancelled");
      assert.equal(result.ok, false);
      assert.match(result.stderr, /cancelled: before launch/);
      await assert.rejects(readFile(marker), "the command ran despite its signal");
    } finally {
      await scopes.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${route.name}: cancelling ends the owned command alone, within the bound, while a supervisor it started holds its streams`, async () => {
    const scopes = await route.scopes();
    const dir = await mkdtemp(path.join(tmpdir(), "owned-command-cancel-"));
    let supervisor: number | null = null;
    try {
      const ready = path.join(dir, "ready");
      // The stand-in supervisor inherits the command's stdout and stderr and
      // outlives it, as a per-user supervisor started by a `claude` command
      // does. The command then hangs, as a stalled launch does.
      const body = `sleep 60 & echo "$$ $!" > ${ready}; while :; do sleep 0.05; done`;
      const abort = new AbortController();
      const pending = runOwnedCommand(scopes, "sh", await script(dir, body), { env: process.env, input: null, signal: abort.signal, bounds });
      await waitForCondition(async () => (await readFile(ready, "utf8").catch(() => "")).includes(" "), "the command to start", 10_000);
      const [command, started] = (await readFile(ready, "utf8")).trim().split(" ").map(Number);
      assert.ok(Number.isInteger(command) && Number.isInteger(started), "the command did not report its pids");
      supervisor = started!;
      const abortedAt = Date.now();
      abort.abort(new Error("deadline"));
      const result = await pending;
      const elapsed = Date.now() - abortedAt;
      assert.equal(result.ending, "cancelled");
      assert.equal(result.ok, false);
      assert.equal(result.signal, "SIGTERM");
      assert.match(result.stderr, /cancelled: deadline/);
      assert.ok(elapsed <= bounds.stopGraceMs + bounds.drainMs + slackMs, `cancellation took ${elapsed}ms`);
      assert.equal(isLive(command!), false, "the owned command survived its cancellation");
      assert.equal(isLive(supervisor), true, "cancellation reached a process the command started");
    } finally {
      if (supervisor !== null && isLive(supervisor)) process.kill(supervisor, "SIGKILL");
      await scopes.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${route.name}: a command that ignores SIGTERM is killed after the stop grace`, async () => {
    const scopes = await route.scopes();
    const dir = await mkdtemp(path.join(tmpdir(), "owned-command-kill-"));
    try {
      const ready = path.join(dir, "ready");
      const body = `trap '' TERM; echo $$ > ${ready}; while :; do sleep 0.05; done`;
      const abort = new AbortController();
      const pending = runOwnedCommand(scopes, "sh", await script(dir, body), { env: process.env, input: null, signal: abort.signal, bounds });
      await waitForCondition(async () => (await readFile(ready, "utf8").catch(() => "")).trim().length > 0, "the command to start", 10_000);
      const command = Number((await readFile(ready, "utf8")).trim());
      assert.ok(Number.isInteger(command), "the command did not report its pid");
      const abortedAt = Date.now();
      abort.abort(new Error("deadline"));
      const result = await pending;
      const elapsed = Date.now() - abortedAt;
      assert.equal(result.ending, "cancelled");
      assert.equal(result.signal, "SIGKILL");
      assert.ok(elapsed >= bounds.stopGraceMs, `SIGKILL came before the stop grace (${elapsed}ms)`);
      assert.ok(elapsed <= bounds.stopGraceMs + bounds.drainMs + slackMs, `cancellation took ${elapsed}ms`);
      assert.equal(isLive(command), false);
    } finally {
      await scopes.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${route.name}: a command that exits while a descendant holds its streams settles within the drain bound`, async () => {
    const scopes = await route.scopes();
    const dir = await mkdtemp(path.join(tmpdir(), "owned-command-drain-"));
    let holder: number | null = null;
    try {
      const pidFile = path.join(dir, "holder");
      const startedAt = Date.now();
      const result = await runOwnedCommand(scopes, "sh", await script(dir, `sleep 60 & echo $! > ${pidFile}; echo done`), {
        env: process.env, input: null, bounds
      });
      holder = Number((await readFile(pidFile, "utf8")).trim());
      assert.ok(Number.isInteger(holder), "the command did not report its descendant");
      assert.equal(result.ending, "completed");
      assert.equal(result.ok, true);
      assert.equal(result.stdout, "done\n");
      assert.ok(Date.now() - startedAt <= bounds.drainMs + slackMs, "the result waited on the descendant's copy of the streams");
      assert.equal(isLive(holder), true);
    } finally {
      if (holder !== null && isLive(holder)) process.kill(holder, "SIGKILL");
      await scopes.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
