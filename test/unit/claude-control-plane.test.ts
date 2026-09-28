import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { spawn } from "node:child_process";

import {
  CLAUDE_CACHE_TTL_VARIABLE,
  ClaudeCliControlPlane,
  SANDBOXED_WORKSPACE_VARIABLE,
  VALVE_SLICE_BYTES,
  WORKER_MARKER_VARIABLE,
  valveSlices
} from "../../src/claude-control-plane.js";
import { ClaudeDispatchError, ClaudeRegistrationTimeoutError } from "../../src/errors.js";
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
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000013";
    const name = "run-scoped-env-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          await writeFile(${JSON.stringify(envPath)}, JSON.stringify({
            recordDir: process.env.ENSEMBLE_RUN_RECORD_DIR ?? null,
            record: process.env.ENSEMBLE_RUN_RECORD ?? null,
            statusDir: process.env.ENSEMBLE_STATUS_DIR ?? null,
            concurrency: process.env.ENSEMBLE_CONCURRENCY_CLAUDE ?? null,
            inherited: process.env.ENSEMBLE_TEST_INHERITED ?? null
          }));
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
      ["ENSEMBLE_RUN_RECORD_DIR", "ENSEMBLE_RUN_RECORD", "ENSEMBLE_STATUS_DIR", "ENSEMBLE_CONCURRENCY_CLAUDE", "ENSEMBLE_TEST_INHERITED"].map(
        (key) => [key, process.env[key]]
      )
    );
    process.env.ENSEMBLE_RUN_RECORD_DIR = path.join(dir, "relocated-store");
    process.env.ENSEMBLE_RUN_RECORD = "on";
    process.env.ENSEMBLE_STATUS_DIR = path.join(dir, "relocated-status");
    process.env.ENSEMBLE_CONCURRENCY_CLAUDE = "3";
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
      inherited: "still-here"
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the first dispatch sweeps settings directories whose owning launcher is provably gone and keeps every other", async () => {
  // A launcher killed by SIGKILL or crashed never reaches stop(), so its
  // per-dispatch settings directory outlives it. Each directory carries the
  // launcher's owner evidence beside the settings file; the next control
  // plane's first dispatch removes the ones whose owner is provably gone,
  // under the run manifest's own judgement — a live owner's directory and
  // an unrelated directory are left exactly as found, and one with no owner
  // record predates owner recording and goes.
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
        [path.basename(liveOwner), path.basename(foreignHost), path.basename(unrelated)].sort(),
        "provably-dead and legacy directories go; live, foreign-host and unrelated ones stay"
      );
      for (const gone of [deadOwner, reusedPid, noOwner]) {
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
      env: { ...declared, [WORKER_MARKER_VARIABLE]: name }
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
      env: { [CLAUDE_CACHE_TTL_VARIABLE]: "5m", [WORKER_MARKER_VARIABLE]: name }
    });
    await controlPlane.stop(handle);
  } finally {
    await rm(dir, { recursive: true, force: true });
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
      env: { [WORKER_MARKER_VARIABLE]: name }
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
      env: { [WORKER_MARKER_VARIABLE]: name },
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
            const args = process.argv.slice(2);
            const literal = args[0] === "send-keys" && args.includes("-l");
            const enter = args[0] === "send-keys" && args.at(-1) === "Enter";
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

test("the valve's attach client receives the sandboxed-workspace declaration beside the declared environment as tmux -e flags", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-valve-sandboxed-"));
  try {
    const claudeStub = path.join(dir, "claude-stub.mjs");
    const tmuxStub = path.join(dir, "tmux-stub.mjs");
    const tmuxArgvPath = path.join(dir, "tmux-argv.json");
    const sessionId = "00000000-0000-4000-8000-000000000022";
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
        const args = process.argv.slice(2);
        if (args[0] === "new-session") {
          await appendFile(${JSON.stringify(tmuxArgvPath)}, JSON.stringify(args) + "\\n");
        }
      `
    );
    await chmod(claudeStub, 0o755);
    await chmod(tmuxStub, 0o755);

    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: claudeStub,
      tmuxBin: tmuxStub,
      projectsDir: dir,
      workerEnv: { ANTHROPIC_BASE_URL: "https://declared.example" },
      valveAttachSettleMs: 0,
      valveSubmitSettleMs: 0,
      valveKillSettleMs: 0
    });
    const steered = await controlPlane.steer({ id: "valve-1", sessionId, name: "valve-probe", cwd: dir }, "continue");
    assert.deepEqual(steered, { delivered: true });

    const newSession = JSON.parse((await readFile(tmuxArgvPath, "utf8")).trim()) as string[];
    const flags = newSession.flatMap((argument, index) => (argument === "-e" ? [newSession[index + 1]] : []));
    assert.deepEqual(flags, ["ANTHROPIC_BASE_URL=https://declared.example", `${SANDBOXED_WORKSPACE_VARIABLE}=1`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("valveSlices cuts a message into bounded, code-point-whole send-keys arguments that rejoin exactly", () => {
  assert.deepEqual(valveSlices(""), []);
  assert.deepEqual(valveSlices("continue"), ["continue"]);

  // Three-byte characters never divide the bound evenly, so every cut lands
  // mid-character on a byte slicer; the newline keeps the fixture line-shaped.
  const message = "€\n".repeat(60_000);
  const slices = valveSlices(message);
  assert.ok(slices.length > 1);
  for (const slice of slices) {
    assert.ok(Buffer.byteLength(slice, "utf8") <= VALVE_SLICE_BYTES);
    assert.equal(Buffer.from(slice, "utf8").toString("utf8"), slice, "a slice is whole UTF-8, never a torn character");
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
        const args = process.argv.slice(2);
        if (args[0] === "send-keys") {
          await appendFile(${JSON.stringify(sendKeysPath)}, JSON.stringify(args.slice(3)) + "\\n");
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
    // Well past Linux's 128 KiB single-argument cap: a diff-carrying follow-up
    // of the size that a one-argument send fails on with `spawn E2BIG`.
    const message = "diff --git a/src/wide.ts b/src/wide.ts\n" + "+  const value = \"é\";\n".repeat(12_000);
    assert.ok(Buffer.byteLength(message, "utf8") > 256 * 1024);

    const steered = await controlPlane.steer({ id: "valve-2", sessionId, name: "valve-large-probe", cwd: dir }, message);
    assert.deepEqual(steered, { delivered: true });

    const sends = (await readFile(sendKeysPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const literal = sends.filter((send) => send[0] === "-l").map((send) => send[1] ?? "");
    assert.ok(literal.length > 1, "the message took more than one literal send");
    for (const slice of literal) {
      assert.ok(Buffer.byteLength(slice, "utf8") <= VALVE_SLICE_BYTES);
    }
    assert.equal(literal.join(""), message);
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
        assert.match(error.message, new RegExp(`'unregistered-probe' in ${dir.replaceAll(".", "\\\\.")} did not register within 50ms`));
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A fake `/proc/<pid>/stat` whose comm carries a space, so the parser's last-close-paren split is what the fixture exercises. */
async function writeProcStat(procDir: string, pid: number, startTicks: string): Promise<void> {
  const statDir = path.join(procDir, String(pid));
  await mkdir(statDir, { recursive: true });
  const before = ["S", "1", "1", "1", "0", "-1", "4194560", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1"];
  await writeFile(path.join(statDir, "stat"), `${pid} (fa ke) ${before.join(" ")} ${startTicks} 0 0\n`);
}

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = saved;
  }
}
