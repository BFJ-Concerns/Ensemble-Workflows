import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { OpenCodeCliRunner } from "../../src/opencode-engine.js";

import { EngineRegistry, OpenCodeEngineAdapter } from "../../src/engines.js";
import {
  FallbackModelUnsupportedError,
  OpenCodeModelNotRegisteredError,
  OpenCodeModelRequiredError,
  OpenCodeSandboxUnsupportedError,
  OpenCodeWebSearchUnsupportedError,
  OpenCodeWorktreeIsolationUnsupportedError
} from "../../src/errors.js";
import { RunRecordWriter } from "../../src/run-record.js";
import { EnsembleRuntime } from "../../src/runtime.js";

import type { OpenCodeRunOptions, OpenCodeRunResult, OpenCodeRunner } from "../../src/opencode-engine.js";

class FakeOpenCodeRunner implements OpenCodeRunner {
  runs: OpenCodeRunOptions[] = [];
  exports: string[] = [];

  #runResult: OpenCodeRunResult;
  #exportText: string | null;

  constructor(options: { runResult?: Partial<OpenCodeRunResult>; exportText?: string | null } = {}) {
    this.#runResult = {
      exitCode: 0,
      signal: null,
      stdout: `${JSON.stringify({ type: "session.created", sessionID: "ses_test" })}\n`,
      stderr: "",
      durationMs: 12,
      ...options.runResult
    };
    this.#exportText = options.exportText ?? exportText("final answer", tokens(3, 2, 1));
  }

  async run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    this.runs.push(options);
    return this.#runResult;
  }

  async exportSession(sessionId: string): Promise<string | null> {
    this.exports.push(sessionId);
    return this.#exportText;
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
