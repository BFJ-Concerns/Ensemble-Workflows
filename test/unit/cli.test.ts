import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, glob, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DIGEST_RECIPE } from "../../src/canonical-document.js";
import { runEnsembleCli } from "../../src/cli.js";
import { hermeticEstateEnvironment } from "../integration/estate-process.js";
import { EngineRegistry } from "../../src/engines.js";
import { AppServerSystemError, EngineShutdownError } from "../../src/errors.js";
import { HoldManager, enumerateHolds } from "../../src/holds.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { Scheduler } from "../../src/scheduler.js";
import { TokenBudget } from "../../src/budget.js";
import { isStatusFileName } from "../../src/status-file.js";

import type { EngineAdapter, EngineAttemptResult, EngineInvocation, EngineTurnOptions } from "../../src/engines.js";
import type { Budget, EngineName, RuntimeEvent, RuntimeOptions, TurnResult } from "../../src/types.js";

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

class InterruptOnSentinelAnnouncementStream extends CaptureStream {
  #interrupted = false;

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.#interrupted && /\[sentinel\] will write \S+ when the run ends\n/.test(chunk.toString())) {
      this.#interrupted = true;
      // This is the former startup gap: stderr is publishing the supervisor's
      // only handle, so the signal arrives before any later CLI setup can arm
      // interruption handling.
      process.emit("SIGINT");
    }
    super._write(chunk, encoding, callback);
  }
}

function withoutSentinelAnnouncement(stderr: string): string {
  const announcement = /^\[sentinel\] will write \S+\/completion-sentinel\.json when the run ends\n/gm;
  const matches = stderr.match(announcement) ?? [];
  assert.equal(matches.length, 1, `expected exactly one completion-sentinel announcement, got:\n${stderr}`);
  const withoutSentinel = stderr.replace(announcement, "");
  const runRecordAnnouncement = /^\[run-record-archive\] .+\n/gm;
  const runRecordMatches = withoutSentinel.match(runRecordAnnouncement) ?? [];
  assert.equal(runRecordMatches.length, 1, `expected exactly one run-record announcement, got:\n${stderr}`);
  return withoutSentinel.replace(runRecordAnnouncement, "");
}

function announcedRunRecord(stderr: string): { run_id: string; archive_path: string } {
  const lines = stderr.split("\n").filter((line) => line.startsWith("[run-record-archive] "));
  assert.equal(lines.length, 1, `expected exactly one run-record announcement, got:\n${stderr}`);
  return JSON.parse(lines[0]!.slice("[run-record-archive] ".length)) as { run_id: string; archive_path: string };
}

test("caller identity links each workflow archive to its invoking session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-caller-identity-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "caller-identity", task: { ledger: "unchanged" } };
      return await agent("record me", { engine: "codex" });
    `
  );

  const cases = [
    { name: "environment", argv: [script], env: { ENSEMBLE_CALLER_IDENTITY: "session:environment" }, expected: "session:environment" },
    {
      name: "flag wins over environment",
      argv: ["--caller-identity", "session:flag", script],
      env: { ENSEMBLE_CALLER_IDENTITY: "session:environment" },
      expected: "session:flag"
    },
    { name: "neither", argv: [script], env: {}, expected: null }
  ];

  try {
    for (const entry of cases) {
      const store = path.join(directory, `${entry.name.replaceAll(" ", "-")}-records`);
      const stderr = new CaptureStream();
      const exitCode = await runEnsembleCli(entry.argv, {
        cwd: directory,
        stdout: new CaptureStream(),
        stderr,
        runRecordDir: store,
        env: { XDG_CONFIG_HOME: path.join(directory, "missing-config"), ...entry.env },
        createRuntime: async (options) => fixedEngineRuntime(new FixedResponseEngine("codex", "done"), 1, options)
      });

      assert.equal(exitCode, 0, stderr.text());
      const announced = announcedRunRecord(stderr.text());
      const manifest = JSON.parse(await readFile(path.join(announced.archive_path, "manifest.json"), "utf8")) as {
        run_id: string;
        caller_identity: string | null;
        meta: { task: unknown };
      };
      assert.equal(manifest.run_id, announced.run_id);
      assert.equal(manifest.caller_identity, entry.expected);
      assert.deepEqual(manifest.meta.task, { ledger: "unchanged" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ensemble agent accepts caller identity and records it separately from its task", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-caller-identity-"));
  const store = path.join(directory, "records");
  const stderr = new CaptureStream();
  try {
    const exitCode = await runEnsembleCli(
      ["agent", "--engine=codex", "--task=ledger-task", "--caller-identity=session:agent", "prompt"],
      {
        cwd: directory,
        stdout: new CaptureStream(),
        stderr,
        runRecordDir: store,
        env: { XDG_CONFIG_HOME: path.join(directory, "missing-config"), ENSEMBLE_CALLER_IDENTITY: "session:environment" },
        createRuntime: async (options) => fixedEngineRuntime(new FixedResponseEngine("codex", "done"), 1, options)
      }
    );

    assert.equal(exitCode, 0, stderr.text());
    const announced = announcedRunRecord(stderr.text());
    const manifest = JSON.parse(await readFile(path.join(announced.archive_path, "manifest.json"), "utf8")) as {
      caller_identity: string | null;
      meta: { task: unknown };
    };
    assert.equal(manifest.caller_identity, "session:agent");
    assert.equal(manifest.meta.task, "ledger-task");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
  }) as unknown as EnsembleRuntime["agent"];
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
    manifest: { sha256?: string; unavailable?: string };
    integrity: { algorithm: string; sentinel_sha256: string };
  };
  assert.equal(sentinel.outcome, "complete");
  assert.equal(sentinel.exit_code, 0);
  assert.ok(sentinel.ended_at.length > 0);

  // The sentinel attests the sealed manifest from outside it, so the
  // manifest's own digest is checkable against a second file.
  const manifest = JSON.parse(
    await readFile(path.join(path.dirname(sentinelPath), "manifest.json"), "utf8")
  ) as { integrity: { manifest_sha256: string } };
  assert.equal(sentinel.manifest.sha256, manifest.integrity.manifest_sha256);
  // Both files verify under one recipe: the digest of the payload with its
  // own digest field null, canonicalised.
  assert.equal(manifest.integrity.manifest_sha256, selfDigest(manifest, "integrity", "manifest_sha256"));
  assert.equal(sentinel.integrity.sentinel_sha256, selfDigest(sentinel, "integrity", "sentinel_sha256"));
});

function selfDigest(document: unknown, block: string, field: string): string {
  const copy = JSON.parse(JSON.stringify(document)) as Record<string, Record<string, unknown>>;
  copy[block]![field] = null;
  return createHash("sha256").update(canonicalJson(copy)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortJson(entryValue)]));
  }
  return value;
}

test("a SIGINT delivered as the sentinel path is announced still writes the interrupted envelope", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-sentinel-startup-interrupt-"));
  const runRecordDir = path.join(directory, "records");
  const script = path.join(directory, "workflow.js");
  await writeFile(script, `export const meta = { name: "sentinel-startup-interrupt" }; return "unreached";`);

  const stdout = new CaptureStream();
  const stderr = new InterruptOnSentinelAnnouncementStream();
  try {
    const exitCode = await runEnsembleCli([script], {
      cwd: directory,
      stdout,
      stderr,
      runRecordDir,
      createRuntime: async () => fakeRuntime()
    });

    // A signal-stopped run exits by the shell convention (128 + the signal
    // number), and every durable surface records that same code.
    assert.equal(exitCode, 130);
    assert.deepEqual(JSON.parse(stdout.text()), {
      partial: true,
      reason: "interrupted",
      error: { kind: "WorkflowInterruptedError", message: "Workflow interrupted by SIGINT" },
      completed: []
    });
    const announced = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/);
    assert.ok(announced, "the interrupted run must retain the announced sentinel path");
    const sentinel = JSON.parse(await readFile(announced[1]!, "utf8")) as { outcome: string; exit_code: number };
    assert.equal(sentinel.outcome, "interrupted");
    assert.equal(sentinel.exit_code, 130);
    const result = JSON.parse(await readFile(path.join(path.dirname(announced[1]!), "result.json"), "utf8")) as {
      exit_code: number;
    };
    assert.equal(result.exit_code, 130);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as {
    outcome: string;
    manifest: { unavailable?: string };
  };
  assert.equal(sentinel.outcome, "complete");
  // No archive: the run directory exists for the sentinel alone, and the
  // attestation says why there is no digest rather than omitting it.
  assert.deepEqual(sentinel.manifest, { unavailable: "recording-disabled" });
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

test("CLI separates --json-args from its malformed-JSON diagnostic", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  let runtimeCreations = 0;

  const exitCode = await runEnsembleCli(["--json-args", "{", "workflow.js"], {
    stdout,
    stderr,
    createRuntime: async () => {
      runtimeCreations += 1;
      return fakeRuntime();
    }
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.equal(
    stderr.text(),
    "--json-args: the argument must contain valid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)\n"
  );
  // The flag must not run into the sentence with no separator.
  assert.doesNotMatch(stderr.text(), /--json-args the argument must contain valid JSON:/);
  assert.doesNotMatch(stderr.text(), /Usage: ensemble/);
  assert.equal(runtimeCreations, 0);
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

test("ensemble agent makes a missing worker result a failed terminal run with a sentinel", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-no-dispatch-"));
  const runRecordDir = path.join(directory, "records");
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  // This runtime returns the value a collapsed direct-agent workflow used to
  // print as a clean `null`, but supplies no completed-worker evidence. The
  // launcher must make that absence supervisor-legible rather than treating
  // it as the valid schema-null result covered above.
  const runtime = fakeRuntime();
  runtime.agent = (async () => null) as unknown as EnsembleRuntime["agent"];

  const exitCode = await runEnsembleCli(["agent", "--engine=codex", "missing worker result"], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir,
    createRuntime: async () => runtime
  });

  assert.equal(exitCode, 1);
  assert.equal(
    stdout.text(),
    '{"partial":true,"reason":"failed","error":{"kind":"SingleAgentFailedError","message":"Agent exhausted its attempts without producing a result"},"completed":[]}\n'
  );
  assert.match(stderr.text(), /Agent exhausted its attempts without producing a result/);
  const announced = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/);
  assert.ok(announced, "a no-dispatch failure must retain the announced wake signal");
  const sentinel = JSON.parse(await readFile(announced[1]!, "utf8")) as {
    schema_version: number;
    kind: string;
    outcome: string;
    exit_code: number;
    workers: unknown;
    error: { kind: string; message: string } | null;
    manifest: unknown;
    integrity: { algorithm: string; sentinel_sha256: string };
    ended_at: string;
  };
  const sealed = JSON.parse(
    await readFile(path.join(path.dirname(announced[1]!), "manifest.json"), "utf8")
  ) as { integrity: { manifest_sha256: string } };
  assert.deepEqual(sentinel, {
    schema_version: 3,
    kind: "completion_sentinel",
    outcome: "failed",
    exit_code: 1,
    // This runtime is injected and carries no progress model, so the
    // launcher observed no worker tally — null says so rather than
    // publishing a zeroed one it did not measure.
    workers: null,
    error: {
      kind: "SingleAgentFailedError",
      message: "Agent exhausted its attempts without producing a result"
    },
    // A failed run still seals its archive, so the sentinel can attest it.
    manifest: { sha256: sealed.integrity.manifest_sha256 },
    integrity: { algorithm: "sha256", recipe: DIGEST_RECIPE, sentinel_sha256: sentinel.integrity.sentinel_sha256 },
    ended_at: sentinel.ended_at
  });
  assert.equal(sentinel.integrity.sentinel_sha256, selfDigest(sentinel, "integrity", "sentinel_sha256"));
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
  assert.equal(
    stdout.text(),
    '{"partial":true,"reason":"failed","error":{"kind":"SingleAgentFailedError","message":"Agent exhausted its attempts without producing a result"},"completed":[]}\n'
  );
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
  assert.match(rejectedStderr.text(), /--max-attempts value must be a positive integer; got 0/);
  assert.doesNotMatch(rejectedStderr.text(), /Usage: ensemble/);
  assert.doesNotMatch(rejectedStderr.text(), /at .*\(/, "usage errors print without a stack trace");
});

test("ensemble agent threads --strip to the worker and rejects unknown capabilities cleanly", async () => {
  // The honoured value is observed at the engine: the fixed codex stub
  // declares no capability table, so the runtime's own fail-loud enforcement
  // rejects the dispatch — zero attempts — proving the flag reached agent()
  // rather than being swallowed by the parser.
  const engine = new FixedResponseEngine("codex", "never dispatched");
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli(["agent", "--engine=codex", "--strip=skills", "prompt"], {
    stdout,
    stderr,
    createRuntime: async (options) => fixedEngineRuntime(engine, 3, options)
  });

  assert.equal(exitCode, 1);
  assert.equal(engine.attempts, 0);
  assert.match(stderr.text(), /cannot strip the "skills" capability/);

  // The parser's own rejection: an unknown capability is a usage error
  // before worker creation — exit 2, one clean line, nothing dispatched.
  const rejectedEngine = new FixedResponseEngine("codex", "never reached");
  const rejectedStdout = new CaptureStream();
  const rejectedStderr = new CaptureStream();
  const rejectedExit = await runEnsembleCli(["agent", "--engine=codex", "--strip=shells", "prompt"], {
    stdout: rejectedStdout,
    stderr: rejectedStderr,
    createRuntime: async (options) => fixedEngineRuntime(rejectedEngine, 3, options)
  });

  assert.equal(rejectedExit, 2);
  assert.equal(rejectedEngine.attempts, 0);
  assert.match(rejectedStderr.text(), /--strip must name a capability from: skills, agents; got shells/);
  assert.doesNotMatch(rejectedStderr.text(), /at .*\(/, "usage errors print without a stack trace");
});

test("the workflow --strip tuning flag reaches the runtime as the run-wide strip", async () => {
  const captured: unknown[] = [];
  const engine = new FixedResponseEngine("codex", "done");
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-cli-strip-"));
  try {
    const workflowPath = path.join(dir, "strip.workflow.js");
    await writeFile(
      workflowPath,
      'export const meta = { name: "strip-probe", description: "run-wide strip" };\nreturn await agent("go", { engine: "codex" });\n'
    );
    const exitCode = await runEnsembleCli(["--strip", "agents", workflowPath], {
      stdout,
      stderr,
      createRuntime: async (options = {}) => {
        captured.push(options.strip);
        return fixedEngineRuntime(engine, 3, options);
      }
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(captured, [["agents"]]);
    // The fixed engine declares no capability table, so the run-wide strip
    // fails the dispatch loud — proof it reached agent() itself.
    assert.match(stderr.text(), /cannot strip the "agents" capability/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  assert.deepEqual(JSON.parse(stdout.text()), { label: "finder", phase: "hunt", output: "done", failure: null });

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

test("ensemble agent persists label and phase in the durable record", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-parity-"));
  const runRecordDir = path.join(directory, "records");
  const engine = new FixedResponseEngine("claude", "done");
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(
    ["agent", "--engine=claude", "--label=reviewer-a", "--phase=verification", "check the patch"],
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
  const records = [];
  for await (const record of glob(path.join(runRecordDir, "runs/**/agents/000001/agent.json"))) {
    records.push(record);
  }
  assert.equal(records.length, 1);
  const record = JSON.parse(await readFile(records[0]!, "utf8")) as {
    label: string | null;
    phase: string | null;
    fallback: unknown;
    answered_by: { entry: number; engine: string; model: string | null } | null;
  };
  assert.equal(record.label, "reviewer-a");
  assert.equal(record.phase, "verification");
  // A direct agent declares no chain, and the record says which target
  // answered even so: its own (entry -1).
  assert.equal(record.fallback, null);
  assert.deepEqual(record.answered_by, { entry: -1, engine: "claude", model: null });
});

test("the archive records the effort the engine actually served, beside the effort that was asked for", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-effort-"));
  const runRecordDir = path.join(directory, "records");
  // The request and the service can disagree; the archive must not let the
  // request stand in for what ran.
  const engine = new FixedResponseEngine("codex", "done", { model: "gpt-5.6-terra", effort: "medium" });
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(["agent", "--engine=codex", "--effort=low", "think"], {
    cwd: directory,
    stdout: new CaptureStream(),
    stderr,
    runRecordDir,
    createRuntime: async (options) => fixedEngineRuntime(engine, 1, options)
  });

  assert.equal(exitCode, 0, stderr.text());
  const records = [];
  for await (const record of glob(path.join(runRecordDir, "runs/**/agents/000001/agent.json"))) {
    records.push(record);
  }
  assert.equal(records.length, 1);
  const record = JSON.parse(await readFile(records[0]!, "utf8")) as {
    effort: string | null;
    resolved_effort: string | null;
    attempts: Array<{ resolved_effort: string | null }>;
  };
  assert.equal(record.effort, "low");
  assert.equal(record.resolved_effort, "medium");
  assert.equal(record.attempts[0]?.resolved_effort, "medium");
});

test("the retired --fallback-model flag names its script-side replacement, and a misplaced flag is still a placement error", async () => {
  let runtimeCreations = 0;
  for (const flag of [["--fallback-model=sonnet"], ["--fallback-model", "sonnet"]]) {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = await runEnsembleCli(["agent", "--engine=claude", ...flag, "prompt"], {
      stdout,
      stderr,
      createRuntime: async () => {
        runtimeCreations += 1;
        return fakeRuntime();
      }
    });
    assert.equal(exitCode, 2);
    assert.equal(stdout.text(), "");
    assert.equal(
      stderr.text(),
      "--fallback-model was retired; declare a script-side fallback chain in agent() or defaults instead.\n"
    );
    assert.equal(runtimeCreations, 0);
  }

  const malformedStderr = new CaptureStream();
  const malformedExit = await runEnsembleCli(
    ["agent", "--engine=claude", "prompt", "--max-attempts"],
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
  // The placement scan runs first: a flag after the prompt is named as a
  // misplacement with its remedy, before parseArgs could misread it.
  assert.match(malformedStderr.text(), /Flag --max-attempts appears after the agent prompt/);
  assert.doesNotMatch(malformedStderr.text(), /\n\s+at /);
});

test("--timeout above the 32-bit timer bound is a usage error, not a platform surprise", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli(["--timeout=2147483648", "workflow.js"], { stdout, stderr });

  assert.equal(exitCode, 2);
  assert.match(stderr.text(), /--timeout value must be at most 2147483647 milliseconds; got 2147483648/);
  assert.doesNotMatch(stderr.text(), /Usage: ensemble/);

  // The bound is inclusive: the maximum representable delay is accepted (and
  // then the invocation is rejected on the missing script, which is the next
  // check in line — still exit 2, but for the script, not the flag).
  const boundaryStderr = new CaptureStream();
  const boundaryExit = await runEnsembleCli(["--timeout=2147483647", "no-such-workflow.js"], {
    stdout: new CaptureStream(),
    stderr: boundaryStderr
  });
  assert.equal(boundaryExit, 2);
  assert.doesNotMatch(boundaryStderr.text(), /--timeout value/);
  assert.match(boundaryStderr.text(), /Could not read workflow script/);
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
  assert.doesNotMatch(stderr.text(), /Usage: ensemble/, "a named-option rejection is one line, not a usage dump");
  assert.doesNotMatch(stderr.text(), /\n\s+at /);
});

test("ensemble agent names an invalid --engine value without repeating the flag", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  let runtimeCreations = 0;

  const exitCode = await runEnsembleCli(["agent", "--engine=nope", "prompt"], {
    stdin: Readable.from([]),
    stdout,
    stderr,
    createRuntime: async () => {
      runtimeCreations += 1;
      return fakeRuntime();
    }
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "--engine must be codex, claude, or opencode; got nope\n");
  // The flag name must not be doubled, nor the separator a comma:
  // "--engine engine must be codex, claude, or opencode, got nope".
  assert.doesNotMatch(stderr.text(), /--engine engine must be codex, claude, or opencode, got nope/);
  assert.doesNotMatch(stderr.text(), /Usage: ensemble/);
  assert.equal(runtimeCreations, 0);
});

test("CLI renders named value mistakes in the must-be-got register without usage", async () => {
  const cases = [
    {
      argv: ["agent", "--engine=codex", "--isolation=sandbox", "prompt"],
      stderr: "--isolation must be worktree; got sandbox\n"
    },
    {
      // This deliberately reaches parseEngineName: an unknown map key is an
      // engine-name mistake, not an invalid budget value.
      argv: ["--budget=bogus=1", "workflow.js"],
      stderr: "--budget engine must be codex, claude, or opencode; got bogus\n"
    },
    {
      argv: ["--budget=codex=-1", "workflow.js"],
      stderr: "--budget value must be a non-negative integer; got -1\n"
    },
    {
      argv: ["--concurrency=codex=0", "workflow.js"],
      stderr: "--concurrency value must be a positive integer; got 0\n"
    },
    {
      argv: ["--agent-ceiling=0", "workflow.js"],
      stderr: "--agent-ceiling value must be a positive integer or null; got 0\n"
    },
    {
      argv: ["--timeout=soon", "workflow.js"],
      stderr: "--timeout value must be a positive integer of milliseconds; got soon\n"
    },
    {
      argv: ["agent", "--engine=codex", "--max-attempts=0", "prompt"],
      stderr: "--max-attempts value must be a positive integer; got 0\n"
    }
  ];

  for (const entry of cases) {
    const stderr = new CaptureStream();
    const exitCode = await runEnsembleCli(entry.argv, {
      stdin: Readable.from([]),
      stdout: new CaptureStream(),
      stderr,
      createRuntime: async () => fakeRuntime()
    });

    assert.equal(exitCode, 2);
    assert.equal(stderr.text(), entry.stderr);
    assert.doesNotMatch(stderr.text(), /Usage: ensemble/);
  }
});

test("ensemble agent rejects misplaced tuning flags, duplicate scalar flags, and blank prompts before runtime creation", async () => {
  const cases = [
    {
      argv: ["--timeout", "1000", "agent", "--engine=codex", "prompt"],
      diagnostic: "Tuning flags must appear after ensemble agent, not before it"
    },
    {
      argv: ["agent", "--engine=codex", "prompt", "--timeout", "1000"],
      diagnostic: "Tuning flag --timeout appears after the agent prompt; put tuning flags before the prompt"
    },
    {
      argv: ["agent", "--engine=codex", "--agent-ceiling=1", "--agent-ceiling=null", "prompt"],
      diagnostic: "Option --agent-ceiling may only be specified once"
    },
    {
      argv: ["agent", "--engine=codex", " \t "],
      diagnostic: "ensemble agent requires a prompt argument or a non-empty prompt on stdin"
    }
  ];

  for (const entry of cases) {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    let runtimeCreations = 0;
    const exitCode = await runEnsembleCli(entry.argv, {
      stdin: Readable.from([]),
      stdout,
      stderr,
      createRuntime: async () => {
        runtimeCreations += 1;
        return fakeRuntime();
      }
    });

    assert.equal(exitCode, 2);
    assert.equal(stdout.text(), "");
    assert.equal(stderr.text(), `${entry.diagnostic}\n`);
    assert.equal(runtimeCreations, 0);
  }
});

test("ensemble agent accepts a dash-leading prompt after --", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(["agent", "--engine=codex", "--", "--timeout"], {
    stdin: Readable.from([]),
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0, stderr.text());
  assert.equal(stdout.text(), '"--timeout"\n');
});

test("a pre-terminator flag repeated in a dash-leading prompt is not a duplicate", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  // The prompt is the exact spelling of the flag used before the
  // terminator — the case the pre-fix scan false-rejected as a duplicate
  // option, and the discriminating input for the scan stopping at `--`.
  const exitCode = await runEnsembleCli(["agent", "--engine=codex", "--timeout", "5000", "--", "--timeout"], {
    stdin: Readable.from([]),
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0, stderr.text());
  assert.equal(stdout.text(), '"--timeout"\n');
});

test("a boolean agent flag is scanned by its declared type, not a literal", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  // --identity consumes no value token, so the prompt right after it is
  // the prompt — and a tuning flag after that prompt is still misplaced.
  // The scan reads the option map's `type`, so this holds for any boolean
  // flag the map declares, present and future.
  const exitCode = await runEnsembleCli(
    ["agent", "--engine=codex", "--identity", "prompt", "--timeout", "1000"],
    {
      stdin: Readable.from([]),
      stdout,
      stderr,
      createRuntime: async () => fakeRuntime()
    }
  );

  assert.equal(exitCode, 2);
  assert.equal(stderr.text(), "Tuning flag --timeout appears after the agent prompt; put tuning flags before the prompt\n");
});

test("workflow invocation rejects duplicate scalar tuning flags before runtime creation", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  let runtimeCreations = 0;

  const exitCode = await runEnsembleCli(["--agent-ceiling=1", "--agent-ceiling=null", "workflow.js"], {
    stdout,
    stderr,
    createRuntime: async () => {
      runtimeCreations += 1;
      return fakeRuntime();
    }
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "Option --agent-ceiling may only be specified once\n");
  assert.equal(runtimeCreations, 0);
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
  assert.doesNotMatch(stderr.text(), /Usage: ensemble/, "a named-option rejection is one line, not a usage dump");
  assert.doesNotMatch(stderr.text(), /\n\s+at /);
});

test("CLI reports a rejected option as exactly one line, exit 2", async () => {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(["--unknown"], { stdout, stderr });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  // The whole rejection surface: the named diagnostic alone. Usage belongs
  // to the invocation that named no work at all (the bin entrypoint test),
  // never to an option mistake, where it buries the actionable line.
  assert.equal(stderr.text(), "Unknown option before script path: --unknown\n");
});

test("CLI rejects empty caller identities as usage errors before starting a run", async () => {
  for (const argv of [
    ["--caller-identity", "   ", "workflow.js"],
    ["agent", "--engine=codex", "--caller-identity", "\t", "prompt"]
  ]) {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = await runEnsembleCli(argv, { stdout, stderr });

    assert.equal(exitCode, 2);
    assert.equal(stdout.text(), "");
    assert.match(stderr.text(), /--caller-identity must be a non-empty string/);
    assert.doesNotMatch(stderr.text(), /\n\s+at /, "usage errors print without a stack trace");
  }
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
  // but it is still emitted, marking the stopped run rather than total loss,
  // and it names the deadline that ended it.
  assert.equal(
    stdout.text(),
    `{"partial":true,"reason":"timed-out","error":{"kind":"WorkflowTimeoutError","message":"Workflow timed out after 50ms"},"completed":[]}\n`
  );
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

  assert.equal(exitCode, 130);
  assert.equal(hangingEngine.cancelCount, 1);

  const envelope = JSON.parse(stdout.text()) as {
    partial: boolean;
    reason: string;
    error: { kind: string; message: string };
    completed: Array<{ engine: string; label: string | null; output: unknown }>;
  };
  assert.equal(envelope.partial, true);
  assert.equal(envelope.reason, "interrupted");
  assert.deepEqual(envelope.error, { kind: "WorkflowInterruptedError", message: "Workflow interrupted by SIGINT" });
  assert.equal(envelope.completed.length, 1);
  assert.equal(envelope.completed[0]?.engine, "codex");
  assert.equal(envelope.completed[0]?.label, "alpha");
  assert.equal(envelope.completed[0]?.output, "codex:done-fast");
  assert.match(stderr.text(), /Interrupted \(SIGINT\) — partial result on stdout/);
});

test("a SIGTERM-stopped run exits 143 and records 143 on every durable surface", async () => {
  // The other interrupt signal takes the same convention (128 + 15): the
  // envelope names the signal, and the sentinel and result carry the code
  // the process will exit with.
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-sigterm-"));
  const runRecordDir = path.join(directory, "records");
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-sigterm" };
      await agent("hang", { engine: "codex" });
      return "never reached";
    `
  );
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const hangingEngine = new HangOnPromptEngine("codex", 4, () => process.emit("SIGTERM"));

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir,
    createRuntime: async () =>
      new EnsembleRuntime({
        engines: new EngineRegistry([hangingEngine]),
        defaultTurnTimeoutMs: 1_000,
        defaultMaxAttempts: 1
      })
  });

  assert.equal(exitCode, 143);
  assert.deepEqual(JSON.parse(stdout.text()), {
    partial: true,
    reason: "interrupted",
    error: { kind: "WorkflowInterruptedError", message: "Workflow interrupted by SIGTERM" },
    completed: []
  });
  assert.match(stderr.text(), /Interrupted \(SIGTERM\) — partial result on stdout/);
  const announced = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/);
  assert.ok(announced);
  const sentinel = JSON.parse(await readFile(announced[1]!, "utf8")) as { outcome: string; exit_code: number };
  assert.deepEqual({ outcome: sentinel.outcome, exit_code: sentinel.exit_code }, { outcome: "interrupted", exit_code: 143 });
  const result = JSON.parse(await readFile(path.join(path.dirname(announced[1]!), "result.json"), "utf8")) as { exit_code: number };
  assert.equal(result.exit_code, 143);
});

test("CLI rejects a non-numeric --timeout with one clean line and exit code 2", async () => {
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
  assert.match(stderr.text(), /--timeout value must be a positive integer of milliseconds; got soon/);
  assert.doesNotMatch(stderr.text(), /Usage: ensemble/, "a named-option rejection is one line, not a usage dump");
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
  assert.equal(
    stdout.text(),
    `{"partial":true,"reason":"failed","error":{"kind":"Error","message":"bad workflow"},"completed":[]}\n`
  );
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
    // The failure still salvages completed work through the partial envelope,
    // and the envelope carries the settlement error that ended the run.
    const envelope = JSON.parse(stdout.text()) as { reason: string; error: { kind: string; message: string }; completed: unknown[] };
    assert.equal(envelope.reason, "failed");
    assert.equal(envelope.error.kind, "WorkflowScriptError");
    assert.match(envelope.error.message, /workflow return value must be a JSON value/);
    assert.deepEqual(envelope.completed, []);
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

test("CLI entrypoint keeps exact usage streams under hostile colour variables", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-bin-"));
  const binPath = path.join(directory, "ensemble");
  const entrypointPath = fileURLToPath(new URL("../../src/cli/ensemble.js", import.meta.url));
  await symlink(entrypointPath, binPath);

  // The child environment comes from the shared hermetic constructor, which
  // strips colour and ambient ENSEMBLE_ variables in a different file from
  // this exact-stream guard — the hostile-ambient journey in
  // cli-process-estate.test.ts is what arms the strip.
  const result = spawnSync(process.execPath, [binPath], { encoding: "utf8", env: hermeticEstateEnvironment() });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
      "Usage: ensemble [--json-args '<json>|@file'] [--budget engine=N] [--agent-ceiling N|null] [--concurrency engine=N] [--timeout ms] [--strip capability] [--caller-identity <identity>] [--hold-scope <scope>] <script.js> [args...]\n" +
      "       ensemble agent --engine <engine> [--model <model>] [--effort <effort>]\n" +
      "                      [--label <label>] [--phase <phase>] [--cwd <path>]\n" +
        "                      [--isolation worktree] [--identity] [--schema '<json>|@file'] [--max-attempts N] [--strip capability] [--task <identity>] [--caller-identity <identity>] [--hold-scope <scope>]\n" +
      "                      [--budget engine=N] [--agent-ceiling N|null] [--concurrency engine=N] [--timeout ms] [prompt]\n" +
      "       ensemble workflows\n" +
      "       ensemble holds [--json] [--scope <scope> | --all]\n" +
      "       ensemble holds answer <hold-id> --verdict <verdict> [--note <note>]\n"
  );
});

test("CLI entrypoint keeps every exit-2 path on stderr", () => {
  const entrypointPath = fileURLToPath(new URL("../../src/cli/ensemble.js", import.meta.url));
  const cases = [
    { argv: ["--unknown"], stderr: "Unknown option before script path: --unknown\n" },
    {
      argv: ["agent", "--unknown", "prompt"],
      stderr:
        "Unknown option '--unknown'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--unknown\"\n"
    },
    { argv: ["--timeout"], stderr: "Option --timeout expects a value\n" },
    { argv: ["workflows", "extra"], stderr: "Usage: ensemble workflows\n" },
    { argv: ["holds", "--unknown"], stderr: "Unknown option for ensemble holds: --unknown\n" },
    { argv: ["holds", "extra"], stderr: "Unexpected argument for ensemble holds: extra\n" },
    { argv: ["holds", "--scope"], stderr: "--scope requires a non-empty value\n" },
    { argv: ["holds", "--scope=", "--all"], stderr: "--scope requires a non-empty value\n" },
    { argv: ["holds", "--scope", "named", "--all"], stderr: "--scope and --all cannot be used together\n" }
  ];

  for (const { argv, stderr } of cases) {
    const result = spawnSync(process.execPath, [entrypointPath, ...argv], {
      encoding: "utf8",
      env: hermeticEstateEnvironment()
    });
    assert.equal(result.status, 2, argv.join(" "));
    assert.equal(result.stdout, "", argv.join(" "));
    assert.equal(result.stderr, stderr, argv.join(" "));
  }
});

test("top-level help states each stdout format without promising JSON for prose listings", () => {
  const entrypointPath = fileURLToPath(new URL("../../src/cli/ensemble.js", import.meta.url));
  const result = spawnSync(process.execPath, [entrypointPath, "--help"], {
    encoding: "utf8",
    env: hermeticEstateEnvironment()
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Workflow and agent runs return JSON on stdout\./);
  assert.match(result.stdout, /workflows and holds list prose on stdout; holds --json lists JSON\./);
  assert.match(result.stdout, /Help and version print text on stdout; diagnostics go to stderr\./);
  assert.doesNotMatch(result.stdout, /Results are JSON on stdout/);
});

test("the CLI attributes effective budget and timeout to the layers that actually decided them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-effective-"));
  const runRecordDir = path.join(directory, "records");
  const engine = new FixedResponseEngine("codex", "done");
  const stderr = new CaptureStream();

  // One flag supplied, one left to its default: the manifest must tell
  // them apart from the producer's own resolution, not from test-supplied
  // attributions.
  const exitCode = await runEnsembleCli(
    ["agent", "--engine=codex", "--budget", "codex=50000", "--timeout", "90000", "work"],
    {
      cwd: directory,
      stdout: new CaptureStream(),
      stderr,
      runRecordDir,
      createRuntime: async (options) => fixedEngineRuntime(engine, 1, options)
    }
  );
  assert.equal(exitCode, 0, stderr.text());

  const manifests = [];
  for await (const manifest of glob(path.join(runRecordDir, "runs/**/manifest.json"))) {
    manifests.push(manifest);
  }
  assert.equal(manifests.length, 1);
  const manifest = JSON.parse(await readFile(manifests[0]!, "utf8")) as {
    budget_ceilings: Record<string, { value: number | null; layer: string }>;
    run_timeout_ms: { value: number | null; layer: string };
  };
  assert.deepEqual(manifest.budget_ceilings.codex, { value: 50_000, layer: "flag" });
  assert.deepEqual(manifest.budget_ceilings.claude, { value: null, layer: "default" });
  assert.deepEqual(manifest.budget_ceilings.opencode, { value: null, layer: "default" });
  assert.deepEqual(manifest.run_timeout_ms, { value: 90_000, layer: "flag" });
});

test("--help, -h, and --version answer a cold arrival at exit 0", async () => {
  for (const flag of ["--help", "-h"]) {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    assert.equal(await runEnsembleCli([flag], { stdout, stderr }), 0);
    assert.match(stdout.text(), /^Usage: ensemble /);
    assert.equal(stderr.text(), "");
  }

  const stdout = new CaptureStream();
  assert.equal(await runEnsembleCli(["--version"], { stdout, stderr: new CaptureStream() }), 0);
  assert.match(stdout.text().trim(), /^\d+\.\d+\.\d+/);

  // Per-subcommand help is an answer, never a usage *error*: exit 0.
  for (const argv of [["workflows", "--help"], ["holds", "--help"], ["holds", "answer", "--help"], ["agent", "--help"]]) {
    const subStdout = new CaptureStream();
    assert.equal(await runEnsembleCli(argv, { stdout: subStdout, stderr: new CaptureStream() }), 0);
    assert.match(subStdout.text(), /Usage: ensemble/);
  }
});

test("ensemble holds serves the two listing contracts: one scope's view, and machine-wide", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-holds-"));
  const dataHome = path.join(directory, "data-home");
  const holdsRoot = path.join(dataHome, "ensemble", "holds");
  const record = (holdId: string, scope: string | null, scopeSegment: string): Record<string, unknown> => ({
    schema_version: 2,
    kind: "ensemble_hold",
    run_id: "run-x",
    hold_id: holdId,
    nonce: `${holdId}-nonce`,
    scope,
    content: `question from ${holdId}`,
    verdicts: ["ok"],
    raised_at: new Date(0).toISOString(),
    timeout_at: null,
    cwd: "/nowhere",
    // No liveness evidence: never guessed dead, so the listing keeps it.
    owner: { host: "elsewhere.invalid", pid: 1, start_ticks: null },
    decision_path: path.join(holdsRoot, scopeSegment, `${holdId}.decision.json`)
  });
  await mkdir(path.join(holdsRoot, "scope-lead-a"), { recursive: true });
  await mkdir(path.join(holdsRoot, "shared"), { recursive: true });
  await writeFile(
    path.join(holdsRoot, "scope-lead-a", "hold-a.json"),
    JSON.stringify(record("hold-a", "lead-a", "scope-lead-a"))
  );
  await writeFile(path.join(holdsRoot, "shared", "hold-s.json"), JSON.stringify(record("hold-s", null, "shared")));

  // The scoped view: exactly the named scope's holds, the shared scope
  // never among them.
  const scoped = new CaptureStream();
  assert.equal(
    await runEnsembleCli(["holds", "--scope", "lead-a"], {
      stdout: scoped,
      stderr: new CaptureStream(),
      env: { XDG_DATA_HOME: dataHome }
    }),
    0
  );
  assert.match(scoped.text(), /hold-a/);
  assert.doesNotMatch(scoped.text(), /hold-s/);

  // The inherited variable scopes the default view the same way.
  const inherited = new CaptureStream();
  assert.equal(
    await runEnsembleCli(["holds"], {
      stdout: inherited,
      stderr: new CaptureStream(),
      env: { XDG_DATA_HOME: dataHome, ENSEMBLE_HOLD_SCOPE: "lead-a" }
    }),
    0
  );
  assert.match(inherited.text(), /hold-a/);
  assert.doesNotMatch(inherited.text(), /hold-s/);

  // Machine-wide (--all, or keyless): every scope, shared included.
  const machineWide = new CaptureStream();
  assert.equal(
    await runEnsembleCli(["holds", "--all", "--json"], {
      stdout: machineWide,
      stderr: new CaptureStream(),
      env: { XDG_DATA_HOME: dataHome, ENSEMBLE_HOLD_SCOPE: "lead-a" }
    }),
    0
  );
  const parsed = JSON.parse(machineWide.text()) as { holds: Array<{ hold_id: string }>; retired: unknown[] };
  assert.deepEqual(parsed.holds.map((hold) => hold.hold_id).sort(), ["hold-a", "hold-s"]);
  assert.deepEqual(parsed.retired, []);

  // Naming a scope and forcing machine-wide contradict: a usage error.
  const conflicted = new CaptureStream();
  assert.equal(
    await runEnsembleCli(["holds", "--scope", "lead-a", "--all"], {
      stdout: new CaptureStream(),
      stderr: conflicted,
      env: { XDG_DATA_HOME: dataHome }
    }),
    2
  );
  assert.equal(conflicted.text(), "--scope and --all cannot be used together\n");
});

test("the help answers carry orientation beyond the bare usage grammar", async () => {
  const topLevel = new CaptureStream();
  assert.equal(await runEnsembleCli(["--help"], { stdout: topLevel, stderr: new CaptureStream() }), 0);
  assert.match(topLevel.text(), /^Usage: ensemble /);
  // Pre-fix, --help printed exactly the exit-2 usage screen and nothing more.
  assert.match(topLevel.text(), /Subcommands: agent/);
  assert.match(topLevel.text(), /Each subcommand answers its own --help/);

  const agentHelp = new CaptureStream();
  assert.equal(await runEnsembleCli(["agent", "--help"], { stdout: agentHelp, stderr: new CaptureStream() }), 0);
  assert.match(agentHelp.text(), /prompt is the single positional\s+argument, or stdin when omitted/);
  assert.match(agentHelp.text(), /--identity wraps the result/);
});

test("an agent flag placed after the prompt is rejected as a misplacement", async () => {
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli(["agent", "--engine=codex", "do the work", "--model=gpt-5.6-terra"], {
    stdout: new CaptureStream(),
    stderr,
    createRuntime: async () => {
      throw new Error("nothing should spawn");
    }
  });
  assert.equal(exitCode, 2);
  assert.match(stderr.text(), /Flag --model=gpt-5\.6-terra appears after the agent prompt/);
  assert.match(stderr.text(), /put flags before the prompt/);

  // The terminator still passes a dash-leading prompt through untouched.
  const engine = new FixedResponseEngine("codex", "ok");
  const stdout = new CaptureStream();
  const passthroughExit = await runEnsembleCli(["agent", "--engine=codex", "--", "--model=not-a-flag"], {
    stdout,
    stderr: new CaptureStream(),
    createRuntime: async (options) => fixedEngineRuntime(engine, 1, options)
  });
  assert.equal(passthroughExit, 0);
});

test("an empty workflows catalogue says what it found and where it looked", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-empty-workflows-"));
  const dataHome = path.join(directory, "data-home");
  const stdout = new CaptureStream();

  const exitCode = await runEnsembleCli(["workflows"], {
    cwd: directory,
    stdout,
    stderr: new CaptureStream(),
    env: { XDG_DATA_HOME: dataHome }
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.text(), /No saved workflows found/);
  assert.ok(stdout.text().includes(path.join(directory, ".claude", "ensemble", "workflows")));
  assert.ok(stdout.text().includes(path.join(dataHome, "ensemble", "workflows")));
});

test("CLI holds renders real verdict choices and a bounced answer's rejection feedback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-holds-"));
  const dataHome = path.join(directory, "data-home");
  const sharedDir = path.join(dataHome, "ensemble", "holds", "shared");
  await mkdir(sharedDir, { recursive: true });
  const record = (holdId: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    schema_version: 2,
    kind: "ensemble_hold",
    run_id: `run-${holdId}`,
    hold_id: holdId,
    nonce: `${holdId}-nonce`,
    scope: null,
    content: `question from ${holdId}`,
    verdicts: ["approve", "reject"],
    raised_at: new Date(0).toISOString(),
    timeout_at: null,
    cwd: directory,
    // No start ticks: the raiser is never guessed dead, so the hold is listed.
    owner: { host: "elsewhere.invalid", pid: 2 ** 30, start_ticks: null },
    decision_path: path.join(sharedDir, `${holdId}.decision.json`),
    ...extra
  });
  await writeFile(
    path.join(sharedDir, "bounced-hold.json"),
    JSON.stringify(
      record("bounced-hold", {
        answer_rejection: {
          reason: "invalid-verdict",
          attempted_verdict: "later",
          attempted_verdict_state: "submitted",
          rejected_at: new Date(1).toISOString()
        }
      })
    )
  );
  await writeFile(path.join(sharedDir, "open-hold.json"), JSON.stringify(record("open-hold", {})));
  const stdout = new CaptureStream();

  assert.equal(await runEnsembleCli(["holds"], { cwd: directory, stdout, stderr: new CaptureStream(), env: { XDG_DATA_HOME: dataHome } }), 0);
  assert.match(stdout.text(), /verdicts: approve \| reject/);
  // The template spells an accepted verdict and names the alternatives, so a
  // decider copying it writes an answer the runtime accepts.
  assert.match(stdout.text(), /"verdict":"approve".*\(or use "reject"\)/);
  assert.match(stdout.text(), /"nonce":"open-hold-nonce","verdict":"approve"/);
  assert.doesNotMatch(stdout.text(), /"verdict":"…"/);
  // The bounced answer's feedback rides the listing; the untouched hold has none.
  assert.match(stdout.text(), /rejected: invalid-verdict \("later"\)/);
  assert.equal(stdout.text().match(/rejected: /g)?.length, 1);
});

test("an unpinned Claude worker's resolution notice names the served model, like the Codex line", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-claude-resolved-"));
  const engine = new FixedResponseEngine("claude", "done", { model: "claude-opus-5" });
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli(["agent", "--engine=claude", "greet"], {
    cwd: directory,
    stdout: new CaptureStream(),
    stderr,
    runRecordDir: null,
    createRuntime: async (options) => fixedEngineRuntime(engine, 1, options)
  });

  assert.equal(exitCode, 0, stderr.text());
  assert.match(stderr.text(), /\[claude\] agent 1 runs unpinned — no model pinned; the ambient default applies/);
  assert.match(stderr.text(), /\[claude\] agent 1 runs unpinned — resolved ambient default: claude-opus-5/);
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
  // The run's own file is gone: nothing published remains in the directory.
  assert.deepEqual((await readdir(statusDir)).filter(isStatusFileName), []);
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
  runtime.agent = (async (prompt: string, options: { label?: string; phase?: string }) => {
    const output = `codex:${prompt}`;
    completed.push({
      id: completed.length + 1,
      engine: "codex",
      label: options.label ?? null,
      phase: options.phase ?? null,
      output
    });
    return output;
  }) as unknown as EnsembleRuntime["agent"];
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
    private readonly response: string,
    private readonly resolvedDefault?: { model: string; effort?: string }
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
        return turn(this.response, this.resolvedDefault);
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
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.strip !== undefined ? { strip: options.strip } : {})
  });
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
  assert.match(unpinnedStderr.text(), /\[claude\] agent 1 \(loose\) runs unpinned — no model pinned; the ambient default applies/);

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

test("a missing workflow script path is a rejected invocation: exit 2, one clean line, no run", async () => {
  // The acceptance boundary: a run begins when the invocation is accepted,
  // and an unreadable script is a rejection before that point. So it takes
  // the usage-error exit, prints nothing on stdout (no envelope claiming a
  // run that lost everything), announces no sentinel, and writes no archive
  // — the same shape as `--engine bogus` on the agent form.
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-missing-script-"));
  const runRecordDir = path.join(directory, "records");
  const missing = path.join(directory, "nowhere.js");

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli([missing], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  // Exactly one clean line: the read fails before the sentinel announce or
  // any worker machinery, so nothing else may reach stderr — an inclusion
  // check would let a builder extend this surface with noisy output unseen.
  assert.equal(
    stderr.text(),
    `WorkflowScriptReadError: Could not read workflow script ${missing}: no file exists at this path\n`
  );
  await assert.rejects(access(runRecordDir), "a rejected invocation writes no archive");
});

test("a direct agent whose --cwd is missing is rejected the same way, before any run artefact exists", async () => {
  // The same boundary from the other side: this path must not write an
  // archive or a sentinel for a rejection that comes before either. One rule,
  // both forms.
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-cwd-"));
  const runRecordDir = path.join(directory, "records");
  const missingCwd = path.join(directory, "nowhere");
  const engine = new FixedResponseEngine("codex", "never reached");

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli(["agent", "--engine=codex", `--cwd=${missingCwd}`, "place me"], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir,
    createRuntime: async (options) => fixedEngineRuntime(engine, 1, options)
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), `--cwd must name an existing directory; got ${missingCwd}\n`);
  assert.equal(engine.attempts, 0);
  await assert.rejects(access(runRecordDir), "a rejected invocation writes no archive");
});

test("the durable surfaces name what ended a failed run, discriminating one cause from another", async () => {
  // Four causes that all read as bare `failed` on status alone. Each must
  // be told apart by a consumer holding only the archive.
  const cases = [
    {
      name: "script-throw",
      source: `export const meta = { name: "cause-script" };\nreturn { value: 1n };`,
      kind: "WorkflowScriptError",
      message: /BigInt/
    },
    {
      name: "unknown-engine",
      source: `export const meta = { name: "cause-engine" };\nawait agent("hi", { engine: "codexx" });`,
      kind: "UnknownEngineError",
      message: /Unknown agent engine/
    },
    {
      name: "budget-refusal",
      source: `export const meta = { name: "cause-budget" };\nawait agent("hi", { engine: "codex" });`,
      kind: "BudgetExceededError",
      message: /Token budget for codex is 0, which admits no agent/
    }
  ] as const;

  for (const terminal of cases) {
    const directory = await mkdtemp(path.join(tmpdir(), `ensemble-cli-cause-${terminal.name}-`));
    const runRecordDir = path.join(directory, "records");
    const script = path.join(directory, "workflow.js");
    await writeFile(script, terminal.source);

    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = await runEnsembleCli([script], {
      cwd: directory,
      stdout,
      stderr,
      runRecordDir,
      createRuntime: async () =>
        new EnsembleRuntime({
          engines: new EngineRegistry([new HangOnPromptEngine("codex", 4)]),
          defaultMaxAttempts: 1,
          // A zero ceiling refuses the first codex dispatch outright; the
          // other two cases never reach the budget.
          ...(terminal.name === "budget-refusal" ? { budgetCeilings: { codex: 0 } } : {})
        })
    });

    assert.equal(exitCode, 1, `${terminal.name}: ${stderr.text()}`);

    const archive = announcedRunRecord(stderr.text()).archive_path;
    const manifest = JSON.parse(await readFile(path.join(archive, "manifest.json"), "utf8")) as {
      status: string;
      error: { kind: string; message: string } | null;
    };
    assert.equal(manifest.status, "failed", terminal.name);
    assert.equal(manifest.error?.kind, terminal.kind, `${terminal.name} manifest kind`);
    assert.match(manifest.error?.message ?? "", terminal.message, `${terminal.name} manifest message`);

    const result = JSON.parse(await readFile(path.join(archive, "result.json"), "utf8")) as {
      status: string;
      error: { kind: string; message: string } | null;
    };
    assert.equal(result.error?.kind, terminal.kind, `${terminal.name} result kind`);
    assert.match(result.error?.message ?? "", terminal.message, `${terminal.name} result message`);

    const sentinelPath = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/)?.[1];
    assert.ok(sentinelPath, `${terminal.name}: sentinel path must be announced`);
    const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as {
      outcome: string;
      error: { kind: string; message: string } | null;
    };
    assert.equal(sentinel.outcome, "failed", terminal.name);
    assert.equal(sentinel.error?.kind, terminal.kind, `${terminal.name} sentinel kind`);
  }
});

test("a clean run's durable surfaces carry no invented cause", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-cause-clean-"));
  const runRecordDir = path.join(directory, "records");
  const script = path.join(directory, "workflow.js");
  await writeFile(script, `export const meta = { name: "cause-clean" };\nreturn "ok";`);

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0, stderr.text());
  const archive = announcedRunRecord(stderr.text()).archive_path;
  const manifest = JSON.parse(await readFile(path.join(archive, "manifest.json"), "utf8")) as { error: unknown };
  const result = JSON.parse(await readFile(path.join(archive, "result.json"), "utf8")) as { error: unknown };
  assert.equal(manifest.error, null);
  assert.equal(result.error, null);
  const sentinelPath = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/)?.[1];
  assert.ok(sentinelPath);
  const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as { error: unknown };
  assert.equal(sentinel.error, null);
});

test("a workflow's failed worker is announced on stderr under its engine tag, with the record's own account", async () => {
  // A dispatched worker's failure resolves to the script as a value, so the
  // notice is where an operator watching the terminal learns which
  // worker failed and why. The direct-agent form is exempt: its collapse
  // is the run's own failure and the terminal diagnosis renders it.
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-agent-failed-notice-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "agent-failed-notice" };
      const answer = await agent("fail", { engine: "codex", label: "scout", phase: "recon" });
      return { answer };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    // Recording off and no store: the notice is the whole of stderr.
    runRecordDir: null,
    createRuntime: async () => fixedEngineRuntime(new FixedResponseEngine("codex", ""), 2)
  });

  assert.equal(exitCode, 0, stderr.text());
  assert.equal(stdout.text(), '{"answer":null}\n');
  assert.equal(
    stderr.text(),
    "[codex] agent 1 (scout) failed after 2 attempts — empty-output: agent returned empty text on attempt 2\n"
  );

  // The direct-agent form: the same collapse is the run's failure, rendered
  // once by the terminal diagnosis — never doubled by the notice.
  const directStdout = new CaptureStream();
  const directStderr = new CaptureStream();
  const directExit = await runEnsembleCli(["agent", "--engine=codex", "fail"], {
    cwd: directory,
    stdout: directStdout,
    stderr: directStderr,
    runRecordDir: null,
    createRuntime: async () => fixedEngineRuntime(new AlwaysFailingEngine("codex", 1), 1)
  });
  assert.equal(directExit, 1);
  assert.doesNotMatch(directStderr.text(), /failed after 1 attempt —/);
  assert.match(directStderr.text(), /Agent exhausted its attempts without producing a result/);
});

/** An engine whose turns follow a script in dispatch order — a chain's targets on one engine share it. */
class ScriptedTurnsEngine implements EngineAdapter {
  readonly concurrency = 1;
  readonly scheduler = new Scheduler(1);
  #steps: Array<() => Promise<EngineAttemptResult>>;

  constructor(
    readonly name: EngineName,
    steps: Array<() => Promise<EngineAttemptResult>>
  ) {
    this.#steps = [...steps];
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule(task);
  }

  createInvocation(): EngineInvocation {
    return {
      runAttempt: async () => {
        const step = this.#steps.shift();
        assert.ok(step, `${this.name} engine ran out of scripted turns`);
        return step();
      }
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A Claude API refusal as the engine returns it: a failed turn carrying the status the classifier reads as availability. */
function claudeApiRefusal(status: number, message: string): () => Promise<EngineAttemptResult> {
  return async () => ({
    ...turn(""),
    attemptFailure: { kind: "claude-worker-diagnostic", message },
    diagnostics: { apiError: { status, code: null } }
  });
}

async function runChainScript(
  source: string,
  engines: EngineAdapter[],
  defaultMaxAttempts: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-chain-notice-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(script, source);
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    // Recording off and no store: the notices are the whole of stderr.
    runRecordDir: null,
    createRuntime: async () => new EnsembleRuntime({ engines: new EngineRegistry(engines), defaultMaxAttempts })
  });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

test("an answer from a fallback entry is announced naming the refused declared target and its bounded refusal", async () => {
  const result = await runChainScript(
    `
      export const meta = { name: "chain-advanced-notice" };
      const answer = await agent("work", {
        engine: "claude", model: "haiku", label: "scout",
        fallback: [{ engine: "claude", model: "sonnet" }, { engine: "claude", model: "opus" }]
      });
      return { answer };
    `,
    [
      new ScriptedTurnsEngine("claude", [
        // Worker-controlled text: flattened to one line on the notice.
        claudeApiRefusal(429, "API Error: Request rejected (429)\n\tslow down"),
        claudeApiRefusal(529, "API Error: Request rejected (529)"),
        async () => ({ ...turn("from opus"), resolvedModel: "opus" })
      ])
    ],
    1
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, '{"answer":"from opus"}\n');
  assert.equal(
    result.stderr,
    "[claude] agent 1 (scout) answered by fallback entry 1 (claude/opus) — the declared target claude/haiku was refused: " +
      "claude-worker-diagnostic: API Error: Request rejected (429) slow down; 1 further chain entry was refused too\n"
  );
});

test("a declared chain left unconsulted by an unrecognised failure says so once, naming the attempt and its failure", async () => {
  const threadFailed = async (): Promise<EngineAttemptResult> => {
    throw new AppServerSystemError("turn notification", { code: "threadFailed", message: "the thread\nfailed" });
  };
  const result = await runChainScript(
    `
      export const meta = { name: "chain-not-consulted-notice" };
      const answer = await agent("work", {
        engine: "codex", model: "gpt-6-sol", label: "scout",
        fallback: [{ engine: "claude", model: "opus" }]
      });
      return { answer };
    `,
    [
      new ScriptedTurnsEngine("codex", [threadFailed, threadFailed, async () => turn("in place")]),
      new ScriptedTurnsEngine("claude", [])
    ],
    3
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, '{"answer":"in place"}\n');
  assert.equal(
    result.stderr,
    "[codex] agent 1 (scout) fallback chain not consulted — attempt 1 on codex/gpt-6-sol failed unclassified " +
      "(AppServerSystemError: turn notification failed (threadFailed): the thread failed); " +
      "the declared chain (1 entry) advances on availability failures only\n"
  );
});

test("an exhausted chain's failure notice names the last target's own failure and how many targets were tried", async () => {
  const result = await runChainScript(
    `
      export const meta = { name: "chain-exhausted-notice" };
      const answer = await agent("work", {
        engine: "claude", model: "haiku", label: "scout",
        fallback: [{ engine: "claude", model: "sonnet" }]
      });
      return { answer };
    `,
    [
      new ScriptedTurnsEngine("claude", [
        claudeApiRefusal(429, "API Error: Request rejected (429)"),
        claudeApiRefusal(529, "API Error: Request rejected (529)")
      ])
    ],
    1
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, '{"answer":null}\n');
  assert.equal(
    result.stderr,
    "[claude] agent 1 (scout) failed after 2 attempts across 2 chain targets — " +
      "the last target's failure: claude-worker-diagnostic: API Error: Request rejected (529)\n"
  );
});

test("the sentinel carries worker outcomes, so `complete` cannot mean every worker failed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-sentinel-workers-"));
  const runRecordDir = path.join(directory, "records");
  const script = path.join(directory, "workflow.js");
  // Worker failures collapse to null, and this script handles them —
  // so the run genuinely succeeds and exits 0. The sentinel is the only
  // surface a supervisor has, and it must not answer "complete" alone.
  await writeFile(
    script,
    `
      export const meta = { name: "sentinel-all-failed" };
      const results = await parallel([
        () => agent("fail", { engine: "codex" }),
        () => agent("fail", { engine: "codex" })
      ]);
      return { nulls: results.filter((value) => value === null).length };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir,
    createRuntime: async () => fixedEngineRuntime(new AlwaysFailingEngine("codex", 4), 1)
  });

  assert.equal(exitCode, 0, stderr.text());
  assert.deepEqual(JSON.parse(stdout.text()), { nulls: 2 });

  const sentinelPath = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/)?.[1];
  assert.ok(sentinelPath);
  const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as {
    outcome: string;
    exit_code: number;
    workers: { done: number; failed: number; cut_short: number; unsettled: number } | null;
  };
  // Outcome and exit code still describe the script, which succeeded.
  assert.equal(sentinel.outcome, "complete");
  assert.equal(sentinel.exit_code, 0);
  // What is added is the tally that stops `complete` reading as "all well".
  assert.deepEqual(sentinel.workers, { done: 0, failed: 2, cut_short: 0, unsettled: 0 });
});

test("the sentinel's worker tally counts a run's successes as its own observation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-sentinel-workers-ok-"));
  const runRecordDir = path.join(directory, "records");
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "sentinel-workers-ok" };
      await agent("one", { engine: "codex" });
      await agent("two", { engine: "codex" });
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
    createRuntime: async () => fixedEngineRuntime(new HangOnPromptEngine("codex", 4), 1)
  });

  assert.equal(exitCode, 0, stderr.text());
  const sentinelPath = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/)?.[1];
  assert.ok(sentinelPath);
  const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as {
    workers: { done: number; failed: number; cut_short: number; unsettled: number } | null;
  };
  assert.deepEqual(sentinel.workers, { done: 2, failed: 0, cut_short: 0, unsettled: 0 });
});

test("a successful run's torn-down workers are interrupted by the run ending, never failed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-clean-teardown-"));
  const runRecordDir = path.join(directory, "records");
  const script = path.join(directory, "workflow.js");
  // The script leaves one worker in flight and returns cleanly anyway — the
  // ordinary fire-and-forget shape. The run succeeded, so the leg the
  // launcher tears down was interrupted by the run ending; branding it
  // `failed` with a `run-failed` cause would tell a supervisor the run's own
  // work had faulted.
  await writeFile(
    script,
    `
      export const meta = { name: "clean-body-teardown" };
      const inflight = agent("hang", { engine: "codex", label: "straggler" });
      inflight.catch(() => null);
      await agent("done-fast", { engine: "codex", label: "alpha" });
      return "ok";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const engine = new HangOnPromptEngine("codex", 4);
  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir,
    createRuntime: async () => fixedEngineRuntime(engine, 1)
  });

  assert.equal(exitCode, 0, stderr.text());
  // The straggler really was live at teardown: the engine cancelled it.
  assert.equal(engine.cancelCount, 1, "the in-flight worker must have been cancelled by the run ending");

  const archive = announcedRunRecord(stderr.text()).archive_path;
  const records: Array<{
    label: string | null;
    status: string;
    termination_cause: { kind: string; message: string } | null;
  }> = [];
  for await (const file of glob(path.join(archive, "agents", "*", "agent.json"))) {
    records.push(JSON.parse(await readFile(file, "utf8")));
  }
  const straggler = records.find((record) => record.label === "straggler");
  assert.ok(straggler, `no record for the in-flight worker in ${JSON.stringify(records)}`);
  assert.equal(straggler.status, "interrupted");
  assert.equal(straggler.termination_cause?.kind, "run-interrupted");
  assert.equal(records.find((record) => record.label === "alpha")?.status, "complete");

  const sentinelPath = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/)?.[1];
  assert.ok(sentinelPath);
  const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as {
    outcome: string;
    workers: { done: number; failed: number; cut_short: number; unsettled: number } | null;
  };
  assert.equal(sentinel.outcome, "complete");
  // The tally partitions the run's workers by the disposition the run's end
  // decided for each: one settled on its own account, one cut short by
  // teardown and carrying the `interrupted` record asserted above. Nothing
  // was abandoned, so nothing is `unsettled` — the sentinel's figures and
  // the archive's records say the same thing.
  assert.deepEqual(sentinel.workers, { done: 1, failed: 0, cut_short: 1, unsettled: 0 });
});

test("a teardown that fails after a clean body degrades the sentinel and the exit code", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-teardown-failure-"));
  const runRecordDir = path.join(directory, "records");
  const script = path.join(directory, "workflow.js");
  await writeFile(script, `export const meta = { name: "teardown-failure" };\nreturn "ok";`);

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const runtime = fakeRuntime();
  runtime.close = (async () => {
    throw new Error("worker teardown never completed");
  }) as unknown as EnsembleRuntime["close"];

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    runRecordDir,
    createRuntime: async () => runtime
  });

  // The body returned cleanly, but the run did not end cleanly: a supervisor
  // reading `complete`/0 here would believe workers were gone that may still
  // be alive.
  assert.equal(exitCode, 1, stderr.text());
  assert.match(stderr.text(), /\[teardown\] the run failed to end cleanly: .*worker teardown never completed/);

  const sentinelPath = stderr.text().match(/\[sentinel\] will write (\S+) when the run ends/)?.[1];
  assert.ok(sentinelPath);
  const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as {
    outcome: string;
    exit_code: number;
    error: { kind: string; message: string } | null;
    manifest: { sha256?: string; unavailable?: string };
  };
  assert.equal(sentinel.outcome, "failed");
  assert.equal(sentinel.exit_code, 1);
  assert.equal(sentinel.error?.kind, "Error");
  assert.match(sentinel.error?.message ?? "", /worker teardown never completed/);
  // The archive still seals — with the degraded status, so it cannot read
  // `complete` under a sentinel saying the run failed to end — and the
  // sentinel attests the sealed manifest (an unsealed one would honestly
  // read `manifest-unsealed` instead).
  const archive = announcedRunRecord(stderr.text()).archive_path;
  const manifest = JSON.parse(await readFile(path.join(archive, "manifest.json"), "utf8")) as {
    status: string;
    integrity: { manifest_sha256: string };
  };
  assert.equal(manifest.status, "failed");
  assert.equal(sentinel.manifest.sha256, manifest.integrity.manifest_sha256);
});

class AlwaysFailingEngine implements EngineAdapter {
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

  createInvocation(): EngineInvocation {
    return {
      runAttempt: async () => {
        throw new Error("engine refused the turn");
      },
      close: async () => {}
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

test("ensemble holds answer writes the decision, reports what the raiser did with it, and exits by outcome", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-holds-answer-"));
  const dataHome = path.join(directory, "data-home");
  const holdsDir = path.join(dataHome, "ensemble", "holds");
  const env = { XDG_DATA_HOME: dataHome, ENSEMBLE_CALLER_IDENTITY: "lead-session-7" };
  const events: RuntimeEvent[] = [];
  const holds = new HoldManager({
    dir: holdsDir,
    runId: "run-cli-answer",
    cwd: directory,
    scope: null,
    pollIntervalMs: 5,
    onEvent: (event) => events.push(event),
    identity: () => ({ workflow: "release-gate", phase: "review", archive_path: "/archive/run-cli-answer", totals: { active: 0, queued: 1, done: 2, failed: 0 } })
  });
  const decision = holds.raise({ content: "ship?", verdicts: ["yes", "no"] });
  // A failing assertion must not leave the raise polling for ever.
  decision.catch(() => undefined);
  try {
    for (let attempt = 0; attempt < 400 && (await enumerateHolds(holdsDir)).holds.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }

    // The listing gives the decider the run's identity card and the hold's state.
    const listing = new CaptureStream();
    assert.equal(await runEnsembleCli(["holds"], { cwd: directory, stdout: listing, stderr: new CaptureStream(), env }), 0);
    assert.match(listing.text(), /run-cli-answer-1\topen\t/);
    assert.match(listing.text(), /run: +release-gate · phase review · agents 2 done, 0 active, 1 queued, 0 failed \(at raise\)/);
    assert.match(listing.text(), /archive: +\/archive\/run-cli-answer/);

    // An unlisted verdict bounces: exit 3, the reason on stdout, the hold still waiting.
    const bounced = new CaptureStream();
    assert.equal(
      await runEnsembleCli(["holds", "answer", "run-cli-answer-1", "--verdict", "maybe"], { cwd: directory, stdout: bounced, stderr: new CaptureStream(), env }),
      3
    );
    const bouncedReport = JSON.parse(bounced.text()) as { outcome: string; rejection: { reason: string } };
    assert.equal(bouncedReport.outcome, "bounced");
    assert.equal(bouncedReport.rejection.reason, "invalid-verdict");
    const afterBounce = new CaptureStream();
    assert.equal(await runEnsembleCli(["holds", "--json"], { cwd: directory, stdout: afterBounce, stderr: new CaptureStream(), env }), 0);
    assert.deepEqual(
      (JSON.parse(afterBounce.text()) as { holds: Array<{ state: string }> }).holds.map((hold) => hold.state),
      ["bounced"]
    );

    // A listed verdict is consumed: exit 0, and the run resumes with it and the note.
    const consumed = new CaptureStream();
    assert.equal(
      await runEnsembleCli(["holds", "answer", "run-cli-answer-1", "--verdict=yes", "--note", "looks good"], { cwd: directory, stdout: consumed, stderr: new CaptureStream(), env }),
      0
    );
    assert.deepEqual(JSON.parse(consumed.text()), { outcome: "consumed", hold_id: "run-cli-answer-1", verdict: "yes", answered_by: "lead-session-7" });
    assert.deepEqual(await decision, { verdict: "yes", note: "looks good" });
    const answered = events.find((event) => event.method === "hold/answered");
    assert.equal(answered?.params.answeredBy, "lead-session-7");
    assert.equal(answered?.params.note, "looks good");

    // The hold is gone now: answering it again finds nothing (exit 5).
    const missing = new CaptureStream();
    assert.equal(
      await runEnsembleCli(["holds", "answer", "run-cli-answer-1", "--verdict", "yes"], { cwd: directory, stdout: missing, stderr: new CaptureStream(), env }),
      5
    );
    assert.equal((JSON.parse(missing.text()) as { outcome: string }).outcome, "not-found");

    // Missing --verdict is a usage error, on stderr.
    const usageErr = new CaptureStream();
    const usageOut = new CaptureStream();
    assert.equal(await runEnsembleCli(["holds", "answer", "run-cli-answer-1"], { cwd: directory, stdout: usageOut, stderr: usageErr, env }), 2);
    assert.equal(usageOut.text(), "");
    assert.match(usageErr.text(), /Usage: ensemble holds answer/);
  } finally {
    holds.close();
    await rm(directory, { recursive: true, force: true });
  }
});
