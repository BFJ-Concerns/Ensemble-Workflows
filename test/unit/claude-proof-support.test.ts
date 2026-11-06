import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { classifySupervisorTransition, selectClaudeExecutable, supervisorLifecycle, type SupervisorIdentity } from "../live/claude-proof-support.js";

const exec = promisify(execFile);
const before: SupervisorIdentity = { pid: 101, startTicks: "123", cgroup: "0::/old", version: "2.1.318" };
const after: SupervisorIdentity = { pid: 202, startTicks: "456", cgroup: "0::/new", version: "2.1.319" };
const start = (identity: SupervisorIdentity): string => `[now] daemon start version=${identity.version} pid=${identity.pid}\n`;
const shutdown = (cause: string): string => `[now] shutting down (cause=${cause}, uptime=10s, leases=1, live_workers=1)\n`;

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), ".claude-proof-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("selected Claude executable and command resolution survive installation symlink movement", async () => {
  await fixture(async (root) => {
    const old = path.join(root, "claude-2.1.318");
    const next = path.join(root, "claude-2.1.319");
    const installed = path.join(root, "claude");
    for (const [file, value] of [[old, "old"], [next, "new"]]) {
      await writeFile(file!, `#!/bin/sh\nprintf '${value}'\n`);
      await chmod(file!, 0o755);
    }
    await symlink(old, installed);
    const selected = await selectClaudeExecutable(installed, root);
    try {
      await rm(installed);
      await symlink(next, installed);
      assert.equal(selected.executable, old);
      assert.equal((await exec(selected.executable)).stdout, "old");
      assert.equal((await exec("claude", [], { env: selected.env })).stdout, "old");
      assert.equal(await readlink(installed), next);
      assert.equal((await exec(installed)).stdout, "new");
    } finally {
      await selected.dispose();
    }
    await assert.rejects(exec("claude", [], { env: { PATH: selected.env.PATH!.split(path.delimiter)[0] } }));
  });
});

test("lifecycle parser retains recognised fields without private messages", async () => {
  await fixture(async (root) => {
    await writeFile(path.join(root, "daemon.log"), start(before) + shutdown("upgrade") +
      "[now] another daemon is already running (pid=202, version=2.1.319) private\n" +
      "[now] bg settled worker-1 (done) private\nprivate message\n");
    assert.deepEqual(await supervisorLifecycle(root), [
      { at: "now", event: "start", version: before.version, pid: "101" },
      { at: "now", event: "shutdown", cause: "upgrade", uptime: "10", leases: "1", liveWorkers: "1" },
      { at: "now", event: "competing-start", pid: "202", version: "2.1.319" },
      { at: "now", event: "settled", worker: "worker-1", outcome: "done" }
    ]);
  });
});

test("only an intervening upgrade shutdown and matching replacement start explain replacement", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "daemon.log");
    await writeFile(file, start(before));
    const baseline = await supervisorLifecycle(root);
    for (const [name, suffix, expected] of [
      ["upgrade", shutdown("upgrade") + start(after), "upgrade"],
      ["other shutdown", shutdown("idle") + start(after), "unexplained"],
      ["no shutdown", start(after), "unexplained"],
      ["wrong order", start(after) + shutdown("upgrade"), "unexplained"],
      ["wrong pid", shutdown("upgrade") + start({ ...after, pid: 303 }), "unexplained"],
      ["wrong version", shutdown("upgrade") + start({ ...after, version: "other" }), "unexplained"],
      ["intervening daemon", shutdown("upgrade") + start({ ...after, pid: 303 }) + start(after), "unexplained"]
    ]) {
      await writeFile(file, start(before) + suffix);
      assert.equal(classifySupervisorTransition(before, after, baseline, await supervisorLifecycle(root)), expected, name);
    }
    const historical = start({ ...before, pid: 99 }) + shutdown("upgrade") + start(before);
    await writeFile(file, historical);
    const history = await supervisorLifecycle(root);
    await writeFile(file, historical + start(after));
    assert.equal(classifySupervisorTransition(before, after, history, await supervisorLifecycle(root)), "unexplained");
    await writeFile(file, start({ ...before, pid: 99 }) + shutdown("upgrade") + start(after));
    const unrelated = await supervisorLifecycle(root);
    assert.equal(classifySupervisorTransition(before, after, unrelated.slice(0, 1), unrelated), "unexplained");
    await writeFile(file, shutdown("upgrade") + start(after));
    assert.equal(classifySupervisorTransition(before, after, baseline, await supervisorLifecycle(root)), "unexplained");
  });
});

test("missing and unreadable lifecycle evidence cannot explain replacement", async () => {
  await fixture(async (root) => {
    for (const location of [root, path.join(root, "absent"), path.join(root, "not-a-directory")]) {
      await writeFile(path.join(root, "not-a-directory"), "file");
      const evidence = await supervisorLifecycle(location);
      assert.equal(evidence[0]?.event, "log-unavailable");
      assert.equal(classifySupervisorTransition(before, after, [], evidence), "unexplained");
    }
    assert.equal(classifySupervisorTransition(before, after, [], []), "unexplained");
  });
});

test("unchanged supervisors require readable matching process identity and cgroup", () => {
  assert.equal(classifySupervisorTransition(before, { ...before }, [], []), "unchanged");
  for (const change of [{ pid: null }, { startTicks: null }, { cgroup: null }, { startTicks: "999" }, { cgroup: "moved" }, { version: "other" }]) {
    assert.equal(classifySupervisorTransition(before, { ...before, ...change }, [], []), "unexplained");
    assert.equal(classifySupervisorTransition({ ...before, ...change }, before, [], []), "unexplained");
  }
});


test("competing startup records do not hide the observed supervisor's upgrade", async () => {
  await fixture(async (root) => {
    const file = path.join(root, "daemon.log");
    for (const confirmed of [false, true]) {
      const prefix = start(before) + start({ ...before, pid: 303 }) + (confirmed
        ? `[now] another daemon is already running (pid=${before.pid}, version=${before.version})\n` : "");
      await writeFile(file, prefix);
      const baseline = await supervisorLifecycle(root);
      await writeFile(file, prefix + shutdown("upgrade") + start(after));
      assert.equal(classifySupervisorTransition(before, after, baseline, await supervisorLifecycle(root)), "upgrade",
        "a competing startup hid the live supervisor's documented upgrade");
      await writeFile(file, prefix + shutdown("idle") + start(after));
      assert.equal(classifySupervisorTransition(before, after, baseline, await supervisorLifecycle(root)), "unexplained",
        "a competing startup excused a non-upgrade replacement");
    }
  });
});
