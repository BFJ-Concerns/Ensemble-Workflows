import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { OpenCodeCliRunner } from "../../src/opencode-engine.js";

import { EngineRegistry, OpenCodeEngineAdapter } from "../../src/engines.js";
import {
  BudgetExceededError,
  EmptyAgentOutputError,
  EngineShutdownError,
  FallbackModelUnsupportedError,
  OpenCodeModelNotRegisteredError,
  OpenCodeModelRequiredError,
  OpenCodeRunError,
  partialWorkerTextOf,
  workerExitStatusOf
} from "../../src/errors.js";
import { RunRecordWriter } from "../../src/run-record.js";
import { EnsembleRuntime } from "../../src/runtime.js";

import type {
  OpenCodeRunOptions,
  OpenCodeRunResult,
  OpenCodeRunner,
  OpenCodeSessionExportResult
} from "../../src/opencode-engine.js";

class FakeOpenCodeRunner implements OpenCodeRunner {
  runs: OpenCodeRunOptions[] = [];
  exports: string[] = [];

  #runResult: OpenCodeRunResult;
  #exportResult: OpenCodeSessionExportResult;

  constructor(
    options: {
      runResult?: Partial<OpenCodeRunResult>;
      exportText?: string | null;
      exportResult?: OpenCodeSessionExportResult;
    } = {}
  ) {
    this.#runResult = {
      exitCode: 0,
      signal: null,
      stdout: `${JSON.stringify({ type: "session.created", sessionID: "ses_test" })}\n`,
      stderr: "",
      durationMs: 12,
      ...options.runResult
    };
    this.#exportResult =
      options.exportResult ??
      (options.exportText === null
        ? { status: "command-failed", exitCode: 1, signal: null, stderr: "fixture export failure" }
        : { status: "ok", stdout: options.exportText ?? exportText("final answer", tokens(3, 2, 1)) });
  }

  async run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    this.runs.push(options);
    return this.#runResult;
  }

  async exportSession(sessionId: string): Promise<OpenCodeSessionExportResult> {
    this.exports.push(sessionId);
    return this.#exportResult;
  }
}

class HangingOpenCodeRunner implements OpenCodeRunner {
  signal: AbortSignal | undefined;

  run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    this.signal = options.signal;
    return new Promise((resolve) => {
      options.signal?.addEventListener(
        "abort",
        () => resolve({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", durationMs: 0 }),
        { once: true }
      );
    });
  }

  async exportSession(): Promise<OpenCodeSessionExportResult> {
    throw new Error("a cancelled run must not export");
  }
}

test("opencode adapter close aborts the active runner and awaits settlement", async () => {
  const runner = new HangingOpenCodeRunner();
  const adapter = new OpenCodeEngineAdapter({ runner });
  const invocation = adapter.createInvocation("keep working", { model: "glm-5.2" });
  const attempt = invocation.runAttempt({ attempt: 1 });

  await adapter.close();

  assert.equal(runner.signal?.aborted, true);
  // A cancelled worker is a shutdown, not an opencode run failure.
  await assert.rejects(attempt, EngineShutdownError);
});

test("opencode run failure preserves stream text and the engine diagnostic in the attempt record", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-failure-cwd-"));
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-failure-store-"));
  const stream = [
    JSON.stringify({ type: "session.created", sessionID: "ses_failed" }),
    JSON.stringify({ type: "text", part: { type: "text", text: "partial from opencode" } }),
    JSON.stringify({ type: "error", error: { data: { message: "provider connection lost" } } })
  ].join("\n");
  const runner = new FakeOpenCodeRunner({
    runResult: { exitCode: 7, stdout: stream, stderr: "wrapper stderr" },
    exportResult: { status: "command-failed", exitCode: 7, signal: null, stderr: "export unavailable" }
  });
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ cwd, runner })]),
    defaultMaxAttempts: 1
  });
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-opencode-failure",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'opencode-failure' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  runtime.setRunRecorder(writer);

  try {
    await assert.rejects(runtime.agent("fail after writing", { engine: "opencode", model: "glm-5.2" }), (error: unknown) => {
      assert.ok(error instanceof OpenCodeRunError);
      assert.match(error.message, /provider connection lost/);
      assert.equal(partialWorkerTextOf(error), "partial from opencode");
      return true;
    });
    const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
      attempts: Array<{ raw_output: string | null; failure: { kind: string; message: string } }>;
    };
    assert.equal(agent.attempts[0]?.raw_output, "partial from opencode");
    assert.equal(agent.attempts[0]?.failure.kind, "OpenCodeRunError");
    assert.match(agent.attempts[0]?.failure.message ?? "", /provider connection lost/);
  } finally {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test("a worker killed by signal leaves its exit evidence in the attempt record", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-signal-cwd-"));
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-signal-store-"));
  // An externally killed run: no exit code, a terminating signal, partial
  // stream text. The record must say *how* the process died, so a killed leg
  // is distinguishable from one that returned nothing.
  const stream = [
    JSON.stringify({ type: "session.created", sessionID: "ses_killed" }),
    JSON.stringify({ type: "text", part: { type: "text", text: "half an answer" } })
  ].join("\n");
  // A killed run's session export realistically fails too; making it fail
  // also keeps the stream text as the retained evidence — a successful
  // export would legitimately replace it with the exported answer.
  const runner = new FakeOpenCodeRunner({
    runResult: { exitCode: null, signal: "SIGKILL", stdout: stream, stderr: "" },
    exportResult: { status: "command-failed", exitCode: 1, signal: null, stderr: "session gone" }
  });
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ cwd, runner })]),
    defaultMaxAttempts: 1
  });
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-opencode-signal",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'opencode-signal' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  runtime.setRunRecorder(writer);

  try {
    await assert.rejects(runtime.agent("get killed", { engine: "opencode", model: "glm-5.2" }), (error: unknown) => {
      assert.ok(error instanceof OpenCodeRunError);
      assert.deepEqual(workerExitStatusOf(error), { exitCode: null, signal: "SIGKILL" });
      return true;
    });
    const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
      attempts: Array<{
        worker_exit: { exit_code: number | null; signal: string | null } | null;
        raw_output: string | null;
      }>;
    };
    assert.deepEqual(agent.attempts[0]?.worker_exit, { exit_code: null, signal: "SIGKILL" });
    // The exit evidence rides beside the partial text, not instead of it.
    assert.equal(agent.attempts[0]?.raw_output, "half an answer");
  } finally {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});

test("a declared opencode worker environment reaches the run child, above inheritance", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-worker-env-"));
  const bin = path.join(directory, "opencode");
  const envPath = path.join(directory, "observed-env.json");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({
  key: process.env.OPENCODE_API_KEY ?? null,
  inherited: process.env.ENSEMBLE_TEST_INHERITED ?? null
}));
process.stdout.write(JSON.stringify({ type: "session.created", sessionID: "ses_env" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: "ok" } }) + "\\n");
`
  );
  await chmod(bin, 0o755);

  // Save-and-restore, not delete: a pre-existing value on the invoking
  // machine must survive this test for later tests in the process.
  const savedKey = process.env.OPENCODE_API_KEY;
  const savedInherited = process.env.ENSEMBLE_TEST_INHERITED;
  process.env.OPENCODE_API_KEY = "inherited-key";
  process.env.ENSEMBLE_TEST_INHERITED = "still-here";
  try {
    const runner = new OpenCodeCliRunner(bin, { workerEnv: { OPENCODE_API_KEY: "declared-key" } });
    const result = await runner.run({ prompt: "hello", cwd: directory, providerModel: "test/model" });
    assert.equal(result.exitCode, 0);
  } finally {
    restoreEnv("OPENCODE_API_KEY", savedKey);
    restoreEnv("ENSEMBLE_TEST_INHERITED", savedInherited);
    // The observation file is written before the child exits, so no wait race.
  }
  const observed = JSON.parse(await readFile(envPath, "utf8")) as { key: string | null; inherited: string | null };
  assert.equal(observed.key, "declared-key");
  assert.equal(observed.inherited, "still-here");
  await rm(directory, { recursive: true, force: true });
});

test("opencode invocation and adapter close terminate their real child processes", async () => {
  for (const closeThrough of ["invocation", "adapter"] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), `ensemble-opencode-close-${closeThrough}-`));
    const bin = path.join(directory, "opencode");
    const ready = path.join(directory, "ready");
    // Signals readiness by file so the test never sleeps on a wall clock, and
    // ignores SIGTERM so the SIGKILL escalation path is what ends it.
    await writeFile(
      bin,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1000);
`
    );
    await chmod(bin, 0o755);
    const adapter = new OpenCodeEngineAdapter({
      cwd: directory,
      runner: new OpenCodeCliRunner(bin, { killGraceMs: 10 })
    });
    const invocation = adapter.createInvocation("hang forever", { model: "glm-5.2" });
    const attempt = invocation.runAttempt({ attempt: 1 });
    await waitForFile(ready);

    if (closeThrough === "invocation") {
      await invocation.close?.();
    } else {
      await adapter.close();
    }

    // The child is SIGKILLed (close awaited its settlement), and the
    // attempt rejects as a shutdown rather than an opencode run failure.
    await assert.rejects(attempt, EngineShutdownError);
  }
});

async function waitForFile(filename: string): Promise<void> {
  for (;;) {
    try {
      await access(filename);
      return;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

test("opencode requires a registered curated model before spawning", () => {
  const runner = new FakeOpenCodeRunner();
  const adapter = new OpenCodeEngineAdapter({ runner });

  assert.throws(
    () => adapter.createInvocation("missing", { timeoutMs: 1_000 }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeModelRequiredError);
      assert.match(error.message, /"glm-5\.2"/);
      assert.match(error.message, /"qwen-3-6-27b-standard"/);
      return true;
    }
  );
  assert.throws(
    () => adapter.createInvocation("unknown", { timeoutMs: 1_000, model: "glm-later" }),
    OpenCodeModelNotRegisteredError
  );
  assert.equal(runner.runs.length, 0);
});

test("opencode rejects fallbackModel before spawning", () => {
  const runner = new FakeOpenCodeRunner();
  const adapter = new OpenCodeEngineAdapter({ runner });

  assert.throws(
    () =>
      adapter.createInvocation("fallback", {
        timeoutMs: 1_000,
        model: "glm-5.2",
        fallbackModel: "glm-4"
      }),
    FallbackModelUnsupportedError
  );
  assert.equal(runner.runs.length, 0);
});

test("opencode run parses final text, usage, transcript, and effort variant", async () => {
  const runner = new FakeOpenCodeRunner();
  const events: string[] = [];
  const adapter = new OpenCodeEngineAdapter({
    runner,
    onEvent: (event) => events.push(event.method)
  });
  const invocation = adapter.createInvocation("answer shortly", {
    timeoutMs: 1_000,
    model: "glm-5.2",
    effort: "minimal"
  });

  const result = await invocation.runAttempt({ attempt: 1 });

  assert.equal(result.text, "final answer");
  assert.equal(result.resolvedModel, "openrouter/z-ai/glm-5.2");
  assert.equal(result.durationMs, 12);
  assert.equal(runner.runs[0]?.providerModel, "openrouter/z-ai/glm-5.2");
  assert.equal(runner.runs[0]?.variant, "minimal");
  assert.equal(runner.exports[0], "ses_test");
  assert.equal(result.tokenUsageEvents[0]?.last.totalTokens, 6);
  assert.deepEqual(events, ["thread/tokenUsage/updated"]);
  assert.equal(result.transcripts?.[0]?.filename, "transcript.opencode.jsonl");
  assert.match(result.transcripts?.[0]?.content ?? "", /session\/export/);
});

test("a per-call cwd reaches opencode run and overrides the adapter cwd", async () => {
  const runner = new FakeOpenCodeRunner();
  const adapter = new OpenCodeEngineAdapter({ cwd: "/adapter/cwd", runner });
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    defaultMaxAttempts: 1
  });

  try {
    await runtime.agent("read", {
      engine: "opencode",
      model: "glm-5.2",
      cwd: "/per-call/cwd"
    });
    assert.equal(runner.runs[0]?.cwd, "/per-call/cwd");
  } finally {
    await runtime.close();
  }
});

test("opencode export fallback recovers the complete final stopped step into the result and run record", async () => {
  let runtime: EnsembleRuntime | null = null;
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-fallback-cwd-"));
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-fallback-store-"));
  const stream = await readFile("test/fixtures/opencode/boundary-17-final-step.jsonl", "utf8");
  const runner = new FakeOpenCodeRunner({
    runResult: { stdout: stream },
    exportResult: {
      status: "command-failed",
      exitCode: 17,
      signal: null,
      stderr: "session export unavailable"
    }
  });
  const adapter = new OpenCodeEngineAdapter({
    cwd,
    runner,
    onEvent: (event) => runtime?.handleEngineEvent("opencode", event)
  });
  runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    budgetCeilings: { opencode: 41_828 },
    defaultMaxAttempts: 1
  });
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-opencode-fallback",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'opencode-fallback' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  runtime.setRunRecorder(writer);

  const result = await runtime.agent("return the report", {
    engine: "opencode",
    model: "glm-5.2"
  });

  assert.equal(result.length, 2_640);
  assert.match(result, /^Here is the report:/);
  assert.match(result, /neither the cached digests nor the signed headers serve this role\./);
  assert.match(result, /Evidence: `src\/inventory\/keys\.py:40-44`$/);
  assert.equal(runtime.budget.spent("opencode"), 41_828);
  assert.equal(runtime.progress.snapshot().engines.opencode?.spent, 41_828);
  await assert.rejects(
    runtime.agent("must be blocked after fallback usage", { engine: "opencode", model: "glm-5.2" }),
    BudgetExceededError
  );
  assert.equal(runner.runs.length, 1);
  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
    status: unknown;
    raw_output: string;
    attempts: Array<{ raw_output: string; diagnostics: unknown }>;
  };
  assert.equal(agent.status, "complete");
  assert.equal(agent.raw_output.length, 2_640);
  assert.equal(agent.attempts[0]?.raw_output.length, 2_640);
  assert.deepEqual(agent.attempts[0]?.diagnostics, {
    opencode: {
      session_export: {
        status: "command-failed",
        exit_code: 17,
        signal: null,
        stderr: "session export unavailable"
      }
    }
  });
});

test("opencode fallback usage below the ceiling admits the next call", async () => {
  let runtime: EnsembleRuntime | null = null;
  const stream = await readFile("test/fixtures/opencode/boundary-17-final-step.jsonl", "utf8");
  const runner = new FakeOpenCodeRunner({
    runResult: { stdout: stream },
    exportResult: {
      status: "command-failed",
      exitCode: 17,
      signal: null,
      stderr: "session export unavailable"
    }
  });
  const adapter = new OpenCodeEngineAdapter({
    runner,
    onEvent: (event) => runtime?.handleEngineEvent("opencode", event)
  });
  runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    budgetCeilings: { opencode: 41_829 },
    defaultMaxAttempts: 1
  });

  await runtime.agent("first fallback turn", { engine: "opencode", model: "glm-5.2" });

  assert.equal(runtime.budget.spent("opencode"), 41_828);
  assert.equal(runtime.budget.remaining("opencode"), 1);

  await runtime.agent("admitted with one token remaining", { engine: "opencode", model: "glm-5.2" });

  assert.equal(runner.runs.length, 2);
  assert.equal(runtime.budget.spent("opencode"), 83_656);
});

test("opencode stream and export share snapshot-input and delta-output accounting", async () => {
  const stream = await readFile("test/fixtures/opencode/multi-step-tool-calls.jsonl", "utf8");
  const fallbackRunner = new FakeOpenCodeRunner({
    runResult: { stdout: stream },
    exportResult: { status: "command-failed", exitCode: 1, signal: null, stderr: "export failed" }
  });
  let fallbackRuntime: EnsembleRuntime | null = null;
  const fallbackAdapter = new OpenCodeEngineAdapter({
    runner: fallbackRunner,
    onEvent: (event) => fallbackRuntime?.handleEngineEvent("opencode", event)
  });
  fallbackRuntime = new EnsembleRuntime({
    engines: new EngineRegistry([fallbackAdapter]),
    budgetCeilings: { opencode: 16_095 },
    defaultMaxAttempts: 1
  });

  assert.equal(await fallbackRuntime.agent("multi-step turn", { engine: "opencode", model: "glm-5.2" }), "DONE");
  assert.deepEqual(fallbackRuntime.budget.events[0]?.event.last, {
    cachedInputTokens: 12_268,
    inputTokens: 3_244,
    outputTokens: 45,
    reasoningOutputTokens: 538,
    totalTokens: 16_095
  });
  await assert.rejects(
    fallbackRuntime.agent("blocked after fallback usage", { engine: "opencode", model: "glm-5.2" }),
    BudgetExceededError
  );
  assert.equal(fallbackRunner.runs.length, 1);

  const exportRunner = new FakeOpenCodeRunner({
    runResult: { stdout: stream },
    exportText: multiStepExportText()
  });
  let exportRuntime: EnsembleRuntime | null = null;
  const exportAdapter = new OpenCodeEngineAdapter({
    runner: exportRunner,
    onEvent: (event) => exportRuntime?.handleEngineEvent("opencode", event)
  });
  exportRuntime = new EnsembleRuntime({
    engines: new EngineRegistry([exportAdapter]),
    budgetCeilings: { opencode: 16_095 },
    defaultMaxAttempts: 1
  });

  assert.equal(await exportRuntime.agent("multi-step turn", { engine: "opencode", model: "glm-5.2" }), "DONE");
  assert.deepEqual(exportRuntime.budget.events[0]?.event.last, fallbackRuntime.budget.events[0]?.event.last);
  await assert.rejects(
    exportRuntime.agent("blocked after export usage", { engine: "opencode", model: "glm-5.2" }),
    BudgetExceededError
  );
  assert.equal(exportRunner.runs.length, 1);
});

test("opencode fallback without usable token data leaves the budget unmeasured", async () => {
  let runtime: EnsembleRuntime | null = null;
  const runner = new FakeOpenCodeRunner({
    runResult: {
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "ses_test", part: { type: "step-start" } }),
        JSON.stringify({ type: "text", sessionID: "ses_test", part: { type: "text", text: "answer" } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_test",
          part: { type: "step-finish", reason: "stop" }
        })
      ].join("\n")
    },
    exportResult: { status: "command-failed", exitCode: 1, signal: null, stderr: "export failed" }
  });
  const adapter = new OpenCodeEngineAdapter({
    runner,
    onEvent: (event) => runtime?.handleEngineEvent("opencode", event)
  });
  runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    budgetCeilings: { opencode: 1 },
    defaultMaxAttempts: 1
  });

  assert.equal(await runtime.agent("first unmeasured turn", { engine: "opencode", model: "glm-5.2" }), "answer");
  assert.equal(await runtime.agent("second unmeasured turn", { engine: "opencode", model: "glm-5.2" }), "answer");

  assert.equal(runtime.budget.spent("opencode"), 0);
  assert.equal(runtime.budget.events.length, 0);
  assert.equal(runner.runs.length, 2);
});

test("opencode fallback charges token-bearing schema retries", async () => {
  let runtime: EnsembleRuntime | null = null;
  const runner = new FakeOpenCodeRunner({
    runResult: {
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "ses_test", part: { type: "step-start" } }),
        JSON.stringify({
          type: "text",
          sessionID: "ses_test",
          part: { type: "text", text: JSON.stringify({ status: "retry" }) }
        }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_test",
          part: {
            type: "step-finish",
            reason: "stop",
            tokens: { total: 7, input: 4, output: 2, reasoning: 0, cache: { read: 1, write: 0 } }
          }
        })
      ].join("\n")
    },
    exportResult: { status: "command-failed", exitCode: 1, signal: null, stderr: "export failed" }
  });
  const adapter = new OpenCodeEngineAdapter({
    runner,
    onEvent: (event) => runtime?.handleEngineEvent("opencode", event)
  });
  runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    budgetCeilings: { opencode: 100 },
    defaultMaxAttempts: 2
  });

  const result = await runtime.agent("return valid JSON", {
    engine: "opencode",
    model: "glm-5.2",
    schema: {
      type: "object",
      required: ["status"],
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["ok"] }
      }
    }
  });

  assert.equal(result, null);
  assert.equal(runner.runs.length, 2);
  assert.equal(runtime.budget.events.length, 2);
  assert.equal(runtime.budget.spent("opencode"), 14);
});

test("opencode run record distinguishes an unparseable export from a failed export command", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-parse-cwd-"));
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-parse-store-"));
  const stream = await readFile("test/fixtures/opencode/boundary-17-final-step.jsonl", "utf8");
  const runner = new FakeOpenCodeRunner({
    runResult: { stdout: stream },
    exportResult: { status: "ok", stdout: "Exporting session: ses_test\n{not-json" }
  });
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ cwd, runner })]),
    defaultMaxAttempts: 1
  });
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-opencode-export-parse",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'opencode-export-parse' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  runtime.setRunRecorder(writer);

  const result = await runtime.agent("return the report", {
    engine: "opencode",
    model: "glm-5.2"
  });

  assert.equal(result.length, 2_640);
  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
    attempts: Array<{ diagnostics: { opencode: { session_export: { status: string; error: string } } } }>;
  };
  const diagnostic = agent.attempts[0]?.diagnostics.opencode.session_export;
  assert.equal(diagnostic?.status, "parse-failed");
  assert.match(diagnostic?.error ?? "", /Unexpected token|property name/i);
});

test("opencode records a missing stream session id separately without attempting export", async () => {
  const runner = new FakeOpenCodeRunner({
    runResult: {
      stdout: [
        JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
        JSON.stringify({ type: "text", part: { type: "text", text: "answer without a session id" } }),
        JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop" } })
      ].join("\n")
    }
  });
  const invocation = new OpenCodeEngineAdapter({ runner }).createInvocation("answer", {
    model: "glm-5.2"
  });

  const result = await invocation.runAttempt({ attempt: 1 });

  assert.equal(result.text, "answer without a session id");
  assert.deepEqual(result.diagnostics, {
    opencode: { session_export: { status: "no-session-id" } }
  });
  assert.deepEqual(runner.exports, []);
});

test("opencode fallback keeps the last text-bearing stopped step when a textless stop follows", async () => {
  const runner = new FakeOpenCodeRunner({
    runResult: {
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "ses_test", part: { type: "step-start" } }),
        JSON.stringify({ type: "text", sessionID: "ses_test", part: { type: "text", text: "complete " } }),
        JSON.stringify({ type: "text", sessionID: "ses_test", part: { type: "text", text: "answer" } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_test",
          part: { type: "step-finish", reason: "stop" }
        }),
        JSON.stringify({ type: "step_start", sessionID: "ses_test", part: { type: "step-start" } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_test",
          part: { type: "step-finish", reason: "stop" }
        })
      ].join("\n")
    },
    exportResult: { status: "command-failed", exitCode: 1, signal: null, stderr: "export failed" }
  });
  const invocation = new OpenCodeEngineAdapter({ runner }).createInvocation("answer", {
    model: "glm-5.2"
  });

  const result = await invocation.runAttempt({ attempt: 1 });

  assert.equal(result.text, "complete answer");
});

test("opencode schema agents keep a completed answer when unowned text is later stopped", async () => {
  const runner = new FakeOpenCodeRunner({
    runResult: {
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "ses_test", part: { type: "step-start" } }),
        JSON.stringify({
          type: "text",
          sessionID: "ses_test",
          part: { type: "text", text: '{"status":"ok"}' }
        }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_test",
          part: { type: "step-finish", reason: "stop" }
        }),
        JSON.stringify({
          type: "text",
          sessionID: "ses_test",
          part: { type: "text", text: '{"status":"orphan"}' }
        }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_test",
          part: { type: "step-finish", reason: "stop" }
        })
      ].join("\n")
    },
    exportResult: { status: "command-failed", exitCode: 1, signal: null, stderr: "export failed" }
  });
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ runner })]),
    defaultMaxAttempts: 1
  });

  const result = await runtime.agent("return JSON", {
    engine: "opencode",
    model: "glm-5.2",
    schema: {
      type: "object",
      required: ["status"],
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["ok"] }
      }
    }
  });

  assert.deepEqual(result, { status: "ok" });
});

test("opencode retains ownerless-only fallback text when no completed answer precedes it", async () => {
  const runner = new FakeOpenCodeRunner({
    runResult: {
      stdout: [
        JSON.stringify({
          type: "text",
          sessionID: "ses_test",
          part: { type: "text", text: "legacy answer" }
        }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_test",
          part: { type: "step-finish", reason: "stop" }
        })
      ].join("\n")
    },
    exportResult: { status: "command-failed", exitCode: 1, signal: null, stderr: "export failed" }
  });
  const invocation = new OpenCodeEngineAdapter({ runner }).createInvocation("answer", {
    model: "glm-5.2"
  });

  const result = await invocation.runAttempt({ attempt: 1 });

  assert.equal(result.text, "legacy answer");
});

test("opencode records empty-output only when neither export nor stream contains text", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-empty-cwd-"));
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-empty-store-"));
  const runner = new FakeOpenCodeRunner({
    runResult: {
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "ses_test", part: { type: "step-start" } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "ses_test",
          part: { type: "step-finish", reason: "stop" }
        })
      ].join("\n")
    },
    exportResult: { status: "command-failed", exitCode: 1, signal: null, stderr: "export failed" }
  });
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ cwd, runner })]),
    defaultMaxAttempts: 1
  });
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-opencode-genuinely-empty",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'opencode-genuinely-empty' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  runtime.setRunRecorder(writer);

  await assert.rejects(
    runtime.agent("return text", { engine: "opencode", model: "glm-5.2" }),
    EmptyAgentOutputError
  );

  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
    attempts: Array<{ failure: { kind: string } | null; diagnostics: unknown }>;
  };
  assert.equal(agent.attempts[0]?.failure?.kind, "empty-output");
  assert.deepEqual(agent.attempts[0]?.diagnostics, {
    opencode: {
      session_export: { status: "command-failed", exit_code: 1, signal: null, stderr: "export failed" }
    }
  });
});

test("opencode falls back from a parseable export without assistant text while retaining usage", async () => {
  const stdout = [
    JSON.stringify({ type: "step_start", sessionID: "ses_test", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", sessionID: "ses_test", part: { type: "text", text: "first " } }),
    JSON.stringify({ type: "text", sessionID: "ses_test", part: { type: "text", text: "second" } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_test", part: { type: "step-finish", reason: "stop" } })
  ].join("\n");
  const runner = new FakeOpenCodeRunner({
    runResult: { stdout },
    exportResult: {
      status: "ok",
      stdout: `Exporting session: ses_test\n${JSON.stringify({
        info: { tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 0, write: 0 } } },
        messages: []
      })}`
    }
  });
  const invocation = new OpenCodeEngineAdapter({ runner }).createInvocation("answer", {
    model: "glm-5.2"
  });

  const result = await invocation.runAttempt({ attempt: 1 });

  assert.equal(result.text, "first second");
  assert.equal(result.tokenUsageEvents[0]?.last.totalTokens, 6);
  assert.deepEqual(result.diagnostics, {
    opencode: {
      session_export: { status: "unusable", error: "export did not contain assistant text" }
    }
  });
});

test("opencode durable agent record stores authored and resolved models", async () => {
  let runtime: EnsembleRuntime | null = null;
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-record-cwd-"));
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-record-store-"));
  const runner = new FakeOpenCodeRunner({
    exportText: exportText(JSON.stringify({ status: "ok" }), tokens(4, 3, 0))
  });
  const adapter = new OpenCodeEngineAdapter({
    cwd,
    runner,
    onEvent: (event) => runtime?.handleEngineEvent("opencode", event)
  });
  runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-opencode-resolved-model",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'opencode-record' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  runtime.setRunRecorder(writer);

  await runtime.agent("return JSON", {
    engine: "opencode",
    model: "qwen-3-6-27b-standard",
    schema: {
      type: "object",
      required: ["status"],
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["ok"] }
      }
    }
  });

  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
    model: unknown;
    resolved_model: unknown;
  };
  assert.equal(agent.model, "qwen-3-6-27b-standard");
  assert.equal(agent.resolved_model, "local/Qwen3.6-27B-Standard");
});

test("opencode reaches the shared schema validation and budget path", async () => {
  let runtime: EnsembleRuntime | null = null;
  const runner = new FakeOpenCodeRunner({
    exportText: exportText(JSON.stringify({ status: "ok" }), tokens(4, 3, 0))
  });
  const adapter = new OpenCodeEngineAdapter({
    runner,
    onEvent: (event) => runtime?.handleEngineEvent("opencode", event)
  });
  runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    budgetCeilings: { opencode: 7 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  const result = await runtime.agent("return JSON", {
    engine: "opencode",
    model: "glm-5.2",
    schema: {
      type: "object",
      required: ["status"],
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["ok"] }
      }
    }
  });

  assert.deepEqual(result, { status: "ok" });
  assert.equal(runtime.budget.spent("opencode"), 7);
  assert.equal(runtime.progress.snapshot().engines.opencode?.spent, 7);
  assert.match(runner.runs[0]?.prompt ?? "", /may surround the value with prose.*markdown code fences/);
  assert.doesNotMatch(runner.runs[0]?.prompt ?? "", /exactly one JSON value/);
  await assert.rejects(
    runtime.agent("must be blocked after export usage", { engine: "opencode", model: "glm-5.2" }),
    BudgetExceededError
  );
  assert.equal(runner.runs.length, 1);
});

function exportText(text: string, tokenCounts: { input: number; output: number; reasoning: number }): string {
  return `Exporting session: ses_test
${JSON.stringify(
  {
    info: {
      id: "ses_test",
      model: { id: "glm-5.2", providerID: "openrouter", variant: "default" },
      cost: 0.001,
      tokens: {
        input: tokenCounts.input,
        output: tokenCounts.output,
        reasoning: tokenCounts.reasoning,
        cache: { read: 0, write: 0 }
      }
    },
    messages: [
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text }]
      }
    ]
  },
  null,
  2
)}
`;
}

function multiStepExportText(): string {
  const first = {
    total: 15_380,
    input: 14_812,
    output: 44,
    reasoning: 524,
    cache: { read: 0, write: 0 }
  };
  const second = {
    total: 15_527,
    input: 3_244,
    output: 1,
    reasoning: 14,
    cache: { read: 12_268, write: 0 }
  };
  return `Exporting session: ses_0608b95c9ffeS5uMwz6QTN8O68
${JSON.stringify({
  info: {
    id: "ses_0608b95c9ffeS5uMwz6QTN8O68",
    cost: 0.0056952,
    tokens: {
      input: 18_056,
      output: 45,
      reasoning: 538,
      cache: { read: 12_268, write: 0 }
    }
  },
  messages: [
    { info: { role: "assistant", tokens: first }, parts: [] },
    { info: { role: "assistant", tokens: second }, parts: [{ type: "text", text: "DONE" }] }
  ]
})}
`;
}

function tokens(input: number, output: number, reasoning: number): { input: number; output: number; reasoning: number } {
  return { input, output, reasoning };
}

test("opencode run escalates to SIGKILL when a timed-out worker ignores SIGTERM", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-stubborn-"));
  const bin = path.join(directory, "opencode");
  await writeFile(
    bin,
    `#!/usr/bin/env node
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`
  );
  await chmod(bin, 0o755);

  const runner = new OpenCodeCliRunner(bin, { killGraceMs: 50 });
  const result = await runner.run({
    prompt: "hang forever",
    cwd: directory,
    providerModel: "openrouter/z-ai/glm-5.2",
    timeoutMs: 50
  });

  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.exitCode, null);
});

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = saved;
  }
}
