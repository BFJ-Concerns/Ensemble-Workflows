import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runCodexWorkflowCli } from "../../src/cli.js";
import { CodexRuntime } from "../../src/runtime.js";

import type {
  JsonObject,
  RuntimeEvent,
  RuntimeTransport,
  ThreadStartOptions,
  TokenUsageBreakdown,
  TurnResult,
  TurnStartOptions
} from "../../src/types.js";

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

interface ScriptedTurn {
  text?: string;
  delayMs?: number;
  tokenDelta?: number;
  throwError?: Error;
}

class ScriptedTransport implements RuntimeTransport {
  readonly openedThreads: ThreadStartOptions[] = [];
  readonly turns: Array<{ threadId: string; prompt: string; options: TurnStartOptions; startedAt: number }> = [];

  #responses: ScriptedTurn[];
  #eventSink: ((event: RuntimeEvent) => void) | null = null;
  #nextThread = 0;
  #nextTurn = 0;

  constructor(responses: ScriptedTurn[]) {
    this.#responses = [...responses];
  }

  setEventSink(eventSink: (event: RuntimeEvent) => void): void {
    this.#eventSink = eventSink;
  }

  async openThread(options: ThreadStartOptions): Promise<string> {
    this.openedThreads.push(options);
    this.#nextThread += 1;
    return `thread-${this.#nextThread}`;
  }

  async runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult> {
    this.turns.push({ threadId, prompt, options, startedAt: Date.now() });
    this.#nextTurn += 1;
    const turnId = `turn-${this.#nextTurn}`;
    this.#emit("turn/started", { threadId, turnId });

    const response = this.#responses.shift();
    assert.ok(response, `no scripted response configured for ${prompt}`);

    if (response.delayMs !== undefined) {
      await sleep(response.delayMs);
    }

    if (response.tokenDelta !== undefined) {
      this.#emit("thread/tokenUsage/updated", {
        threadId,
        turnId,
        tokenUsage: {
          last: usage(response.tokenDelta),
          total: usage(response.tokenDelta)
        }
      });
    }

    if (response.throwError !== undefined) {
      throw response.throwError;
    }

    const text = response.text ?? "";
    this.#emit("item/agentMessage/delta", { threadId, turnId, delta: text });
    this.#emit("item/completed", { threadId, turnId, item: { type: "agentMessage", text } });
    this.#emit("turn/completed", { threadId, turnId });

    return {
      text,
      deltaText: text,
      durationMs: response.delayMs ?? 0,
      firstDeltaMs: response.delayMs ?? 0,
      items: { agentMessage: 1 },
      tokenUsageEvents: []
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  #emit(method: string, params: JsonObject): void {
    this.#eventSink?.({ method, params, receivedAt: Date.now() });
  }
}

test("CLI workflow fans out, compiles, logs to stderr, and emits result JSON on stdout", async () => {
  const { exitCode, stdout, stderr, transport } = await runScript(
    `
      export const meta = { name: "fanout-compile" };

      const findingSchema = {
        type: "object",
        required: ["topic", "confidence"],
        additionalProperties: false,
        properties: {
          topic: { type: "string", enum: ["alpha", "beta", "gamma"] },
          confidence: { type: "number" }
        }
      };

      phase("collect");
      const findings = await parallel([
        () => agent("search alpha", {
          webSearch: true,
          schema: findingSchema
        }),
        () => agent("search beta", {
          webSearch: true,
          schema: findingSchema
        }),
        () => agent("search gamma", {
          webSearch: true,
          schema: findingSchema
        })
      ]);

      phase("compile");
      const compiled = await agent("compile " + JSON.stringify(findings), {
        schema: {
          type: "object",
          required: ["count", "summary"],
          additionalProperties: false,
          properties: {
            count: { type: "integer" },
            summary: { type: "string" }
          }
        }
      });

      return { args, findings: findings.filter(Boolean), compiled };
    `,
    [
      { text: "{\"topic\":\"alpha\",\"confidence\":0.9}", delayMs: 30, tokenDelta: 4 },
      { text: "{\"topic\":\"beta\",\"confidence\":0.8}", delayMs: 20, tokenDelta: 5 },
      { text: "{\"topic\":\"gamma\",\"confidence\":0.7}", delayMs: 10, tokenDelta: 6 },
      { text: "{\"count\":3,\"summary\":\"compiled alpha beta gamma\"}", tokenDelta: 7 }
    ],
    ["one", "two"]
  );

  assert.equal(exitCode, 0, stderr);
  assert.equal(stderr, "[phase] collect\n[phase] compile\n");
  const result = JSON.parse(stdout) as {
    args: string[];
    findings: Array<{ topic: string; confidence: number }>;
    compiled: { count: number; summary: string };
  };
  assert.deepEqual(result.args, ["one", "two"]);
  assert.deepEqual(result.findings.map((finding) => finding.topic).sort(), ["alpha", "beta", "gamma"]);
  assert.equal(result.compiled.count, 3);
  assert.match(result.compiled.summary, /alpha beta gamma/);
  assert.equal(transport.openedThreads.filter((thread) => thread.webSearch).length, 3);
});

test("pipeline workflow interleaves items and drops only the failing item", async () => {
  const { exitCode, stdout, stderr } = await runScript(
    `
      export const meta = { name: "pipeline-interleaving" };

      const events = [];
      let releaseSlow;
      const slowGate = new Promise((resolve) => {
        releaseSlow = resolve;
      });

      const results = await pipeline(["slow", "fast", "bad"], async (_previous, item) => {
        events.push("stage0-start-" + item);
        if (item === "slow") {
          await slowGate;
        }
        if (item === "bad") {
          throw new Error("bad item");
        }
        events.push("stage0-end-" + item);
        return await agent("stage0 " + item);
      }, async (previous, item) => {
        events.push("stage1-start-" + item);
        if (item === "fast") {
          releaseSlow();
        }
        return await agent("stage1 " + item + " " + previous);
      });

      return { events, results };
    `,
    [
      { text: "fast-stage0", delayMs: 10 },
      { text: "fast-stage1", delayMs: 10 },
      { text: "slow-stage0", delayMs: 10 },
      { text: "slow-stage1", delayMs: 10 }
    ]
  );

  assert.equal(exitCode, 0, stderr);
  assert.match(stderr, /pipeline item 2 stage 0 failed: Error: bad item/);
  const result = JSON.parse(stdout) as { events: string[]; results: Array<string | null> };
  assert.deepEqual(result.results, ["slow-stage1", "fast-stage1", null]);
  assert.ok(result.events.indexOf("stage1-start-fast") < result.events.indexOf("stage0-end-slow"));
  assert.ok(!result.events.includes("stage1-start-bad"));
});

test("schema retries, per-thunk failure, and budget ceiling survive a whole workflow", async () => {
  const { exitCode, stdout, stderr, transport } = await runScript(
    `
      export const meta = { name: "retry-budget" };

      const schema = {
        type: "object",
        required: ["status", "details"],
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["ok"] },
          details: {
            type: "object",
            required: ["count"],
            additionalProperties: false,
            properties: {
              count: { type: "integer" }
            }
          }
        }
      };

      const validAfterRetry = await agent("retry until valid", { schema, maxAttempts: 2 });
      const impossible = await agent("never satisfies schema", { schema, maxAttempts: 2 });
      const fanout = await parallel([
        () => agent("plain success"),
        () => agent("worker throws")
      ]);
      const spentBeforeBlockedCall = budget.spent();
      let blockedMessage = null;
      try {
        await agent("should be blocked by budget");
      } catch (error) {
        blockedMessage = error.message;
      }

      return {
        validAfterRetry,
        impossible,
        fanout,
        spentBeforeBlockedCall,
        remaining: budget.remaining(),
        blockedMessage
      };
    `,
    [
      { text: "not json", tokenDelta: 2 },
      { text: "{\"status\":\"ok\",\"details\":{\"count\":4}}", tokenDelta: 3 },
      { text: "{\"status\":\"wrong\",\"details\":{\"count\":1}}", tokenDelta: 4 },
      { text: "{\"status\":\"still-wrong\",\"details\":{\"count\":2}}", tokenDelta: 5 },
      { text: "plain", tokenDelta: 6 },
      { throwError: new Error("transport failure"), tokenDelta: 7 }
    ],
    [],
    { budgetTotal: 20 }
  );

  assert.equal(exitCode, 0, stderr);
  assert.match(stderr, /parallel thunk 1 failed: Error: transport failure/);
  const result = JSON.parse(stdout) as {
    validAfterRetry: { status: string; details: { count: number } };
    impossible: null;
    fanout: Array<string | null>;
    spentBeforeBlockedCall: number;
    remaining: number;
    blockedMessage: string | null;
  };
  assert.deepEqual(result.validAfterRetry, { status: "ok", details: { count: 4 } });
  assert.equal(result.impossible, null);
  assert.deepEqual(result.fanout, ["plain", null]);
  assert.equal(result.spentBeforeBlockedCall, 27);
  assert.equal(result.remaining, 0);
  assert.match(result.blockedMessage ?? "", /Token budget exhausted: spent 27 of 20 tokens/);
  assert.equal(transport.turns.length, 6);
});

test("CLI workflow returns non-zero, stderr error, and no stdout when the script throws", async () => {
  const { exitCode, stdout, stderr } = await runScript(
    `
      export const meta = { name: "throws" };
      log("before throw");
      throw new Error("script exploded");
    `,
    []
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /before throw/);
  assert.match(stderr, /Error: script exploded/);
});

async function runScript(
  source: string,
  responses: ScriptedTurn[],
  args: string[] = [],
  runtimeOptions: { budgetTotal?: number } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; transport: ScriptedTransport }> {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-workflow-integration-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(script, source);

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const transport = new ScriptedTransport(responses);
  const runtime = new CodexRuntime({
    transport,
    concurrency: 8,
    budgetTotal: runtimeOptions.budgetTotal ?? null,
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 3
  });
  transport.setEventSink((event) => runtime.handleTransportEvent(event));

  const exitCode = await runCodexWorkflowCli([script, ...args], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => runtime
  });

  return { exitCode, stdout: stdout.text(), stderr: stderr.text(), transport };
}

function usage(totalTokens: number): TokenUsageBreakdown {
  return {
    cachedInputTokens: 0,
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
