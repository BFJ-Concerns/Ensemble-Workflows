import assert from "node:assert/strict";
import test from "node:test";

import { appServerErrorFromPayload } from "../../src/app-server.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { BudgetExceededError, CodexSchemaSubsetUnsupportedError, MissingEngineError } from "../../src/errors.js";

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
      branch: `ensemble-workflows/fake-${this.#next}`
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
    concurrency: 1,
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
    concurrency: 1,
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 3
  });

  const result = await runtime.agent("return JSON", { engine: "codex", schema });

  assert.deepEqual(result, { answer: "yes" });
  assert.equal(transport.turns.length, 2);
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
    concurrency: 1,
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
    concurrency: 1,
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

test("default agents keep the read-only sandbox and base cwd", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrency: 1,
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  await runtime.agent("read", { engine: "codex" });

  assert.deepEqual(transport.openedThreads, [{ webSearch: false, sandbox: "read-only" }]);
});

test("worktree isolation forces workspace-write in the isolated cwd and records the finished worktree", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const worktreeManager = new FakeWorktreeManager(true);
  const runtime = new EnsembleRuntime({
    transport,
    concurrency: 1,
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1,
    worktreeManager
  });
  const events: string[] = [];
  runtime.onEvent((event) => {
    events.push(event.method);
  });

  const result = await runtime.agent("write", { engine: "codex", isolation: "worktree", sandbox: "read-only" });

  assert.equal(result, "ok");
  assert.deepEqual(transport.openedThreads, [
    {
      webSearch: false,
      sandbox: "workspace-write",
      cwd: "/fake/worktree-1"
    }
  ]);
  assert.deepEqual(runtime.worktrees, [
    {
      path: "/fake/worktree-1",
      branch: "ensemble-workflows/fake-1",
      changed: true,
      removed: false
    }
  ]);
  assert.deepEqual(worktreeManager.finished, [{ path: "/fake/worktree-1", branch: "ensemble-workflows/fake-1" }]);
  assert.deepEqual(events, ["worktree/finished"]);
});

test("agent requires an explicit engine", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrency: 1,
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  const unsafeAgent = runtime.agent as (prompt: string, options: Partial<AgentOptions>) => Promise<unknown>;

  await assert.rejects(() => unsafeAgent.call(runtime, "read", {}), MissingEngineError);
  assert.equal(transport.turns.length, 0);
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
