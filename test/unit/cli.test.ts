import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runEnsembleCli } from "../../src/cli.js";
import { EngineRegistry } from "../../src/engines.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { Scheduler } from "../../src/scheduler.js";
import { TokenBudget } from "../../src/budget.js";
import { STATUS_FILENAME } from "../../src/status-file.js";

import type { EngineAdapter, EngineInvocation } from "../../src/engines.js";
import type { Budget, EngineName, RuntimeOptions, TurnResult } from "../../src/types.js";

class CaptureStream extends Writable {
  chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

test("CLI prints result JSON to stdout and logs to stderr", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli" };
      log("hello stderr");
      return { args };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script, "a", "b"], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.text(), "{\"args\":[\"a\",\"b\"]}\n");
  assert.equal(stderr.text(), "hello stderr\n");
});

test("CLI passes parsed JSON as args when --json-args is set", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-json-args-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-json-args" };
      return { args, isArray: Array.isArray(args) };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([`--json-args={"items":["a","b"],"count":2}`, script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.text(), "{\"args\":{\"items\":[\"a\",\"b\"],\"count\":2},\"isArray\":false}\n");
  assert.equal(stderr.text(), "");
});

test("CLI reads parsed JSON args from an @file path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-json-args-file-"));
  const script = path.join(directory, "workflow.js");
  const payload = path.join(directory, "payload.json");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-json-args-file" };
      return { args, isArray: Array.isArray(args) };
    `
  );
  await writeFile(payload, JSON.stringify({ brief: "Analyse the API's quirks (part 2)", rounds: 3 }));

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(["--json-args", "@payload.json", script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0);
  assert.equal(
    stdout.text(),
    `{"args":{"brief":"Analyse the API's quirks (part 2)","rounds":3},"isArray":false}\n`
  );
  assert.equal(stderr.text(), "");
});

test("CLI reports an unreadable --json-args @file as a usage error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-json-args-file-missing-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(script, `export const meta = { name: "cli-json-args-file-missing" }; return args;`);

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(["--json-args", "@missing.json", script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /--json-args could not read .*missing\.json/);
  assert.match(stderr.text(), /Usage: ensemble/);
  assert.doesNotMatch(stderr.text(), /\n\s+at /);
});

test("CLI reports usage errors without a stack trace", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(["--unknown"], { stdout, stderr });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.equal(
    stderr.text(),
    "Unknown option before script path: --unknown\n" +
      "Usage: ensemble [--json-args '<json>|@file'] [--budget engine=N] [--agent-ceiling N|null] [--concurrency engine=N] [--timeout ms] <script.js> [args...]\n" +
      "       ensemble workflows\n"
  );
});

test("CLI wires per-engine budget ceilings into the workflow runtime", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-budget-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-budget" };
      const first = await agent("spend-codex", { engine: "codex" });
      let codexBlocked = false;
      try {
        await agent("codex-again", { engine: "codex" });
      } catch (error) {
        codexBlocked = /Token budget exhausted/.test(String(error?.message ?? error));
      }
      const claude = await agent("claude-ok", { engine: "claude" });
      return {
        first,
        codexBlocked,
        claude,
        codexRemaining: budget.remaining("codex"),
        claudeUnbounded: budget.remaining("claude") === Infinity
      };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const runtimeOptions: RuntimeOptions[] = [];

  const exitCode = await runEnsembleCli([`--budget=codex=5`, script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async (options) => {
      const runtimeOption = options ?? {};
      runtimeOptions.push(runtimeOption);
      return budgetRuntime(runtimeOption);
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(runtimeOptions[0]?.budgetCeilings, { codex: 5 });
  assert.equal(
    stdout.text(),
    "{\"first\":\"codex:spend-codex\",\"codexBlocked\":true,\"claude\":\"claude:claude-ok\",\"codexRemaining\":0,\"claudeUnbounded\":true}\n"
  );
  assert.equal(stderr.text(), "");
});

test("CLI wires per-engine concurrency caps into the runtime scheduler", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-concurrency-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-concurrency" };
      await parallel([
        () => agent("c1", { engine: "codex" }),
        () => agent("c2", { engine: "codex" }),
        () => agent("c3", { engine: "codex" }),
        () => agent("h1", { engine: "claude", model: "test-model" }),
        () => agent("h2", { engine: "claude", model: "test-model" }),
        () => agent("h3", { engine: "claude", model: "test-model" })
      ]);
      return "done";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const runtimeOptions: RuntimeOptions[] = [];
  const codexEngines: ScheduledTextEngine[] = [];
  const claudeEngines: ScheduledTextEngine[] = [];

  const exitCode = await runEnsembleCli([`--concurrency=codex=1`, `--concurrency=claude=2`, script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async (options) => {
      const runtimeOption = options ?? {};
      runtimeOptions.push(runtimeOption);
      const codex = new ScheduledTextEngine("codex", runtimeOption.concurrencyCaps?.codex ?? 99);
      const claude = new ScheduledTextEngine("claude", runtimeOption.concurrencyCaps?.claude ?? 99);
      codexEngines.push(codex);
      claudeEngines.push(claude);
      return new EnsembleRuntime({
        engines: new EngineRegistry([codex, claude]),
        defaultTurnTimeoutMs: 1_000,
        defaultMaxAttempts: 1
      });
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(runtimeOptions[0]?.concurrencyCaps, { codex: 1, claude: 2 });
  assert.equal(codexEngines[0]?.maxActive, 1);
  assert.equal(claudeEngines[0]?.maxActive, 2);
  assert.equal(stdout.text(), "\"done\"\n");
  assert.equal(stderr.text(), "");
});

test("CLI wires the whole-workflow agent ceiling into runtime construction", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-ceiling-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(script, `export const meta = { name: "cli-agent-ceiling" }; return "done";`);
  const observed: RuntimeOptions[] = [];

  const exitCode = await runEnsembleCli(["--agent-ceiling=2", script], {
    cwd: directory,
    stdout: new CaptureStream(),
    stderr: new CaptureStream(),
    runRecordDir: null,
    createRuntime: async (options = {}) => {
      observed.push(options);
      return fakeRuntime();
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(observed[0]?.agentCeiling, 2);
});

test("CLI null agent ceiling lifts a machine default for one run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-unbounded-agent-ceiling-"));
  const configHome = path.join(directory, "config");
  const configFile = path.join(configHome, "ensemble", "config.json");
  const script = path.join(directory, "workflow.js");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({ schema_version: 1, agent_ceiling: 2 }));
  await writeFile(script, `export const meta = { name: "cli-unbounded-agent-ceiling" }; return "done";`);
  const observed: RuntimeOptions[] = [];

  try {
    const exitCode = await runEnsembleCli(["--agent-ceiling=null", script], {
      cwd: directory,
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      env: { XDG_CONFIG_HOME: configHome },
      runRecordDir: null,
      createRuntime: async (options = {}) => {
        observed.push(options);
        return fakeRuntime();
      }
    });

    assert.equal(exitCode, 0);
    assert.equal(observed[0]?.agentCeiling, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects a zero agent ceiling as a usage error", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli(["--agent-ceiling=0", "unused.js"], {
    cwd: "/tmp",
    stdout,
    stderr,
    env: { XDG_CONFIG_HOME: "/definitely/absent" }
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /agent-ceiling.*positive integer/i);
});

test("CLI --timeout caps the whole-workflow run and times out a hanging script", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-timeout-"));
  const script = path.join(directory, "workflow.js");
  // The agent never resolves, so only the workflow timeout can end the run.
  await writeFile(
    script,
    `
      export const meta = { name: "cli-timeout" };
      await agent("hang", { engine: "codex" });
      return "never reached";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([`--timeout=50`, script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => hangingRuntime()
  });

  assert.equal(exitCode, 1);
  // No worker completed before the deadline, so the partial envelope is empty —
  // but it is still emitted, marking the stopped run rather than total loss.
  assert.equal(stdout.text(), `{"partial":true,"reason":"timed-out","completed":[]}\n`);
  assert.match(stderr.text(), /Workflow timed out after 50ms/);
});

test("CLI --timeout emits completed worker outputs as a partial result", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-partial-"));
  const script = path.join(directory, "workflow.js");
  // The first worker finishes fast; the second hangs until the deadline. The
  // completed one must survive in the partial envelope rather than being lost.
  await writeFile(
    script,
    `
      export const meta = { name: "cli-partial" };
      await agent("done-fast", { engine: "codex", label: "alpha" });
      await agent("hang", { engine: "codex" });
      return "never reached";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([`--timeout=120`, script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () =>
      new EnsembleRuntime({
        engines: new EngineRegistry([new HangOnPromptEngine("codex", 4), new HangOnPromptEngine("claude", 4)]),
        defaultTurnTimeoutMs: 1_000,
        defaultMaxAttempts: 1
      })
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stdout.text()) as {
    partial: boolean;
    reason: string;
    completed: Array<{ engine: string; label: string | null; output: unknown }>;
  };
  assert.equal(envelope.partial, true);
  assert.equal(envelope.reason, "timed-out");
  assert.equal(envelope.completed.length, 1);
  assert.equal(envelope.completed[0]?.engine, "codex");
  assert.equal(envelope.completed[0]?.label, "alpha");
  assert.equal(envelope.completed[0]?.output, "codex:done-fast");
  assert.match(stderr.text(), /Workflow timed out after 120ms/);
});

test("CLI emits completed worker outputs when interrupted by SIGINT", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-interrupt-"));
  const script = path.join(directory, "workflow.js");
  // The first worker finishes fast; the second hangs until the interrupt. The
  // completed one must survive in the partial envelope rather than being lost.
  await writeFile(
    script,
    `
      export const meta = { name: "cli-interrupt" };
      await agent("done-fast", { engine: "codex", label: "alpha" });
      await agent("hang", { engine: "codex" });
      return "never reached";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const interrupt = setTimeout(() => process.emit("SIGINT"), 50);

  try {
    const exitCode = await runEnsembleCli([script], {
      cwd: directory,
      stdout,
      stderr,
      runRecordDir: null,
      createRuntime: async () =>
        new EnsembleRuntime({
          engines: new EngineRegistry([new HangOnPromptEngine("codex", 4), new HangOnPromptEngine("claude", 4)]),
          defaultTurnTimeoutMs: 1_000,
          defaultMaxAttempts: 1
        })
    });

    assert.equal(exitCode, 1);
  } finally {
    clearTimeout(interrupt);
  }

  const envelope = JSON.parse(stdout.text()) as {
    partial: boolean;
    reason: string;
    completed: Array<{ engine: string; label: string | null; output: unknown }>;
  };
  assert.equal(envelope.partial, true);
  assert.equal(envelope.reason, "interrupted");
  assert.equal(envelope.completed.length, 1);
  assert.equal(envelope.completed[0]?.engine, "codex");
  assert.equal(envelope.completed[0]?.label, "alpha");
  assert.equal(envelope.completed[0]?.output, "codex:done-fast");
  assert.match(stderr.text(), /Workflow interrupted by SIGINT/);
});

test("CLI rejects a non-numeric --timeout with the usage line and exit code 2", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-timeout-bad-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(script, `export const meta = { name: "cli-timeout-bad" }; return "ok";`);

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([`--timeout=soon`, script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /--timeout value must be a positive integer of milliseconds/);
  assert.match(stderr.text(), /Usage: ensemble/);
});

test("CLI returns non-zero and writes errors to stderr when the script throws", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-error" };
      throw new Error("bad workflow");
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), `{"partial":true,"reason":"failed","completed":[]}\n`);
  assert.match(stderr.text(), /Error: bad workflow/);
});

test("CLI with run recording emits completed worker outputs when the script throws mid-run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-failed-salvage-"));
  const script = path.join(directory, "workflow.js");
  const runRecordDir = path.join(directory, "records");
  // One worker finishes before the script blows up; its output must survive in
  // the salvage envelope — a late failure is not total loss.
  await writeFile(
    script,
    `
      export const meta = { name: "cli-failed-salvage" };
      await agent("done-fast", { engine: "codex", label: "alpha" });
      throw new Error("reduce stage exploded");
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir,
    createRuntime: async () => salvageRuntime()
  });

  assert.equal(exitCode, 1);
  const envelope = JSON.parse(stdout.text()) as {
    partial: boolean;
    reason: string;
    completed: Array<{ engine: string; label: string | null; output: unknown }>;
  };
  assert.equal(envelope.partial, true);
  assert.equal(envelope.reason, "failed");
  assert.equal(envelope.completed.length, 1);
  assert.equal(envelope.completed[0]?.engine, "codex");
  assert.equal(envelope.completed[0]?.label, "alpha");
  assert.equal(envelope.completed[0]?.output, "codex:done-fast");
  assert.match(stderr.text(), /reduce stage exploded/);
  await access(path.join(runRecordDir, "runs"));
});

test("CLI treats an option-looking token after the script path as a script arg", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-option-arg-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "option-arg" };
      return { args };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script, "--not-a-tuning-flag"], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.text(), "{\"args\":[\"--not-a-tuning-flag\"]}\n");
});

test("CLI prints null for a return value JSON.stringify cannot serialise", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-circular-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-circular" };
      const value = { name: "loop" };
      value.self = value;
      return value;
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.text(), "null\n");
});

test("CLI entrypoint runs when invoked through a symlinked binary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-bin-"));
  const binPath = path.join(directory, "ensemble");
  const entrypointPath = fileURLToPath(new URL("../../src/cli/ensemble.js", import.meta.url));
  await symlink(entrypointPath, binPath);

  const result = spawnSync(process.execPath, [binPath], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Usage: ensemble [--json-args '<json>|@file'] [--budget engine=N] [--agent-ceiling N|null] [--concurrency engine=N] [--timeout ms] <script.js> [args...]\n" +
      "       ensemble workflows\n"
  );
});

test("CLI workflows lists saved workflows and notes unparseable files without crashing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-workflows-"));
  const userData = await mkdtemp(path.join(tmpdir(), "ensemble-cli-workflows-user-"));
  const projectRegistry = path.join(directory, ".claude", "ensemble", "workflows");
  const userRegistry = path.join(userData, "ensemble", "workflows");
  await mkdir(projectRegistry, { recursive: true });
  await mkdir(userRegistry, { recursive: true });
  await writeFile(
    path.join(projectRegistry, "summarise.js"),
    `
      export const meta = { name: "summarise", description: "Summarise findings" };
      return "ok";
    `
  );
  await writeFile(path.join(projectRegistry, "broken.js"), `return "not a workflow";`);
  await writeFile(
    path.join(userRegistry, "verify.js"),
    `
      export const meta = { name: "verify", description: "Verify a claim" };
      return "ok";
    `
  );
  await writeFile(
    path.join(userRegistry, "summarise.js"),
    `
      export const meta = { name: "summarise", description: "Personal summary" };
      return "ok";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(["workflows"], {
    cwd: directory,
    stdout,
    stderr,
    env: { XDG_DATA_HOME: userData }
  });

  assert.equal(exitCode, 0);
  assert.equal(
    stdout.text(),
    `summarise\tSummarise findings\tproject\t${path.join(projectRegistry, "summarise.js")}\n` +
      `summarise\tPersonal summary\tuser (shadowed by project)\t${path.join(userRegistry, "summarise.js")}\n` +
      `verify\tVerify a claim\tuser\t${path.join(userRegistry, "verify.js")}\n`
  );
  assert.match(stderr.text(), /\[workflows\] skipped .*broken\.js: Workflow script must begin with `export const meta = \{ \.\.\. \}`/);
});

test("CLI removes the live status snapshot after a run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-status-run-"));
  const statusDir = await mkdtemp(path.join(tmpdir(), "ensemble-cli-status-dir-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "status-run" };
      phase("work");
      await parallel([
        () => agent("a", { engine: "codex" }),
        () => agent("b", { engine: "codex" })
      ]);
      return "ok";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    statusDir,
    createRuntime: async () =>
      new EnsembleRuntime({
        engines: new EngineRegistry([new ScheduledTextEngine("codex", 2), new ScheduledTextEngine("claude", 2)]),
        defaultTurnTimeoutMs: 1_000,
        defaultMaxAttempts: 1
      })
  });

  assert.equal(exitCode, 0, stderr.text());
  await assert.rejects(access(path.join(statusDir, STATUS_FILENAME)));
});

test("CLI leaves a missing status namespace absent and silent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-status-off-"));
  const statusDir = path.join(directory, "missing-status");
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "status-off" };
      return "ok";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    statusDir,
    createRuntime: async () =>
      new EnsembleRuntime({
        engines: new EngineRegistry([new ScheduledTextEngine("codex", 1), new ScheduledTextEngine("claude", 1)]),
        defaultTurnTimeoutMs: 1_000,
        defaultMaxAttempts: 1
      })
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  await assert.rejects(access(statusDir));
});

test("a throwing status reporter cannot make CLI shutdown reject", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-status-error-"));
  const blocker = path.join(directory, "blocker");
  const statusDir = path.join(blocker, "status");
  const script = path.join(directory, "workflow.js");
  await writeFile(blocker, "not a directory");
  await writeFile(
    script,
    `
      export const meta = { name: "status-error" };
      return "ok";
    `
  );

  const stdout = new CaptureStream();
  let reportAttempts = 0;
  const stderr = {
    write(chunk: Buffer | string): boolean {
      if (chunk.toString().startsWith("[status]")) {
        reportAttempts += 1;
        throw new Error("status reporter failed");
      }
      return true;
    }
  } as Writable;

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    statusDir,
    createRuntime: async () =>
      new EnsembleRuntime({
        engines: new EngineRegistry([new ScheduledTextEngine("codex", 1), new ScheduledTextEngine("claude", 1)]),
        defaultTurnTimeoutMs: 1_000,
        defaultMaxAttempts: 1
      })
  });

  assert.equal(exitCode, 0);
  assert.ok(reportAttempts >= 1);
});

function fakeRuntime(): EnsembleRuntime {
  const budget: Budget = {
    spent: () => 0,
    remaining: () => Number.POSITIVE_INFINITY
  };

  return {
    budget,
    worktrees: [],
    onEvent: () => () => {},
    agent: async (prompt: string) => prompt,
    close: async () => {}
  } as unknown as EnsembleRuntime;
}

function salvageRuntime(): EnsembleRuntime {
  const completed: Array<{
    id: number;
    engine: "codex";
    label: string | null;
    phase: string | null;
    output: string;
  }> = [];
  const runtime = fakeRuntime() as EnsembleRuntime & {
    completedOutputs: () => typeof completed;
  };
  runtime.agent = async (prompt: string, options: { label?: string; phase?: string }) => {
    const output = `codex:${prompt}`;
    completed.push({
      id: completed.length + 1,
      engine: "codex",
      label: options.label ?? null,
      phase: options.phase ?? null,
      output
    });
    return output;
  };
  runtime.completedOutputs = () => completed;
  return runtime;
}

function hangingRuntime(): EnsembleRuntime {
  const budget: Budget = {
    spent: () => 0,
    remaining: () => Number.POSITIVE_INFINITY
  };

  return {
    budget,
    worktrees: [],
    onEvent: () => () => {},
    // Never resolves — the only way out is the workflow timeout.
    agent: () => new Promise<string>(() => {}),
    close: async () => {}
  } as unknown as EnsembleRuntime;
}

function budgetRuntime(options: RuntimeOptions): EnsembleRuntime {
  const budget = new TokenBudget(options.budgetCeilings);

  return {
    budget,
    worktrees: [],
    onEvent: () => () => {},
    agent: async (prompt: string, agentOptions: { engine?: unknown }) => {
      const engine = agentOptions.engine;
      if (engine !== "codex" && engine !== "claude") {
        throw new Error("test runtime requires an engine");
      }
      budget.assertCanStart(engine);
      if (prompt === "spend-codex") {
        budget.record(engine, tokenUsageEvent(5));
      }
      return `${engine}:${prompt}`;
    },
    close: async () => {}
  } as unknown as EnsembleRuntime;
}

class ScheduledTextEngine implements EngineAdapter {
  readonly concurrency: number;
  readonly scheduler: Scheduler;
  active = 0;
  maxActive = 0;

  constructor(
    readonly name: EngineName,
    concurrency: number,
    readonly resolvedDefault?: { model: string; effort?: string }
  ) {
    this.concurrency = concurrency;
    this.scheduler = new Scheduler(concurrency);
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule(task);
  }

  createInvocation(prompt: string): EngineInvocation {
    return {
      runAttempt: async () => {
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        this.active -= 1;
        return turn(`${this.name}:${prompt}`, this.resolvedDefault);
      }
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

// Resolves every turn immediately except for the "hang" prompt, which never
// settles — so a stopped run has some workers done and one still in flight.
class HangOnPromptEngine implements EngineAdapter {
  readonly concurrency: number;
  readonly scheduler: Scheduler;

  constructor(
    readonly name: EngineName,
    concurrency: number
  ) {
    this.concurrency = concurrency;
    this.scheduler = new Scheduler(concurrency);
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule(task);
  }

  createInvocation(prompt: string): EngineInvocation {
    return {
      runAttempt: async () => {
        if (prompt === "hang") {
          await new Promise<never>(() => {});
        }
        return turn(`${this.name}:${prompt}`);
      }
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

function turn(text: string, resolvedDefault?: { model: string; effort?: string }): TurnResult {
  return {
    text,
    deltaText: text,
    durationMs: 1,
    firstDeltaMs: 1,
    items: {},
    tokenUsageEvents: [],
    ...(resolvedDefault !== undefined ? { resolvedModel: resolvedDefault.model } : {}),
    ...(resolvedDefault?.effort !== undefined ? { resolvedEffort: resolvedDefault.effort } : {})
  };
}

function tokenUsageEvent(totalTokens: number): Parameters<TokenBudget["record"]>[1] {
  const usage = {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: totalTokens,
    reasoningOutputTokens: 0,
    totalTokens
  };
  return {
    threadId: "thread",
    turnId: "turn",
    last: usage,
    total: usage,
    raw: {}
  };
}

test("CLI warns on unpinned Claude calls and stays quiet when defaults pin the model", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-unpinned-"));
  const unpinnedScript = path.join(directory, "unpinned.js");
  await writeFile(
    unpinnedScript,
    `
      export const meta = { name: "unpinned" };
      return await agent("no model set", { engine: "claude", label: "loose" });
    `
  );
  const pinnedScript = path.join(directory, "pinned.js");
  await writeFile(
    pinnedScript,
    `
      export const meta = { name: "pinned" };
      export const defaults = { claude: { model: "opus" } };
      return await agent("model from defaults", { engine: "claude" });
    `
  );

  const makeRuntime = async () =>
    new EnsembleRuntime({
      engines: new EngineRegistry([new ScheduledTextEngine("claude", 2)]),
      defaultTurnTimeoutMs: 1_000,
      defaultMaxAttempts: 1
    });

  const unpinnedStderr = new CaptureStream();
  const unpinnedExit = await runEnsembleCli([unpinnedScript], {
    cwd: directory,
    stdout: new CaptureStream(),
    stderr: unpinnedStderr,
    createRuntime: makeRuntime
  });
  assert.equal(unpinnedExit, 0);
  assert.match(unpinnedStderr.text(), /\[claude\] agent 1 \(loose\) runs unpinned — no model: set/);

  const pinnedStderr = new CaptureStream();
  const pinnedStdout = new CaptureStream();
  const pinnedExit = await runEnsembleCli([pinnedScript], {
    cwd: directory,
    stdout: pinnedStdout,
    stderr: pinnedStderr,
    createRuntime: makeRuntime
  });
  assert.equal(pinnedExit, 0);
  assert.doesNotMatch(pinnedStderr.text(), /runs unpinned/);
  assert.equal(pinnedStdout.text(), "\"claude:model from defaults\"\n");
});

test("CLI logs the resolved Codex default and stays quiet when the model is pinned", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-codex-default-"));
  const unpinnedScript = path.join(directory, "unpinned.js");
  await writeFile(
    unpinnedScript,
    `
      export const meta = { name: "unpinned-codex" };
      return await agent("ambient model", { engine: "codex", label: "loose" });
    `
  );
  const pinnedScript = path.join(directory, "pinned.js");
  await writeFile(
    pinnedScript,
    `
      export const meta = { name: "pinned-codex" };
      export const defaults = { codex: { model: "gpt-pinned" } };
      return await agent("explicit model", { engine: "codex" });
    `
  );

  const makeRuntime = async () =>
    new EnsembleRuntime({
      engines: new EngineRegistry([
        new ScheduledTextEngine("codex", 2, { model: "gpt-resolved-default", effort: "high" })
      ]),
      defaultTurnTimeoutMs: 1_000,
      defaultMaxAttempts: 1
    });

  const unpinnedStderr = new CaptureStream();
  const unpinnedExit = await runEnsembleCli([unpinnedScript], {
    cwd: directory,
    stdout: new CaptureStream(),
    stderr: unpinnedStderr,
    createRuntime: makeRuntime
  });
  assert.equal(unpinnedExit, 0);
  assert.equal(
    unpinnedStderr.text(),
    "[codex] agent 1 (loose) runs unpinned — resolved ambient default: gpt-resolved-default (high effort)\n"
  );

  const pinnedStderr = new CaptureStream();
  const pinnedExit = await runEnsembleCli([pinnedScript], {
    cwd: directory,
    stdout: new CaptureStream(),
    stderr: pinnedStderr,
    createRuntime: makeRuntime
  });
  assert.equal(pinnedExit, 0);
  assert.doesNotMatch(pinnedStderr.text(), /resolved ambient default/);
});
