import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { spawn } from "node:child_process";

import { CLAUDE_CACHE_TTL_VARIABLE, ClaudeCliControlPlane, WORKER_MARKER_VARIABLE } from "../../src/claude-control-plane.js";
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

        assert.equal(steered, false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = saved;
  }
}
