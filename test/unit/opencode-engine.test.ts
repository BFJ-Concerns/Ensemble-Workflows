import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { OpenCodeCliRunner } from "../../src/opencode-engine.js";

import { EngineRegistry, OpenCodeEngineAdapter } from "../../src/engines.js";
import {
  EmptyAgentOutputError,
  FallbackModelUnsupportedError,
  OpenCodeModelNotRegisteredError,
  OpenCodeModelRequiredError,
  OpenCodeNetworkUnsupportedError,
  OpenCodeSandboxUnsupportedError,
  OpenCodeWebSearchUnsupportedError,
  OpenCodeWorktreeIsolationUnsupportedError
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

test("opencode requires a registered curated model before spawning", () => {
  const runner = new FakeOpenCodeRunner();
  const adapter = new OpenCodeEngineAdapter({ runner });

  assert.throws(
    () => adapter.createInvocation("missing", { webSearch: false, timeoutMs: 1_000 }),
    (error: unknown) => {
      assert.ok(error instanceof OpenCodeModelRequiredError);
      assert.match(error.message, /"glm-5\.2"/);
      assert.match(error.message, /"qwen-3-6-27b-standard"/);
      return true;
    }
  );
  assert.throws(
    () => adapter.createInvocation("unknown", { webSearch: false, timeoutMs: 1_000, model: "glm-later" }),
    OpenCodeModelNotRegisteredError
  );
  assert.equal(runner.runs.length, 0);
});

test("opencode unsupported options fail before spawning", () => {
  const runner = new FakeOpenCodeRunner();
  const adapter = new OpenCodeEngineAdapter({ runner });

  assert.throws(
    () =>
      adapter.createInvocation("isolated", {
        webSearch: false,
        timeoutMs: 1_000,
        model: "glm-5.2",
        isolation: "worktree"
      }),
    OpenCodeWorktreeIsolationUnsupportedError
  );
  assert.throws(
    () => adapter.createInvocation("search", { webSearch: true, timeoutMs: 1_000, model: "glm-5.2" }),
    OpenCodeWebSearchUnsupportedError
  );
  assert.throws(
    () =>
      adapter.createInvocation("sandbox", {
        webSearch: false,
        timeoutMs: 1_000,
        model: "glm-5.2",
        sandbox: "read-only"
      }),
    OpenCodeSandboxUnsupportedError
  );
  assert.throws(
    () =>
      adapter.createInvocation("offline", {
        webSearch: false,
        timeoutMs: 1_000,
        model: "glm-5.2",
        network: false
      }),
    OpenCodeNetworkUnsupportedError
  );
  assert.throws(
    () =>
      adapter.createInvocation("fallback", {
        webSearch: false,
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
    webSearch: false,
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

test("opencode export fallback recovers the complete final stopped step into the result and run record", async () => {
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
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ cwd, runner })]),
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
    webSearch: false,
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
    webSearch: false,
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
    webSearch: false,
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
    webSearch: false,
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
    budgetCeilings: { opencode: 20 },
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
