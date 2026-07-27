import assert from "node:assert/strict";
import test from "node:test";

import { appServerErrorFromPayload } from "../../src/app-server.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import {
  BudgetExceededError,
  CodexSchemaSubsetUnsupportedError,
  FallbackModelUnsupportedError,
  InvalidAgentSchemaError,
  MissingEngineError
} from "../../src/errors.js";

import type { RunRecordWriter } from "../../src/run-record.js";

import type {
  AgentOptions,
  RuntimeTransport,
  ThreadStartOptions,
  TurnResult,
  TurnStartOptions
} from "../../src/types.js";
import type {
  IsolatedWorktree,
  IsolatedWorktreeRecord,
  WorktreeIsolationManager
} from "../../src/worktree-isolation.js";

class FakeTransport implements RuntimeTransport {
  readonly cwd = "/fake/repo";
  openedThreads: ThreadStartOptions[] = [];
  turns: Array<{ threadId: string; prompt: string; options: TurnStartOptions }> = [];

  #responses: TurnResult[];

  constructor(responses: TurnResult[]) {
    this.#responses = responses;
  }

  async openThread(options: ThreadStartOptions): Promise<string> {
    this.openedThreads.push(options);
    return `thread-${this.openedThreads.length}`;
  }

  async runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult> {
    this.turns.push({ threadId, prompt, options });
    const response = this.#responses.shift();
    assert.ok(response, "fake transport response was not configured");
    return response;
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

class ErrorTransport implements RuntimeTransport {
  readonly cwd = "/fake/repo";
  openedThreads: ThreadStartOptions[] = [];

  #error: Error;

  constructor(error: Error) {
    this.#error = error;
  }

  async openThread(options: ThreadStartOptions): Promise<string> {
    this.openedThreads.push(options);
    return "thread-1";
  }

  async runTurn(): Promise<TurnResult> {
    throw this.#error;
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeWorktreeManager implements WorktreeIsolationManager {
  finished: IsolatedWorktree[] = [];

  #next = 0;
  #changed: boolean;

  constructor(changed: boolean) {
    this.#changed = changed;
  }

  async create(): Promise<IsolatedWorktree> {
    this.#next += 1;
    return {
      path: `/fake/worktree-${this.#next}`,
      branch: `ensemble-workflows/fake-${this.#next}`,
      baseCommit: `fake-base-${this.#next}`
    };
  }

  async finish(worktree: IsolatedWorktree): Promise<IsolatedWorktreeRecord> {
    this.finished.push(worktree);
    return {
      ...worktree,
      changed: this.#changed,
      removed: !this.#changed
    };
  }
}

const schema = {
  type: "object",
  required: ["answer"],
  additionalProperties: false,
  properties: {
    answer: { type: "string", enum: ["yes"] }
  }
};

test("schema agents retry invalid output and return null after the bounded attempts", async () => {
  const transport = new FakeTransport([turn("not json"), turn("{\"answer\":\"no\"}")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 2
  });

  const result = await runtime.agent("return JSON", { engine: "codex", schema });

  assert.equal(result, null);
  assert.equal(transport.turns.length, 2);
});

test("schema agents return the validated object when a retry succeeds", async () => {
  const transport = new FakeTransport([turn("not json"), turn("{\"answer\":\"yes\"}")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 3
  });

  const result = await runtime.agent("return JSON", { engine: "codex", schema });

  assert.deepEqual(result, { answer: "yes" });
  assert.equal(transport.turns.length, 2);
});

test("schema agents return the last validating candidate from prose and fences", async () => {
  const transport = new FakeTransport([
    turn(
      [
        "Initial reading:",
        "```json",
        '{"answer":"draft"}',
        "```",
        "Final conclusion:",
        '{"answer":"final"}'
      ].join("\n")
    )
  ]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });
  const candidateSchema = {
    type: "object",
    required: ["answer"],
    additionalProperties: false,
    properties: {
      answer: { type: "string", enum: ["draft", "final"] }
    }
  };

  const result = await runtime.agent("return JSON", { engine: "codex", schema: candidateSchema });

  assert.deepEqual(result, { answer: "final" });
});

test("schema agents keep an earlier valid candidate when the final candidate fails validation", async () => {
  const transport = new FakeTransport([
    turn('Accepted: {"answer":"yes"}\nDiscarded later thought: {"answer":"no"}')
  ]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  const result = await runtime.agent("return JSON", { engine: "codex", schema });

  assert.deepEqual(result, { answer: "yes" });
});

test("schema agents keep schema-validation failure behaviour when no candidate validates", async () => {
  const transport = new FakeTransport([
    turn('First: {"answer":"no"}\nSecond: {"answer":"still no"}'),
    turn('["not an object"] then {"answer":"yes"}')
  ]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 2
  });

  const result = await runtime.agent("return JSON", { engine: "codex", schema });

  assert.deepEqual(result, { answer: "yes" });
  assert.match(transport.turns[1]?.prompt ?? "", /A previous attempt failed \(schema-validation\)/);
});

test("schema agents label empty output as empty-output, not invalid-json", async () => {
  // Empty or whitespace-only output is an empty-output failure, not invalid JSON.
  const transport = new FakeTransport([turn(""), turn("  \n"), turn("{\"answer\":\"yes\"}")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 3
  });

  const result = await runtime.agent("return JSON", { engine: "codex", schema });

  assert.deepEqual(result, { answer: "yes" });
  assert.equal(transport.turns.length, 3);
  assert.match(transport.turns[1]?.prompt ?? "", /A previous attempt failed \(empty-output\)/);
  assert.match(transport.turns[2]?.prompt ?? "", /A previous attempt failed \(empty-output\)/);
});

test("Codex invalid_json_schema becomes a distinguishing schema-subset error", async () => {
  const transport = new ErrorTransport(
    appServerErrorFromPayload("turn/start", {
      code: -32602,
      message: "invalid_json_schema",
      data: { code: "invalid_json_schema", detail: "required key missing from properties" }
    })
  );
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 2
  });

  await assert.rejects(
    () => runtime.agent("return JSON", { engine: "codex", schema }),
    (error: unknown) => {
      assert.ok(error instanceof CodexSchemaSubsetUnsupportedError);
      assert.match(error.message, /outside Codex's accepted subset or malformed/);
      assert.doesNotMatch(error.message, /turn\/start failed/);
      return true;
    }
  );
  assert.equal(transport.openedThreads.length, 1);
});

test("Codex budget records Codex tokenUsage.last deltas and blocks later Codex calls", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    budgetCeilings: { codex: 5 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  runtime.handleTransportEvent({
    method: "thread/tokenUsage/updated",
    receivedAt: Date.now(),
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: usage(3),
        total: usage(3)
      }
    }
  });
  runtime.handleTransportEvent({
    method: "thread/tokenUsage/updated",
    receivedAt: Date.now(),
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: usage(2),
        total: usage(5)
      }
    }
  });

  assert.equal(runtime.budget.spent("codex"), 5);
  assert.equal(runtime.budget.spent("claude"), 0);
  assert.equal(runtime.budget.remaining("codex"), 0);
  assert.equal(runtime.budget.remaining("claude"), Number.POSITIVE_INFINITY);
  await assert.rejects(() => runtime.agent("blocked", { engine: "codex" }), BudgetExceededError);
});

test("Codex agents pass only turn options that remain configurable", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  await runtime.agent("read", { engine: "codex" });

  assert.deepEqual(transport.openedThreads, [{}]);
  assert.deepEqual(transport.turns[0]?.options, { timeoutMs: 1_000 });
});

test("worktree isolation uses the isolated cwd and records the finished worktree", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const worktreeManager = new FakeWorktreeManager(true);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1,
    worktreeManager
  });
  const events: string[] = [];
  let recordedWorktree: unknown;
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      recordedWorktree = record.worktree;
    }
  } as RunRecordWriter);
  runtime.onEvent((event) => {
    events.push(event.method);
  });

  const result = await runtime.agent("write", { engine: "codex", isolation: "worktree" });

  assert.equal(result, "ok");
  assert.deepEqual(transport.openedThreads, [
    {
      cwd: "/fake/worktree-1"
    }
  ]);
  assert.deepEqual(transport.turns[0]?.options, { timeoutMs: 1_000 });
  assert.deepEqual(runtime.worktrees, [
    {
      path: "/fake/worktree-1",
      branch: "ensemble-workflows/fake-1",
      baseCommit: "fake-base-1",
      changed: true,
      removed: false
    }
  ]);
  assert.deepEqual(worktreeManager.finished, [
    { path: "/fake/worktree-1", branch: "ensemble-workflows/fake-1", baseCommit: "fake-base-1" }
  ]);
  assert.deepEqual(recordedWorktree, {
    branch: "ensemble-workflows/fake-1",
    baseCommit: "fake-base-1"
  });
  assert.deepEqual(events, ["worktree/finished"]);
});

test("removed and unrecognised options fail before a Codex thread opens", async () => {
  const transport = new FakeTransport([turn("unused")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
    prompt: string,
    options: Record<string, unknown>
  ) => Promise<unknown>;
  await assert.rejects(() => unsafeAgent("removed", { engine: "codex", sandbox: "read-only" }), /sandbox.*was removed/);
  await assert.rejects(() => unsafeAgent("typo", { engine: "codex", maxAttemps: 2 }), /Unrecognised.*maxAttemps/);
  assert.equal(transport.openedThreads.length, 0);
  assert.equal(transport.turns.length, 0);
});

test("agent requires an explicit engine", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  const unsafeAgent = runtime.agent as (prompt: string, options: Partial<AgentOptions>) => Promise<unknown>;

  await assert.rejects(() => unsafeAgent.call(runtime, "read", {}), MissingEngineError);
  assert.equal(transport.turns.length, 0);
});

test("per-turn timeout is unbounded when neither a default nor a per-call timeout is set", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });

  await runtime.agent("read", { engine: "codex" });

  assert.equal(transport.turns.length, 1);
  // No timeoutMs reaches the engine → the turn runs unbounded (no per-turn deadline).
  assert.equal(transport.turns[0]?.options.timeoutMs, undefined);
});

test("an explicit per-call timeoutMs is passed through to the engine turn", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });

  await runtime.agent("read", { engine: "codex", timeoutMs: 1_234 });

  assert.equal(transport.turns[0]?.options.timeoutMs, 1_234);
});

test("defaultTurnTimeoutMs applies as the per-turn timeout when no per-call timeout is set", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 5_000,
    defaultMaxAttempts: 1
  });

  await runtime.agent("read", { engine: "codex" });

  assert.equal(transport.turns[0]?.options.timeoutMs, 5_000);
});

test("Codex retries carry the previous failure back to the worker", async () => {
  const transport = new FakeTransport([turn("not json"), turn("{\"answer\":\"yes\"}")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 2
  });

  const result = await runtime.agent("return JSON", { engine: "codex", schema });

  assert.deepEqual(result, { answer: "yes" });
  assert.equal(transport.turns.length, 2);
  assert.equal(transport.turns[0]?.prompt, "return JSON");
  assert.match(transport.turns[1]?.prompt ?? "", /A previous attempt failed \(invalid-json\)/);
});

test("a schema that does not compile fails before any worker spawns", async () => {
  const transport = new FakeTransport([turn("never reached")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });

  await assert.rejects(
    () =>
      runtime.agent("return JSON", {
        engine: "codex",
        schema: { type: "object", properties: { a: { type: "not-a-type" } } }
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidAgentSchemaError);
      assert.match(error.message, /does not compile/);
      return true;
    }
  );
  assert.equal(transport.openedThreads.length, 0);
});

test("a run-record write failure surfaces as an event and never fails the agent", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder({
    recordAgent: async () => {
      throw new Error("disk full");
    }
  } as unknown as RunRecordWriter);
  const events: Array<{ method: string; message: unknown }> = [];
  runtime.onEvent((event) => {
    if (event.method === "runRecord/writeFailed") {
      events.push({ method: event.method, message: event.params.message });
    }
  });

  const result = await runtime.agent("read", { engine: "codex" });

  assert.equal(result, "ok");
  assert.deepEqual(events, [{ method: "runRecord/writeFailed", message: "disk full" }]);
});

// The Claude engine is now implemented; it is driven through the runtime with a
// fake control plane in test/unit/claude-engine.test.ts. Routing to it (and the
// isolation:'worktree' rejection) is covered there.

function turn(text: string): TurnResult {
  return {
    text,
    deltaText: text,
    durationMs: 10,
    firstDeltaMs: 5,
    items: {},
    tokenUsageEvents: []
  };
}

function usage(totalTokens: number) {
  return {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: totalTokens,
    reasoningOutputTokens: 0,
    totalTokens
  };
}

test("fallbackModel is rejected on the Codex engine before any worker spawns", async () => {
  const transport = new FakeTransport([turn("never reached")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });

  await assert.rejects(
    () => runtime.agent("read", { engine: "codex", fallbackModel: "sonnet" }),
    (error: unknown) => {
      assert.ok(error instanceof FallbackModelUnsupportedError);
      assert.match(error.message, /not supported on the codex engine/);
      return true;
    }
  );
  assert.equal(transport.openedThreads.length, 0);
});
