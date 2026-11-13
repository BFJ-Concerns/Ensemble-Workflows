import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertFixedClaudeVersion, classifyClaudeVersion, classifySupervisorTransition, selectClaudeExecutable, supervisorSnapshot, supervisorLifecycle, type SupervisorIdentity } from "../live/claude-proof-support.js";
import { waitForCondition } from "../wait-for-condition.js";

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
    for (const [file, value] of [[old, "2.1.318"], [next, "2.1.319"]]) {
      await writeFile(file!, `#!/bin/sh\nprintf '${value} (Claude Code)\n'\n`);
      await chmod(file!, 0o755);
    }
    await symlink(old, installed);
    const selected = await selectClaudeExecutable(installed, root);
    try {
      await rm(installed);
      await symlink(next, installed);
      assert.equal(selected.executable, old);
      assert.equal(selected.version, "2.1.318");
      assert.equal((await exec(selected.executable)).stdout, "2.1.318 (Claude Code)\n");
      assert.equal((await exec("claude", [], { env: selected.env })).stdout, "2.1.318 (Claude Code)\n");
      assert.equal(await readlink(installed), next);
      assert.equal((await exec(installed)).stdout, "2.1.319 (Claude Code)\n");
    } finally {
      await selected.dispose();
    }
    await assert.rejects(exec("claude", [], { env: { PATH: selected.env.PATH!.split(path.delimiter)[0] } }));
  });
});

test("Claude selection uses PATH order in a home without a local launcher", async () => {
  await fixture(async (root) => {
    const home = path.join(root, "home");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const blocked = path.join(root, "blocked");
    const directory = path.join(root, "directory");
    for (const entry of [home, first, second, blocked, path.join(directory, "claude")]) await mkdir(entry, { recursive: true });
    await writeFile(path.join(blocked, "claude"), "not executable", { mode: 0o600 });
    for (const [entry, version] of [[first, "2.1.318"], [second, "2.1.319"]]) {
      await writeFile(path.join(entry!, "claude"), `#!/bin/sh\nprintf '${version} (Claude Code)\\n'\n`, { mode: 0o755 });
    }
    for (const [entries, expected] of [[[blocked, directory, first, second], first], [[second, first], second]] as const) {
      const env = { HOME: home, PATH: entries.join(path.delimiter) };
      const selected = await selectClaudeExecutable("claude", root, env);
      try {
        assert.equal(selected.executable, path.join(expected, "claude"));
        assert.equal((await exec("claude", ["--version"], { env: selected.env })).stdout.trim(), `${selected.version} (Claude Code)`);
        assert.equal(selected.env.HOME, home);
      } finally {
        await selected.dispose();
      }
    }
    await assert.rejects(selectClaudeExecutable("claude", root, { HOME: home, PATH: home }), /claude not found on PATH/);
  });
});

test("Codex-only scope cases skip their missing model without a Claude installation", async () => {
  await fixture(async (root) => {
    const result = await exec(process.execPath, [
      "--test", "--test-reporter=tap", "--test-name-pattern=^built launcher scopes: (direct|unreachable manager) codex$",
      path.resolve("dist/test/live/worker-scopes.live.test.js")
    ], { env: { ...process.env, HOME: root, PATH: root, NODE_TEST_CONTEXT: undefined, ENSEMBLE_LIVE: "1", ENSEMBLE_LIVE_CODEX_MODEL: "" } });
    assert.equal((result.stdout.match(/# SKIP ENSEMBLE_LIVE_CODEX_MODEL is unset/g) ?? []).length, 2);
    assert.doesNotMatch(result.stdout, /UNPROVEN|not ok|hookFailed|ENOENT|not found on PATH/);
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

test("fixed-version evidence rejects mismatched and unavailable native versions", () => {
  const snapshot = (selectedVersion: string | null, identity = before) => ({
    selectedVersion, identity, versionEvidence: classifyClaudeVersion(selectedVersion, identity.version),
    lifecycle: [{ event: "start", pid: String(identity.pid), version: identity.version }], offset: 0
  });
  const matching = snapshot(before.version);
  assert.equal(assertFixedClaudeVersion(matching, matching, "matching"), "unchanged");
  for (const selected of [after.version, null, ""]) {
    const state = snapshot(selected);
    assert.equal(state.versionEvidence, selected ? "mismatched" : "unavailable");
    assert.throws(() => assertFixedClaudeVersion(state, state, "native evidence"), /fixed-version proof/);
  }
  const unavailable = snapshot(before.version, { ...before, version: "" });
  assert.equal(unavailable.versionEvidence, "unavailable");
  assert.throws(() => assertFixedClaudeVersion(unavailable, unavailable, "missing"), /fixed-version proof/);
  assert.throws(() => assertFixedClaudeVersion(matching, snapshot(before.version, { ...before, cgroup: "moved" }), "moved"),
    /without a recorded upgrade/);
  const upgraded = { ...snapshot(before.version, after), lifecycle: [
    ...matching.lifecycle, { event: "shutdown", cause: "upgrade" },
    { event: "start", pid: String(after.pid), version: after.version }
  ] };
  assert.equal(classifySupervisorTransition(before, after, matching.lifecycle, upgraded.lifecycle), "upgrade");
  assert.throws(() => assertFixedClaudeVersion(matching, upgraded, "upgrade"), /fixed-version proof/);
  assert.throws(() => assertFixedClaudeVersion(matching, snapshot(after.version), "selection changed"), /fixed-version proof/);
});

test("snapshots distinguish selected CLI from the observed supervisor version", async () => {
  await fixture(async root => {
    const executable = path.join(root, "claude");
    for (const version of ["2.1.318", "2.1.319", "unknown"]) {
      await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '${version} (Claude Code)\n'
else
  printf 'pid: ${process.pid}\n'
fi
`);
      await chmod(executable, 0o755);
      await writeFile(path.join(root, "daemon.log"), start({ ...before, pid: process.pid }));
      const snapshot = await supervisorSnapshot(executable, { ...process.env, CLAUDE_CONFIG_DIR: root }, "current");
      assert.equal(snapshot.selectedVersion, version === "unknown" ? null : version);
      assert.equal(snapshot.identity.version, before.version);
      assert.equal(snapshot.versionEvidence, version === "unknown" ? "unavailable" : version === before.version ? "matching" : "mismatched");
    }
    await rm(path.join(root, "daemon.log"));
    assert.equal((await supervisorSnapshot(executable, { ...process.env, CLAUDE_CONFIG_DIR: root })).versionEvidence, "unavailable");
    await writeFile(executable, "#!/bin/sh\nexit 1\n");
    const selected = await selectClaudeExecutable(executable, root);
    try {
      assert.equal(selected.version, null);
    } finally {
      await selected.dispose();
    }
  });
});

test("a startup between the status and log reads cannot leave a null baseline beside its serving daemon", async () => {
  await fixture(async root => {
    const executable = path.join(root, "claude.mjs");
    const observed = path.join(root, "status-read");
    const release = path.join(root, "release");
    await writeFile(executable, `#!${process.execPath}
import { access, readFile, writeFile } from 'node:fs/promises';
const exists = file => access(file).then(() => true, () => false);
if (process.argv[2] === '--version') {
  console.log('2.1.318 (Claude Code)');
} else {
  const pid = await readFile(${JSON.stringify(path.join(root, "daemon.pid"))}, 'utf8').catch(() => null);
  if (!(await exists(${JSON.stringify(observed)}))) {
    await writeFile(${JSON.stringify(observed)}, '');
    const deadline = Date.now() + 20_000;
    while (!(await exists(${JSON.stringify(release)}))) {
      if (Date.now() >= deadline) throw new Error('status barrier was never released');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  console.log(pid === null ? 'not running' : 'pid: ' + pid);
  process.exitCode = pid === null ? 1 : 0;
}
`, { mode: 0o755 });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: root };
    const pending = supervisorSnapshot(executable, env, "current");
    try {
      // The first CLI has already observed absence. Publish a serving
      // identity and its log before that CLI returns its saved result.
      await waitForCondition(() => access(observed).then(() => true, () => false), "the first status read", 20_000);
      await writeFile(path.join(root, "daemon.log"), start({ ...before, pid: process.pid }));
      await writeFile(path.join(root, "daemon.pid"), String(process.pid));
    } finally {
      await writeFile(release, "");
    }
    const baseline = await pending;
    const later = await supervisorSnapshot(executable, env, baseline.offset);
    assert.equal(baseline.identity.pid, process.pid);
    assert.equal(baseline.lifecycle.filter(row => row.event === "start").length, 1);
    assert.equal(assertFixedClaudeVersion(baseline, later, "startup barrier"), "unchanged");
  });
});

test("snapshot log discovery follows the worker HOME when CLAUDE_CONFIG_DIR is unset", async () => {
  await fixture(async root => {
    await mkdir(path.join(root, ".claude"));
    const executable = path.join(root, "claude");
    await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '2.1.318 (Claude Code)\\n'
else
  printf 'pid: ${process.pid}\\n'
fi
`, { mode: 0o755 });
    await writeFile(path.join(root, ".claude/daemon.log"), start({ ...before, pid: process.pid }));
    const snapshot = await supervisorSnapshot(executable, { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: undefined }, "current");
    assert.equal(snapshot.identity.version, before.version);
    assert.equal(snapshot.versionEvidence, "matching");
  });
});

test("both supervisor boundary proofs name an unavailable suite daemon before selecting an executable", async () => {
  await fixture(async root => {
    const record = path.join(root, "suite.json");
    await writeFile(record, JSON.stringify({
      home: root, origin: "unavailable",
      attempt: { reason: "fixture startup refused", status: { code: 1, pid: null, stdout: "not running", stderr: "" }, exit: { code: 3, signal: null, error: null } }
    }));
    const result = await exec(process.execPath, ["--test", "--test-reporter=tap", path.resolve("dist/test/live/claude-supervisor-boundary.live.test.js")], {
      env: { ...process.env, PATH: root, NODE_TEST_CONTEXT: undefined, ENSEMBLE_LIVE: "1", ENSEMBLE_LIVE_SUITE_CLAUDE_DAEMON: record }
    }).then(() => assert.fail("the missing shared daemon must refuse both proofs"), (error: unknown) => error as { stdout: string });
    assert.match(result.stdout, /# fail 2/);
    assert.match(result.stdout, /UNPROVEN: shared Claude daemon unavailable/);
    assert.match(result.stdout, /fixture startup refused/);
    assert.doesNotMatch(result.stdout, /hookFailed|ENOENT|not found on PATH/);
  });
});
