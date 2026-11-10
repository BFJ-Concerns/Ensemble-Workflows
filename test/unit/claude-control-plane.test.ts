import { waitForCondition } from "../wait-for-condition.js";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { execFileSync, spawn } from "node:child_process";

import {
  CLAUDE_CACHE_TTL_VARIABLE,
  ClaudeCliControlPlane,
  SANDBOXED_WORKSPACE_VARIABLE,
  WORKER_MARKER_VARIABLE
} from "../../src/claude-control-plane.js";
import { ClaudeDispatchError, ClaudeRegistrationTimeoutError } from "../../src/errors.js";
import { SystemdWorkerScopes, containingSlice, type ScopePlacement, type WorkerScopes } from "../../src/worker-scopes.js";
import type { RuntimeEvent } from "../../src/types.js";
import { writeProcStat } from "../fixtures/proc-stat.js";
import { hermeticEstateEnvironment } from "../integration/estate-process.js";

test("transcript discovery follows the configured Claude directory and explicit overrides", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-transcript-config-"));
  const inherited = process.env.CLAUDE_CONFIG_DIR;
  try {
    const config = path.join(dir, "inherited");
    const declared = path.join(dir, "declared");
    const explicit = path.join(dir, "explicit-projects");
    const handle = { id: "private", sessionId: "private-session", name: "private", cwd: dir };
    const locations = [path.join(config, "projects"), path.join(declared, "projects"), explicit];
    for (const location of locations) {
      await mkdir(path.join(location, "project"), { recursive: true });
      // Discovery tests only file location; native content belongs to live proof.
      await writeFile(path.join(location, "project", `${handle.sessionId}.jsonl`), "");
    }
    process.env.CLAUDE_CONFIG_DIR = config;
    for (const [controlPlane, location] of [
      [new ClaudeCliControlPlane(), locations[0]],
      [new ClaudeCliControlPlane({ workerEnv: { CLAUDE_CONFIG_DIR: declared } }), locations[1]],
      [new ClaudeCliControlPlane({ projectsDir: explicit, workerEnv: { CLAUDE_CONFIG_DIR: declared } }), explicit]
    ] as const) {
      assert.equal(await controlPlane.transcriptPath(handle), path.join(location!, "project", `${handle.sessionId}.jsonl`));
    }
  } finally {
    if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = inherited;
    await rm(dir, { recursive: true, force: true });
  }
});

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
        import { readFile, writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          const chunks = [];
          for await (const chunk of process.stdin) chunks.push(chunk);
          await writeFile(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
          await writeFile(${JSON.stringify(argvPath)}, JSON.stringify(args));
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          // Registration acknowledges consumed input, not merely a process
          // whose asynchronous prompt capture has not completed yet.
          try { JSON.parse(await readFile(${JSON.stringify(argvPath)}, "utf8")); }
          catch { process.stdout.write("[]"); process.exit(0); }
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
        import { readFile, writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          await writeFile(${JSON.stringify(envPath)}, JSON.stringify({
            base: process.env.ANTHROPIC_BASE_URL ?? null,
            inherited: process.env.ENSEMBLE_TEST_INHERITED ?? null
          }));
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          // Registration acknowledges the completed child observation.
          try { JSON.parse(await readFile(${JSON.stringify(envPath)}, "utf8")); }
          catch { process.stdout.write("[]"); process.exit(0); }
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
        import { copyFile, readFile, writeFile } from "node:fs/promises";
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
          // The final capture acknowledges that every observed artefact is complete.
          try { JSON.parse(await readFile(${JSON.stringify(settingsCopyPath)}, "utf8")); }
          catch { process.stdout.write("[]"); process.exit(0); }
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
    // Force roster reads before capture and with an incomplete artefact.
    assert.deepEqual(JSON.parse(execFileSync(stubPath, ["agents", "--json"], { encoding: "utf8" })), []);
    await writeFile(settingsCopyPath, '{"env":');
    assert.deepEqual(JSON.parse(execFileSync(stubPath, ["agents", "--json"], { encoding: "utf8" })), []);

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
        import { copyFile, readFile } from "node:fs/promises";
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
          // The final capture acknowledges that every observed artefact is complete.
          try { JSON.parse(await readFile(${JSON.stringify(dir)} + "/settings-" + name + ".json", "utf8")); }
          catch { process.stdout.write("[]"); process.exit(0); }
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
      // Force roster reads before capture and with an incomplete artefact.
      assert.deepEqual(JSON.parse(execFileSync(stubPath, ["agents", "--json"], { encoding: "utf8" })), []);
      await writeFile(path.join(dir, `settings-${name}.json`), '{"env":');
      assert.deepEqual(JSON.parse(execFileSync(stubPath, ["agents", "--json"], { encoding: "utf8" })), []);
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
        ENSEMBLE_HOLD_SCOPE: "flag-scope-7",
        [WORKER_MARKER_VARIABLE]: "explicit-scope"
      });
      // No explicit input: the control plane resolves as a bare invocation would.
      assert.deepEqual(await settingsFor("inherited-scope", undefined), {
        ENSEMBLE_HOLD_SCOPE: "lead-session-42",
        [WORKER_MARKER_VARIABLE]: "inherited-scope"
      });
      // The shared scope, resolved by the caller: nothing is delivered, even
      // though this process's own variable names a scope.
      assert.deepEqual(await settingsFor("shared-scope", null), {
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
        import { copyFile, readFile, writeFile } from "node:fs/promises";
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
          // The final capture acknowledges that every observed artefact is complete.
          try { JSON.parse(await readFile(${JSON.stringify(settingsCopyPath)}, "utf8")); }
          catch { process.stdout.write("[]"); process.exit(0); }
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
    // Force roster reads before capture and with an incomplete artefact.
    assert.deepEqual(JSON.parse(execFileSync(stubPath, ["agents", "--json"], { encoding: "utf8" })), []);
    await writeFile(settingsCopyPath, '{"env":');
    assert.deepEqual(JSON.parse(execFileSync(stubPath, ["agents", "--json"], { encoding: "utf8" })), []);

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
        import { copyFile, readFile, writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          const flag = args.indexOf("--settings");
          if (flag !== -1) {
            await copyFile(args[flag + 1], ${JSON.stringify(settingsCopyPath)});
          }
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          // The final capture acknowledges that every observed artefact is complete.
          try { JSON.parse(await readFile(${JSON.stringify(settingsCopyPath)}, "utf8")); }
          catch { process.stdout.write("[]"); process.exit(0); }
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
    // Force roster reads before capture and with an incomplete artefact.
    assert.deepEqual(JSON.parse(execFileSync(stubPath, ["agents", "--json"], { encoding: "utf8" })), []);
    await writeFile(settingsCopyPath, '{"env":');
    assert.deepEqual(JSON.parse(execFileSync(stubPath, ["agents", "--json"], { encoding: "utf8" })), []);

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
          // The final capture acknowledges that every observed artefact is complete.
          try { JSON.parse(await readFile(${JSON.stringify(dir)} + "/observed-" + probe + ".json", "utf8")); }
          catch { process.stdout.write("[]"); process.exit(0); }
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
      // Force roster reads before capture and with an incomplete artefact.
      assert.deepEqual(JSON.parse(execFileSync(stubPath, ["agents", "--json"], { encoding: "utf8" })), []);
      await writeFile(path.join(dir, `observed-${name}.json`), '{"env":');
      assert.deepEqual(JSON.parse(execFileSync(stubPath, ["agents", "--json"], { encoding: "utf8" })), []);
      // Keep direct fixture probes out of the control-plane child observations.
      await rm(path.join(dir, `children-${name}.jsonl`));
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

/** Real helper execution behind a scripted terminal and native transcript. */
async function installValveStubs(dir: string, mode = "exact") {
  const claude = path.join(dir, "claude stub.mjs");
  const tmux = path.join(dir, "tmux-stub.mjs");
  const project = path.join(dir, "project");
  await mkdir(project);
  const transcript = path.join(project, "valve-session.jsonl");
  // A matching old row must never acknowledge a new delivery.
  await writeFile(transcript, JSON.stringify({ type: "user", message: { content: "old" } }) + "\n");
  const handle = { id: "valve-1", sessionId: "valve-session", name: "valve-probe", cwd: dir };
  await writeFile(claude, `#!/usr/bin/env node
    if (process.argv[2] === "agents") process.stdout.write(JSON.stringify([
      ${JSON.stringify({ ...handle, status: "busy", state: "working", kind: "background" })}
    ]));
  `, { mode: 0o755 });
  await writeFile(tmux, `#!/usr/bin/env node
    import { appendFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    import path from "node:path";
    ${TMUX_STUB_COMMAND}
    const root = path.dirname(process.argv[3]);
    const state = path.join(root, "test-state.json");
    const target = path.join(root, "edited.txt");
    const mode = ${JSON.stringify(mode)};
    appendFileSync(${JSON.stringify(path.join(dir, "calls.jsonl"))}, JSON.stringify({
      argv: process.argv.slice(2), env: {
        base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN,
        sandboxed: process.env.CLAUDE_CODE_SANDBOXED
      }
    }) + "\\n");
    const step = command[0] === "new-session" ? "attach" : command.at(-1);
    if (mode === step) { console.error("delivery refused"); process.exit(1); }
    if (command[0] === "new-session") {
      writeFileSync(state, JSON.stringify({ editor: process.env.VISUAL }));
    }
    if (step === "C-g" && mode !== "editor-missing") {
      const { editor } = JSON.parse(readFileSync(state, "utf8"));
      const [file, ...args] = editor.split(" ");
      execFileSync(file, [...args, target]);
      appendFileSync(${JSON.stringify(path.join(dir, "copied.jsonl"))}, JSON.stringify({
        text: readFileSync(target, "utf8"), mode: statSync(path.join(root, "prompt.txt")).mode & 0o777,
        editorMode: statSync(path.join(root, "editor.cjs")).mode & 0o777, root
      }) + "\\n");
    }
    if (step === "Enter") {
      const text = readFileSync(target, "utf8");
      if ((mode === "notification" || mode === "notification-missing")) appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({
        type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification>background task complete</task-notification>" }
      }) + "\\n");
      const row = (mode === "missing" || mode === "notification-missing") ? { type: "assistant", message: { content: "unrelated" } } :
        { type: "user", message: { content: mode === "mismatch" ? text + "changed" : text } };
      appendFileSync(${JSON.stringify(transcript)}, JSON.stringify(row) + "\\n");
    }
  `, { mode: 0o755 });
  return { claude, tmux, handle, transcript };
}

for (const mode of ["attach", "C-g", "Enter", "editor-missing", "missing", "notification-missing", "mismatch"] as const) {
  test(`reply valve reports ${mode} failure and removes its private files`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ensemble-valve-failure-"));
    try {
      const stub = await installValveStubs(dir, mode);
      const control = new ClaudeCliControlPlane({
        claudeBin: stub.claude, tmuxBin: stub.tmux, projectsDir: dir,
        valveAttachSettleMs: 0, valveDeliveryTimeoutMs: 50
      });
      const result = await control.steer(stub.handle, "old");
      assert.equal(result.delivered, false);
      if (!result.delivered) {
        assert.match(result.reason, mode === "editor-missing" ? /editor did not finish/ :
          (mode === "missing" || mode === "notification-missing") ? /delivery missing/ : mode === "mismatch" ? /delivery mismatch.*sha256/ : /delivery refused/);
      }
      const calls = (await readFile(path.join(dir, "calls.jsonl"), "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as { argv: string[] });
      assert.equal(calls.at(-1)?.argv.at(-1), "kill-server");
      await assert.rejects(access(path.dirname(calls[0]!.argv[1]!)));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("a missing transcript baseline refuses delivery before opening an attachment", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-valve-no-baseline-"));
  try {
    const stub = await installValveStubs(dir);
    await rm(stub.transcript);
    const control = new ClaudeCliControlPlane({
      claudeBin: stub.claude, tmuxBin: stub.tmux, projectsDir: dir, valveAttachSettleMs: 0
    });
    const result = await control.steer(stub.handle, "new input");
    assert.equal(result.delivered, false);
    if (!result.delivered) assert.match(result.reason, /not attempted.*no transcript baseline/);
    const calls = (await readFile(path.join(dir, "calls.jsonl"), "utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as { argv: string[] });
    assert.deepEqual(calls.map(call => call.argv.at(-1)), ["kill-server"]);
    await assert.rejects(access(path.dirname(calls[0]!.argv[1]!)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a background notification between attach and receipt does not acknowledge or corrupt delivery", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-valve-notification-"));
  try {
    const stub = await installValveStubs(dir, "notification");
    const control = new ClaudeCliControlPlane({
      claudeBin: stub.claude, tmuxBin: stub.tmux, projectsDir: dir, valveAttachSettleMs: 0
    });
    assert.deepEqual(await control.steer(stub.handle, "new input"), { delivered: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("literal command-record XML is accepted as exact ordinary text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-valve-literal-"));
  try {
    const stub = await installValveStubs(dir);
    const control = new ClaudeCliControlPlane({
      claudeBin: stub.claude, tmuxBin: stub.tmux, projectsDir: dir, valveAttachSettleMs: 0
    });
    const message = "<command-message>check</command-message>\n<command-name>/check</command-name>\n<command-args>literal fixture</command-args>";
    assert.deepEqual(await control.steer(stub.handle, message), { delivered: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("concurrent multi-megabyte follow-ups use private editors, exact receipts and no payload argv", async () => {
  const dirs = await Promise.all([0, 1].map(() => mkdtemp(path.join(tmpdir(), "ensemble-valve-large-"))));
  const declared = { ANTHROPIC_BASE_URL: "https://declared.example", ANTHROPIC_AUTH_TOKEN: "declared-token", TMUX_TMPDIR: "/declared-root" };
  try {
    const roots = await Promise.all(dirs.map(async (dir, index) => {
      const stub = await installValveStubs(dir);
      const control = new ClaudeCliControlPlane({
        claudeBin: stub.claude, tmuxBin: stub.tmux, projectsDir: dir, workerEnv: declared,
        valveAttachSettleMs: 0
      });
      const message = `${index}:` + "café £ Ω 中文 😀;\n- data\n/slash inside\n".repeat(60_000) + "end";
      assert.ok(Buffer.byteLength(message) > 2_000_000);
      assert.deepEqual(await control.steer(stub.handle, message), { delivered: true });
      const copied = JSON.parse((await readFile(path.join(dir, "copied.jsonl"), "utf8")).trim()) as { text: string; mode: number; editorMode: number; root: string };
      assert.equal(copied.text, message);
      assert.equal(copied.mode, 0o600);
      assert.equal(copied.editorMode, 0o700);
      const calls = (await readFile(path.join(dir, "calls.jsonl"), "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as { argv: string[]; env: { base: string; token: string; sandboxed: string } });
      for (const call of calls) {
        assert.ok(call.argv.every(arg => Buffer.byteLength(arg) < 8192));
        for (const value of Object.values(declared)) assert.ok(call.argv.every(arg => !arg.includes(value)));
        assert.equal(call.argv[1], path.join(copied.root, "tmux.sock"));
      }
      assert.deepEqual(calls[0]?.env, { base: declared.ANTHROPIC_BASE_URL, token: declared.ANTHROPIC_AUTH_TOKEN, sandboxed: "1" });
      assert.deepEqual(calls.slice(1).map(call => call.argv.at(-1)), ["C-g", "Enter", "kill-server"]);
      await assert.rejects(access(copied.root));
      return copied.root;
    }));
    assert.notEqual(roots[0], roots[1]);
  } finally { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); }
});

test("a real private tmux server gives its attach client the editor and declared environment", async (t) => {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); }
  catch { t.skip("tmux is not installed"); return; }
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-valve-real-"));
  const savedShell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  try {
    const stub = await installValveStubs(dir);
    await writeFile(stub.claude, `#!/usr/bin/env node
      import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
      import { execFileSync } from "node:child_process";
      if (process.argv[2] === "agents") {
        console.log(JSON.stringify([${JSON.stringify({ ...stub.handle, status: "idle", state: "working", kind: "background" })}]));
      } else if (process.argv[2] === "attach") {
        writeFileSync(${JSON.stringify(path.join(dir, "attach-env"))}, JSON.stringify({ token: process.env.ANTHROPIC_AUTH_TOKEN, sandboxed: process.env.CLAUDE_CODE_SANDBOXED }));
        process.stdin.setRawMode(true);
        process.stdin.on("data", chunk => {
          if (chunk.includes(7)) {
            const [file, ...args] = process.env.VISUAL.split(" ");
            execFileSync(file, [...args, ${JSON.stringify(path.join(dir, "edited.txt"))}]);
          }
          if (chunk.includes(13)) appendFileSync(${JSON.stringify(stub.transcript)}, JSON.stringify({ type: "user", message: { content: readFileSync(${JSON.stringify(path.join(dir, "edited.txt"))}, "utf8") } }) + "\\n");
        });
      }
    `);
    const control = new ClaudeCliControlPlane({
      claudeBin: stub.claude, projectsDir: dir,
      workerEnv: { ANTHROPIC_AUTH_TOKEN: "declared-token" }, valveAttachSettleMs: 1_500
    });
    assert.deepEqual(await control.steer(stub.handle, "é😀\nwhole turn"), { delivered: true });
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "attach-env"), "utf8")), { token: "declared-token", sandboxed: "1" });
    await waitForCondition(async () => (await processesNaming(stub.claude)).length === 0, "private attach client survived cleanup");
  } finally {
    restoreEnv("SHELL", savedShell);
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
        assert.match(error.message, new RegExp(`dispatch command failed for worker 'refused-probe' in ${dir.replaceAll(".", "\\.")}`));
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

function fileExists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false
  );
}

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = saved;
  }
}

test("every claude process the control plane starts is launched through the scope manager", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-control-plane-"));
  try {
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-00000000000a";
    const name = "scoped-launch-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          for await (const chunk of process.stdin) void chunk;
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "scoped-1",
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

    // A manager that records what it is asked to launch and then launches it
    // itself: the control plane must never reach spawn directly, since the
    // manager is what keeps a supervisor these commands may start outside
    // the launcher's box.
    const launched: { file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const scopes: WorkerScopes = {
      slice: null,
      async place() {
        return { kind: "unavailable" as const };
      },
      async launch(file, args, options) {
        launched.push({ file, args: [...args], env: options.env });
        return spawn(file, [...args], options);
      },
      async close() {}
    };
    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: stubPath,
      projectsDir: dir,
      dispatchTimeoutMs: 1_000,
      scopes
    });
    const handle = await controlPlane.dispatch({ prompt: "hello", name, cwd: dir });
    await controlPlane.stop(handle);

    const commands = launched.filter((entry) => entry.file === stubPath).map((entry) => entry.args.slice(0, 2).join(" "));
    assert.ok(commands.includes("--bg --name"), `dispatch was not launched through the scope manager: ${JSON.stringify(commands)}`);
    assert.ok(commands.includes("agents --json"), `roster query was not launched through the scope manager: ${JSON.stringify(commands)}`);
    assert.ok(commands.includes("stop scoped-1"), `stop was not launched through the scope manager: ${JSON.stringify(commands)}`);
    assert.ok(commands.includes("rm scoped-1"), `rm was not launched through the scope manager: ${JSON.stringify(commands)}`);
    // The narrowed environment the control plane composes is what the manager launches with.
    for (const entry of launched) {
      assert.equal(entry.env?.[SANDBOXED_WORKSPACE_VARIABLE], "1");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a session is placed while `claude --bg` still runs, once the roster names its pid, and placed again when the pid changes", async () => {
  await sessionPlacement("worker");
});

test("run grouping places the first and replacement Claude PIDs in the shared run group", async () => {
  await sessionPlacement("run");
});

async function sessionPlacement(workerScope: "worker" | "run"): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-control-plane-"));
  const first = spawn("sleep", ["300"], { stdio: "ignore" });
  const replacement = spawn("sleep", ["300"], { stdio: "ignore" });
  let background: ReturnType<typeof spawn> | undefined;
  try {
    const stubPath = path.join(dir, "claude-stub.mjs");
    const releasePath = path.join(dir, "release-bg");
    const bgExitedPath = path.join(dir, "bg-exited");
    const queriesPath = path.join(dir, "roster-queries");
    const replacementPath = path.join(dir, "replacement-pid");
    const settingsPathFile = path.join(dir, "settings-path");
    const lateSettingsPath = path.join(dir, "late-settings.json");
    const sessionId = "00000000-0000-4000-8000-00000000000b";
    const name = "placement-probe";
    const group = workerScope === "run" ? "run" : name;
    // `claude --bg` holds until the test releases it, as the real command
    // outlives the session's registration by seconds. The roster counts its
    // queries and answers the first two without a pid — the row registers
    // before the supervisor reports its process — then names the first
    // process, until a replacement pid is named. Count-based, not timed: the
    // control plane necessarily sees the row without a pid before it can see
    // one with it, however quickly or slowly it polls. Every bound below is
    // a ceiling on a hang, never a deadline the product must meet: the
    // fixture runs real subprocesses and files for each roster read, and a
    // busy machine is given minutes before anything is judged. The hold's
    // own ceiling fails the command rather than returning as if released.
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { access, readFile, writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        const exists = (file) => access(file).then(() => true, () => false);
        if (args[0] === "--bg") {
          for await (const chunk of process.stdin) void chunk;
          const settingsPath = args[args.indexOf("--settings") + 1];
          await writeFile(${JSON.stringify(settingsPathFile)}, settingsPath);
          const deadline = Date.now() + 120_000;
          while (!(await exists(${JSON.stringify(releasePath)}))) {
            if (Date.now() >= deadline) {
              await writeFile(${JSON.stringify(bgExitedPath)}, "not released within 120 s");
              process.stderr.write("held claude --bg: not released within 120 s\\n");
              process.exit(1);
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          // Read only after dispatch has returned and the test releases us.
          const settings = await readFile(settingsPath, "utf8").then(
            (text) => ({ settings: JSON.parse(text) }),
            (error) => ({ error: error.code })
          );
          await writeFile(${JSON.stringify(lateSettingsPath)}, JSON.stringify(settings));
          await writeFile(${JSON.stringify(bgExitedPath)}, "");
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          const queries = Number(await readFile(${JSON.stringify(queriesPath)}, "utf8").catch(() => "0")) + 1;
          await writeFile(${JSON.stringify(queriesPath)}, String(queries));
          const replacement = await readFile(${JSON.stringify(replacementPath)}, "utf8").then((text) => Number(text.trim())).catch(() => null);
          const pid = replacement ?? (queries > 2 ? ${first.pid} : null);
          process.stdout.write(JSON.stringify([{
            id: "placed-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: ${JSON.stringify(name)},
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working",
            ...(pid === null ? {} : { pid })
          }]));
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    const placed: { group: string; pids: number[]; bgStillRunning: boolean; rosterQueries: number }[] = [];
    const scopes: WorkerScopes = {
      slice: "agents.slice",
      async place(group, pids): Promise<ScopePlacement> {
        placed.push({
          group,
          pids: [...pids],
          bgStillRunning: !(await fileExists(bgExitedPath)),
          rosterQueries: Number(await readFile(queriesPath, "utf8"))
        });
        return { kind: "placed", unit: `ensemble-test-${group}.scope`, pids };
      },
      async launch(file, args, options) {
        const child = spawn(file, [...args], options);
        if (args[0] === "--bg") background = child;
        return child;
      },
      async close() {}
    };
    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: stubPath,
      projectsDir: dir,
      dispatchTimeoutMs: 60_000,
      placementSettleMs: 60_000,
      // This witness controls turn polling; the idle-watch witness is separate.
      placementWatchIntervalMs: 600_000,
      workerScope,
      scopes
    });
    const dispatching = controlPlane.dispatch({ prompt: "hello", name, cwd: dir });
    // Placed before `claude --bg` is released: the roster was read while the
    // command still ran, and read again until it named the pid.
    await waitForCondition(() => placed.length > 0, "the session to be placed while `claude --bg` was still running", 90_000, 25);
    assert.equal(placed[0]!.bgStillRunning, true, "the session was placed only after `claude --bg` returned");
    assert.ok(placed[0]!.rosterQueries >= 3, `the roster was read ${placed[0]!.rosterQueries} time(s) before placement; the two pid-less answers were never seen`);
    const handle = await dispatching;
    assert.equal(await fileExists(bgExitedPath), false, "dispatch waited for the held background command");
    await waitForCondition(() => fileExists(settingsPathFile), "the background command to publish its settings path", 60_000, 25);
    const settingsPath = await readFile(settingsPathFile, "utf8");
    assert.equal(await fileExists(settingsPath), true, "registration removed the live session's settings");
    await writeFile(releasePath, "");
    await waitForCondition(() => fileExists(bgExitedPath), "`claude --bg` to return once released", 60_000, 25);
    assert.equal(await readFile(bgExitedPath, "utf8"), "", "`claude --bg` returned on its own ceiling, not on release");
    const lateSettings = JSON.parse(await readFile(lateSettingsPath, "utf8")) as { error?: string; settings?: { env: Record<string, string> } };
    assert.equal(lateSettings.error, undefined, "the background command lost settings after early registration");
    assert.equal(lateSettings.settings?.env[WORKER_MARKER_VARIABLE], name);
    assert.equal(await fileExists(settingsPath), true, "background-command completion removed the live session's settings");

    assert.deepEqual(
      placed.map(({ group, pids }) => ({ group, pids })),
      [{ group, pids: [first.pid] }],
      "the session was not placed once its pid was named"
    );
    assert.deepEqual(controlPlane.placementOf(handle), { kind: "placed", unit: `ensemble-test-${group}.scope`, pids: [first.pid] });

    // The same pid again places nothing more; a new pid is placed again.
    await controlPlane.poll(handle);
    assert.equal(placed.length, 1);
    await writeFile(replacementPath, `${replacement.pid}\n`);
    const status = await controlPlane.poll(handle);
    assert.equal(status.present, true);
    assert.deepEqual(placed.at(-1)?.pids, [replacement.pid], "the replacement pid was not placed");
    assert.equal(placed.length, 2);
    assert.equal(placed.at(-1)?.group, group);
    await controlPlane.stop(handle);
    assert.equal(await fileExists(settingsPath), false, "stopping the session retained its settings");
  } finally {
    background?.kill("SIGKILL");
    first.kill("SIGKILL");
    replacement.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}


test("refused Claude placement retries during registration and at the same polled pid, reporting refusal and recovery", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-refused-placement-"));
  const first = spawn("sleep", ["infinity"], { stdio: "ignore" });
  const replacement = spawn("sleep", ["infinity"], { stdio: "ignore" });
  const slice = containingSlice(await readFile("/proc/self/cgroup", "utf8"));
  const manager = new SystemdWorkerScopes({ slice, label: `retry-${process.pid}` });
  let releaseMove!: () => void;
  const released = new Promise<void>((resolve) => { releaseMove = resolve; });
  let thirdAttempt!: () => void;
  const retried = new Promise<void>((resolve) => { thirdAttempt = resolve; });
  let calls = 0;
  let dispatching: ReturnType<ClaudeCliControlPlane["dispatch"]> | undefined;
  let plane: ClaudeCliControlPlane | undefined;
  try {
    const stub = path.join(dir, "claude.mjs");
    const replacementPath = path.join(dir, "replacement");
    const name = "retry-probe";
    await writeFile(stub, `#!/usr/bin/env node
      import { readFile } from "node:fs/promises";
      if (process.argv[2] === "--bg") {
        for await (const chunk of process.stdin) void chunk;
      } else if (process.argv[2] === "agents") {
        const pid = await readFile(${JSON.stringify(replacementPath)}, "utf8").then(Number).catch(() => ${first.pid});
        process.stdout.write(JSON.stringify([{ id: "retry-1", sessionId: "retry-session", name: ${JSON.stringify(name)}, kind: "background", cwd: ${JSON.stringify(dir)}, pid, status: "busy", state: "working" }]));
      }
    `);
    await chmod(stub, 0o755);
    const scopes: WorkerScopes = {
      slice,
      launch: async (file, args, options) => spawn(file, [...args], options),
      close: manager.close.bind(manager),
      async place(group, pids) {
        calls += 1;
        // Supply only the transient refusal. Recovery is an actual move by
        // systemd, checked against the live processes' kernel cgroup files.
        if (calls <= 2 || calls === 4) return { kind: "refused", reason: "controlled manager refusal" };
        if (calls === 3) { thirdAttempt(); await released; }
        return manager.place(group, pids);
      }
    };
    const events: RuntimeEvent[] = [];
    plane = new ClaudeCliControlPlane({ claudeBin: stub, projectsDir: dir, scopes, placementSettleMs: 60_000, placementWatchIntervalMs: 600_000, onEvent: (event) => events.push(event) });
    dispatching = plane.dispatch({ prompt: "hello", name, cwd: dir });
    assert.equal(await Promise.race([dispatching.then(() => "dispatch settled"), retried.then(() => "placement retried")]), "placement retried",
      "dispatch treated the first refused placement as final");
    assert.equal(events.length, 1, "identical refusals repeated the notice");
    assert.equal(events[0]?.method, "claude/workerScopePlacement");
    assert.equal(events[0]?.params.reason, "controlled manager refusal");
    const unit = manager.unitFor(name);
    assert.ok(!(await readFile(`/proc/${first.pid}/cgroup`, "utf8")).trim().endsWith(`/${unit}`));
    releaseMove();
    const handle = await dispatching;
    assert.ok((await readFile(`/proc/${first.pid}/cgroup`, "utf8")).trim().endsWith(`/${unit}`), "registration retry left the process outside its worker scope");
    await plane.poll(handle);
    assert.equal(calls, 3, "a successfully placed pid was moved again");

    await writeFile(replacementPath, String(replacement.pid));
    await plane.poll(handle);
    assert.equal(plane.placementOf(handle)?.kind, "refused");
    assert.ok(!(await readFile(`/proc/${replacement.pid}/cgroup`, "utf8")).trim().endsWith(`/${unit}`));
    await plane.poll(handle);
    assert.ok((await readFile(`/proc/${replacement.pid}/cgroup`, "utf8")).trim().endsWith(`/${unit}`), "same-pid poll did not recover refused placement");
    assert.deepEqual(events.map((event) => event.params.kind), ["refused", "placed", "refused", "placed"]);
    assert.equal(events.at(-1)?.params.unit, unit);
    assert.equal(events.at(-1)?.params.pid, replacement.pid);
    assert.equal(events.at(-1)?.params.sessionId, handle.sessionId);
    await plane.poll(handle);
    assert.equal(calls, 5);
  } finally {
    releaseMove();
    const handle = await dispatching?.catch(() => undefined);
    if (handle) await plane?.stop(handle);
    first.kill("SIGKILL");
    replacement.kill("SIGKILL");
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test("owned idle sessions re-place replacement PIDs without turn polling", async () => {
  for (const workerScope of ["worker", "run"] as const) {
    const dir = await mkdtemp(path.join(tmpdir(), "ensemble-idle-placement-"));
    const first = spawn("sleep", ["infinity"], { stdio: "ignore" });
    const replacement = spawn("sleep", ["infinity"], { stdio: "ignore" });
    const slice = containingSlice(await readFile("/proc/self/cgroup", "utf8"));
    const manager = new SystemdWorkerScopes({ slice, label: `idle-${process.pid}-${path.basename(dir)}` });
    let plane: ClaudeCliControlPlane | undefined;
    let handle: Awaited<ReturnType<ClaudeCliControlPlane["dispatch"]>> | undefined;
    try {
      const stub = path.join(dir, "claude.mjs");
      const pidFile = path.join(dir, "pid");
      await writeFile(pidFile, String(first.pid));
      await writeFile(stub, `#!/usr/bin/env node
        import { readFile } from "node:fs/promises";
        if (process.argv[2] === "--bg") { for await (const chunk of process.stdin) void chunk; }
        if (process.argv[2] === "agents") {
          const pid = Number(await readFile(${JSON.stringify(pidFile)}, "utf8"));
          process.stdout.write(JSON.stringify([{id:"idle-session", sessionId:"idle-session", name:"idle-worker", kind:"background", cwd:${JSON.stringify(dir)}, pid, status:"idle", state:"done"}]));
        }
      `);
      await chmod(stub, 0o755);
      plane = new ClaudeCliControlPlane({ claudeBin: stub, projectsDir: dir, scopes: manager, workerScope });
      handle = await plane.dispatch({ prompt: "hello", name: "idle-worker", cwd: dir });
      const unit = manager.unitFor(workerScope === "run" ? "run" : "idle-worker");
      assert.ok((await readFile(`/proc/${first.pid}/cgroup`, "utf8")).trim().endsWith(`/${unit}`));
      assert.ok(!(await readFile(`/proc/${replacement.pid}/cgroup`, "utf8")).trim().endsWith(`/${unit}`));
      await writeFile(pidFile, String(replacement.pid));
      // No poll(), steer() or turn runs here. Only the owned background watch
      // can discover the new roster PID and move this actual process.
      await waitForCondition(async () => {
        const group = await readFile(`/proc/${replacement.pid}/cgroup`, "utf8");
        const placement = plane!.placementOf(handle!);
        return group.trim().endsWith(`/${unit}`) && placement?.kind === "placed" && placement.pids.includes(replacement.pid!);
      }, "the idle-session watch to place the replacement process", 60_000, 25);
      assert.ok((await readFile(`/proc/${replacement.pid}/cgroup`, "utf8")).trim().endsWith(`/${unit}`), "idle replacement stayed outside its worker scope");
    } finally {
      if (plane && handle) await plane.stop(handle);
      await manager.close();
      first.kill("SIGKILL"); replacement.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("unavailable scope placement returns a PID-less completed registration without further roster reads", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-no-scope-registration-"));
  try {
    const queries = path.join(dir, "queries");
    const stub = path.join(dir, "claude.mjs");
    await writeFile(stub, `#!/usr/bin/env node
      import { readFile, writeFile } from "node:fs/promises";
      if (process.argv[2] === "--bg") { for await (const chunk of process.stdin) void chunk; }
      if (process.argv[2] === "agents") {
        const count = Number(await readFile(${JSON.stringify(queries)}, "utf8").catch(() => "0")) + 1;
        await writeFile(${JSON.stringify(queries)}, String(count));
        process.stdout.write(JSON.stringify([{kind:"background", name:"no-scope", id:"no-scope", sessionId:"no-scope-session", status:"done", state:"idle", ...(count > 1 ? {pid:process.pid} : {})}]));
      }
    `);
    await chmod(stub, 0o755);
    const plane = new ClaudeCliControlPlane({ claudeBin: stub, projectsDir: dir });
    const handle = await plane.dispatch({ prompt: "hello", name: "no-scope", cwd: dir });
    assert.equal(await readFile(queries, "utf8"), "1", "a no-op placement manager still waited for a PID");
    await plane.stop(handle);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
