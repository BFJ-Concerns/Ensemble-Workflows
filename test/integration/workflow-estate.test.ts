import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import { runEnsembleCli } from "../../src/cli.js";
import { hermeticEstateEnvironment } from "./estate-process.js";
import { ClaudeEngineAdapter, EngineRegistry } from "../../src/engines.js";
import { CodexSchemaSubsetUnsupportedError } from "../../src/errors.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { Scheduler } from "../../src/scheduler.js";

import type { EngineAdapter, EngineAttemptContext, EngineInvocation, EngineTurnOptions } from "../../src/engines.js";
import type {
  EngineName,
  JsonObject,
  RuntimeOptions,
  RuntimeEvent,
  RuntimeTransport,
  ThreadStartOptions,
  TokenUsageBreakdown,
  TurnResult,
  TurnStartOptions
} from "../../src/types.js";

const execFileAsync = promisify(execFile);

function withoutSentinelAnnouncement(stderr: string): string {
  const announcement = /^\[sentinel\] will write \S+\/completion-sentinel\.json when the run ends\n/gm;
  const matches = stderr.match(announcement) ?? [];
  assert.equal(matches.length, 1, `expected exactly one completion-sentinel announcement, got:\n${stderr}`);
  const withoutSentinel = stderr.replace(announcement, "");
  const runRecordAnnouncement = /^\[run-record-archive\] .+\n/gm;
  const runRecordMatches = withoutSentinel.match(runRecordAnnouncement) ?? [];
  assert.ok(runRecordMatches.length <= 1, `expected at most one run-record announcement, got:\n${stderr}`);
  return withoutSentinel.replace(runRecordAnnouncement, "");
}

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
  writeFile?: { name: string; contents: string };
}

interface ScriptedEngineTurn {
  text?: string;
  delayMs?: number;
  tokenDelta?: number;
  throwError?: Error;
}

class ScriptedTransport implements RuntimeTransport {
  readonly cwd: string;
  readonly openedThreads: ThreadStartOptions[] = [];
  readonly turns: Array<{ threadId: string; prompt: string; options: TurnStartOptions; startedAt: number }> = [];

  #responses: ScriptedTurn[];
  #eventSink: ((event: RuntimeEvent) => void) | null = null;
  #threadCwds = new Map<string, string>();
  #nextThread = 0;
  #nextTurn = 0;

  constructor(responses: ScriptedTurn[], cwd: string) {
    this.#responses = [...responses];
    this.cwd = cwd;
  }

  setEventSink(eventSink: (event: RuntimeEvent) => void): void {
    this.#eventSink = eventSink;
  }

  async openThread(options: ThreadStartOptions): Promise<string> {
    this.openedThreads.push(options);
    this.#nextThread += 1;
    const threadId = `thread-${this.#nextThread}`;
    this.#threadCwds.set(threadId, options.cwd ?? this.cwd);
    return threadId;
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

    if (response.writeFile !== undefined) {
      const cwd = this.#threadCwds.get(threadId);
      assert.ok(cwd, `no cwd tracked for ${threadId}`);
      await writeFile(path.join(cwd, response.writeFile.name), response.writeFile.contents);
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

class ScriptedEngineAdapter implements EngineAdapter {
  readonly name: EngineName;
  readonly concurrency: number;
  readonly invocations: ScriptedEngineInvocation[] = [];
  readonly scheduleStarts: number[] = [];
  readonly scheduleFinishes: number[] = [];
  maxActive = 0;

  #responses: ScriptedEngineTurn[];
  #scheduler: Scheduler;
  #closed = false;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #active = 0;

  constructor(options: {
    name: EngineName;
    concurrency: number;
    responses: ScriptedEngineTurn[];
    onEvent?: (event: RuntimeEvent) => void;
  }) {
    this.name = options.name;
    this.concurrency = options.concurrency;
    this.#responses = [...options.responses];
    this.#scheduler = new Scheduler(options.concurrency);
    this.#onEvent = options.onEvent;
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(async () => {
      this.scheduleStarts.push(Date.now());
      this.#active += 1;
      this.maxActive = Math.max(this.maxActive, this.#active);
      try {
        return await task();
      } finally {
        this.#active -= 1;
        this.scheduleFinishes.push(Date.now());
      }
    });
  }

  createInvocation(prompt: string, options: EngineTurnOptions): EngineInvocation {
    const invocation = new ScriptedEngineInvocation({
      engine: this.name,
      prompt,
      options,
      nextTurn: () => {
        const response = this.#responses.shift();
        assert.ok(response, `no scripted ${this.name} response configured for ${prompt}`);
        return response;
      },
      ...(this.#onEvent !== undefined ? { onEvent: this.#onEvent } : {})
    });
    this.invocations.push(invocation);
    return invocation;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }
}

class ScriptedEngineInvocation implements EngineInvocation {
  readonly engine: EngineName;
  readonly prompt: string;
  readonly options: EngineTurnOptions;
  readonly contexts: EngineAttemptContext[] = [];

  #nextTurn: () => ScriptedEngineTurn;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #closed = false;

  constructor(options: {
    engine: EngineName;
    prompt: string;
    options: EngineTurnOptions;
    nextTurn: () => ScriptedEngineTurn;
    onEvent?: (event: RuntimeEvent) => void;
  }) {
    this.engine = options.engine;
    this.prompt = options.prompt;
    this.options = options.options;
    this.#nextTurn = options.nextTurn;
    this.#onEvent = options.onEvent;
  }

  async runAttempt(context: EngineAttemptContext): Promise<TurnResult> {
    this.contexts.push(context);
    const response = this.#nextTurn();

    if (response.delayMs !== undefined) {
      await sleep(response.delayMs);
    }

    const threadId = `${this.engine}-thread-${this.contexts.length}`;
    const turnId = `${this.engine}-turn-${this.contexts.length}`;
    if (response.tokenDelta !== undefined) {
      this.#onEvent?.({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            last: usage(response.tokenDelta),
            total: usage(response.tokenDelta)
          }
        },
        receivedAt: Date.now()
      });
    }

    if (response.throwError !== undefined) {
      throw response.throwError;
    }

    const text = response.text ?? "";
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
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
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
          engine: "codex",
          schema: findingSchema
        }),
        () => agent("search beta", {
          engine: "codex",
          schema: findingSchema
        }),
        () => agent("search gamma", {
          engine: "codex",
          schema: findingSchema
        })
      ]);

      phase("compile");
      const compiled = await agent("compile " + JSON.stringify(findings), {
        engine: "codex",
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
  assert.equal(withoutSentinelAnnouncement(stderr), "[phase] collect\n[phase] compile\n");
  const result = JSON.parse(stdout) as {
    args: string[];
    findings: Array<{ topic: string; confidence: number }>;
    compiled: { count: number; summary: string };
  };
  assert.deepEqual(result.args, ["one", "two"]);
  assert.deepEqual(result.findings.map((finding) => finding.topic).sort(), ["alpha", "beta", "gamma"]);
  assert.equal(result.compiled.count, 3);
  assert.match(result.compiled.summary, /alpha beta gamma/);
  assert.equal(transport.openedThreads.length, 4);
});

test("engine routing rejects missing and unknown engines through the real CLI", async () => {
  const { exitCode: missingExitCode, stdout: missingStdout, stderr: missingStderr } = await runScriptWithEngines(
    `
      export const meta = { name: "missing-engine" };
      await agent("missing engine");
    `,
    new ScriptedEngineAdapter({ name: "codex", concurrency: 1, responses: [] }),
    new ScriptedEngineAdapter({ name: "claude", concurrency: 1, responses: [] })
  );

  assert.equal(missingExitCode, 1);
  assert.equal(missingStdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
  assert.match(
    missingStderr,
    /agent\(\) requires an engine field: use engine: 'codex', engine: 'claude', or engine: 'opencode'/
  );

  const { exitCode: unknownExitCode, stdout: unknownStdout, stderr: unknownStderr } = await runScriptWithEngines(
    `
      export const meta = { name: "unknown-engine" };
      await agent("unknown engine", { engine: "gemini" });
    `,
    new ScriptedEngineAdapter({ name: "codex", concurrency: 1, responses: [] }),
    new ScriptedEngineAdapter({ name: "claude", concurrency: 1, responses: [] })
  );

  assert.equal(unknownExitCode, 1);
  assert.equal(unknownStdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
  assert.match(unknownStderr, /Unknown agent engine "gemini"; expected 'codex', 'claude', or 'opencode'/);
});

test("registry routes each engine and keeps per-engine concurrency caps independent", async () => {
  const codex = new ScriptedEngineAdapter({
    name: "codex",
    concurrency: 1,
    responses: [
      { text: "codex-slow", delayMs: 80 },
      { text: "codex-queued", delayMs: 1 }
    ]
  });
  const claude = new ScriptedEngineAdapter({
    name: "claude",
    concurrency: 1,
    responses: [
      { text: "claude-slow", delayMs: 10 },
      { text: "claude-queued", delayMs: 1 }
    ]
  });

  const { exitCode, stdout, stderr } = await runScriptWithEngines(
    `
      export const meta = { name: "independent-engine-caps" };

      const results = await parallel([
        () => agent("codex slow", { engine: "codex" }),
        () => agent("codex queued", { engine: "codex" }),
        () => agent("claude slow", { engine: "claude" }),
        () => agent("claude queued", { engine: "claude" })
      ]);

      return { results };
    `,
    codex,
    claude
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    results: ["codex-slow", "codex-queued", "claude-slow", "claude-queued"]
  });
  assert.equal(codex.invocations.length, 2);
  assert.equal(claude.invocations.length, 2);
  const firstCodexFinish = codex.scheduleFinishes[0];
  const secondCodexStart = codex.scheduleStarts[1];
  const firstClaudeStart = claude.scheduleStarts[0];
  const firstClaudeFinish = claude.scheduleFinishes[0];
  const secondClaudeStart = claude.scheduleStarts[1];
  assert.ok(firstCodexFinish !== undefined);
  assert.ok(secondCodexStart !== undefined);
  assert.ok(firstClaudeStart !== undefined);
  assert.ok(firstClaudeFinish !== undefined);
  assert.ok(secondClaudeStart !== undefined);
  assert.ok(
    firstClaudeStart < firstCodexFinish,
    "Claude should start while Codex's single slot is still saturated"
  );
  assert.ok(firstCodexFinish <= secondCodexStart);
  assert.ok(firstClaudeFinish <= secondClaudeStart);
});

test("scripted Claude schema retries carry previousFailure for in-session correction", async () => {
  const claude = new ScriptedEngineAdapter({
    name: "claude",
    concurrency: 8,
    responses: [
      { text: "transcript without json" },
      { text: "{\"status\":\"draft\",\"confidence\":0.2}" },
      { text: "{\"status\":\"verified\",\"confidence\":0.91}" }
    ]
  });

  const { exitCode, stdout, stderr } = await runScriptWithEngines(
    `
      export const meta = { name: "claude-schema-correction" };

      const verdict = await agent("verify finding", {
        engine: "claude",
        maxAttempts: 3,
        schema: {
          type: "object",
          required: ["status", "confidence"],
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["verified"] },
            confidence: { type: "number" }
          }
        }
      });

      return { verdict };
    `,
    new ScriptedEngineAdapter({ name: "codex", concurrency: 8, responses: [] }),
    claude
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    verdict: { status: "verified", confidence: 0.91 }
  });

  const [invocation] = claude.invocations;
  assert.ok(invocation);
  assert.equal(invocation.closed, true);
  assert.deepEqual(
    invocation.contexts.map((context) => ({
      attempt: context.attempt,
      previousFailure: context.previousFailure?.kind
    })),
    [
      { attempt: 1, previousFailure: undefined },
      { attempt: 2, previousFailure: "invalid-json" },
      { attempt: 3, previousFailure: "schema-validation" }
    ]
  );
  assert.match(invocation.contexts[2]?.previousFailure?.message ?? "", /must be equal to one of the allowed values/);
});

test("scripted Claude schema failures return null after the bounded correction attempts", async () => {
  const claude = new ScriptedEngineAdapter({
    name: "claude",
    concurrency: 8,
    responses: [{ text: "no json here" }, { text: "{\"status\":\"still-wrong\"}" }]
  });

  const { exitCode, stdout, stderr } = await runScriptWithEngines(
    `
      export const meta = { name: "claude-null-after-bound" };

      const verdict = await agent("verify finding", {
        engine: "claude",
        maxAttempts: 2,
        schema: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["verified"] }
          }
        }
      });

      return { verdict };
    `,
    new ScriptedEngineAdapter({ name: "codex", concurrency: 8, responses: [] }),
    claude
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { verdict: null });
  assert.equal(claude.invocations[0]?.closed, true);
});

test("scripted Claude gracefully degrades to null when the correction valve is absent", async () => {
  const claudeWithoutValve = new ScriptedEngineAdapter({
    name: "claude",
    concurrency: 8,
    responses: [{ text: "{\"status\":\"draft\"}" }, { text: "{\"status\":\"draft\"}" }]
  });

  const { exitCode, stdout, stderr } = await runScriptWithEngines(
    `
      export const meta = { name: "claude-valve-absent" };

      const verdict = await agent("verify without valve", {
        engine: "claude",
        maxAttempts: 2,
        schema: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["verified"] }
          }
        }
      });

      return { verdict };
    `,
    new ScriptedEngineAdapter({ name: "codex", concurrency: 8, responses: [] }),
    claudeWithoutValve
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { verdict: null });
  assert.equal(claudeWithoutValve.invocations[0]?.closed, true);
  assert.equal(claudeWithoutValve.closed, true);
});

test("cross-engine workflow lets Codex find and Claude verify through the real CLI", async () => {
  const codex = new ScriptedEngineAdapter({
    name: "codex",
    concurrency: 8,
    responses: [{ text: "{\"topic\":\"schema parity\",\"risk\":\"medium\"}" }]
  });
  const claude = new ScriptedEngineAdapter({
    name: "claude",
    concurrency: 8,
    responses: [{ text: "{\"accepted\":true,\"checkedBy\":\"claude\"}" }]
  });

  const { exitCode, stdout, stderr } = await runScriptWithEngines(
    `
      export const meta = { name: "codex-finds-claude-verifies" };

      const finding = await agent("find cross-engine risk", {
        engine: "codex",
        schema: {
          type: "object",
          required: ["topic", "risk"],
          additionalProperties: false,
          properties: {
            topic: { type: "string" },
            risk: { type: "string" }
          }
        }
      });
      const verification = await agent("verify " + JSON.stringify(finding), {
        engine: "claude",
        schema: {
          type: "object",
          required: ["accepted", "checkedBy"],
          additionalProperties: false,
          properties: {
            accepted: { type: "boolean" },
            checkedBy: { type: "string", enum: ["claude"] }
          }
        }
      });

      return { finding, verification };
    `,
    codex,
    claude
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    finding: { topic: "schema parity", risk: "medium" },
    verification: { accepted: true, checkedBy: "claude" }
  });
  assert.match(claude.invocations[0]?.prompt ?? "", /schema parity/);
});

test("cross-engine workflow lets Claude find and Codex verify through the real CLI", async () => {
  const claude = new ScriptedEngineAdapter({
    name: "claude",
    concurrency: 8,
    responses: [{ text: "{\"topic\":\"cap bleed\",\"risk\":\"high\"}" }]
  });
  const codex = new ScriptedEngineAdapter({
    name: "codex",
    concurrency: 8,
    responses: [{ text: "{\"accepted\":true,\"checkedBy\":\"codex\"}" }]
  });

  const { exitCode, stdout, stderr } = await runScriptWithEngines(
    `
      export const meta = { name: "claude-finds-codex-verifies" };

      const finding = await agent("find cross-engine risk", {
        engine: "claude",
        schema: {
          type: "object",
          required: ["topic", "risk"],
          additionalProperties: false,
          properties: {
            topic: { type: "string" },
            risk: { type: "string" }
          }
        }
      });
      const verification = await agent("verify " + JSON.stringify(finding), {
        engine: "codex",
        schema: {
          type: "object",
          required: ["accepted", "checkedBy"],
          additionalProperties: false,
          properties: {
            accepted: { type: "boolean" },
            checkedBy: { type: "string", enum: ["codex"] }
          }
        }
      });

      return { finding, verification };
    `,
    codex,
    claude
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    finding: { topic: "cap bleed", risk: "high" },
    verification: { accepted: true, checkedBy: "codex" }
  });
  assert.match(codex.invocations[0]?.prompt ?? "", /cap bleed/);
});

test("CLI budget flag enforces Codex ceiling without blocking Claude", async () => {
  const { exitCode, stdout, stderr, codex, claude } = await runScriptWithCliEngines(
    `
      export const meta = { name: "cli-codex-budget-cross-unit" };

      const codexFirst = await agent("spend codex over ceiling", { engine: "codex" });
      let codexBlockedMessage = null;
      try {
        await agent("codex should be blocked by cli ceiling", { engine: "codex" });
      } catch (error) {
        codexBlockedMessage = error.message;
      }
      const claudeAfterCodexExhaustion = await agent("claude should still run", { engine: "claude" });

      return {
        codexFirst,
        codexSpent: budget.spent("codex"),
        codexRemaining: budget.remaining("codex"),
        claudeSpent: budget.spent("claude"),
        claudeUnbounded: budget.remaining("claude") === Infinity,
        codexBlockedMessage,
        claudeAfterCodexExhaustion
      };
    `,
    {
      cliArgs: ["--budget=codex=5"],
      codexResponses: [{ text: "codex-first", tokenDelta: 6 }],
      claudeResponses: [{ text: "claude-still-runs", tokenDelta: 3 }]
    }
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    codexFirst: "codex-first",
    codexSpent: 6,
    codexRemaining: 0,
    claudeSpent: 3,
    claudeUnbounded: true,
    codexBlockedMessage: "Token budget exhausted for codex: spent 6 of 5 tokens",
    claudeAfterCodexExhaustion: "claude-still-runs"
  });
  // The blocked call is rejected at dispatch, before the engine sees it: one
  // invocation total, not a second invocation with zero attempts.
  assert.deepEqual(codex.invocations.map((invocation) => invocation.contexts.length), [1]);
  assert.equal(claude.invocations.length, 1);
});

test("CLI budget flag enforces Claude ceiling without blocking Codex", async () => {
  const { exitCode, stdout, stderr, codex, claude } = await runScriptWithCliEngines(
    `
      export const meta = { name: "cli-claude-budget-cross-unit" };

      const claudeFirst = await agent("spend claude over ceiling", { engine: "claude" });
      let claudeBlockedMessage = null;
      try {
        await agent("claude should be blocked by cli ceiling", { engine: "claude" });
      } catch (error) {
        claudeBlockedMessage = error.message;
      }
      const codexAfterClaudeExhaustion = await agent("codex should still run", { engine: "codex" });

      return {
        claudeFirst,
        claudeSpent: budget.spent("claude"),
        claudeRemaining: budget.remaining("claude"),
        codexSpent: budget.spent("codex"),
        codexUnbounded: budget.remaining("codex") === Infinity,
        claudeBlockedMessage,
        codexAfterClaudeExhaustion
      };
    `,
    {
      cliArgs: ["--budget=claude=5"],
      codexResponses: [{ text: "codex-still-runs", tokenDelta: 4 }],
      claudeResponses: [{ text: "claude-first", tokenDelta: 7 }]
    }
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    claudeFirst: "claude-first",
    claudeSpent: 7,
    claudeRemaining: 0,
    codexSpent: 4,
    codexUnbounded: true,
    claudeBlockedMessage: "Token budget exhausted for claude: spent 7 of 5 tokens",
    codexAfterClaudeExhaustion: "codex-still-runs"
  });
  assert.equal(codex.invocations.length, 1);
  // The blocked call is rejected at dispatch, before the engine sees it.
  assert.deepEqual(claude.invocations.map((invocation) => invocation.contexts.length), [1]);
});

test("CLI json-args flag switches args from raw strings to parsed JSON", async () => {
  const source = `
    export const meta = { name: "cli-json-args-parity" };
    return { args, isArray: Array.isArray(args) };
  `;

  const raw = await runScriptWithCliEngines(source, {
    scriptArgs: ["alpha", "beta"],
    codexResponses: [],
    claudeResponses: []
  });
  const parsed = await runScriptWithCliEngines(source, {
    cliArgs: [`--json-args={"items":["alpha","beta"],"count":2}`],
    codexResponses: [],
    claudeResponses: []
  });

  assert.equal(raw.exitCode, 0, raw.stderr);
  assert.equal(parsed.exitCode, 0, parsed.stderr);
  assert.deepEqual(JSON.parse(raw.stdout), { args: ["alpha", "beta"], isArray: true });
  assert.deepEqual(JSON.parse(parsed.stdout), {
    args: { items: ["alpha", "beta"], count: 2 },
    isArray: false
  });
});

test("CLI concurrency flag serialises only the named engine", async () => {
  const { exitCode, stdout, stderr, codex, claude } = await runScriptWithCliEngines(
    `
      export const meta = { name: "cli-concurrency-cross-unit" };

      const results = await parallel([
        () => agent("codex slow", { engine: "codex" }),
        () => agent("codex queued", { engine: "codex" }),
        () => agent("claude slow", { engine: "claude" }),
        () => agent("claude overlaps", { engine: "claude" })
      ]);

      return { results };
    `,
    {
      cliArgs: ["--concurrency=codex=1"],
      defaultConcurrency: 2,
      codexResponses: [
        { text: "codex-slow", delayMs: 80 },
        { text: "codex-queued", delayMs: 1 }
      ],
      claudeResponses: [
        { text: "claude-slow", delayMs: 80 },
        { text: "claude-overlaps", delayMs: 1 }
      ]
    }
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    results: ["codex-slow", "codex-queued", "claude-slow", "claude-overlaps"]
  });
  assert.equal(codex.concurrency, 1);
  assert.equal(claude.concurrency, 2);

  assert.equal(codex.maxActive, 1);
  assert.equal(claude.maxActive, 2);
});

test("CLI concurrency flag serialises Claude without reducing Codex concurrency", async () => {
  const { exitCode, stdout, stderr, codex, claude } = await runScriptWithCliEngines(
    `
      export const meta = { name: "cli-claude-concurrency-cross-unit" };

      const results = await parallel([
        () => agent("codex slow", { engine: "codex" }),
        () => agent("codex overlaps", { engine: "codex" }),
        () => agent("claude slow", { engine: "claude" }),
        () => agent("claude queued", { engine: "claude" })
      ]);

      return { results };
    `,
    {
      cliArgs: ["--concurrency=claude=1"],
      defaultConcurrency: 2,
      codexResponses: [
        { text: "codex-slow", delayMs: 80 },
        { text: "codex-overlaps", delayMs: 1 }
      ],
      claudeResponses: [
        { text: "claude-slow", delayMs: 80 },
        { text: "claude-queued", delayMs: 1 }
      ]
    }
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    results: ["codex-slow", "codex-overlaps", "claude-slow", "claude-queued"]
  });
  assert.equal(codex.concurrency, 2);
  assert.equal(claude.concurrency, 1);

  // Peak active work is recorded at the scheduler boundary, so it proves the
  // per-engine caps without inferring scheduler behaviour from wall-clock order.
  assert.equal(codex.maxActive, 2);
  assert.equal(claude.maxActive, 1);
});

test("default Codex concurrency is hermetic to the caller environment", async () => {
  const { exitCode, stderr, codex } = await runScriptWithCliEngines(
    `
      export const meta = { name: "default-codex-concurrency-is-hermetic" };
      return await agent("use the default Codex concurrency", { engine: "codex" });
    `,
    { codexResponses: [{ text: "codex-default" }], claudeResponses: [] }
  );

  assert.equal(exitCode, 0, stderr);
  assert.equal(codex.concurrency, 12);
});

test("default Claude concurrency is hermetic to the caller environment", async () => {
  const { exitCode, stderr, claude } = await runScriptWithCliEngines(
    `
      export const meta = { name: "default-claude-concurrency-is-hermetic" };
      return await agent("use the default Claude concurrency", { engine: "claude" });
    `,
    { codexResponses: [], claudeResponses: [{ text: "claude-default" }] }
  );

  assert.equal(exitCode, 0, stderr);
  assert.equal(claude.concurrency, 12);
});

test("removed options fail loudly on the real agent path before spawning", async () => {
  for (const scenario of [
    {
      name: "web-search-removed",
      options: `{ engine: "claude", webSearch: true }`,
      message: /RemovedAgentOptionError: agent\(\) option "webSearch" was removed/
    },
    {
      name: "sandbox-removed",
      options: `{ engine: "claude", sandbox: "read-only" }`,
      message: /RemovedAgentOptionError: agent\(\) option "sandbox" was removed/
    },
    {
      name: "network-removed",
      options: `{ engine: "claude", network: false }`,
      message: /RemovedAgentOptionError: agent\(\) option "network" was removed/
    },
    {
      name: "unknown-option",
      options: `{ engine: "claude", maxAttemps: 2 }`,
      message: /UnrecognisedAgentOptionError: Unrecognised agent\(\) option "maxAttemps"/
    }
  ]) {
    const codex = new ScriptedEngineAdapter({ name: "codex", concurrency: 1, responses: [] });
    const { exitCode, stdout, stderr } = await runScriptWithRuntimeFactory(
      `
        export const meta = { name: ${JSON.stringify(scenario.name)} };
        await agent("must fail before Claude worker spawn", ${scenario.options});
      `,
      [],
      async () =>
        new EnsembleRuntime({
          engines: new EngineRegistry([codex, new ClaudeEngineAdapter({ concurrency: 1 })]),
          defaultTurnTimeoutMs: 1_000,
          defaultMaxAttempts: 1
        })
    );

    assert.equal(exitCode, 1);
    assert.equal(stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(stderr, scenario.message);
    assert.equal(codex.invocations.length, 0);
  }
});

test("Codex schema-subset rejection is distinct from ordinary schema validation failure through the CLI", async () => {
  const unsupported = await runScriptWithCliEngines(
    `
      export const meta = { name: "codex-schema-subset-fail-loud" };

      await agent("schema rejected before generation", {
        engine: "codex",
        schema: {
          type: "object",
          required: ["answer"],
          additionalProperties: false,
          properties: {
            answer: { type: "string" }
          }
        }
      });
    `,
    {
      codexResponses: [
        {
          throwError: new CodexSchemaSubsetUnsupportedError({
            code: -32602,
            message: "invalid_json_schema",
            data: { code: "invalid_json_schema" }
          })
        }
      ],
      claudeResponses: []
    }
  );

  assert.equal(unsupported.exitCode, 1);
  assert.equal(unsupported.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
  const unsupportedDiagnostic = withoutSentinelAnnouncement(unsupported.stderr);
  assert.match(unsupportedDiagnostic, /CodexSchemaSubsetUnsupportedError: Codex rejected outputSchema before generation/);
  assert.doesNotMatch(unsupportedDiagnostic, /verdict/);

  const ordinaryValidation = await runScriptWithCliEngines(
    `
      export const meta = { name: "codex-ordinary-validation-failure" };

      const verdict = await agent("schema validates client-side after generation", {
        engine: "codex",
        maxAttempts: 1,
        schema: {
          type: "object",
          required: ["answer"],
          additionalProperties: false,
          properties: {
            answer: { type: "string", enum: ["yes"] }
          }
        }
      });

      return { verdict };
    `,
    {
      codexResponses: [{ text: "{\"answer\":\"no\"}" }],
      claudeResponses: []
    }
  );

  assert.equal(ordinaryValidation.exitCode, 0, ordinaryValidation.stderr);
  assert.deepEqual(JSON.parse(ordinaryValidation.stdout), { verdict: null });
  assert.equal(withoutSentinelAnnouncement(ordinaryValidation.stderr), "");
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
        return await agent("stage0 " + item, { engine: "codex" });
      }, async (previous, item) => {
        events.push("stage1-start-" + item);
        if (item === "fast") {
          releaseSlow();
        }
        return await agent("stage1 " + item + " " + previous, { engine: "codex" });
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

test("parallel and pipeline propagate rejected options before a worker opens", async () => {
  for (const scenario of [
    {
      name: "parallel-rejected-option",
      body: `await parallel([() => agent("never", { engine: "codex", sandbox: "read-only" })]);`,
      message: /RemovedAgentOptionError: agent\(\) option "sandbox" was removed/
    },
    {
      name: "pipeline-rejected-option",
      body: `await pipeline(["item"], () => agent("never", { engine: "codex", maxAttemps: 2 }));`,
      message: /UnrecognisedAgentOptionError: Unrecognised agent\(\) option "maxAttemps"/
    }
  ]) {
    const { exitCode, stdout, stderr, transport } = await runScript(
      `
        export const meta = { name: ${JSON.stringify(scenario.name)} };
        ${scenario.body}
        return "never";
      `,
      []
    );

    assert.equal(exitCode, 1);
    assert.equal(stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(stderr, scenario.message);
    assert.equal(transport.openedThreads.length, 0);
  }
});

test("computed open-domain options reach the final engine invocation unchanged", async () => {
  const model = "gpt-5.6-terra";
  // model's domain is genuinely open (engine-owned); effort's is the
  // canonical harness vocabulary, on which Codex is native passthrough —
  // a computed canonical level must still reach the invocation unchanged.
  const effort = "xhigh";
  const label = "unusual label: Δ / release-candidate";
  const phaseName = "verify → final consumer";
  const { exitCode, stdout, stderr, codex } = await runScriptWithCliEngines(
    `
      export const meta = { name: "computed-open-domain-options" };

      const selected = await agent("select an engine-owned option set", {
        engine: "codex",
        maxAttempts: 1,
        schema: {
          type: "object",
          required: ["model", "effort", "label", "phase"],
          additionalProperties: false,
          properties: {
            model: { type: "string" },
            effort: { type: "string" },
            label: { type: "string" },
            phase: { type: "string" }
          }
        }
      });

      const options = {
        engine: "codex",
        model: selected.model,
        effort: selected.effort,
        label: selected.label,
        phase: selected.phase,
        timeoutMs: 12_345,
        maxAttempts: 1
      };
      return await agent("run with the selected unusual values", options);
    `,
    {
      codexResponses: [
        { text: JSON.stringify({ model, effort, label, phase: phaseName }) },
        { text: "OPEN_DOMAIN_OPTIONS_RAN" }
      ],
      claudeResponses: []
    }
  );

  assert.equal(exitCode, 0, stderr);
  assert.equal(stdout, `"OPEN_DOMAIN_OPTIONS_RAN"\n`);
  assert.equal(codex.invocations.length, 2);
  const finalInvocation = codex.invocations[1];
  assert.ok(finalInvocation);
  assert.equal(finalInvocation.options.model, model);
  assert.equal(finalInvocation.options.effort, effort);
  assert.equal(finalInvocation.options.timeoutMs, 12_345);
  assert.equal(finalInvocation.contexts.length, 1);
});

test("parallel propagates repeated malformed schemas before a worker opens", async () => {
  const { exitCode, stdout, stderr, transport } = await runScript(
    `
      export const meta = { name: "parallel-malformed-schema" };
      const schema = { type: "object", properties: { answer: { type: "not-a-type" } } };
      await parallel([
        () => agent("never", { engine: "codex", schema }),
        () => agent("never", { engine: "codex", schema }),
        () => agent("never", { engine: "codex", schema })
      ]);
      return "survived";
    `,
    []
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
  assert.match(stderr, /InvalidAgentSchemaError: agent schema does not compile as JSON Schema/);
  assert.equal(transport.openedThreads.length, 0);
});

test("pipeline propagates repeated malformed schemas before a worker opens", async () => {
  const { exitCode, stdout, stderr, transport } = await runScript(
    `
      export const meta = { name: "pipeline-malformed-schema" };
      const schema = { type: "object", properties: { answer: { type: "not-a-type" } } };
      await pipeline(["first", "second", "third"], () =>
        agent("never", { engine: "codex", schema })
      );
      return "survived";
    `,
    []
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
  assert.match(stderr, /InvalidAgentSchemaError: agent schema does not compile as JSON Schema/);
  assert.equal(transport.openedThreads.length, 0);
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

      const validAfterRetry = await agent("retry until valid", { engine: "codex", schema, maxAttempts: 2 });
      const impossible = await agent("never satisfies schema", { engine: "codex", schema, maxAttempts: 2 });
      const fanout = await parallel([
        () => agent("plain success", { engine: "codex" }),
        () => agent("worker throws", { engine: "codex" })
      ]);
      const spentBeforeBlockedCall = budget.spent("codex");
      let blockedMessage = null;
      try {
        await agent("should be blocked by budget", { engine: "codex" });
      } catch (error) {
        blockedMessage = error.message;
      }

      return {
        validAfterRetry,
        impossible,
        fanout,
        spentBeforeBlockedCall,
        remaining: budget.remaining("codex"),
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
    { budgetCeilings: { codex: 20 } }
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
  assert.match(result.blockedMessage ?? "", /Token budget exhausted for codex: spent 27 of 20 tokens/);
  assert.equal(transport.turns.length, 6);
});

test("Codex budget exhaustion leaves Claude unbounded and runnable", async () => {
  const { exitCode, stdout, stderr } = await runScriptWithBudgetedEngines(
    `
      export const meta = { name: "codex-budget-independent" };

      const firstCodex = await agent("spend codex", { engine: "codex" });
      let codexBlockedMessage = null;
      try {
        await agent("blocked codex", { engine: "codex" });
      } catch (error) {
        codexBlockedMessage = error.message;
      }
      const claudeAfterCodexExhaustion = await agent("claude still runs", { engine: "claude" });

      return {
        firstCodex,
        codexSpent: budget.spent("codex"),
        codexRemaining: budget.remaining("codex"),
        claudeSpent: budget.spent("claude"),
        claudeUnbounded: budget.remaining("claude") === Infinity,
        codexBlockedMessage,
        claudeAfterCodexExhaustion
      };
    `,
    [{ text: "codex-first", tokenDelta: 6 }],
    [{ text: "claude-still-runs", tokenDelta: 3 }],
    { codex: 5 }
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    firstCodex: "codex-first",
    codexSpent: 6,
    codexRemaining: 0,
    claudeSpent: 3,
    claudeUnbounded: true,
    codexBlockedMessage: "Token budget exhausted for codex: spent 6 of 5 tokens",
    claudeAfterCodexExhaustion: "claude-still-runs"
  });
});

test("Claude budget exhaustion leaves Codex unbounded and runnable", async () => {
  const { exitCode, stdout, stderr } = await runScriptWithBudgetedEngines(
    `
      export const meta = { name: "claude-budget-independent" };

      const firstClaude = await agent("spend claude", { engine: "claude" });
      let claudeBlockedMessage = null;
      try {
        await agent("blocked claude", { engine: "claude" });
      } catch (error) {
        claudeBlockedMessage = error.message;
      }
      const codexAfterClaudeExhaustion = await agent("codex still runs", { engine: "codex" });

      return {
        firstClaude,
        claudeSpent: budget.spent("claude"),
        claudeRemaining: budget.remaining("claude"),
        codexSpent: budget.spent("codex"),
        codexUnbounded: budget.remaining("codex") === Infinity,
        claudeBlockedMessage,
        codexAfterClaudeExhaustion
      };
    `,
    [{ text: "codex-still-runs", tokenDelta: 4 }],
    [{ text: "claude-first", tokenDelta: 7 }],
    { claude: 5 }
  );

  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {
    firstClaude: "claude-first",
    claudeSpent: 7,
    claudeRemaining: 0,
    codexSpent: 4,
    codexUnbounded: true,
    claudeBlockedMessage: "Token budget exhausted for claude: spent 7 of 5 tokens",
    codexAfterClaudeExhaustion: "codex-still-runs"
  });
});

test("CLI workflow exposes changed isolated worktrees and removes the clean one", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-isolation-estate-"));
  const repo = path.join(directory, "repo");

  try {
    await mkdir(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "ensemble-workflows@example.invalid"]);
    await git(repo, ["config", "user.name", "Ensemble Workflows Test"]);
    await writeFile(path.join(repo, "README.md"), "temporary isolation fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);

    const { exitCode, stdout, stderr, transport } = await runScript(
      `
        export const meta = { name: "worktree-isolation-estate" };

        const clean = await agent("make no file changes", { engine: "codex", isolation: "worktree" });
        const writes = await parallel([
          () => agent("write agent-a.txt only", { engine: "codex", isolation: "worktree" }),
          () => agent("write agent-b.txt only", { engine: "codex", isolation: "worktree" })
        ]);

        return {
          clean,
          writes,
          worktrees: worktrees.map((worktree) => ({
            path: worktree.path,
            branch: worktree.branch,
            changed: worktree.changed,
            removed: worktree.removed
          }))
        };
      `,
      [
        { text: "clean-ok", delayMs: 5 },
        { text: "a-ok", delayMs: 30, writeFile: { name: "agent-a.txt", contents: "A_ONLY\n" } },
        { text: "b-ok", delayMs: 10, writeFile: { name: "agent-b.txt", contents: "B_ONLY\n" } }
      ],
      [],
      { cwd: repo }
    );

    assert.equal(exitCode, 0, stderr);
    const result = JSON.parse(stdout) as {
      clean: string;
      writes: string[];
      worktrees: Array<{ path: string; branch: string; changed: boolean; removed: boolean }>;
    };
    assert.equal(result.clean, "clean-ok");
    assert.deepEqual(result.writes.sort(), ["a-ok", "b-ok"]);
    assert.equal(result.worktrees.length, 3);

    const cleanWorktree = result.worktrees.find((worktree) => !worktree.changed);
    assert.ok(cleanWorktree, "expected one clean isolated worktree");
    assert.equal(cleanWorktree.removed, true);
    await assert.rejects(() => access(cleanWorktree.path), /ENOENT/);
    await assert.rejects(() => git(repo, ["rev-parse", "--verify", cleanWorktree.branch]), /unknown revision|Needed a single revision/);

    const changedWorktrees = result.worktrees.filter((worktree) => worktree.changed);
    assert.equal(changedWorktrees.length, 2);
    assert.notEqual(changedWorktrees[0]?.path, changedWorktrees[1]?.path);
    assert.notEqual(changedWorktrees[0]?.branch, changedWorktrees[1]?.branch);
    for (const worktree of changedWorktrees) {
      assert.match(stderr, new RegExp(`\\[worktree\\] changed ${escapeRegExp(worktree.path)} \\(${escapeRegExp(worktree.branch)}\\)`));
    }

    const aWorktree = await worktreeContaining(changedWorktrees, "agent-a.txt");
    const bWorktree = await worktreeContaining(changedWorktrees, "agent-b.txt");
    assert.notEqual(aWorktree.path, bWorktree.path);
    assert.equal((await readFile(path.join(aWorktree.path, "agent-a.txt"), "utf8")).trim(), "A_ONLY");
    assert.equal((await readFile(path.join(bWorktree.path, "agent-b.txt"), "utf8")).trim(), "B_ONLY");
    await assert.rejects(() => access(path.join(aWorktree.path, "agent-b.txt")), /ENOENT/);
    await assert.rejects(() => access(path.join(bWorktree.path, "agent-a.txt")), /ENOENT/);

    const isolatedThreadCwds = transport.openedThreads.map((thread) => thread.cwd).filter((cwd): cwd is string => cwd !== undefined);
    assert.equal(isolatedThreadCwds.length, 3);
    assert.equal(new Set(isolatedThreadCwds).size, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI workflow returns non-zero, stderr error, and a salvage envelope when the script throws", async () => {
  const { exitCode, stdout, stderr } = await runScript(
    `
      export const meta = { name: "throws" };
      log("before throw");
      throw new Error("script exploded");
    `,
    []
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
  assert.match(stderr, /before throw/);
  assert.match(stderr, /Error: script exploded/);
});

async function runScript(
  source: string,
  responses: ScriptedTurn[],
  args: string[] = [],
  runtimeOptions: { budgetCeilings?: Partial<Record<EngineName, number | null>>; cwd?: string } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; transport: ScriptedTransport }> {
  const directory = runtimeOptions.cwd ?? (await mkdtemp(path.join(tmpdir(), "ensemble-integration-")));
  const script = path.join(directory, "workflow.js");
  await writeFile(script, source);

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const transport = new ScriptedTransport(responses, directory);
  const runtime = new EnsembleRuntime({
    transport,
    cwd: directory,
    concurrencyCaps: { codex: 8 },
    ...(runtimeOptions.budgetCeilings !== undefined ? { budgetCeilings: runtimeOptions.budgetCeilings } : {}),
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 3
  });
  transport.setEventSink((event) => runtime.handleTransportEvent(event));

  const exitCode = await runEnsembleCli([script, ...args], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => runtime
  });

  return { exitCode, stdout: stdout.text(), stderr: stderr.text(), transport };
}

async function runScriptWithEngines(
  source: string,
  codex: EngineAdapter,
  claude: EngineAdapter,
  args: string[] = []
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-multi-engine-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(script, source);

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  try {
    const exitCode = await runEnsembleCli([script, ...args], {
      cwd: directory,
      stdout,
      stderr,
      createRuntime: async () =>
        new EnsembleRuntime({
          engines: new EngineRegistry([codex, claude]),
          cwd: directory,
          defaultTurnTimeoutMs: 1_000,
          defaultMaxAttempts: 3
        })
    });

    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runScriptWithCliEngines(
  source: string,
  options: {
    cliArgs?: string[];
    scriptArgs?: string[];
    codexResponses: ScriptedEngineTurn[];
    claudeResponses: ScriptedEngineTurn[];
    defaultConcurrency?: number;
  }
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  codex: ScriptedEngineAdapter;
  claude: ScriptedEngineAdapter;
}> {
  let runtime: EnsembleRuntime | null = null;
  let codex: ScriptedEngineAdapter | null = null;
  let claude: ScriptedEngineAdapter | null = null;
  const defaultConcurrency = options.defaultConcurrency ?? 12;

  const result = await runScriptWithRuntimeFactory(
    source,
    options.cliArgs ?? [],
    async (runtimeOptions) => {
      const runtimeOption = runtimeOptions ?? {};
      const codexAdapter = new ScriptedEngineAdapter({
        name: "codex",
        concurrency: runtimeOption.concurrencyCaps?.codex ?? defaultConcurrency,
        responses: options.codexResponses,
        onEvent: (event) => runtime?.handleEngineEvent("codex", event)
      });
      const claudeAdapter = new ScriptedEngineAdapter({
        name: "claude",
        concurrency: runtimeOption.concurrencyCaps?.claude ?? defaultConcurrency,
        responses: options.claudeResponses,
        onEvent: (event) => runtime?.handleEngineEvent("claude", event)
      });
      codex = codexAdapter;
      claude = claudeAdapter;
      runtime = new EnsembleRuntime({
        engines: new EngineRegistry([codexAdapter, claudeAdapter]),
        ...(runtimeOption.cwd !== undefined ? { cwd: runtimeOption.cwd } : {}),
        ...(runtimeOption.budgetCeilings !== undefined ? { budgetCeilings: runtimeOption.budgetCeilings } : {}),
        defaultTurnTimeoutMs: 1_000,
        defaultMaxAttempts: 3
      });
      return runtime;
    },
    options.scriptArgs ?? []
  );

  assert.ok(codex, "Codex scripted engine was not created");
  assert.ok(claude, "Claude scripted engine was not created");
  return { ...result, codex, claude };
}

async function runScriptWithRuntimeFactory(
  source: string,
  cliArgs: string[],
  createRuntime: (options?: RuntimeOptions) => Promise<EnsembleRuntime>,
  scriptArgs: string[] = []
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-integration-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(script, source);

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  try {
    const exitCode = await runEnsembleCli([...cliArgs, script, ...scriptArgs], {
      cwd: directory,
      // The integration estate observes CLI defaults. The caller's settings
      // still govern the product; the shared hermetic environment (every
      // ambient ENSEMBLE_ key stripped, not two named ones) prevents a
      // developer's shell from changing the test's asserted baseline.
      env: hermeticEstateEnvironment({ XDG_CONFIG_HOME: directory }),
      stdout,
      stderr,
      createRuntime
    });

    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runScriptWithBudgetedEngines(
  source: string,
  codexResponses: ScriptedEngineTurn[],
  claudeResponses: ScriptedEngineTurn[],
  budgetCeilings: Partial<Record<EngineName, number | null>>
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-budgeted-engines-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(script, source);

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  let runtime: EnsembleRuntime | null = null;
  const codex = new ScriptedEngineAdapter({
    name: "codex",
    concurrency: 8,
    responses: codexResponses,
    onEvent: (event) => runtime?.handleEngineEvent("codex", event)
  });
  const claude = new ScriptedEngineAdapter({
    name: "claude",
    concurrency: 8,
    responses: claudeResponses,
    onEvent: (event) => runtime?.handleEngineEvent("claude", event)
  });
  runtime = new EnsembleRuntime({
    engines: new EngineRegistry([codex, claude]),
    budgetCeilings,
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 3
  });

  try {
    const exitCode = await runEnsembleCli([script], {
      cwd: directory,
      stdout,
      stderr,
      createRuntime: async () => {
        assert.ok(runtime);
        return runtime;
      }
    });

    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function worktreeContaining<T extends { path: string }>(worktrees: T[], filename: string): Promise<T> {
  for (const worktree of worktrees) {
    try {
      await access(path.join(worktree.path, filename));
      return worktree;
    } catch {
      // Keep scanning: the assertion below reports the missing fixture.
    }
  }
  assert.fail(`no changed worktree contained ${filename}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
