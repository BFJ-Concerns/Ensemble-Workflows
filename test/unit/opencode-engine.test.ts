import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { OpenCodeCliRunner } from "../../src/opencode-engine.js";
import { testOpenCodeModelRegistry, testOpenCodeModels } from "../fixtures/opencode/models.js";

import { EngineRegistry, OpenCodeEngineAdapter } from "../../src/engines.js";
import {
  BudgetExceededError,
  CapabilityStripUnsupportedError,
  EngineShutdownError,
  InvalidAgentOptionValueError,
  OpenCodeModelNotRegisteredError,
  OpenCodeModelRequiredError
} from "../../src/errors.js";
import { RunRecordWriter } from "../../src/run-record.js";
import { validateEngineDefaults } from "../../src/engine-option-validation.js";
import { EnsembleRuntime } from "../../src/runtime.js";

import type { RuntimeAgentRecord } from "../../src/run-record.js";

import type {
  OpenCodeRunOptions,
  OpenCodeRunResult,
  OpenCodeRunner,
  OpenCodeSessionExportResult
} from "../../src/opencode-engine.js";

const execFileAsync = promisify(execFile);

class FakeOpenCodeRunner implements OpenCodeRunner {
  runs: OpenCodeRunOptions[] = [];
  exports: string[] = [];

  #runResult: OpenCodeRunResult;
  /** Per-attempt overrides, consumed in dispatch order; the base result serves any attempt beyond the list. */
  #runResults: Array<Partial<OpenCodeRunResult>>;
  #exportResult: OpenCodeSessionExportResult;
  #onDataChunks: string[];
  #beforeResolve: (() => Promise<void>) | undefined;

  constructor(
    options: {
      runResult?: Partial<OpenCodeRunResult>;
      runResults?: Array<Partial<OpenCodeRunResult>>;
      exportText?: string | null;
      exportResult?: OpenCodeSessionExportResult;
      /** Chunks emitted while the runner is still active, before it resolves. */
      onDataChunks?: string[];
      /** Test-only barrier after live chunks have been delivered. */
      beforeResolve?: () => Promise<void>;
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
    this.#runResults = [...(options.runResults ?? [])];
    this.#onDataChunks = options.onDataChunks ?? [];
    this.#beforeResolve = options.beforeResolve;
    this.#exportResult =
      options.exportResult ??
      (options.exportText === null
        ? { status: "command-failed", exitCode: 1, signal: null, stderr: "fixture export failure" }
        : { status: "ok", stdout: options.exportText ?? exportText("final answer", tokens(3, 2, 1)) });
  }

  async run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    this.runs.push(options);
    for (const chunk of this.#onDataChunks) {
      options.onData?.(chunk);
    }
    await this.#beforeResolve?.();
    return { ...this.#runResult, ...this.#runResults.shift() };
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
  const adapter = new OpenCodeEngineAdapter({ runner, modelRegistry: testOpenCodeModelRegistry });
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
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ cwd, runner, modelRegistry: testOpenCodeModelRegistry })]),
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
    // The failure consumes the bounded attempt: with maxAttempts 1 the loop
    // exhausts and the call resolves null, the engine's own diagnostic
    // and the partial text retained on the attempt record.
    assert.equal(await runtime.agent("fail after writing", { engine: "opencode", model: "glm-5.2" }), null);
    const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
      attempts: Array<{ raw_output: string | null; failure: { kind: string; message: string } }>;
    };
    assert.equal(agent.attempts[0]?.raw_output, "partial from opencode");
    assert.equal(agent.attempts[0]?.failure.kind, "opencode-run-error");
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
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ cwd, runner, modelRegistry: testOpenCodeModelRegistry })]),
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
    assert.equal(await runtime.agent("get killed", { engine: "opencode", model: "glm-5.2" }), null);
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

test("an opencode subprocess stopped by its turn deadline records a timeout", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-deadline-"));
  const bin = path.join(directory, "opencode");
  const records: RuntimeAgentRecord[] = [];
  await writeFile(bin, "#!/bin/sh\nexec sleep 2\n");
  await chmod(bin, 0o755);
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([
      new OpenCodeEngineAdapter({
        cwd: directory,
        runner: new OpenCodeCliRunner(bin, { killGraceMs: 20 }),
        modelRegistry: testOpenCodeModelRegistry
      })
    ]),
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder({
    recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
  } as unknown as RunRecordWriter);

  try {
    assert.equal(await runtime.agent("outlast the deadline", {
      engine: "opencode",
      model: "glm-5.2",
      timeoutMs: 50,
      maxAttempts: 1
    }), null);
    const record = records.at(-1);
    assert.equal(record?.status, "timed-out");
    assert.equal(record.terminationCause?.kind, "turn-timeout");
    assert.match(record.terminationCause.message, /50ms/);
    assert.equal(record.attempts[0]?.failure?.kind, "TurnTimeoutError");
    assert.match(record.attempts[0]?.failure?.message ?? "", /50ms/);
    assert.deepEqual(record.attempts[0]?.workerExit, { exitCode: null, signal: "SIGTERM" });
    assert.deepEqual(record.attempts[0]?.classification, { class: "unclassified", rule: "opencode.deadline" });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an opencode deadline keeps the spend and transcript the stream had already shown", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-deadline-usage-"));
  const bin = path.join(directory, "opencode");
  const records: RuntimeAgentRecord[] = [];
  const stream = [
    JSON.stringify({ type: "session.created", sessionID: "ses_deadline_usage" }),
    JSON.stringify({
      type: "step_finish",
      sessionID: "ses_deadline_usage",
      part: { type: "step-finish", tokens: { input: 5, output: 3, reasoning: 2, cache: { read: 0, write: 0 } } }
    })
  ];
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' '${stream[0]}' '${stream[1]}'\nexec sleep 2\n`);
  await chmod(bin, 0o755);
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([
      new OpenCodeEngineAdapter({
        cwd: directory,
        runner: new OpenCodeCliRunner(bin, { killGraceMs: 20 }),
        modelRegistry: testOpenCodeModelRegistry
      })
    ]),
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder({
    recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
  } as unknown as RunRecordWriter);

  try {
    assert.equal(await runtime.agent("spend, then outlast the deadline", {
      engine: "opencode",
      model: "glm-5.2",
      timeoutMs: 500,
      maxAttempts: 1
    }), null);
    const attempt = records.at(-1)?.attempts[0];
    assert.equal(attempt?.failure?.kind, "TurnTimeoutError");
    assert.equal(attempt.tokenUsageEvents.length, 1);
    assert.equal(attempt.tokenUsageEvents[0]?.last.totalTokens, 10);
    assert.equal(attempt.transcripts.length, 1);
    assert.match(attempt.transcripts[0]?.content ?? "", /ses_deadline_usage/);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an opencode run failure consumes an attempt and the retry redispatches with the failure", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-retry-cwd-"));
  // First dispatch dies operationally; the second succeeds. The documented
  // retry contract: the failure spends one of the bounded attempts, and the
  // fresh dispatch carries the failure folded into its prompt.
  const runner = new FakeOpenCodeRunner({
    runResults: [{ exitCode: 7, stderr: "provider fell over" }]
  });
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ cwd, runner, modelRegistry: testOpenCodeModelRegistry })]),
    defaultMaxAttempts: 2
  });
  const records: RuntimeAgentRecord[] = [];
  runtime.setRunRecorder({
    recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
  } as unknown as RunRecordWriter);

  try {
    const result = await runtime.agent("recover on the second dispatch", { engine: "opencode", model: "glm-5.2" });
    assert.equal(result, "final answer");
    assert.equal(runner.runs.length, 2);
    assert.match(runner.runs[1]?.prompt ?? "", /A previous attempt failed \(opencode-run-error\): opencode run failed: provider fell over/);
    const settledRecord = records.at(-1);
    assert.equal(settledRecord?.attempts.length, 2);
    assert.equal(settledRecord?.attempts[0]?.failure?.kind, "opencode-run-error");
    assert.deepEqual(settledRecord?.attempts[0]?.workerExit, { exitCode: 7, signal: null });
    assert.equal(settledRecord?.attempts[1]?.status, "complete");
  } finally {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
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
      modelRegistry: testOpenCodeModelRegistry,
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

test("opencode requires a registered model before spawning", () => {
  const runner = new FakeOpenCodeRunner();
  const adapter = new OpenCodeEngineAdapter({ runner, modelRegistry: testOpenCodeModelRegistry });

  assert.throws(
    () => adapter.createInvocation("missing", { timeoutMs: 1_000 }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeModelRequiredError);
      assert.match(error.message, /expected one of "glm-5\.2", "local-model"$/);
      return true;
    }
  );
  assert.throws(
    () => adapter.createInvocation("unknown", { timeoutMs: 1_000, model: "glm-later" }),
    OpenCodeModelNotRegisteredError
  );
  assert.equal(runner.runs.length, 0);
});

test("a created runtime dispatches opencode against the models it was given", async () => {
  const declared = await EnsembleRuntime.create({ cwd: tmpdir(), openCodeModels: testOpenCodeModels });
  const undeclared = await EnsembleRuntime.create({ cwd: tmpdir() });
  try {
    assert.deepEqual(declared.openCodeModelRegistry?.names(), ["glm-5.2", "local-model"]);
    assert.deepEqual(undeclared.openCodeModelRegistry?.names(), []);
  } finally {
    await declared.close();
    await undeclared.close();
  }
});

test("an opencode adapter with no declared models names where to declare them", () => {
  // The harness ships no catalogue: an unconfigured machine's refusal must
  // point the operator at the config section, not list an empty set.
  const runner = new FakeOpenCodeRunner();
  const adapter = new OpenCodeEngineAdapter({ runner });

  for (const [options, ErrorClass] of [
    [{}, OpenCodeModelRequiredError],
    [{ model: "glm-5.2" }, OpenCodeModelNotRegisteredError]
  ] as const) {
    assert.throws(
      () => adapter.createInvocation("unconfigured", options),
      (error: unknown) => {
        assert.ok(error instanceof ErrorClass);
        assert.match(error.message, /no opencode models are declared; declare them under opencode_models in the machine configuration/);
        return true;
      }
    );
  }
  assert.equal(runner.runs.length, 0);
});

test("opencode rejects an effort outside the registry entry's declared variants before spawning", () => {
  const runner = new FakeOpenCodeRunner();
  const adapter = new OpenCodeEngineAdapter({ runner, modelRegistry: testOpenCodeModelRegistry });

  // The test catalogue's entries declare no served variants, so any
  // effort request is out of domain and must be rejected, not forwarded
  // silently to a provider that would run the worker at exit 0.
  assert.throws(
    () => adapter.createInvocation("variant", { model: "glm-5.2", effort: "definitely-invalid" }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidAgentOptionValueError);
      assert.match(error.message, /declares no served variants/);
      return true;
    }
  );
  assert.equal(runner.runs.length, 0);

  // An entry that does declare variants accepts exactly those.
  const registry = {
    get: (model: string) =>
      model === "variant-model"
        ? {
            key: "variant-model",
            providerModel: "prov/variant-model",
            displayName: "Variant Model",
            provider: "prov",
            family: "variant",
            capabilities: { vision: false },
            billing: { mode: "pay-as-you-go" as const },
            variants: ["fast", "thorough"]
          }
        : undefined,
    names: () => ["variant-model"]
  };
  const variantAdapter = new OpenCodeEngineAdapter({ runner, modelRegistry: registry });
  assert.doesNotThrow(() => variantAdapter.createInvocation("ok", { model: "variant-model", effort: "thorough" }));
  assert.throws(
    () => variantAdapter.createInvocation("bad", { model: "variant-model", effort: "leisurely" }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidAgentOptionValueError);
      assert.match(error.message, /fast \| thorough/);
      return true;
    }
  );
  assert.equal(runner.runs.length, 0);
});

test("a statically declared opencode effort outside the model's variants fails before the body runs", () => {
  // Judged only when the declaration names the model whose registry
  // entry owns the domain; an effort defaulted without a model waits for
  // the call that names one.
  assert.throws(
    () => validateEngineDefaults("opencode", { model: "glm-5.2", effort: "definitely-invalid" }, testOpenCodeModelRegistry),
    InvalidAgentOptionValueError
  );
  assert.doesNotThrow(() =>
    validateEngineDefaults("opencode", { effort: "unjudgeable-without-a-model" }, testOpenCodeModelRegistry)
  );
});

test("opencode refuses unproven capability strips before the runner starts", async () => {
  // Measured opencode 1.18.4 accepts OPENCODE_CONFIG_CONTENT as a merge
  // overlay, including these deny keys. Config resolution is not a worker
  // proof, however: until a live worker demonstrates that each deny takes
  // effect, the adapter must reject both capability names before its runner
  // sees a process rather than silently dispatching an unrestricted worker.
  for (const capability of ["skills", "agents"] as const) {
    const runner = new FakeOpenCodeRunner();
    const runtime = new EnsembleRuntime({
      engines: new EngineRegistry([new OpenCodeEngineAdapter({ runner, modelRegistry: testOpenCodeModelRegistry })]),
      defaultMaxAttempts: 1
    });
    try {
      await assert.rejects(
        () => runtime.agent("must not start", { engine: "opencode", model: "glm-5.2", strip: [capability] }),
        (error: unknown) => {
          assert.ok(error instanceof CapabilityStripUnsupportedError);
          assert.match(error.message, new RegExp(`cannot strip the "${capability}" capability`));
          assert.match(error.message, /OPENCODE_CONFIG_CONTENT/);
          assert.match(error.message, /worker-boundary enforcement is unproven/);
          return true;
        }
      );
      assert.equal(runner.runs.length, 0);
    } finally {
      await runtime.close();
    }
  }
});

test("opencode run parses final text, usage, transcript, and effort variant", async () => {
  const runner = new FakeOpenCodeRunner();
  const events: string[] = [];
  // The variant must be one the registry entry declares (the registry owns
  // the domain); the curated entries declare none, so this test injects an
  // entry that does.
  const registry = {
    get: (model: string) =>
      model === "glm-5.2"
        ? {
            key: "glm-5.2",
            providerModel: "openrouter/z-ai/glm-5.2",
            displayName: "GLM 5.2",
            provider: "openrouter",
            family: "glm",
            capabilities: { vision: false },
            billing: { mode: "pay-as-you-go" as const },
            variants: ["minimal"]
          }
        : undefined,
    names: () => ["glm-5.2"]
  };
  const adapter = new OpenCodeEngineAdapter({
    runner,
    modelRegistry: registry,
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

test("opencode publishes streamed usage while its worker is still running", async () => {
  let releaseRunner: () => void;
  const runnerHeld = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  let liveChunksDelivered: () => void;
  const liveChunksDeliveredPromise = new Promise<void>((resolve) => {
    liveChunksDelivered = resolve;
  });
  const stream = [
    JSON.stringify({ type: "session.created", sessionID: "ses_live_usage" }),
    JSON.stringify({
      type: "step_finish",
      sessionID: "ses_live_usage",
      part: {
        type: "step-finish",
        tokens: { input: 5, output: 3, reasoning: 2, cache: { read: 0, write: 0 } }
      }
    })
  ].join("\n");
  const runner = new FakeOpenCodeRunner({
    runResult: { stdout: `${stream}\n` },
    onDataChunks: [`${stream}\n`],
    beforeResolve: async () => {
      liveChunksDelivered();
      await runnerHeld;
    }
  });
  let runtime: EnsembleRuntime | null = null;
  const adapter = new OpenCodeEngineAdapter({
    modelRegistry: testOpenCodeModelRegistry,
    runner,
    onEvent: (event) => runtime?.handleEngineEvent("opencode", event)
  });
  runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    defaultMaxAttempts: 1
  });
  let settled = false;
  const result = runtime.agent("report live usage", { engine: "opencode", model: "glm-5.2" }).then((value) => {
    settled = true;
    return value;
  });

  try {
    await liveChunksDeliveredPromise;
    const snapshot = runtime.progress.snapshot();
    assert.equal(settled, false);
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.engines.opencode?.active, 1);
    assert.equal(snapshot.engines.opencode?.done, 0);
    assert.equal(snapshot.engines.opencode?.spent, 10);
  } finally {
    releaseRunner!();
    await result;
    await runtime.close();
  }
});

test("a per-call cwd reaches opencode run and overrides the adapter cwd", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-per-call-cwd-"));
  const runner = new FakeOpenCodeRunner();
  const adapter = new OpenCodeEngineAdapter({ cwd: "/adapter/cwd", runner, modelRegistry: testOpenCodeModelRegistry });
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    defaultMaxAttempts: 1
  });

  try {
    await runtime.agent("read", {
      engine: "opencode",
      model: "glm-5.2",
      cwd: directory
    });
    assert.equal(runner.runs[0]?.cwd, directory);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
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
    modelRegistry: testOpenCodeModelRegistry,
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

  assert.ok(result !== null, "the fallback route must answer");
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
    modelRegistry: testOpenCodeModelRegistry,
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
    modelRegistry: testOpenCodeModelRegistry,
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
    modelRegistry: testOpenCodeModelRegistry,
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

test("opencode cache writes survive the engine path as a separate archive roll-up line", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-cache-write-cwd-"));
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-cache-write-store-"));
  const cache = { read: 13, write: 5 };
  const runner = new FakeOpenCodeRunner({
    exportText: `Exporting session: ses_test\n${JSON.stringify({
      info: {
        id: "ses_test",
        model: { id: "glm-5.2", providerID: "openrouter", variant: "default" },
        cost: 0.001,
        tokens: { input: 7, output: 3, reasoning: 2, cache }
      },
      messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "cached answer" }] }]
    })}\n`
  });
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ cwd, runner, modelRegistry: testOpenCodeModelRegistry })]),
    defaultMaxAttempts: 1
  });
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-opencode-cache-write",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'opencode-cache-write' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  runtime.setRunRecorder(writer);

  try {
    assert.equal(await runtime.agent("return cached answer", { engine: "opencode", model: "glm-5.2" }), "cached answer");
    await writer.finish({ status: "complete", exitCode: 0, result: true });

    // A separate reader sees the durable archive, not the in-process writer.
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { readFile } from "node:fs/promises";
      import path from "node:path";
      const manifest = JSON.parse(await readFile(path.join(process.argv[1], "manifest.json"), "utf8"));
      // Keyed by the served provider model, not the registry key that was requested.
      const tokens = manifest.cost_rollup.opencode["openrouter/z-ai/glm-5.2"].tokens;
      assert.equal(tokens.cachedInputTokens, 18);
      assert.equal(tokens.cacheReadTokens, 13);
      assert.equal(tokens.cacheCreationTokens, 5);
      assert.equal(tokens.totalTokens, 30);
    `, writer.archiveDir]);
  } finally {
    await runtime.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
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
    modelRegistry: testOpenCodeModelRegistry,
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
    modelRegistry: testOpenCodeModelRegistry,
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
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ cwd, runner, modelRegistry: testOpenCodeModelRegistry })]),
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

  assert.ok(result !== null, "the export route must answer");
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
  const invocation = new OpenCodeEngineAdapter({ runner, modelRegistry: testOpenCodeModelRegistry }).createInvocation("answer", {
    model: "glm-5.2"
  });

  const result = await invocation.runAttempt({ attempt: 1 });

  assert.equal(result.text, "answer without a session id");
  assert.deepEqual(result.diagnostics, {
    opencode: { session_export: { status: "no-session-id" } }
  });
  assert.deepEqual(runner.exports, []);
});

test("a token-bearing stream with no session id still reaches the budget under a synthetic identity", async () => {
  let runtime: EnsembleRuntime | null = null;
  const runner = new FakeOpenCodeRunner({
    runResult: {
      stdout: [
        JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
        JSON.stringify({ type: "text", part: { type: "text", text: "measured answer" } }),
        JSON.stringify({
          type: "step_finish",
          part: {
            type: "step-finish",
            reason: "stop",
            tokens: { input: 100, output: 40, reasoning: 0, cache: { read: 10, write: 0 } }
          }
        })
      ].join("\n")
    }
  });
  const adapter = new OpenCodeEngineAdapter({
    modelRegistry: testOpenCodeModelRegistry,
    runner,
    onEvent: (event) => runtime?.handleEngineEvent("opencode", event)
  });
  runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    defaultMaxAttempts: 1
  });

  assert.equal(await runtime.agent("measure me", { engine: "opencode", model: "glm-5.2" }), "measured answer");

  // Measured spend reaches the ledger despite the missing id…
  assert.equal(runtime.budget.spent("opencode"), 150);
  assert.equal(runtime.budget.events.length, 1);
  // …under an identity a consumer can never mistake for a real session id,
  // while the missing-id diagnostic still tells the truth about the stream.
  const event = runtime.budget.events[0]?.event;
  assert.match(event?.threadId ?? "", /^opencode-no-session-/);
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
  const invocation = new OpenCodeEngineAdapter({ runner, modelRegistry: testOpenCodeModelRegistry }).createInvocation("answer", {
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
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ runner, modelRegistry: testOpenCodeModelRegistry })]),
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
  const invocation = new OpenCodeEngineAdapter({ runner, modelRegistry: testOpenCodeModelRegistry }).createInvocation("answer", {
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
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ cwd, runner, modelRegistry: testOpenCodeModelRegistry })]),
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

  assert.equal(await runtime.agent("return text", { engine: "opencode", model: "glm-5.2" }), null);

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
  const invocation = new OpenCodeEngineAdapter({ runner, modelRegistry: testOpenCodeModelRegistry }).createInvocation("answer", {
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
    modelRegistry: testOpenCodeModelRegistry,
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
    model: "local-model",
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
  assert.equal(agent.model, "local-model");
  assert.equal(agent.resolved_model, "local/Served-Model");
});

test("opencode reaches the shared schema validation and budget path", async () => {
  let runtime: EnsembleRuntime | null = null;
  const runner = new FakeOpenCodeRunner({
    exportText: exportText(JSON.stringify({ status: "ok" }), tokens(4, 3, 0))
  });
  const adapter = new OpenCodeEngineAdapter({
    modelRegistry: testOpenCodeModelRegistry,
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

test("opencode run escalates to SIGKILL when a terminated worker ignores SIGTERM", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-stubborn-"));
  const bin = path.join(directory, "opencode");
  const ready = path.join(directory, "handler-installed");
  // The fixture announces when its SIGTERM handler exists, and termination
  // waits for that announcement (abort signal, not a wall-clock deadline) —
  // under host contention a fixed timeout could deliver SIGTERM before the
  // handler was installed, killing the child with the very signal the test
  // needs it to ignore. The TERM-then-KILL grace period is the mechanism
  // under test and remains a real timer; only the racy trigger is replaced.
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

  const runner = new OpenCodeCliRunner(bin, { killGraceMs: 50 });
  const abort = new AbortController();
  const running = runner.run({
    prompt: "hang forever",
    cwd: directory,
    providerModel: "openrouter/z-ai/glm-5.2",
    signal: abort.signal
  });
  // Race the readiness wait against the child settling: a fixture that dies
  // before announcing (spawn failure, script error) fails the test with the
  // child's own result instead of leaving waitForFile looping forever.
  const readiness = await Promise.race([
    waitForFile(ready).then(() => "ready" as const),
    running.then(
      (early) => `child settled before readiness: ${JSON.stringify(early)}`,
      (error) => `child failed before readiness: ${String(error)}`
    )
  ]);
  assert.equal(readiness, "ready");
  abort.abort();
  const result = await running;

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

test("opencode forwards liveness evidence, fired by the real runner's first stdout chunk", async () => {
  // Forwarding half: the invocation hands the agent-level callback through as
  // the run's onFirstData.
  const runner = new FakeOpenCodeRunner();
  const adapter = new OpenCodeEngineAdapter({ runner, modelRegistry: testOpenCodeModelRegistry });
  const invocation = adapter.createInvocation("say", { timeoutMs: 1_000, model: "glm-5.2" });
  let evidence = 0;
  await invocation.runAttempt({
    attempt: 1,
    onLiveEvidence: () => {
      evidence += 1;
    }
  });
  runner.runs[0]?.onFirstData?.();
  assert.equal(evidence, 1);

  // Firing half: the CLI runner reports the first stdout chunk exactly once.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-first-data-"));
  try {
    const stub = path.join(dir, "opencode-stub.mjs");
    await writeFile(
      stub,
      `#!/usr/bin/env node\nprocess.stdout.write("one\\n");\nsetTimeout(() => { process.stdout.write("two\\n"); }, 20);\n`
    );
    await chmod(stub, 0o755);
    let fires = 0;
    const cliRunner = new OpenCodeCliRunner(stub);
    const result = await cliRunner.run({
      prompt: "p",
      cwd: dir,
      providerModel: "m",
      timeoutMs: 5_000,
      onFirstData: () => {
        fires += 1;
      }
    });
    assert.equal(result.exitCode, 0);
    assert.equal(fires, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
