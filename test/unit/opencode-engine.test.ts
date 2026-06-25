import assert from "node:assert/strict";
import test from "node:test";

import { EngineRegistry, OpenCodeEngineAdapter } from "../../src/engines.js";
import {
  OpenCodeModelNotRegisteredError,
  OpenCodeModelRequiredError,
  OpenCodeSandboxUnsupportedError,
  OpenCodeWebSearchUnsupportedError,
  OpenCodeWorktreeIsolationUnsupportedError
} from "../../src/errors.js";
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

  assert.throws(() => adapter.createInvocation("missing", { webSearch: false, timeoutMs: 1_000 }), OpenCodeModelRequiredError);
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
  assert.equal(result.durationMs, 12);
  assert.equal(runner.runs[0]?.providerModel, "openrouter/z-ai/glm-5.2");
  assert.equal(runner.runs[0]?.variant, "minimal");
  assert.equal(runner.exports[0], "ses_test");
  assert.equal(result.tokenUsageEvents[0]?.last.totalTokens, 6);
  assert.deepEqual(events, ["thread/tokenUsage/updated"]);
  assert.equal(result.transcripts?.[0]?.filename, "transcript.opencode.jsonl");
  assert.match(result.transcripts?.[0]?.content ?? "", /session\/export/);
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
