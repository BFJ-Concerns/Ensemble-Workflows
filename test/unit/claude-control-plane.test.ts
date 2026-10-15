import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { execFileSync, spawn } from "node:child_process";

import {
  BACKGROUND_ISOLATION_VARIABLE,
  CLAUDE_CACHE_TTL_VARIABLE,
  ClaudeCliControlPlane,
  SANDBOXED_WORKSPACE_VARIABLE,
  VALVE_PASTE_THRESHOLD_CHARS,
  VALVE_SLICE_CHARS,
  WORKER_MARKER_VARIABLE,
  valveSlices
} from "../../src/claude-control-plane.js";
import { ClaudeDispatchError, ClaudeRegistrationTimeoutError } from "../../src/errors.js";
import { writeProcStat } from "../fixtures/proc-stat.js";
import { hermeticEstateEnvironment } from "../integration/estate-process.js";

test("dispatch streams a multi-megabyte prompt byte-exactly instead of placing it on argv", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-control-plane-"));
  try {
    const receivedPath = path.join(dir, "received-prompt.txt");
    const argvPath = path.join(dir, "dispatch-argv.json");
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const name = "large-prompt-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          const chunks = [];
          for await (const chunk of process.stdin) chunks.push(chunk);
          await writeFile(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
          await writeFile(${JSON.stringify(argvPath)}, JSON.stringify(args));
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "large-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: ${JSON.stringify(name)},
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
          process.exit(0);
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    // Repeated non-ASCII text catches accidental character/byte conversions as
    // well as proving the payload is comfortably beyond ordinary argv limits.
    const prompt = `${"diff --git a/old b/new\n+résumé → exact bytes\n".repeat(60_000)}TAIL\n`;
    assert.ok(Buffer.byteLength(prompt) > 2 * 1024 * 1024);

    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: stubPath,
      projectsDir: dir,
      dispatchTimeoutMs: 1_000
    });
    const handle = await controlPlane.dispatch({ prompt, name, cwd: dir });

    assert.equal(handle.sessionId, sessionId);
    assert.equal(await readFile(receivedPath, "utf8"), prompt);
    const dispatchArgv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
    assert.ok(!dispatchArgv.includes(prompt));
    assert.ok(dispatchArgv.every((argument) => Buffer.byteLength(argument) < 1024));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a declared worker environment reaches the dispatched claude child, above inheritance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-worker-env-"));
  try {
    const envPath = path.join(dir, "observed-env.json");
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000003";
    const name = "worker-env-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          await writeFile(${JSON.stringify(envPath)}, JSON.stringify({
            base: process.env.ANTHROPIC_BASE_URL ?? null,
            inherited: process.env.ENSEMBLE_TEST_INHERITED ?? null
          }));
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "env-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: ${JSON.stringify(name)},
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    // The declared value must win over an inherited one for the same name,
    // and an undeclared inherited variable must still pass through.
    // Save-and-restore, not delete: a pre-existing value on the invoking
    // machine must survive this test for later tests in the process.
    const savedBase = process.env.ANTHROPIC_BASE_URL;
    const savedInherited = process.env.ENSEMBLE_TEST_INHERITED;
    process.env.ANTHROPIC_BASE_URL = "https://inherited.example";
    process.env.ENSEMBLE_TEST_INHERITED = "still-here";
    try {
      const controlPlane = new ClaudeCliControlPlane({
        claudeBin: stubPath,
        projectsDir: dir,
        dispatchTimeoutMs: 1_000,
        workerEnv: { ANTHROPIC_BASE_URL: "https://declared.example" }
      });
      await controlPlane.dispatch({ prompt: "hello", name, cwd: dir });
    } finally {
      restoreEnv("ANTHROPIC_BASE_URL", savedBase);
      restoreEnv("ENSEMBLE_TEST_INHERITED", savedInherited);
    }

    const observed = JSON.parse(await readFile(envPath, "utf8")) as { base: string | null; inherited: string | null };
    assert.equal(observed.base, "https://declared.example");
    assert.equal(observed.inherited, "still-here");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the run's own environment-layer settings are withheld from every claude child, while the rest inherits and declarations still win", async () => {
  // Any control-plane child can start Claude Code's per-user daemon, which
  // outlives the run and serves every later session on the machine. The
  // run's record and status directories (and their sibling settings) must
  // not become the daemon's; an unrelated inherited variable still passes,
  // and an operator's explicit declaration of one of those names is still
  // injected — the declaration is their word, the withholding is the
  // harness's default.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-run-scoped-env-"));
  try {
    const envPath = path.join(dir, "observed-env.json");
    const settingsCopyPath = path.join(dir, "settings-copy.json");
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000013";
    const name = "run-scoped-env-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { copyFile, writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          await writeFile(${JSON.stringify(envPath)}, JSON.stringify({
            recordDir: process.env.ENSEMBLE_RUN_RECORD_DIR ?? null,
            record: process.env.ENSEMBLE_RUN_RECORD ?? null,
            statusDir: process.env.ENSEMBLE_STATUS_DIR ?? null,
            concurrency: process.env.ENSEMBLE_CONCURRENCY_CLAUDE ?? null,
            holdScope: process.env.ENSEMBLE_HOLD_SCOPE ?? null,
            inherited: process.env.ENSEMBLE_TEST_INHERITED ?? null
          }));
          await copyFile(args[args.indexOf("--settings") + 1], ${JSON.stringify(settingsCopyPath)});
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "run-scoped-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: ${JSON.stringify(name)},
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    const saved = Object.fromEntries(
      ["ENSEMBLE_RUN_RECORD_DIR", "ENSEMBLE_RUN_RECORD", "ENSEMBLE_STATUS_DIR", "ENSEMBLE_CONCURRENCY_CLAUDE", "ENSEMBLE_HOLD_SCOPE", "ENSEMBLE_TEST_INHERITED"].map(
        (key) => [key, process.env[key]]
      )
    );
    process.env.ENSEMBLE_RUN_RECORD_DIR = path.join(dir, "relocated-store");
    process.env.ENSEMBLE_RUN_RECORD = "on";
    process.env.ENSEMBLE_STATUS_DIR = path.join(dir, "relocated-status");
    process.env.ENSEMBLE_CONCURRENCY_CLAUDE = "3";
    process.env.ENSEMBLE_HOLD_SCOPE = "lead-session-42";
    process.env.ENSEMBLE_TEST_INHERITED = "still-here";
    try {
      const controlPlane = new ClaudeCliControlPlane({
        claudeBin: stubPath,
        projectsDir: dir,
        dispatchTimeoutMs: 1_000,
        workerEnv: { ENSEMBLE_STATUS_DIR: path.join(dir, "declared-status") }
      });
      await controlPlane.dispatch({ prompt: "hello", name, cwd: dir });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        restoreEnv(key, value);
      }
    }

    assert.deepEqual(JSON.parse(await readFile(envPath, "utf8")), {
      recordDir: null,
      record: null,
      statusDir: path.join(dir, "declared-status"),
      concurrency: null,
      holdScope: null,
      inherited: "still-here"
    });
    // The hold scope's contract is inheritance by every nested invocation,
    // so it reaches the worker session by the settings file instead —
    // beneath the machine's declarations, above nothing else.
    assert.deepEqual(JSON.parse(await readFile(settingsCopyPath, "utf8")), {
      env: {
        [BACKGROUND_ISOLATION_VARIABLE]: "none",
        ENSEMBLE_HOLD_SCOPE: "lead-session-42",
        ENSEMBLE_STATUS_DIR: path.join(dir, "declared-status"),
        [WORKER_MARKER_VARIABLE]: name
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the settings file carries the run's resolved hold scope: an explicit scope outranks the inherited variable, and none resolves from the environment", async () => {
  // The hold scope's contract is inheritance by every nested invocation,
  // and `resolveHoldScope` gives the `--hold-scope` flag (or `holdScope`
  // option) precedence over `ENSEMBLE_HOLD_SCOPE`. The control plane is
  // handed that resolved value; it must never re-read the variable itself,
  // because a scope the launcher took from the flag exists nowhere in the
  // environment — the settings file would then carry the wrong scope, or
  // none, and a lead listing its own scope would never see the worker's
  // nested holds.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-hold-scope-"));
  try {
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000014";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { copyFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          const name = args[args.indexOf("--name") + 1];
          await copyFile(args[args.indexOf("--settings") + 1], ${JSON.stringify(dir)} + "/settings-" + name + ".json");
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          // The stub registers whichever dispatch asked last: one session
          // name per control plane below, so each dispatch finds its own.
          const name = process.env.ENSEMBLE_TEST_ROSTER_NAME;
          process.stdout.write(JSON.stringify([{
            id: "hold-scope-1",
            sessionId: ${JSON.stringify(sessionId)},
            name,
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    const savedScope = process.env.ENSEMBLE_HOLD_SCOPE;
    const savedRoster = process.env.ENSEMBLE_TEST_ROSTER_NAME;
    process.env.ENSEMBLE_HOLD_SCOPE = "lead-session-42";
    const settingsFor = async (name: string, holdScope: string | null | undefined): Promise<Record<string, unknown>> => {
      process.env.ENSEMBLE_TEST_ROSTER_NAME = name;
      const controlPlane = new ClaudeCliControlPlane({
        claudeBin: stubPath,
        projectsDir: dir,
        dispatchTimeoutMs: 1_000,
        ...(holdScope !== undefined ? { holdScope } : {})
      });
      await controlPlane.dispatch({ prompt: "hello", name, cwd: dir });
      return (JSON.parse(await readFile(path.join(dir, `settings-${name}.json`), "utf8")) as { env: Record<string, unknown> }).env;
    };
    try {
      // Explicit wins: the flag's scope, not the variable's, reaches the session.
      assert.deepEqual(await settingsFor("explicit-scope", "flag-scope-7"), {
        [BACKGROUND_ISOLATION_VARIABLE]: "none",
        ENSEMBLE_HOLD_SCOPE: "flag-scope-7",
        [WORKER_MARKER_VARIABLE]: "explicit-scope"
      });
      // No explicit input: the control plane resolves as a bare invocation would.
      assert.deepEqual(await settingsFor("inherited-scope", undefined), {
        [BACKGROUND_ISOLATION_VARIABLE]: "none",
        ENSEMBLE_HOLD_SCOPE: "lead-session-42",
        [WORKER_MARKER_VARIABLE]: "inherited-scope"
      });
      // The shared scope, resolved by the caller: nothing is delivered, even
      // though this process's own variable names a scope.
      assert.deepEqual(await settingsFor("shared-scope", null), {
        [BACKGROUND_ISOLATION_VARIABLE]: "none",
        [WORKER_MARKER_VARIABLE]: "shared-scope"
      });
    } finally {
      restoreEnv("ENSEMBLE_HOLD_SCOPE", savedScope);
      restoreEnv("ENSEMBLE_TEST_ROSTER_NAME", savedRoster);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the first dispatch sweeps settings directories whose owning launcher is provably gone and keeps every other", async () => {
  // A launcher killed by SIGKILL or crashed never reaches stop(), so its
  // per-dispatch settings directory outlives it. Each directory carries the
  // launcher's owner evidence beside the settings file; the next control
  // plane's first dispatch removes the ones whose owner is provably gone,
  // under the run manifest's own judgement — a live owner's directory, an
  // unrelated directory, and one with no readable owner record (a
  // concurrent launcher between its mkdtemp and its owner write looks
  // exactly like that) are left exactly as found.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-settings-sweep-"));
  const tempRoot = path.join(dir, "tmp");
  const proc = path.join(dir, "proc");
  await mkdir(tempRoot);
  await writeProcStat(proc, process.pid, "1111");
  try {
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000014";
    const name = "sweep-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "sweep-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: ${JSON.stringify(name)},
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);
    const host = hostname();
    const leftover = async (basename: string, owner: object | null): Promise<string> => {
      const leftoverDir = path.join(tempRoot, basename);
      await mkdir(leftoverDir, { mode: 0o700 });
      await writeFile(path.join(leftoverDir, "settings.json"), `${JSON.stringify({ env: { [WORKER_MARKER_VARIABLE]: basename } })}\n`);
      if (owner !== null) {
        await writeFile(path.join(leftoverDir, "owner.json"), `${JSON.stringify(owner)}\n`);
      }
      return leftoverDir;
    };
    const deadOwner = await leftover("ensemble-claude-env-dead-aaaaaa", { pid: 999999, start_ticks: "3333", host });
    const reusedPid = await leftover("ensemble-claude-env-reused-bbbbbb", { pid: process.pid, start_ticks: "9999", host });
    const liveOwner = await leftover("ensemble-claude-env-live-cccccc", { pid: process.pid, start_ticks: "1111", host });
    const foreignHost = await leftover("ensemble-claude-env-foreign-dddddd", { pid: 999999, start_ticks: "3333", host: `${host}-elsewhere` });
    const noOwner = await leftover("ensemble-claude-env-legacy-eeeeee", null);
    const unrelated = path.join(tempRoot, "someone-elses-dir");
    await mkdir(unrelated);

    const savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = tempRoot;
    try {
      const controlPlane = new ClaudeCliControlPlane({
        claudeBin: stubPath,
        projectsDir: dir,
        dispatchTimeoutMs: 1_000,
        procDir: proc
      });
      const handle = await controlPlane.dispatch({ prompt: "hello", name, cwd: dir });

      const survivors = (await readdir(tempRoot)).sort();
      const ownDir = survivors.find((entry) => entry.startsWith(`ensemble-claude-env-${name}-`));
      assert.ok(ownDir, "this dispatch's own directory exists");
      assert.deepEqual(
        survivors.filter((entry) => entry !== ownDir),
        [path.basename(liveOwner), path.basename(foreignHost), path.basename(noOwner), path.basename(unrelated)].sort(),
        "provably-dead directories go; live, foreign-host, ownerless and unrelated ones stay"
      );
      for (const gone of [deadOwner, reusedPid]) {
        await assert.rejects(access(gone), gone);
      }
      // This dispatch's own directory carries the evidence a later sweep judges by.
      const owner = JSON.parse(await readFile(path.join(tempRoot, ownDir, "owner.json"), "utf8")) as {
        pid: number;
        start_ticks: string | null;
        host: string;
      };
      assert.deepEqual(owner, { pid: process.pid, start_ticks: "1111", host });
      assert.equal((await stat(path.join(tempRoot, ownDir, "owner.json"))).mode & 0o777, 0o600);
      await controlPlane.stop(handle);
      await assert.rejects(access(path.join(tempRoot, ownDir)), "stop() still removes the whole directory");
    } finally {
      restoreEnv("TMPDIR", savedTmpdir);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a declared worker environment rides a per-dispatch settings file to the worker session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-settings-env-"));
  try {
    const argvPath = path.join(dir, "dispatch-argv.json");
    const settingsCopyPath = path.join(dir, "settings-copy.json");
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000004";
    const name = "settings-env-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { copyFile, writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          await writeFile(${JSON.stringify(argvPath)}, JSON.stringify(args));
          // The daemon reads the settings file while starting the session;
          // copy it here so the test can inspect content that outlives stop().
          const flag = args.indexOf("--settings");
          if (flag !== -1) {
            await copyFile(args[flag + 1], ${JSON.stringify(settingsCopyPath)});
          }
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "settings-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: ${JSON.stringify(name)},
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    const declared = { ANTHROPIC_BASE_URL: "https://declared.example", ANTHROPIC_AUTH_TOKEN: "sentinel-token" };
    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: stubPath,
      projectsDir: dir,
      dispatchTimeoutMs: 1_000,
      workerEnv: declared
    });
    const handle = await controlPlane.dispatch({ prompt: "hello", name, cwd: dir });

    // The flag was passed and the file carried exactly the declared env block
    // plus the dispatch's ownership tag — the harness writes only its own
    // declarations, never a merge of the operator's settings (Claude Code's
    // own additive layering does the merge).
    const dispatchArgv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
    const flagIndex = dispatchArgv.indexOf("--settings");
    assert.notEqual(flagIndex, -1);
    const settingsPath = dispatchArgv[flagIndex + 1]!;
    assert.deepEqual(JSON.parse(await readFile(settingsCopyPath, "utf8")), {
      env: { [BACKGROUND_ISOLATION_VARIABLE]: "none", ...declared, [WORKER_MARKER_VARIABLE]: name }
    });

    // The file holds credentials: private file in a private directory, and it
    // lives exactly as long as the session — present while live, gone on stop().
    const fileMode = (await stat(settingsPath)).mode & 0o777;
    assert.equal(fileMode, 0o600);
    const dirMode = (await stat(path.dirname(settingsPath))).mode & 0o777;
    assert.equal(dirMode, 0o700);
    await controlPlane.stop(handle);
    await assert.rejects(access(settingsPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a requested cache TTL joins the settings env block, and a machine declaration for the same variable wins", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-cache-ttl-"));
  try {
    const settingsCopyPath = path.join(dir, "settings-copy.json");
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000006";
    const name = "cache-ttl-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { copyFile, writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          const flag = args.indexOf("--settings");
          if (flag !== -1) {
            await copyFile(args[flag + 1], ${JSON.stringify(settingsCopyPath)});
          }
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "cache-ttl-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: ${JSON.stringify(name)},
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    // The operator's word outranks the harness default: a machine-declared
    // value for the TTL variable must survive the dispatch's own request.
    const declared = { [CLAUDE_CACHE_TTL_VARIABLE]: "5m" };
    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: stubPath,
      projectsDir: dir,
      dispatchTimeoutMs: 1_000,
      workerEnv: declared
    });
    const handle = await controlPlane.dispatch({ prompt: "hello", name, cwd: dir, cacheTtl: "1h" });
    assert.deepEqual(JSON.parse(await readFile(settingsCopyPath, "utf8")), {
      env: { [BACKGROUND_ISOLATION_VARIABLE]: "none", [CLAUDE_CACHE_TTL_VARIABLE]: "5m", [WORKER_MARKER_VARIABLE]: name }
    });
    await controlPlane.stop(handle);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every dispatch declares in-place editing to the worker session, and a machine declaration of the same variable wins", async (context) => {
  // Claude Code's background default is `worktree`: the job prompt tells the
  // model to call EnterWorktree before its first edit and the Edit and Write
  // tools reject the shared checkout until it does (measured 2026-10-15,
  // 2.1.300), so a worker placed by `cwd` would leave that directory
  // untouched. The declaration rides the settings file — the one surface that
  // reaches the daemon-served session — beneath the operator's own word.
  for (const declared of [undefined, { [BACKGROUND_ISOLATION_VARIABLE]: "worktree" }]) {
    await context.test(declared === undefined ? "harness default" : "machine declaration wins", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-isolation-"));
      try {
        const settingsCopyPath = path.join(dir, "settings-copy.json");
        const stubPath = path.join(dir, "claude-stub.mjs");
        const sessionId = "00000000-0000-4000-8000-000000000031";
        const name = "isolation-probe";
        await writeFile(
          stubPath,
          `#!/usr/bin/env node
            import { copyFile } from "node:fs/promises";
            const args = process.argv.slice(2);
            if (args[0] === "--bg") {
              const flag = args.indexOf("--settings");
              if (flag !== -1) {
                await copyFile(args[flag + 1], ${JSON.stringify(settingsCopyPath)});
              }
              process.exit(0);
            }
            if (args[0] === "agents" && args[1] === "--json") {
              process.stdout.write(JSON.stringify([{
                id: "isolation-1",
                sessionId: ${JSON.stringify(sessionId)},
                name: ${JSON.stringify(name)},
                kind: "background",
                cwd: ${JSON.stringify(dir)},
                status: "busy",
                state: "working"
              }]));
            }
            process.exit(0);
          `
        );
        await chmod(stubPath, 0o755);

        const controlPlane = new ClaudeCliControlPlane({
          claudeBin: stubPath,
          projectsDir: dir,
          dispatchTimeoutMs: 1_000,
          ...(declared !== undefined ? { workerEnv: declared } : {})
        });
        const handle = await controlPlane.dispatch({ prompt: "edit main.js", name, cwd: dir });
        assert.deepEqual(JSON.parse(await readFile(settingsCopyPath, "utf8")), {
          env: { [BACKGROUND_ISOLATION_VARIABLE]: declared === undefined ? "none" : "worktree", [WORKER_MARKER_VARIABLE]: name }
        });
        await controlPlane.stop(handle);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("an undeclared worker environment still dispatches with the ownership tag alone", async () => {
  // The settings file is written on every dispatch now: the tag is what lets
  // stop() reap the worker's surviving descendants, and an untagged worker
  // would be an unowned one. With nothing declared, the tag is the file's
  // whole content.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-no-settings-"));
  try {
    const argvPath = path.join(dir, "dispatch-argv.json");
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000005";
    const name = "no-settings-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          await writeFile(${JSON.stringify(argvPath)}, JSON.stringify(args));
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "no-settings-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: ${JSON.stringify(name)},
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: stubPath,
      projectsDir: dir,
      dispatchTimeoutMs: 1_000
    });
    await controlPlane.dispatch({ prompt: "hello", name, cwd: dir });

    const dispatchArgv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
    const flagIndex = dispatchArgv.indexOf("--settings");
    assert.notEqual(flagIndex, -1);
    assert.deepEqual(JSON.parse(await readFile(dispatchArgv[flagIndex + 1]!, "utf8")), {
      env: { [BACKGROUND_ISOLATION_VARIABLE]: "none", [WORKER_MARKER_VARIABLE]: name }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("permission deny rules join the per-dispatch settings file beside the env block", async () => {
  // Capability stripping rides the same single-purpose file as the
  // worker environment: deny rules union additively across settings layers
  // and beat every allow, so carrying only this dispatch's rules never
  // touches the operator's own permission configuration.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-deny-rules-"));
  try {
    const argvPath = path.join(dir, "dispatch-argv.json");
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000014";
    const name = "deny-rules-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          await writeFile(${JSON.stringify(argvPath)}, JSON.stringify(args));
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "deny-rules-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: ${JSON.stringify(name)},
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: stubPath,
      projectsDir: dir,
      dispatchTimeoutMs: 1_000
    });
    await controlPlane.dispatch({
      prompt: "hello",
      name,
      cwd: dir,
      permissionDenyRules: ["Skill", "Task", "Agent", "ListAgents", "SendMessage"]
    });

    const dispatchArgv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
    const flagIndex = dispatchArgv.indexOf("--settings");
    assert.notEqual(flagIndex, -1);
    assert.deepEqual(JSON.parse(await readFile(dispatchArgv[flagIndex + 1]!, "utf8")), {
      env: { [BACKGROUND_ISOLATION_VARIABLE]: "none", [WORKER_MARKER_VARIABLE]: name },
      permissions: { deny: ["Skill", "Task", "Agent", "ListAgents", "SendMessage"] }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop reaps a surviving process tagged with the dispatch's marker", async () => {
  // The failure this closes: descendants of a daemon-hosted worker reparent
  // to the user session when the worker dies, and nothing in the harness
  // could reach them. The tag inherits through every spawn, so stop() can.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-reap-"));
  try {
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000006";
    const name = "reap-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "reap-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: ${JSON.stringify(name)},
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    // Two descendants as the worker would have left them: alive, and
    // carrying the dispatch tag they inherited through the settings-file env
    // block. The second ignores SIGTERM, so it exercises the escalation —
    // which must re-establish identity by re-scan (a pid can be reused
    // during the grace period) before SIGKILL.
    const straggler = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: hermeticEstateEnvironment({ [WORKER_MARKER_VARIABLE]: name }),
      stdio: "ignore"
    });
    const readyPath = path.join(dir, "stubborn-ready");
    const stubborn = spawn(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "ready");`
      ],
      {
        env: hermeticEstateEnvironment({ [WORKER_MARKER_VARIABLE]: name }),
        stdio: "ignore"
      }
    );
    const exited = new Promise<void>((resolve) => straggler.once("exit", () => resolve()));
    const stubbornExited = new Promise<void>((resolve) => stubborn.once("exit", () => resolve()));
    await new Promise<void>((resolve) => straggler.once("spawn", () => resolve()));
    // The TERM handler must be installed before the reap fires, or the
    // default disposition kills the child and the escalation goes untested.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await readFile(readyPath, "utf8");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: stubPath,
      projectsDir: dir,
      dispatchTimeoutMs: 1_000,
      reapGraceMs: 100
    });
    const handle = await controlPlane.dispatch({ prompt: "hello", name, cwd: dir });
    await controlPlane.stop(handle);

    await exited;
    await stubbornExited;
    assert.equal(straggler.exitCode === null ? straggler.signalCode : straggler.exitCode, "SIGTERM");
    assert.equal(stubborn.signalCode, "SIGKILL");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A tmux stub's view of its own invocation. The valve names its private
 * server before every command (`-S <socket>`, plus `-f <config>` when it
 * starts the server), so a stub strips those global options to read the
 * command itself as `command`.
 */
const TMUX_STUB_COMMAND = `
  const command = process.argv.slice(2);
  while (command[0] === "-S" || command[0] === "-f") command.splice(0, 2);
`;

test("steer returns false when either tmux delivery step fails", async (context) => {
  for (const failedStep of ["literal", "enter"] as const) {
    await context.test(failedStep, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-control-plane-"));
      try {
        const claudeStub = path.join(dir, "claude-stub.mjs");
        const tmuxStub = path.join(dir, "tmux-stub.mjs");
        const sessionId = "00000000-0000-4000-8000-000000000002";
        await writeFile(
          claudeStub,
          `#!/usr/bin/env node
            const args = process.argv.slice(2);
            if (args[0] === "agents" && args[1] === "--json") {
              process.stdout.write(JSON.stringify([{
                id: "steer-1",
                sessionId: ${JSON.stringify(sessionId)},
                name: "steer-probe",
                kind: "background",
                cwd: ${JSON.stringify(dir)},
                status: "idle",
                state: "blocked"
              }]));
            }
          `
        );
        await writeFile(
          tmuxStub,
          `#!/usr/bin/env node
            ${TMUX_STUB_COMMAND}
            const literal = command[0] === "send-keys" && command.includes("-l");
            const enter = command[0] === "send-keys" && command.at(-1) === "Enter";
            if ((${JSON.stringify(failedStep)} === "literal" && literal) ||
                (${JSON.stringify(failedStep)} === "enter" && enter)) {
              process.exit(1);
            }
          `
        );
        await chmod(claudeStub, 0o755);
        await chmod(tmuxStub, 0o755);

        const controlPlane = new ClaudeCliControlPlane({
          claudeBin: claudeStub,
          tmuxBin: tmuxStub,
          projectsDir: dir,
          valveAttachSettleMs: 0,
          valveSubmitSettleMs: 0,
          valveKillSettleMs: 0
        });
        const steered = await controlPlane.steer(
          { id: "steer-1", sessionId, name: "steer-probe", cwd: dir },
          "continue"
        );

        assert.equal(steered.delivered, false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("every launched claude child sees the workspace declared sandboxed, above a machine declaration, and the settings file never carries it", async () => {
  // The declaration is what lifts Claude Code's trust gate for a scratch
  // directory, a sibling checkout, or a worktree, so it must reach the
  // dispatching process whatever the parent environment says — and it is
  // harness bookkeeping, not worker configuration, so the per-dispatch
  // settings file (the worker session's surface) carries only the declared
  // environment and the ownership tag.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-sandboxed-"));
  try {
    const sessionId = "00000000-0000-4000-8000-000000000021";
    const stubPath = path.join(dir, "claude-stub.mjs");
    // Every invocation — dispatch, roster query, stop, rm — appends what it
    // saw, so the assertion covers each child the control plane launches
    // and not only the dispatch.
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { appendFile, readFile, writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        const probe = process.env.ENSEMBLE_TEST_ROSTER_NAME;
        await appendFile(${JSON.stringify(dir)} + "/children-" + probe + ".jsonl", JSON.stringify({
          child: args[0],
          sandboxed: process.env[${JSON.stringify(SANDBOXED_WORKSPACE_VARIABLE)}] ?? null
        }) + "\\n");
        if (args[0] === "--bg") {
          const settings = await readFile(args[args.indexOf("--settings") + 1], "utf8");
          await writeFile(${JSON.stringify(dir)} + "/observed-" + probe + ".json", JSON.stringify({
            settings: JSON.parse(settings)
          }));
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "sandboxed-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: probe,
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    const observe = async (name: string, workerEnv: Record<string, string>) => {
      process.env.ENSEMBLE_TEST_ROSTER_NAME = name;
      const controlPlane = new ClaudeCliControlPlane({ claudeBin: stubPath, projectsDir: dir, dispatchTimeoutMs: 1_000, workerEnv });
      const handle = await controlPlane.dispatch({ prompt: "hello", name, cwd: dir });
      await controlPlane.stop(handle);
      const children = (await readFile(path.join(dir, `children-${name}.jsonl`), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { child: string; sandboxed: string | null });
      const settings = JSON.parse(await readFile(path.join(dir, `observed-${name}.json`), "utf8")) as {
        settings: { env: Record<string, string> };
      };
      return { children, settings: settings.settings };
    };
    // The parent deliberately does not carry the variable: the declaration
    // must be the harness's, not an inheritance the test happened to have.
    const savedSandboxed = process.env[SANDBOXED_WORKSPACE_VARIABLE];
    const savedRosterName = process.env.ENSEMBLE_TEST_ROSTER_NAME;
    delete process.env[SANDBOXED_WORKSPACE_VARIABLE];
    try {
      const plain = await observe("sandboxed-plain", { ANTHROPIC_BASE_URL: "https://declared.example" });
      // Dispatch, the roster queries around it, stop, and rm all saw the
      // declaration — and nothing the control plane launched went without it.
      const seen = new Set(plain.children.map((child) => child.child));
      for (const child of ["--bg", "agents", "stop", "rm"]) {
        assert.ok(seen.has(child), `the control plane launched no '${child}' child`);
      }
      for (const child of plain.children) {
        assert.equal(child.sandboxed, "1", `the '${child.child}' child did not see the declaration`);
      }
      assert.deepEqual(plain.settings.env, {
        [BACKGROUND_ISOLATION_VARIABLE]: "none",
        ANTHROPIC_BASE_URL: "https://declared.example",
        [WORKER_MARKER_VARIABLE]: "sandboxed-plain"
      });

      // A machine declaration of the same name does not switch the lift off:
      // bookkeeping lands last, as the ownership tag does.
      const overridden = await observe("sandboxed-overridden", { [SANDBOXED_WORKSPACE_VARIABLE]: "0" });
      assert.ok(overridden.children.every((child) => child.sandboxed === "1"));
    } finally {
      restoreEnv(SANDBOXED_WORKSPACE_VARIABLE, savedSandboxed);
      restoreEnv("ENSEMBLE_TEST_ROSTER_NAME", savedRosterName);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the valve's private tmux server starts from the declared environment, and no tmux argument carries a declared value", async () => {
  // The declared values are gateway credentials, and a process's argv is
  // readable by every local user: they must reach the attach client only as
  // the environment its private server starts from.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-valve-sandboxed-"));
  try {
    const claudeStub = path.join(dir, "claude-stub.mjs");
    const tmuxStub = path.join(dir, "tmux-stub.mjs");
    const invocationsPath = path.join(dir, "tmux-invocations.jsonl");
    const sessionId = "00000000-0000-4000-8000-000000000022";
    // A declared TMUX_TMPDIR is the workers' setting, not the valve's: it
    // must not steer where the valve's socket goes, which would put a
    // declared value into every `-S` argument.
    const declared = {
      ANTHROPIC_BASE_URL: "https://declared.example",
      ANTHROPIC_AUTH_TOKEN: "declared-gateway-token",
      TMUX_TMPDIR: "/declared-tmux-root"
    };
    await writeFile(
      claudeStub,
      `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "valve-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: "valve-probe",
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "idle",
            state: "blocked"
          }]));
        }
      `
    );
    await writeFile(
      tmuxStub,
      `#!/usr/bin/env node
        import { appendFile } from "node:fs/promises";
        await appendFile(${JSON.stringify(invocationsPath)}, JSON.stringify({
          argv: process.argv.slice(2),
          base: process.env.ANTHROPIC_BASE_URL ?? null,
          token: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
          sandboxed: process.env[${JSON.stringify(SANDBOXED_WORKSPACE_VARIABLE)}] ?? null
        }) + "\\n");
      `
    );
    await chmod(claudeStub, 0o755);
    await chmod(tmuxStub, 0o755);

    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: claudeStub,
      tmuxBin: tmuxStub,
      projectsDir: dir,
      workerEnv: declared,
      valveAttachSettleMs: 0,
      valveSubmitSettleMs: 0,
      valveKillSettleMs: 0
    });
    const steered = await controlPlane.steer({ id: "valve-1", sessionId, name: "valve-probe", cwd: dir }, "continue");
    assert.deepEqual(steered, { delivered: true });

    const invocations = (await readFile(invocationsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; base: string | null; token: string | null; sandboxed: string | null });
    for (const { argv } of invocations) {
      for (const value of Object.values(declared)) {
        assert.ok(
          argv.every((argument) => !argument.includes(value)),
          `a tmux invocation carried a declared value in argv: ${JSON.stringify(argv)}`
        );
      }
    }

    // One private server for the whole valve: every command names the same
    // socket, the server starts on no configuration file, and the valve ends
    // by killing it.
    const socket = invocations[0]?.argv[1];
    assert.ok(invocations.every(({ argv }) => argv[0] === "-S" && argv[1] === socket));
    assert.deepEqual(invocations[0]?.argv.slice(2, 5), ["-f", "/dev/null", "new-session"]);
    assert.deepEqual(
      invocations.slice(1).map(({ argv }) => argv[2]),
      ["send-keys", "send-keys", "kill-server"]
    );

    // The server's starting environment is what its pane inherits.
    const started = invocations[0];
    assert.deepEqual(
      { base: started?.base, token: started?.token, sandboxed: started?.sandboxed },
      { base: declared.ANTHROPIC_BASE_URL, token: declared.ANTHROPIC_AUTH_TOKEN, sandboxed: "1" }
    );

    // tmux leaves its socket file behind on exit; the valve removes it with
    // its directory.
    await assert.rejects(access(path.dirname(socket ?? "")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a real tmux valve hands the declared environment and the message to its attach client, and leaves no server behind", async (t) => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("tmux is not installed");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-valve-real-"));
  // The pane runs its command through the server's shell, which tmux takes
  // from SHELL: a plain sh keeps the attach stub's start well inside the
  // attach settle, whatever the operator's login shell loads.
  const savedShell = process.env.SHELL;
  const savedTmpdir = process.env.TMPDIR;
  const savedTmuxTmpdir = process.env.TMUX_TMPDIR;
  process.env.SHELL = "/bin/sh";
  // tmux keeps its sockets under TMUX_TMPDIR. A short, empty root of the
  // test's own keeps the valve away from the operator's tmux server and
  // shows afterwards whether anything — a default server's socket
  // directory, a valve's leftover one — was made there.
  const tmuxRoot = await mkdtemp(path.join("/tmp", "ensemble-tmux-root-"));
  process.env.TMUX_TMPDIR = tmuxRoot;
  try {
    const claudeStub = path.join(dir, "claude-stub.sh");
    const sessionId = "00000000-0000-4000-8000-000000000024";
    const roster = JSON.stringify([
      { id: "valve-real-1", sessionId, name: "valve-real-probe", kind: "background", cwd: dir, status: "idle", state: "blocked" }
    ]);
    // The attach stub records the two variables it inherited, then echoes
    // its terminal input to a file, as the real attach client would take it.
    await writeFile(
      claudeStub,
      `#!/bin/sh
case "$1" in
  agents) printf '%s' '${roster}' ;;
  attach)
    printf '%s\\n%s\\n' "$ANTHROPIC_AUTH_TOKEN" "$${SANDBOXED_WORKSPACE_VARIABLE}" > '${dir}/attach-env.tmp'
    mv '${dir}/attach-env.tmp' '${dir}/attach-env'
    exec cat > '${dir}/attach-input'
    ;;
esac
`
    );
    await chmod(claudeStub, 0o755);
    // A temp root deeper than any socket path can be: the valve's socket
    // lives where tmux keeps its own, so the temp root must not matter.
    const deepTmpdir = path.join(dir, "t".repeat(120));
    await mkdir(deepTmpdir);
    process.env.TMPDIR = deepTmpdir;

    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: claudeStub,
      projectsDir: dir,
      workerEnv: { ANTHROPIC_AUTH_TOKEN: "declared-gateway-token" },
      valveAttachSettleMs: 1_500,
      valveSubmitSettleMs: 200,
      valveKillSettleMs: 1_000
    });
    // A follow-up with the shapes the valve must carry literally: a leading
    // dash, newlines that insert rather than submit, non-ASCII text, and a
    // length that takes several sends. The attach stub reads the pane's tty in
    // canonical mode, which passes every byte here and turns the submitting
    // Enter (a carriage return) into the trailing newline.
    const message = `-- continue\nline ${"é".repeat(900)}\nend`;
    assert.ok(message.length > VALVE_SLICE_CHARS * 2);
    const steered = await controlPlane.steer({ id: "valve-real-1", sessionId, name: "valve-real-probe", cwd: dir }, message);
    assert.deepEqual(steered, { delivered: true });

    assert.equal(await readFile(path.join(dir, "attach-env"), "utf8"), "declared-gateway-token\n1\n");
    assert.equal(await readFile(path.join(dir, "attach-input"), "utf8"), `${message}\n`);
    assert.deepEqual(await readdir(tmuxRoot), [], "the valve left a socket directory behind, or used the default tmux server");
    // The server is forked from the client that started it and keeps that
    // client's argv, which names the stub; it exits once killed, though not
    // necessarily before the kill command returns.
    const deadline = Date.now() + 5_000;
    while ((await processesNaming(claudeStub)).length > 0) {
      assert.ok(Date.now() < deadline, "the valve's tmux server outlived the valve");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    restoreEnv("SHELL", savedShell);
    restoreEnv("TMPDIR", savedTmpdir);
    restoreEnv("TMUX_TMPDIR", savedTmuxTmpdir);
    // Only a valve that used the default server leaves one running here.
    try {
      execFileSync("tmux", ["kill-server"], { env: { ...process.env, TMUX_TMPDIR: tmuxRoot }, stdio: "ignore" });
    } catch {
      // No server under the test's root: the expected case.
    }
    await rm(dir, { recursive: true, force: true });
    await rm(tmuxRoot, { recursive: true, force: true });
  }
});

test("valveSlices cuts a message into typed-length, code-point-whole send-keys arguments that rejoin exactly", () => {
  assert.deepEqual(valveSlices(""), []);
  assert.deepEqual(valveSlices("continue"), ["continue"]);
  // Three sends the client reads as one must still fall under its paste
  // threshold: the slice is a quarter of it by construction.
  assert.ok(VALVE_SLICE_CHARS * 3 < VALVE_PASTE_THRESHOLD_CHARS);

  // Astral characters take two UTF-16 code units, so a cut by code units
  // lands between a surrogate pair somewhere unless the slicer steps by code
  // point. The repeat is five code units long, which no slice bound that is
  // a multiple of four divides, so a naive `slice(offset, offset + bound)`
  // would tear a pair at some boundary; the newline keeps the fixture
  // line-shaped.
  const message = "ab😀\n".repeat(20_000);
  const slices = valveSlices(message);
  assert.ok(slices.length > 1);
  for (const slice of slices) {
    assert.ok(slice.length <= VALVE_SLICE_CHARS, "a slice is read as typing, never as a paste");
    assert.equal(Buffer.from(slice, "utf8").toString("utf8"), slice, "a slice is whole UTF-16, never a torn surrogate pair");
  }
  assert.equal(slices.join(""), message);
});

test("a follow-up turn larger than one argv element reaches the valve whole, in order, before its submit keystroke", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-valve-large-"));
  try {
    const claudeStub = path.join(dir, "claude-stub.mjs");
    const tmuxStub = path.join(dir, "tmux-stub.mjs");
    const sendKeysPath = path.join(dir, "send-keys.jsonl");
    const sessionId = "00000000-0000-4000-8000-000000000023";
    await writeFile(
      claudeStub,
      `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "valve-2",
            sessionId: ${JSON.stringify(sessionId)},
            name: "valve-large-probe",
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "idle",
            state: "blocked"
          }]));
        }
      `
    );
    await writeFile(
      tmuxStub,
      `#!/usr/bin/env node
        import { appendFile } from "node:fs/promises";
        ${TMUX_STUB_COMMAND}
        if (command[0] === "send-keys") {
          await appendFile(${JSON.stringify(sendKeysPath)}, JSON.stringify(command.slice(3)) + "\\n");
        }
      `
    );
    await chmod(claudeStub, 0o755);
    await chmod(tmuxStub, 0o755);

    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: claudeStub,
      tmuxBin: tmuxStub,
      projectsDir: dir,
      valveAttachSettleMs: 0,
      valveSubmitSettleMs: 0,
      valveKillSettleMs: 0,
      valveSliceGapMs: 0
    });
    // Well past tmux's 16 KiB client-command cap: a diff-carrying follow-up
    // of the size a one-command send is refused at ("command too long"). It
    // begins with `-`, the shape a slice boundary can leave at the head of
    // any send, so each literal must be sent after `--`.
    const message = "-- a/src/wide.ts\n+++ b/src/wide.ts\n" + "+  const value = \"é\";\n".repeat(1_500);
    assert.ok(Buffer.byteLength(message, "utf8") > 32 * 1024);

    const steered = await controlPlane.steer({ id: "valve-2", sessionId, name: "valve-large-probe", cwd: dir }, message);
    assert.deepEqual(steered, { delivered: true });

    const sends = (await readFile(sendKeysPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const literalSends = sends.filter((send) => send[0] === "-l");
    assert.ok(literalSends.length > 1, "the message took more than one literal send");
    for (const send of literalSends) {
      assert.equal(send[1], "--", "option parsing ends before the literal, whatever it begins with");
      assert.ok((send[2] ?? "").length <= VALVE_SLICE_CHARS, "a slice is read as typing, never as a paste");
    }
    assert.equal(literalSends.map((send) => send[2] ?? "").join(""), message);
    assert.deepEqual(sends.at(-1), ["Enter"], "the submit keystroke follows the last slice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dispatch Claude Code refuses is a ClaudeDispatchError naming the directory, the declaration, and Claude Code's own text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-refused-"));
  try {
    const stubPath = path.join(dir, "claude-stub.mjs");
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          // Two lines and a colour reset, as a CLI's stderr may well carry.
          process.stderr.write("Workspace not trusted.\\nRun \`claude\` in " + ${JSON.stringify(dir)} + " once and accept the trust prompt, then retry.\\u001b[0m\\n");
          process.exit(1);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write("[]");
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    const controlPlane = new ClaudeCliControlPlane({ claudeBin: stubPath, projectsDir: dir, dispatchTimeoutMs: 1_000 });
    await assert.rejects(
      () => controlPlane.dispatch({ prompt: "hello", name: "refused-probe", cwd: dir }),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeDispatchError);
        // The operator reads the directory, sees the lift was declared, and
        // gets Claude Code's words whole — the remedy is in the environment.
        assert.match(error.message, new RegExp(`refused to dispatch worker 'refused-probe' in ${dir.replaceAll(".", "\\.")}`));
        assert.match(error.message, new RegExp(`declared sandboxed via ${SANDBOXED_WORKSPACE_VARIABLE}`));
        // Engine-controlled text on a one-line operator surface: flattened,
        // control-stripped, bounded — so the run's failure is one clean line.
        assert.match(error.message, /Workspace not trusted\. Run `claude` in .* once and accept the trust prompt, then retry\.$/);
        assert.ok(!error.message.includes("\n") && !error.message.includes("\u001b"), "the refusal must be one clean line");
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dispatch the daemon accepted but never registered is a registration timeout, not a refusal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-unregistered-"));
  try {
    const stubPath = path.join(dir, "claude-stub.mjs");
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write("[]");
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    const controlPlane = new ClaudeCliControlPlane({ claudeBin: stubPath, projectsDir: dir, dispatchTimeoutMs: 50 });
    await assert.rejects(
      () => controlPlane.dispatch({ prompt: "hello", name: "unregistered-probe", cwd: dir }),
      (error: unknown) => {
        // Claude Code did not decline — `claude --bg` returned — so this is
        // the engine's operational failure (spent and retried by the loop),
        // never the pre-spawn refusal.
        assert.ok(error instanceof ClaudeRegistrationTimeoutError);
        assert.ok(!(error instanceof ClaudeDispatchError));
        // The whole line, compared as text: a path is not a pattern, and a
        // temp root with a dot in it must not change what the test proves.
        assert.equal(error.message, `dispatched session 'unregistered-probe' in ${dir} did not register within 50ms`);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


/** Pids whose command line mentions `text`; a process that exits mid-scan is passed over. */
async function processesNaming(text: string): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await readdir("/proc").catch(() => [] as string[])) {
    if (/^\d+$/.test(entry) && (await readFile(path.join("/proc", entry, "cmdline"), "utf8").catch(() => "")).includes(text)) {
      pids.push(Number(entry));
    }
  }
  return pids;
}

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = saved;
  }
}
