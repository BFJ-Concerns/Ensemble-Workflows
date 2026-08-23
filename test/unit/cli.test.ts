import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { access, glob, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runEnsembleCli } from "../../src/cli.js";
import { CodexEngineAdapter, EngineRegistry, OpenCodeEngineAdapter } from "../../src/engines.js";
import { EngineShutdownError } from "../../src/errors.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { Scheduler } from "../../src/scheduler.js";
import { TokenBudget } from "../../src/budget.js";
import { STATUS_FILENAME } from "../../src/status-file.js";

import type { EngineAdapter, EngineInvocation, EngineTurnOptions } from "../../src/engines.js";
import type { OpenCodeRunner } from "../../src/opencode-engine.js";
import type { Budget, EngineName, RuntimeOptions, RuntimeTransport, TurnResult } from "../../src/types.js";

const execFileAsync = promisify(execFile);

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

function withoutSentinelAnnouncement(stderr: string): string {
  const announcement = /^\[sentinel\] will write \S+\/completion-sentinel\.json when the run ends\n/gm;
  const matches = stderr.match(announcement) ?? [];
  assert.equal(matches.length, 1, `expected exactly one completion-sentinel announcement, got:\n${stderr}`);
  return stderr.replace(announcement, "");
}

test("the launcher announces the sentinel path before workers spawn and writes it on success", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-sentinel-"));
  const runRecordDir = path.join(directory, "records");
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "sentinel-success" };
      await agent("observe ordering", { engine: "codex" });
      return "ok";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  // The ordering property is pinned by observation, not by code position:
  // the worker dispatch itself records whether the announcement had already
  // reached stderr when the first agent() ran.
  let announcedBeforeFirstAgent: boolean | null = null;
  const runtime = fakeRuntime();
  runtime.agent = (async (prompt: string) => {
    announcedBeforeFirstAgent ??= /\[sentinel\] will write /.test(stderr.text());
    return prompt;
  }) as EnsembleRuntime["agent"];
  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir,
    createRuntime: async () => runtime
  });

  assert.equal(announcedBeforeFirstAgent, true, "the sentinel path must be announced before the first worker runs");

  assert.equal(exitCode, 0, stderr.text());
  const announced = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/);
  assert.ok(announced, "sentinel path must be announced on stderr at startup");
  const sentinelPath = announced[1]!;
  assert.equal(path.basename(sentinelPath), "completion-sentinel.json");
  // The sentinel lands under the run's own directory in the store, beside
  // the archive a supervisor would read next.
  assert.ok(sentinelPath.startsWith(path.join(runRecordDir, "runs")));
  const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as {
    outcome: string;
    exit_code: number;
    ended_at: string;
  };
  assert.equal(sentinel.outcome, "complete");
  assert.equal(sentinel.exit_code, 0);
  assert.ok(sentinel.ended_at.length > 0);
});

test("the sentinel is written even when durable recording is disabled ambiently", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-sentinel-off-"));
  const configHome = path.join(directory, "config");
  const dataHome = path.join(directory, "data");
  await mkdir(path.join(configHome, "ensemble"), { recursive: true });
  // Recording off, but the store's location still resolves: the sentinel is
  // supervision surface, not archive.
  await writeFile(
    path.join(configHome, "ensemble", "config.json"),
    JSON.stringify({ schema_version: 1, run_record: { enabled: false } })
  );
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "sentinel-recording-off" };
      return "ok";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0, stderr.text());
  const announced = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/);
  assert.ok(announced, "recording off must not remove the supervisor's wake signal");
  const sentinelPath = announced[1]!;
  assert.ok(sentinelPath.startsWith(path.join(dataHome, "ensemble")));
  const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as { outcome: string };
  assert.equal(sentinel.outcome, "complete");
  // No archive: the run directory exists for the sentinel alone.
  await assert.rejects(access(path.join(path.dirname(sentinelPath), "manifest.json")));
});

test("the sentinel carries each terminal outcome the launcher can handle", async () => {
  // Failure and timeout, driven through the same terminal finally as
  // success; interruption shares that path (the SIGINT test above proves the
  // interrupted envelope reaches it).
  const cases = [
    {
      name: "failed",
      source: `export const meta = { name: "sentinel-failed" };\nthrow new Error("boom");`,
      argv: (script: string) => [script],
      outcome: "failed"
    },
    {
      name: "timed-out",
      source: `export const meta = { name: "sentinel-timeout" };\nawait agent("hang", { engine: "codex" });`,
      argv: (script: string) => ["--timeout=50", script],
      outcome: "timed-out"
    }
  ] as const;

  for (const terminal of cases) {
    const directory = await mkdtemp(path.join(tmpdir(), `ensemble-cli-sentinel-${terminal.name}-`));
    const runRecordDir = path.join(directory, "records");
    const script = path.join(directory, "workflow.js");
    await writeFile(script, terminal.source);

    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = await runEnsembleCli(terminal.argv(script), {
      cwd: directory,
      stdout,
      stderr,
      runRecordDir,
      createRuntime: async () => (terminal.name === "timed-out" ? hangingRuntime() : fakeRuntime())
    });

    assert.equal(exitCode, 1);
    const announced = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/);
    assert.ok(announced, `${terminal.name}: sentinel path must be announced`);
    const sentinel = JSON.parse(await readFile(announced[1]!, "utf8")) as { outcome: string; exit_code: number };
    assert.equal(sentinel.outcome, terminal.outcome, terminal.name);
    assert.equal(sentinel.exit_code, 1, terminal.name);
  }
});

test("a failed sentinel write reports on stderr and never fails the run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-sentinel-unwritable-"));
  // A file where the store directory should be makes every mkdir under it
  // fail — the sentinel must degrade to a report, not an exit-code change.
  const runRecordDir = path.join(directory, "store-blocker");
  await writeFile(runRecordDir, "not a directory");
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "sentinel-unwritable" };
      return "ok";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir,
    createRuntime: async () => fakeRuntime()
  });

  // The unwritable store already fails the run through the record writer
  // (existing behaviour); what this pins is the sentinel half — its write
  // failure surfaces as a [sentinel] stderr report, never as a crash or a
  // different exit path.
  assert.equal(exitCode, 1);
  const announced = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/);
  assert.ok(announced, "the path is announced before the store proves unwritable");
  await assert.rejects(access(announced[1]!), "no sentinel can exist under the blocked store");
  // A [sentinel] line beyond the announcement is the degraded write report.
  const sentinelLines = stderr.text().split("\n").filter((line) => line.startsWith("[sentinel]"));
  assert.ok(sentinelLines.length >= 2, `expected a sentinel write-failure report, got: ${stderr.text()}`);
});

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
    runRecordDir: null,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.text(), "{\"args\":[\"a\",\"b\"]}\n");
  assert.equal(stderr.text(), "hello stderr\n");
});

test("CLI reports a worktree finalisation failure through the operator log", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-worktree-finalisation-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "worktree-finalisation" };
      return "ok";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const runtime = fakeRuntime();
  runtime.onEvent = (listener) => {
    listener({
      method: "worktree/finalisationFailed",
      params: {
        agentId: 1,
        path: "/missing/worktree",
        branch: "ensemble-workflows/recover-me",
        message: "git status failed: ENOENT"
      },
      receivedAt: 0
    });
    return () => {};
  };

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir: null,
    createRuntime: async () => runtime
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.text(), "\"ok\"\n");
  assert.equal(
    stderr.text(),
    "[worktree] finalisation failed for /missing/worktree (ensemble-workflows/recover-me): git status failed: ENOENT\n"
  );
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
    runRecordDir: null,
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
    runRecordDir: null,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0);
  assert.equal(
    stdout.text(),
    `{"args":{"brief":"Analyse the API's quirks (part 2)","rounds":3},"isArray":false}\n`
  );
  assert.equal(stderr.text(), "");
});

test("ensemble agent preserves a stdin prompt and accepts the same schema inline or from a file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-schema-"));
  const schema = {
    type: "object",
    required: ["answer"],
    additionalProperties: false,
    properties: {
      answer: { type: "string", enum: ["validated"] }
    }
  };
  await writeFile(path.join(directory, "schema.json"), JSON.stringify(schema));
  const prompt = " \t\nQuote-heavy: 'single' \"double\" $HOME `ticks`\nsecond line\\n\n \t";
  const engine = new FixedResponseEngine("codex", JSON.stringify({ answer: "validated" }));

  const inlineStdout = new CaptureStream();
  const inlineStderr = new CaptureStream();
  const inlineExit = await runEnsembleCli(
    ["agent", "--engine=codex", `--schema=${JSON.stringify(schema)}`, prompt],
    {
      cwd: directory,
      stdout: inlineStdout,
      stderr: inlineStderr,
      createRuntime: async (options) => fixedEngineRuntime(engine, 1, options)
    }
  );

  const fileStdout = new CaptureStream();
  const fileStderr = new CaptureStream();
  const fileExit = await runEnsembleCli(["agent", "--engine=codex", "--schema=@schema.json"], {
    cwd: directory,
    stdin: Readable.from([prompt]),
    stdout: fileStdout,
    stderr: fileStderr,
    createRuntime: async (options) => fixedEngineRuntime(engine, 1, options)
  });

  assert.equal(inlineExit, 0, inlineStderr.text());
  assert.equal(fileExit, 0, fileStderr.text());
  assert.equal(inlineStdout.text(), '{"answer":"validated"}\n');
  assert.equal(fileStdout.text(), inlineStdout.text());
  assert.deepEqual(engine.prompts, [prompt, prompt]);
});

test("ensemble agent resolves run-wide concurrency through ambient settings", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-ambient-"));
  const configHome = path.join(directory, "config");
  const configFile = path.join(configHome, "ensemble", "config.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(
    configFile,
    JSON.stringify({
      schema_version: 1,
      agent_ceiling: 7,
      concurrency: { codex: 3 }
    })
  );
  const observed: RuntimeOptions[] = [];

  const exitCode = await runEnsembleCli(
    ["agent", "--engine=codex", "--agent-ceiling=2", "use ambient settings"],
    {
      cwd: directory,
      env: { XDG_CONFIG_HOME: configHome },
      stdout: new CaptureStream(),
      stderr: new CaptureStream(),
      runRecordDir: null,
      createRuntime: async (options = {}) => {
        observed.push(options);
        return fakeRuntime();
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(observed[0]?.agentCeiling, 2);
  assert.deepEqual(observed[0]?.concurrencyCaps, { codex: 3 });
});

test("ensemble agent preserves successful schema-validated null stdout equivalence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-null-"));
  const script = path.join(directory, "workflow.js");
  const schema = { type: ["null", "string"] };
  await writeFile(
    script,
    `
      export const meta = { name: "validated-null-script" };
      return await agent("return null", {
        engine: "codex",
        schema: ${JSON.stringify(schema)}
      });
    `
  );

  const scriptedStdout = new CaptureStream();
  const scriptedStderr = new CaptureStream();
  const scriptedExit = await runEnsembleCli([script], {
    cwd: directory,
    stdout: scriptedStdout,
    stderr: scriptedStderr,
    createRuntime: async (options) =>
      fixedEngineRuntime(new FixedResponseEngine("codex", "null"), 1, options)
  });

  const directStdout = new CaptureStream();
  const directStderr = new CaptureStream();
  const directExit = await runEnsembleCli(
    ["agent", "--engine=codex", `--schema=${JSON.stringify(schema)}`, "return null"],
    {
      cwd: directory,
      stdout: directStdout,
      stderr: directStderr,
      createRuntime: async (options) =>
        fixedEngineRuntime(new FixedResponseEngine("codex", "null"), 1, options)
    }
  );

  assert.equal(scriptedExit, 0, scriptedStderr.text());
  assert.equal(directExit, 0, directStderr.text());
  assert.equal(scriptedStdout.text(), "null\n");
  assert.equal(directStdout.text(), scriptedStdout.text());
});

test("ensemble agent turns schema retry exhaustion into a failed-run envelope", async () => {
  const schema = {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" } }
  };
  const engine = new FixedResponseEngine("codex", "not JSON");
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(
    ["agent", "--engine=codex", `--schema=${JSON.stringify(schema)}`, "return JSON"],
    {
      stdout,
      stderr,
      createRuntime: async () => fixedEngineRuntime(engine, 2)
    }
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), '{"partial":true,"reason":"failed","completed":[]}\n');
  assert.doesNotMatch(stdout.text(), /^null/m);
  assert.match(stderr.text(), /Agent exhausted its attempts without producing a result/);
  assert.equal(engine.attempts, 2);
});

test("ensemble agent honours --max-attempts and rejects invalid values before any worker runs", async () => {
  // An engine that always returns empty text exhausts the attempt budget, so
  // the attempt count observed at the engine is the flag's honoured value —
  // the run's default (3) would show three attempts.
  const engine = new FixedResponseEngine("codex", "");
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli(["agent", "--engine=codex", "--max-attempts=2", "empty answers"], {
    stdout,
    stderr,
    createRuntime: async (options) => fixedEngineRuntime(engine, 3, options)
  });

  assert.equal(exitCode, 1);
  assert.equal(engine.attempts, 2);

  // The rejection path: an invalid value is a usage error before worker
  // creation — exit 2, one clean line, nothing dispatched.
  const rejectedEngine = new FixedResponseEngine("codex", "never reached");
  const rejectedStdout = new CaptureStream();
  const rejectedStderr = new CaptureStream();
  const rejectedExit = await runEnsembleCli(["agent", "--engine=codex", "--max-attempts=0", "prompt"], {
    stdout: rejectedStdout,
    stderr: rejectedStderr,
    createRuntime: async (options) => fixedEngineRuntime(rejectedEngine, 3, options)
  });

  assert.equal(rejectedExit, 2);
  assert.equal(rejectedEngine.attempts, 0);
  assert.match(rejectedStderr.text(), /--max-attempts value must be a positive integer, got 0/);
  assert.doesNotMatch(rejectedStderr.text(), /at .*\(/, "usage errors print without a stack trace");
});

test("ensemble agent --identity prints the identified envelope and still fails on exhaustion", async () => {
  // Success: stdout matches agent()'s identified return contract exactly.
  const engine = new FixedResponseEngine("codex", "done");
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli(
    ["agent", "--engine=codex", "--identity", "--label=finder", "--phase=hunt", "go"],
    {
      stdout,
      stderr,
      createRuntime: async (options) => fixedEngineRuntime(engine, 1, options)
    }
  );
  assert.equal(exitCode, 0, stderr.text());
  assert.deepEqual(JSON.parse(stdout.text()), { label: "finder", phase: "hunt", output: "done" });

  // Exhaustion: the envelope's null output is still the failure signal —
  // exit 1 with the partial envelope, never `{output: null}` at exit 0.
  const exhaustedEngine = new FixedResponseEngine("codex", "not JSON");
  const exhaustedStdout = new CaptureStream();
  const exhaustedStderr = new CaptureStream();
  const exhaustedExit = await runEnsembleCli(
    [
      "agent",
      "--engine=codex",
      "--identity",
      "--max-attempts=1",
      "--schema",
      '{"type":"object","additionalProperties":false,"required":["answer"],"properties":{"answer":{"type":"string"}}}',
      "go"
    ],
    {
      stdout: exhaustedStdout,
      stderr: exhaustedStderr,
      createRuntime: async (options) => fixedEngineRuntime(exhaustedEngine, 1, options)
    }
  );
  assert.equal(exhaustedExit, 1);
  const envelope = JSON.parse(exhaustedStdout.text()) as { partial?: boolean };
  assert.equal(envelope.partial, true);
});

test("ensemble agent persists label and phase and forwards Claude's fallback model", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-parity-"));
  const runRecordDir = path.join(directory, "records");
  const engine = new FixedResponseEngine("claude", "done");
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(
    [
      "agent",
      "--engine=claude",
      "--label=reviewer-a",
      "--phase=verification",
      "--fallback-model=claude-sonnet-fallback",
      "check the patch"
    ],
    {
      cwd: directory,
      stdout,
      stderr,
      runRecordDir,
      createRuntime: async (options) => fixedEngineRuntime(engine, 1, options)
    }
  );

  assert.equal(exitCode, 0, stderr.text());
  assert.equal(stdout.text(), '"done"\n');
  assert.equal(engine.turnOptions[0]?.fallbackModel, "claude-sonnet-fallback");
  const records = [];
  for await (const record of glob(path.join(runRecordDir, "runs/**/agents/000001/agent.json"))) {
    records.push(record);
  }
  assert.equal(records.length, 1);
  const record = JSON.parse(await readFile(records[0]!, "utf8")) as {
    label: string | null;
    phase: string | null;
    fallback_model: string | null;
  };
  assert.equal(record.label, "reviewer-a");
  assert.equal(record.phase, "verification");
  assert.equal(record.fallback_model, "claude-sonnet-fallback");
});

test("ensemble agent leaves fallback-model support to the engine and rejects malformed flag syntax before runtime", async () => {
  for (const engineName of ["codex", "opencode"] as const) {
    const externalCalls: string[] = [];
    const engine = fallbackRejectingAdapter(engineName, externalCalls);
    const stderr = new CaptureStream();
    const exitCode = await runEnsembleCli(
      ["agent", `--engine=${engineName}`, "--fallback-model=unsupported", "prompt"],
      {
        stdout: new CaptureStream(),
        stderr,
        runRecordDir: null,
        createRuntime: async (options) => fixedEngineRuntime(engine, 1, options)
      }
    );

    assert.equal(exitCode, 1);
    assert.deepEqual(externalCalls, []);
    assert.match(stderr.text(), new RegExp(`fallbackModel is not supported on the ${engineName} engine`));
  }

  let runtimeCreations = 0;
  const malformedStderr = new CaptureStream();
  const malformedExit = await runEnsembleCli(
    ["agent", "--engine=claude", "prompt", "--fallback-model"],
    {
      stdout: new CaptureStream(),
      stderr: malformedStderr,
      createRuntime: async () => {
        runtimeCreations += 1;
        return fakeRuntime();
      }
    }
  );

  assert.equal(malformedExit, 2);
  assert.equal(runtimeCreations, 0);
  assert.match(malformedStderr.text(), /Option '--fallback-model <value>' argument missing/);
  assert.doesNotMatch(malformedStderr.text(), /\n\s+at /);
});

test("--timeout above the 32-bit timer bound is a usage error, not a platform surprise", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli(["--timeout=2147483648", "workflow.js"], { stdout, stderr });

  assert.equal(exitCode, 2);
  assert.match(stderr.text(), /--timeout value must be at most 2147483647 milliseconds, got 2147483648/);

  // The bound is inclusive: the maximum representable delay is accepted (and
  // then fails on the missing script, which is the next check in line).
  const boundaryStderr = new CaptureStream();
  const boundaryExit = await runEnsembleCli(["--timeout=2147483647", "no-such-workflow.js"], {
    stdout: new CaptureStream(),
    stderr: boundaryStderr
  });
  assert.equal(boundaryExit, 1);
  assert.doesNotMatch(boundaryStderr.text(), /--timeout value/);
});

test("ensemble agent reports option mistakes as stack-free usage errors", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(["agent", "--unknown", "prompt"], {
    stdin: Readable.from([]),
    stdout,
    stderr
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /Unknown option '--unknown'/);
  assert.match(stderr.text(), /ensemble agent --engine/);
  assert.doesNotMatch(stderr.text(), /\n\s+at /);
});

test("ensemble agent reports a recoverable branch carrying the worker commit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-worktree-"));
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: directory });
  await writeFile(path.join(directory, "README.md"), "base\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });

  const engine = new CommittingEngine();
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  try {
    const exitCode = await runEnsembleCli(
      ["agent", "--engine=codex", "--isolation=worktree", "commit the receipt"],
      {
        cwd: directory,
        stdout,
        stderr,
        createRuntime: async (options) => fixedEngineRuntime(engine, 1, options)
      }
    );

    assert.equal(exitCode, 0, stderr.text());
    assert.equal(stdout.text(), '"committed"\n');
    const branch = stderr.text().match(/\((ensemble-workflows\/[^)]+)\)/)?.[1];
    assert.ok(branch, stderr.text());
    const { stdout: committed } = await execFileAsync("git", ["show", `${branch}:worker-receipt.txt`], {
      cwd: directory
    });
    assert.equal(committed, "WORKER_COMMIT_RECEIPT\n");
  } finally {
    if (engine.cwd !== null) {
      await execFileAsync("git", ["worktree", "remove", "--force", engine.cwd], { cwd: directory });
      await rm(path.dirname(engine.cwd), { recursive: true, force: true });
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("ensemble agent reports an unchanged worktree branch before removing it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-clean-worktree-"));
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: directory });
  await writeFile(path.join(directory, "README.md"), "base\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: directory });

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  try {
    const exitCode = await runEnsembleCli(
      ["agent", "--engine=codex", "--isolation=worktree", "read without changing anything"],
      {
        cwd: directory,
        stdout,
        stderr,
        createRuntime: async (options) =>
          fixedEngineRuntime(new FixedResponseEngine("codex", "unchanged"), 1, options)
      }
    );

    assert.equal(exitCode, 0, stderr.text());
    assert.equal(stdout.text(), '"unchanged"\n');
    assert.match(
      stderr.text(),
      /\[worktree\] unchanged and removed .* \(ensemble-workflows\/[^)]+\)\n/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}.ensemble-workflows-worktrees`, { recursive: true, force: true });
  }
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
      "       ensemble agent --engine <engine> [--model <model>] [--effort <effort>] [--fallback-model <model>]\n" +
      "                      [--label <label>] [--phase <phase>] [--cwd <path>]\n" +
      "                      [--isolation worktree] [--identity] [--schema '<json>|@file'] [--max-attempts N] [--task <identity>]\n" +
      "                      [--budget engine=N] [--agent-ceiling N|null] [--concurrency engine=N] [--timeout ms] [prompt]\n" +
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
    runRecordDir: null,
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
    runRecordDir: null,
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

test("CLI threads the config file's worker environment into runtime construction", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-worker-env-"));
  const configHome = path.join(directory, "config");
  const configFile = path.join(configHome, "ensemble", "config.json");
  const script = path.join(directory, "workflow.js");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(
    configFile,
    JSON.stringify({
      schema_version: 1,
      worker_environment: { claude: { ANTHROPIC_BASE_URL: "https://gateway.example" } }
    })
  );
  await writeFile(script, `export const meta = { name: "cli-worker-env" }; return "done";`);
  const observed: RuntimeOptions[] = [];

  const exitCode = await runEnsembleCli([script], {
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
  assert.deepEqual(observed[0]?.workerEnvironment, {
    claude: { ANTHROPIC_BASE_URL: "https://gateway.example" }
  });

  // A run with no section behaves exactly as today: the option is absent,
  // not an empty object a later consumer might treat as a declaration.
  const bare = await mkdtemp(path.join(tmpdir(), "ensemble-cli-worker-env-absent-"));
  const bareScript = path.join(bare, "workflow.js");
  await writeFile(bareScript, `export const meta = { name: "cli-worker-env-absent" }; return "done";`);
  const bareObserved: RuntimeOptions[] = [];
  const bareExit = await runEnsembleCli([bareScript], {
    cwd: bare,
    stdout: new CaptureStream(),
    stderr: new CaptureStream(),
    env: { XDG_CONFIG_HOME: path.join(bare, "no-config") },
    runRecordDir: null,
    createRuntime: async (options = {}) => {
      bareObserved.push(options);
      return fakeRuntime();
    }
  });
  assert.equal(bareExit, 0);
  assert.equal(bareObserved[0]?.workerEnvironment, undefined);
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
  // Interrupt only once the worker is genuinely hanging, and assert its
  // cancellation: the envelope alone would pass even with the worker left
  // running behind it, which is the exact failure this journey guards.
  const hangingEngine = new HangOnPromptEngine("codex", 4, () => process.emit("SIGINT"));

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir: null,
    createRuntime: async () =>
      new EnsembleRuntime({
        engines: new EngineRegistry([hangingEngine]),
        defaultTurnTimeoutMs: 1_000,
        defaultMaxAttempts: 1
      })
  });

  assert.equal(exitCode, 1);
  assert.equal(hangingEngine.cancelCount, 1);

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

test("CLI rejects a tuning flag after the script path with pass-through guidance", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-misplaced-tuning-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "misplaced-tuning" };
      return { args };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script, "--json-args", "@args.json"], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /Tuning flag --json-args appears after the script path/);
  assert.match(stderr.text(), /put `--` before the script path to pass it through/);
});

test("CLI passes a tuning-looking workflow argument through after --", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-tuning-pass-through-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "tuning-pass-through" };
      return { args };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(["--", script, "--json-args", "@args.json"], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0, stderr.text());
  assert.equal(stdout.text(), '{"args":["--json-args","@args.json"]}\n');
});

test("CLI fails the run loudly when the return value is not a JSON value", async () => {
  // The contract: the return value is printed, hashed, and archived, so a
  // non-JSON value fails the run with the offending path named — never a
  // silent collapse to null. One scenario per unserialisable kind.
  for (const scenario of [
    { name: "cycle", body: `const value = { name: "loop" };\nvalue.self = value;\nreturn value;`, offence: /return value\.self closes a cycle/ },
    { name: "function", body: `return { callback: () => "later" };`, offence: /return value\.callback is a function/ },
    { name: "bigint", body: `return { count: 10n };`, offence: /return value\.count is a BigInt/ }
  ]) {
    const directory = await mkdtemp(path.join(tmpdir(), `ensemble-cli-unserialisable-${scenario.name}-`));
    const script = path.join(directory, "workflow.js");
    await writeFile(script, `export const meta = { name: "cli-unserialisable-${scenario.name}" };\n${scenario.body}`);

    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const exitCode = await runEnsembleCli([script], {
      cwd: directory,
      stdout,
      stderr,
      createRuntime: async () => fakeRuntime()
    });

    assert.equal(exitCode, 1, `${scenario.name}: ${stderr.text()}`);
    // The failure still salvages completed work through the partial envelope.
    assert.equal(stdout.text(), `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(stderr.text(), /WorkflowScriptError: workflow return value must be a JSON value/);
    assert.match(stderr.text(), scenario.offence);
    // An authoring error is the author's to fix: one clean line, no stack.
    assert.doesNotMatch(stderr.text(), /\n\s+at /);
  }
});

test("CLI still prints null for a script with no top-level return", async () => {
  // A bare undefined return is not a lossy collapse — it is the documented
  // shape of a script that ends without `return`, and stays permitted.
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-no-return-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(script, `export const meta = { name: "cli-no-return" };\nlog("ran");`);

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0, stderr.text());
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
      "       ensemble agent --engine <engine> [--model <model>] [--effort <effort>] [--fallback-model <model>]\n" +
      "                      [--label <label>] [--phase <phase>] [--cwd <path>]\n" +
      "                      [--isolation worktree] [--identity] [--schema '<json>|@file'] [--max-attempts N] [--task <identity>]\n" +
      "                      [--budget engine=N] [--agent-ceiling N|null] [--concurrency engine=N] [--timeout ms] [prompt]\n" +
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
    runRecordDir: null,
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

class FixedResponseEngine implements EngineAdapter {
  readonly concurrency = 1;
  readonly scheduler = new Scheduler(1);
  readonly prompts: string[] = [];
  readonly turnOptions: EngineTurnOptions[] = [];
  attempts = 0;

  constructor(
    readonly name: EngineName,
    private readonly response: string
  ) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule(task);
  }

  createInvocation(prompt: string, options: EngineTurnOptions): EngineInvocation {
    this.prompts.push(prompt);
    this.turnOptions.push(options);
    return {
      runAttempt: async () => {
        this.attempts += 1;
        return turn(this.response);
      }
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

class CommittingEngine implements EngineAdapter {
  readonly name = "codex";
  readonly concurrency = 1;
  readonly scheduler = new Scheduler(1);
  cwd: string | null = null;

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule(task);
  }

  createInvocation(_prompt: string, options: EngineTurnOptions): EngineInvocation {
    const cwd = options.cwd;
    if (cwd === undefined) {
      throw new Error("test engine requires a cwd");
    }
    this.cwd = cwd;
    return {
      runAttempt: async () => {
        await writeFile(path.join(cwd, "worker-receipt.txt"), "WORKER_COMMIT_RECEIPT\n");
        await execFileAsync("git", ["add", "worker-receipt.txt"], { cwd });
        await execFileAsync("git", ["commit", "-m", "worker commit"], { cwd });
        return turn("committed");
      }
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

function fixedEngineRuntime(
  engine: EngineAdapter,
  defaultMaxAttempts = 1,
  options: RuntimeOptions = {}
): EnsembleRuntime {
  return new EnsembleRuntime({
    engines: new EngineRegistry([engine]),
    defaultMaxAttempts,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {})
  });
}

function fallbackRejectingAdapter(engineName: "codex" | "opencode", externalCalls: string[]): EngineAdapter {
  if (engineName === "codex") {
    const transport: RuntimeTransport = {
      cwd: process.cwd(),
      openThread: async () => {
        externalCalls.push("openThread");
        return "unexpected";
      },
      runTurn: async () => {
        externalCalls.push("runTurn");
        return turn("unexpected");
      },
      close: async () => {}
    };
    return new CodexEngineAdapter({ transport, concurrency: 1 });
  }

  const runner: OpenCodeRunner = {
    run: async () => {
      externalCalls.push("run");
      throw new Error("unexpected opencode run");
    },
    exportSession: async () => {
      externalCalls.push("exportSession");
      throw new Error("unexpected opencode export");
    }
  };
  return new OpenCodeEngineAdapter({ runner, concurrency: 1 });
}

// Resolves every turn immediately except for the "hang" prompt, which never
// settles — so a stopped run has some workers done and one still in flight.
class HangOnPromptEngine implements EngineAdapter {
  readonly concurrency: number;
  readonly scheduler: Scheduler;
  cancelCount = 0;
  #activeInvocations = new Set<EngineInvocation>();

  constructor(
    readonly name: EngineName,
    concurrency: number,
    private readonly onHangStarted: () => void = () => {}
  ) {
    this.concurrency = concurrency;
    this.scheduler = new Scheduler(concurrency);
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule(task);
  }

  createInvocation(prompt: string): EngineInvocation {
    let rejectHang: ((error: Error) => void) | undefined;
    const invocation: EngineInvocation = {
      runAttempt: async () => {
        if (prompt === "hang") {
          this.onHangStarted();
          await new Promise<never>((_resolve, reject) => {
            rejectHang = reject;
          });
        }
        return turn(`${this.name}:${prompt}`);
      },
      close: async () => {
        this.#activeInvocations.delete(invocation);
        if (rejectHang !== undefined) {
          this.cancelCount += 1;
          rejectHang(new EngineShutdownError(this.name));
          rejectHang = undefined;
        }
      }
    };
    this.#activeInvocations.add(invocation);
    return invocation;
  }

  async close(): Promise<void> {
    this.scheduler.close(new EngineShutdownError(this.name));
    await Promise.allSettled([...this.#activeInvocations].map((invocation) => invocation.close?.()));
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
    withoutSentinelAnnouncement(unpinnedStderr.text()),
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
  assert.doesNotMatch(withoutSentinelAnnouncement(pinnedStderr.text()), /resolved ambient default/);
});
