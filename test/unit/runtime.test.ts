import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { appServerErrorFromPayload } from "../../src/app-server.js";
import { EngineRegistry } from "../../src/engines.js";
import { parallel } from "../../src/hooks.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import {
  AgentOptionRejectedError,
  AppServerExitedError,
  AppServerOverloadedError,
  BudgetExceededError,
  CodexSchemaSubsetUnsupportedError,
  EmptyAgentOutputError,
  EngineShutdownError,
  CapabilityStripUnsupportedError,
  FallbackModelUnsupportedError,
  InvalidAgentOptionValueError,
  InvalidAgentSchemaError,
  MissingEngineError,
  TurnTimeoutError,
  WorktreePlacementRejectedError
} from "../../src/errors.js";

import type { RunRecordWriter, RuntimeAgentRecord } from "../../src/run-record.js";
import type { EngineAdapter } from "../../src/engines.js";

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

class ClosingTransport implements RuntimeTransport {
  readonly cwd = "/fake/repo";
  readonly started: Promise<void>;
  #error: Error;
  #reject: ((error: Error) => void) | null = null;
  #markStarted: (() => void) | null = null;

  constructor(error: Error = new AppServerExitedError("transport closed")) {
    this.#error = error;
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  async openThread(): Promise<string> {
    return "thread-1";
  }

  runTurn(): Promise<TurnResult> {
    this.#markStarted?.();
    return new Promise((_, reject) => {
      this.#reject = reject;
    });
  }

  async close(): Promise<void> {
    this.#reject?.(this.#error);
  }
}

class NonSettlingCloseTransport implements RuntimeTransport {
  readonly cwd = "/fake/repo";
  readonly started: Promise<void>;
  #markStarted: (() => void) | null = null;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  async openThread(): Promise<string> {
    return "thread-1";
  }

  runTurn(): Promise<TurnResult> {
    this.#markStarted?.();
    return new Promise(() => undefined);
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

class DispatchBlockedRecorder {
  readonly records: RuntimeAgentRecord[] = [];
  readonly dispatchStarted: Promise<void>;
  #markDispatchStarted: (() => void) | null = null;
  #releaseDispatch: (() => void) | null = null;

  constructor(private readonly failReplacement = false) {
    this.dispatchStarted = new Promise((resolve) => {
      this.#markDispatchStarted = resolve;
    });
  }

  async recordAgent(record: RuntimeAgentRecord): Promise<void> {
    this.records.push(structuredClone(record));
    if (this.records.length !== 1) {
      if (this.failReplacement) {
        throw new Error("disk full");
      }
      return;
    }
    this.#markDispatchStarted?.();
    await new Promise<void>((resolve) => {
      this.#releaseDispatch = resolve;
    });
  }

  releaseDispatch(): void {
    this.#releaseDispatch?.();
  }
}

class InvalidOutputDuringCloseTransport implements RuntimeTransport {
  readonly cwd = "/fake/repo";
  readonly started: Promise<void>;
  #markStarted: (() => void) | null = null;
  #release: (() => void) | null = null;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  async openThread(): Promise<string> {
    return "thread-1";
  }

  async runTurn(): Promise<TurnResult> {
    this.#markStarted?.();
    await new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    return turn("not JSON");
  }

  async close(): Promise<void> {
    this.#release?.();
  }
}

class FakeWorktreeManager implements WorktreeIsolationManager {
  createdFrom: string[] = [];
  finished: IsolatedWorktree[] = [];

  #next = 0;
  #changed: boolean;

  constructor(changed: boolean) {
    this.#changed = changed;
  }

  async create(baseCwd: string): Promise<IsolatedWorktree> {
    this.createdFrom.push(baseCwd);
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
      tipCommit: `${worktree.baseCommit}-tip`,
      changed: this.#changed,
      removed: !this.#changed
    };
  }
}

class FailingWorktreeManager implements WorktreeIsolationManager {
  readonly finished: IsolatedWorktree[] = [];

  constructor(
    private readonly worktree: IsolatedWorktree,
    private readonly error: Error
  ) {}

  async create(): Promise<IsolatedWorktree> {
    return this.worktree;
  }

  async finish(worktree: IsolatedWorktree): Promise<IsolatedWorktreeRecord> {
    this.finished.push(worktree);
    throw this.error;
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

test("identity: true resolves the identified envelope; default resolution is unchanged", async () => {
  const runtime = new EnsembleRuntime({
    transport: new FakeTransport([turn("{\"answer\":\"yes\"}"), turn("{\"answer\":\"yes\"}")]),
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });

  const identified = await runtime.agent("go", {
    engine: "codex",
    schema,
    label: "finder",
    phase: "hunt",
    identity: true
  });
  assert.deepEqual(identified, { label: "finder", phase: "hunt", output: { answer: "yes" } });

  const bare = await runtime.agent("go", { engine: "codex", schema });
  assert.deepEqual(bare, { answer: "yes" });
});

test("an identified schema collapse still carries the worker's identity", async () => {
  // The envelope wraps every resolution, the null collapse included — the
  // fan-in filtering idiom under identity is on `output`, and a failed leg
  // keeps saying which worker it was.
  const runtime = new EnsembleRuntime({
    transport: new FakeTransport([turn("not json")]),
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });

  const collapsed = await runtime.agent("go", { engine: "codex", schema, label: "verifier", identity: true });
  assert.deepEqual(collapsed, { label: "verifier", phase: null, output: null });
});

test("a non-boolean identity value is rejected before any worker spawns", async () => {
  const transport = new FakeTransport([]);
  const runtime = new EnsembleRuntime({ transport, concurrencyCaps: { codex: 1 }, defaultMaxAttempts: 1 });

  await assert.rejects(
    () => runtime.agent("go", { engine: "codex", identity: "yes" as never }),
    InvalidAgentOptionValueError
  );
  // Nothing reached the engine at all: no thread opened, no turn run.
  assert.equal(transport.openedThreads.length, 0);
  assert.equal(transport.turns.length, 0);
});

test("schema-valid null settles as complete while retry exhaustion remains failed", async () => {
  const nullableSchema = { type: ["null", "string"] };
  const completedRecords: Array<{ status: string; attempts: Array<{ status: string }> }> = [];
  const completedRuntime = new EnsembleRuntime({
    transport: new FakeTransport([turn("null")]),
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  completedRuntime.setRunRecorder({
    recordAgent: async (record) => {
      completedRecords.push(structuredClone(record));
    }
  } as RunRecordWriter);

  const completedResult = await completedRuntime.agent("return null", {
    engine: "codex",
    schema: nullableSchema
  });

  assert.equal(completedResult, null);
  // First record is the dispatch-time in-progress write; the settlement
  // record with the outcome is the last.
  assert.equal(completedRecords[0]?.status, "in-progress");
  assert.equal(completedRecords.at(-1)?.status, "complete");
  assert.equal(completedRecords.at(-1)?.attempts[0]?.status, "complete");
  assert.deepEqual(completedRuntime.completedOutputs(), [
    {
      id: 1,
      engine: "codex",
      label: null,
      phase: null,
      output: null
    }
  ]);

  const failedRecords: Array<{ status: string; attempts: Array<{ status: string }> }> = [];
  const failedRuntime = new EnsembleRuntime({
    transport: new FakeTransport([turn("not json")]),
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  failedRuntime.setRunRecorder({
    recordAgent: async (record) => {
      failedRecords.push(structuredClone(record));
    }
  } as RunRecordWriter);

  const failedResult = await failedRuntime.agent("return null", {
    engine: "codex",
    schema: nullableSchema
  });

  assert.equal(failedResult, null);
  assert.equal(failedRecords.at(-1)?.status, "failed");
  assert.equal(failedRecords.at(-1)?.attempts[0]?.status, "failed");
  assert.deepEqual(failedRuntime.completedOutputs(), []);
});

test("schema agents return the validated object when a retry succeeds", async () => {
  const transport = new FakeTransport([turn("not json"), turn("{\"answer\":\"yes\"}")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 3
  });
  const records: RuntimeAgentRecord[] = [];
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  const result = await runtime.agent("return JSON", { engine: "codex", schema });

  assert.deepEqual(result, { answer: "yes" });
  assert.equal(transport.turns.length, 2);
  assert.equal(records[0]?.parseRoute, null);
  assert.equal(records.at(-1)?.parseRoute, "direct");
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
  const records: RuntimeAgentRecord[] = [];
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);
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
  assert.equal(records.at(-1)?.parseRoute, "object-fallback");
});

test("schema agents recover a valid array nested inside an unparseable brace region", async () => {
  const transport = new FakeTransport([turn('Findings: { see below ["a","b"] }')]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  const result = await runtime.agent("return findings", {
    engine: "codex",
    schema: { type: "array", items: { type: "string" } }
  });

  assert.deepEqual(result, ["a", "b"]);
  assert.equal(transport.turns.length, 1);
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
      assert.match(error.message, /-32602/);
      assert.match(error.message, /invalid_json_schema/);
      assert.match(error.message, /required key missing from properties/);
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

test("an active Codex record retains a decode diagnostic without failing its worker", async () => {
  class DecodeFailureTransport extends FakeTransport {
    #runtime: (() => EnsembleRuntime | null) | undefined;

    bind(runtime: () => EnsembleRuntime | null): void {
      this.#runtime = runtime;
    }

    override async runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult> {
      this.#runtime?.()?.handleTransportEvent({
        method: "transport/decodeFailed",
        receivedAt: Date.now(),
        params: { byteLength: 22, linePrefix: "this is not JSON at all" }
      });
      return await super.runTurn(threadId, prompt, options);
    }
  }

  const transport = new DecodeFailureTransport([turn("worker-ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  transport.bind(() => runtime);
  const records: RuntimeAgentRecord[] = [];
  runtime.setRunRecorder({
    recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
  } as unknown as RunRecordWriter);

  assert.equal(await runtime.agent("continue after bad frame", { engine: "codex" }), "worker-ok");
  assert.equal(records.length, 2);
  assert.equal(records[0]?.decodeFailure, null);
  assert.deepEqual(records.at(-1)?.decodeFailure, {
    byteLength: 22,
    linePrefix: "this is not JSON at all"
  });
});

test("the budget is judged at dispatch, not per attempt: exhaustion mid-retry cannot replace the provoking failure", async () => {
  // A transport that fails retryably on every attempt, exhausting the codex
  // ceiling from the *first* attempt's usage — the interleaving that used to
  // surface BudgetExceededError in place of the worker's own failure.
  class OverloadedSpendingTransport implements RuntimeTransport {
    readonly cwd = "/fake/repo";
    attempts = 0;
    #runtime: (() => EnsembleRuntime | null) | undefined;

    bind(runtime: () => EnsembleRuntime | null): void {
      this.#runtime = runtime;
    }

    async openThread(): Promise<string> {
      return "thread-1";
    }

    async runTurn(): Promise<TurnResult> {
      this.attempts += 1;
      // Spend past the ceiling before failing, as a live turn's usage event
      // would arrive before its terminal error notification.
      this.#runtime?.()?.handleTransportEvent({
        method: "thread/tokenUsage/updated",
        receivedAt: Date.now(),
        params: {
          threadId: "thread-1",
          turnId: `turn-${this.attempts}`,
          tokenUsage: { last: usage(10), total: usage(10) }
        }
      });
      throw new AppServerOverloadedError("turn/start", { code: undefined, message: "server overloaded" });
    }

    async close(): Promise<void> {
      return Promise.resolve();
    }
  }

  const transport = new OverloadedSpendingTransport();
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    budgetCeilings: { codex: 5 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 3
  });
  transport.bind(() => runtime);
  const records: RuntimeAgentRecord[] = [];
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  // The call was dispatched under the ceiling, so it owns its full attempt
  // bound: every attempt runs, and the surfaced failure is the transport's.
  await assert.rejects(() => runtime.agent("overloaded", { engine: "codex" }), AppServerOverloadedError);

  assert.equal(transport.attempts, 3);
  const settled = records.at(-1);
  assert.equal(settled?.status, "failed");
  assert.equal(settled?.attempts.length, 3);
  for (const attempt of settled?.attempts ?? []) {
    assert.equal(attempt.failure?.kind, "AppServerOverloadedError");
  }

  // The exhaustion still gates the next call: the ceiling moved from
  // per-attempt re-checking to one dispatch-time judgement, not away. A
  // blocked call is a pre-dispatch rejection — no engine reach, no record.
  await assert.rejects(() => runtime.agent("next call blocked", { engine: "codex" }), BudgetExceededError);
  assert.equal(transport.attempts, 3, "a blocked call must not reach the engine");
  assert.equal(records.at(-1)?.id, settled?.id, "a blocked call writes no agent record");
});

test("the ceiling bounds new dispatches, not the already-dispatched backlog", async () => {
  // Five calls dispatched together under cap 1 while spend is still zero:
  // all five pass the dispatch-time judgement and run to completion even
  // though the first call's spend crosses the ceiling — the documented
  // accepted cost (overshoot bounded by the dispatched backlog). What the
  // ceiling does bound is the next dispatch, which this test pins too.
  // This is the contract from both sides: a builder must not "fix" the
  // overshoot by re-checking at queue-start or per attempt — both
  // placements make the outcome depend on event interleaving.
  class SpendingTransport implements RuntimeTransport {
    readonly cwd = "/fake/repo";
    turns = 0;
    #runtime: (() => EnsembleRuntime | null) | undefined;

    bind(runtime: () => EnsembleRuntime | null): void {
      this.#runtime = runtime;
    }

    async openThread(): Promise<string> {
      return "thread-1";
    }

    async runTurn(): Promise<TurnResult> {
      this.turns += 1;
      this.#runtime?.()?.handleTransportEvent({
        method: "thread/tokenUsage/updated",
        receivedAt: Date.now(),
        params: {
          threadId: "thread-1",
          turnId: `turn-${this.turns}`,
          tokenUsage: { last: usage(10), total: usage(10) }
        }
      });
      return turn(`answer-${this.turns}`);
    }

    async close(): Promise<void> {
      return Promise.resolve();
    }
  }

  const transport = new SpendingTransport();
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    budgetCeilings: { codex: 5 },
    defaultMaxAttempts: 1
  });
  transport.bind(() => runtime);

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) => runtime.agent(`fan-out ${index}`, { engine: "codex" }))
  );

  // Every dispatched call ran: overshoot to 50 against a ceiling of 5.
  assert.equal(transport.turns, 5);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 5);
  assert.equal(runtime.budget.spent("codex"), 50);
  // The ceiling's bite is the next dispatch, which never reaches the engine.
  await assert.rejects(() => runtime.agent("sixth call blocked", { engine: "codex" }), BudgetExceededError);
  assert.equal(transport.turns, 5);
});

test("Codex agents pass only turn options that remain configurable", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    cwd: "/fake/repo",
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  await runtime.agent("read", { engine: "codex" });

  assert.deepEqual(transport.openedThreads, [{ cwd: "/fake/repo" }]);
  // The liveness callback is runtime plumbing on every turn; the remaining
  // options are the configurable surface this test pins.
  const { onFirstOutput, ...turnOptions } = transport.turns[0]?.options ?? {};
  assert.equal(typeof onFirstOutput, "function");
  assert.deepEqual(turnOptions, { timeoutMs: 1_000 });
});

test("a per-call cwd reaches the Codex thread and overrides the run-wide cwd", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });

  await runtime.agent("read", { engine: "codex", cwd: "/per-call/cwd" });

  assert.deepEqual(transport.openedThreads, [{ cwd: "/per-call/cwd" }]);
});

test("worktree isolation uses the isolated cwd and records the finished worktree", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const worktreeManager = new FakeWorktreeManager(true);
  const runtime = new EnsembleRuntime({
    transport,
    cwd: "/fake/repo",
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
  const { onFirstOutput, ...turnOptions } = transport.turns[0]?.options ?? {};
  assert.equal(typeof onFirstOutput, "function");
  assert.deepEqual(turnOptions, { timeoutMs: 1_000 });
  assert.deepEqual(runtime.worktrees, [
    {
      path: "/fake/worktree-1",
      branch: "ensemble-workflows/fake-1",
      baseCommit: "fake-base-1",
      tipCommit: "fake-base-1-tip",
      changed: true,
      removed: false
    }
  ]);
  assert.deepEqual(worktreeManager.finished, [
    { path: "/fake/worktree-1", branch: "ensemble-workflows/fake-1", baseCommit: "fake-base-1" }
  ]);
  assert.deepEqual(worktreeManager.createdFrom, ["/fake/repo"]);
  assert.deepEqual(recordedWorktree, {
    branch: "ensemble-workflows/fake-1",
    baseCommit: "fake-base-1",
    tipCommit: "fake-base-1-tip",
    changed: true,
    removed: false
  });
  assert.deepEqual(events, ["worktree/finished"]);
});

test("one worktree stays open across every retry in one agent call", async () => {
  const transport = new FakeTransport([turn("not json"), turn("{\"answer\":\"no\"}"), turn("{\"answer\":\"yes\"}")]);
  const worktreeManager = new FakeWorktreeManager(true);
  const runtime = new EnsembleRuntime({
    transport,
    cwd: "/fake/repo",
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 3,
    worktreeManager
  });

  const result = await runtime.agent("return JSON", {
    engine: "codex",
    schema,
    isolation: "worktree"
  });

  assert.deepEqual(result, { answer: "yes" });
  assert.deepEqual(worktreeManager.createdFrom, ["/fake/repo"]);
  assert.equal(worktreeManager.finished.length, 1);
  assert.deepEqual(transport.openedThreads, [
    { cwd: "/fake/worktree-1" },
    { cwd: "/fake/worktree-1" },
    { cwd: "/fake/worktree-1" }
  ]);
});

test("a failed worker still finishes and records its changed worktree", async () => {
  const transport = new ErrorTransport(new Error("worker failed after commit"));
  const worktreeManager = new FakeWorktreeManager(true);
  const records: unknown[] = [];
  const runtime = new EnsembleRuntime({
    transport,
    cwd: "/fake/repo",
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1,
    worktreeManager
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(record);
    }
  } as RunRecordWriter);

  await assert.rejects(
    () => runtime.agent("commit then fail", { engine: "codex", isolation: "worktree" }),
    /worker failed after commit/
  );

  assert.equal(worktreeManager.finished.length, 1);
  assert.equal(runtime.worktrees[0]?.changed, true);
  assert.deepEqual((records.at(-1) as { worktree: unknown }).worktree, {
    branch: "ensemble-workflows/fake-1",
    baseCommit: "fake-base-1",
    tipCommit: "fake-base-1-tip",
    changed: true,
    removed: false
  });
});

test("a missing worktree path remains discoverable and reports its finalisation failure", async () => {
  const worktree = {
    path: "/missing/fake-worktree",
    branch: "ensemble-workflows/missing-worktree",
    baseCommit: "missing-base"
  };
  const finalisationError = new Error(`git status failed in ${worktree.path}: ENOENT`);
  const worktreeManager = new FailingWorktreeManager(worktree, finalisationError);
  const records: RuntimeAgentRecord[] = [];
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = new EnsembleRuntime({
    transport: new FakeTransport([turn("committed")]),
    cwd: "/fake/repo",
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1,
    worktreeManager
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);
  runtime.onEvent((event) => {
    if (event.method === "worktree/finalisationFailed") {
      events.push({ method: event.method, params: event.params });
    }
  });

  const propagated = await runtime
    .agent("commit before removing the worktree path", { engine: "codex", isolation: "worktree" })
    .then(
      () => assert.fail("finalisation failure must reject the agent"),
      (error: unknown) => error
    );

  assert.strictEqual(propagated, finalisationError);
  assert.deepEqual(worktreeManager.finished, [worktree]);
  assert.deepEqual(runtime.worktrees, [{ ...worktree, tipCommit: null, changed: true, removed: false }]);
  assert.deepEqual(records.at(-1)?.worktree, {
    branch: worktree.branch,
    baseCommit: worktree.baseCommit,
    tipCommit: null,
    changed: true,
    removed: false
  });
  assert.deepEqual(events, [
    {
      method: "worktree/finalisationFailed",
      params: {
        agentId: 1,
        path: worktree.path,
        branch: worktree.branch,
        message: finalisationError.message
      }
    }
  ]);
});

test("a worker error remains primary when worktree finalisation also fails", async () => {
  const worktree = {
    path: "/fake/failed-worktree",
    branch: "ensemble-workflows/failed-worktree",
    baseCommit: "failed-base"
  };
  const workerError = new Error("worker failed after commit");
  const finalisationError = new Error("manager failed while inspecting the worktree");
  const worktreeManager = new FailingWorktreeManager(worktree, finalisationError);
  const records: RuntimeAgentRecord[] = [];
  const events: Array<{ method: string; message: unknown }> = [];
  const runtime = new EnsembleRuntime({
    transport: new ErrorTransport(workerError),
    cwd: "/fake/repo",
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1,
    worktreeManager
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);
  runtime.onEvent((event) => {
    if (event.method === "worktree/finalisationFailed") {
      events.push({ method: event.method, message: event.params.message });
    }
  });

  const propagated = await runtime
    .agent("commit then fail", { engine: "codex", isolation: "worktree" })
    .then(
      () => assert.fail("worker failure must reject the agent"),
      (error: unknown) => error
    );

  assert.strictEqual(propagated, workerError);
  assert.deepEqual(runtime.worktrees, [{ ...worktree, tipCommit: null, changed: true, removed: false }]);
  assert.equal(records.at(-1)?.worktree?.branch, worktree.branch);
  assert.deepEqual(events, [
    {
      method: "worktree/finalisationFailed",
      message: finalisationError.message
    }
  ]);
});

test("placement closes a worktree when invocation option validation rejects the call", async () => {
  const transport = new FakeTransport([]);
  const worktreeManager = new FakeWorktreeManager(false);
  const runtime = new EnsembleRuntime({
    transport,
    cwd: "/fake/repo",
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1,
    worktreeManager
  });

  await assert.rejects(
    () =>
      runtime.agent("never starts", {
        engine: "codex",
        fallbackModel: "sonnet",
        isolation: "worktree"
      }),
    FallbackModelUnsupportedError
  );

  assert.equal(transport.openedThreads.length, 0);
  assert.equal(worktreeManager.finished.length, 1);
  assert.equal(runtime.worktrees[0]?.removed, true);
});

test("invocation shutdown completes before worktree finalisation", async () => {
  const order: string[] = [];
  const worktreeManager: WorktreeIsolationManager = {
    create: async () => ({
      path: "/fake/ordered-worktree",
      branch: "ensemble-workflows/ordered",
      baseCommit: "ordered-base"
    }),
    finish: async (worktree) => {
      order.push("worktree-finish");
      return { ...worktree, tipCommit: worktree.baseCommit, changed: false, removed: true };
    }
  };
  const engine: EngineAdapter = {
    name: "claude",
    concurrency: 1,
    schedule: async (task) => task(),
    createInvocation: () => ({
      runAttempt: async () => {
        order.push("attempt");
        return turn("ok");
      },
      close: async () => {
        order.push("invocation-close");
      }
    }),
    close: async () => undefined
  };
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([engine]),
    cwd: "/fake/repo",
    defaultMaxAttempts: 1,
    worktreeManager
  });

  await runtime.agent("read", { engine: "claude", isolation: "worktree" });

  assert.deepEqual(order, ["attempt", "invocation-close", "worktree-finish"]);
});

test("non-git cwd under isolation fails loudly before spawning and escapes parallel", async () => {
  const nonGitCwd = await mkdtemp(path.join(tmpdir(), "ensemble-runtime-non-git-"));
  const transport = new FakeTransport([]);
  const runtime = new EnsembleRuntime({
    transport,
    cwd: "/fake/repo",
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });

  try {
    await assert.rejects(
      () =>
        parallel(
          [() => runtime.agent("never starts", { engine: "codex", cwd: nonGitCwd, isolation: "worktree" })],
          () => undefined
        ),
      WorktreePlacementRejectedError
    );
    assert.equal(transport.openedThreads.length, 0);
    assert.equal(runtime.worktrees.length, 0);
  } finally {
    await rm(nonGitCwd, { recursive: true, force: true });
  }
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

test("an invalid isolation value fails before a Codex thread opens", async () => {
  const transport = new FakeTransport([turn("unused")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
    prompt: string,
    options: Record<string, unknown>
  ) => Promise<unknown>;

  await assert.rejects(
    () => unsafeAgent("never starts", { engine: "codex", isolation: "wroktree" }),
    (error: unknown) => {
      assert.ok(error instanceof AgentOptionRejectedError);
      assert.match(error.message, /option "isolation"/);
      assert.match(error.message, /value "wroktree"/);
      return true;
    }
  );
  assert.equal(transport.openedThreads.length, 0);
  assert.equal(transport.turns.length, 0);
});

test("invalid timeoutMs values fail before a Codex thread opens", async () => {
  for (const timeoutMs of [0, -1, 1.5, 2_147_483_648]) {
    const transport = new FakeTransport([turn("unused")]);
    const runtime = new EnsembleRuntime({
      transport,
      concurrencyCaps: { codex: 1 },
      defaultMaxAttempts: 1
    });
    const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
      prompt: string,
      options: Record<string, unknown>
    ) => Promise<unknown>;

    await assert.rejects(
      () => unsafeAgent("never starts", { engine: "codex", timeoutMs }),
      (error: unknown) => {
        assert.ok(error instanceof AgentOptionRejectedError);
        assert.match(error.message, /option "timeoutMs"/);
        assert.match(error.message, new RegExp(`value ${timeoutMs}`));
        return true;
      }
    );
    assert.equal(transport.openedThreads.length, 0);
    assert.equal(transport.turns.length, 0);
  }
});

test("invalid maxAttempts values fail before a Codex thread opens", async () => {
  for (const maxAttempts of [0, -1, 1.5]) {
    const transport = new FakeTransport([turn("unused")]);
    const runtime = new EnsembleRuntime({
      transport,
      concurrencyCaps: { codex: 1 },
      defaultMaxAttempts: 1
    });
    const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
      prompt: string,
      options: Record<string, unknown>
    ) => Promise<unknown>;

    await assert.rejects(
      () => unsafeAgent("never starts", { engine: "codex", maxAttempts }),
      (error: unknown) => {
        assert.ok(error instanceof AgentOptionRejectedError);
        assert.match(error.message, /option "maxAttempts"/);
        assert.match(error.message, new RegExp(`value ${maxAttempts}`));
        return true;
      }
    );
    assert.equal(transport.openedThreads.length, 0);
    assert.equal(transport.turns.length, 0);
  }
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

test("an agent's record exists from dispatch, in-progress with prompt and resolved options", async () => {
  // The contract: recording intent before delivery, so a worker that dies
  // uncleanly still leaves evidence it was asked. The first write must land
  // before the engine runs and already carry the prompt and the options as
  // resolved (defaults applied), not as authored.
  const records: Array<{ status: string; prompt: string; options: { timeoutMs: number | null; maxAttempts: number } }> = [];
  const runtime = new EnsembleRuntime({
    transport: new FakeTransport([turn("ok")]),
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 3
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  await runtime.agent("what was asked", { engine: "codex", maxAttempts: 2 });

  assert.equal(records.length, 2);
  assert.equal(records[0]?.status, "in-progress");
  assert.equal(records[0]?.prompt, "what was asked");
  // maxAttempts as authored per call; timeoutMs resolved from the runtime default.
  assert.deepEqual(records[0]?.options, { timeoutMs: 1_000, maxAttempts: 2 });
  assert.equal(records.at(-1)?.status, "complete");
  assert.equal(records.at(-1)?.prompt, "what was asked");
});

test("a worker that dies uncleanly leaves its dispatch-time record", async () => {
  const records: Array<{ status: string; prompt: string }> = [];
  const runtime = new EnsembleRuntime({
    transport: new ErrorTransport(new Error("engine fell over")),
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  await assert.rejects(() => runtime.agent("doomed prompt", { engine: "codex" }), /engine fell over/);

  // Even with the settlement write present, the dispatch-time write is the
  // evidence a crash-before-settlement scenario relies on: it must be the
  // in-progress record carrying the prompt.
  assert.equal(records[0]?.status, "in-progress");
  assert.equal(records[0]?.prompt, "doomed prompt");
  assert.equal(records.at(-1)?.status, "failed");
});

test("a recorded Codex failure serialises its observed app-server diagnostic", async () => {
  const records: RuntimeAgentRecord[] = [];
  const error = appServerErrorFromPayload("turn/start", {
    code: -32001,
    message: "backpressure from fixture",
    data: { queue: "saturated" }
  });
  const runtime = new EnsembleRuntime({
    transport: new ErrorTransport(error),
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  await assert.rejects(() => runtime.agent("record the engine cause", { engine: "codex" }));

  assert.deepEqual(records.at(-1)?.attempts.at(-1)?.appServerDiagnostic, {
    code: -32001,
    message: "backpressure from fixture",
    payload: '{"queue":"saturated"}'
  });
});

test("terminal timeout and shutdown errors retain their agent statuses with two transition writes", async () => {
  for (const [error, expected] of [
    [new TurnTimeoutError("turn timed out"), "timed-out"],
    [new EngineShutdownError("codex"), "interrupted"]
  ] as const) {
    const records: RuntimeAgentRecord[] = [];
    const runtime = new EnsembleRuntime({
      transport: new ErrorTransport(error),
      concurrencyCaps: { codex: 1 },
      defaultMaxAttempts: 1
    });
    runtime.setRunRecorder({
      recordAgent: async (record) => {
        records.push(structuredClone(record));
      }
    } as RunRecordWriter);

    await assert.rejects(() => runtime.agent("stop", { engine: "codex" }), error.constructor);

    assert.equal(records.length, 2);
    assert.equal(records[0]?.status, "in-progress");
    assert.equal(records[1]?.status, expected);
  }
});

test("a spontaneous app-server exit records a failed agent without runtime shutdown", async () => {
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({
    transport: new ErrorTransport(new AppServerExitedError("transport exited unexpectedly")),
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  await assert.rejects(
    () => runtime.agent("survive the transport", { engine: "codex" }),
    AppServerExitedError
  );

  assert.equal(records.length, 2);
  assert.equal(records[0]?.status, "in-progress");
  assert.equal(records[1]?.status, "failed");
  assert.equal(records[1]?.attempts.at(-1)?.failure?.kind, "AppServerExitedError");
});

test("thrown non-shutdown failures retain failed status while the runtime closes", async () => {
  for (const error of [
    new Error("worker failed"),
    new EmptyAgentOutputError("worker returned no output"),
    new CodexSchemaSubsetUnsupportedError({ code: -32602, message: "unsupported schema" })
  ]) {
    const records: RuntimeAgentRecord[] = [];
    const transport = new ClosingTransport(error);
    const runtime = new EnsembleRuntime({
      transport,
      concurrencyCaps: { codex: 1 },
      defaultMaxAttempts: 1
    });
    runtime.setRunRecorder({
      recordAgent: async (record) => {
        records.push(structuredClone(record));
      }
    } as RunRecordWriter);

    const agent = runtime.agent("fail independently", { engine: "codex" });
    await transport.started;
    await runtime.close("interrupted");
    await assert.rejects(agent, error.constructor);

    assert.equal(records.length, 2);
    assert.equal(records[0]?.status, "in-progress");
    assert.equal(records[1]?.status, "failed");
  }
});

test("a returned retry-exhaustion failure retains failed status while the runtime closes", async () => {
  const records: RuntimeAgentRecord[] = [];
  const transport = new InvalidOutputDuringCloseTransport();
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  const agent = runtime.agent("return JSON", {
    engine: "codex",
    schema: { type: "object" }
  });
  await transport.started;
  await runtime.close("interrupted");

  assert.equal(await agent, null);
  assert.equal(records.length, 2);
  assert.equal(records[1]?.status, "failed");
  assert.equal(records[1]?.attempts.at(-1)?.failure?.kind, "invalid-json");
});

test("genuine shutdown errors inherit the runtime shutdown status", async () => {
  for (const error of [new EngineShutdownError("codex"), new AppServerExitedError("transport closed")]) {
    for (const status of ["timed-out", "interrupted"] as const) {
      const records: RuntimeAgentRecord[] = [];
      const transport = new ClosingTransport(error);
      const runtime = new EnsembleRuntime({
        transport,
        concurrencyCaps: { codex: 1 },
        defaultMaxAttempts: 1
      });
      runtime.setRunRecorder({
        recordAgent: async (record) => {
          records.push(structuredClone(record));
        }
      } as RunRecordWriter);

      const agent = runtime.agent("stop with the run", { engine: "codex" });
      await transport.started;
      await runtime.close(status);
      await assert.rejects(agent, error.constructor);

      assert.equal(records.length, 2);
      assert.equal(records[0]?.status, "in-progress");
      assert.equal(records[1]?.status, status);
    }
  }
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
  // Two writes per agent now — dispatch-time and settlement — so a recorder
  // that always throws surfaces two failures, and neither fails the agent.
  assert.deepEqual(events, [
    { method: "runRecord/writeFailed", message: "disk full" },
    { method: "runRecord/writeFailed", message: "disk full" }
  ]);
});

test("a run-end record write failure remains an observability event", async () => {
  const transport = new NonSettlingCloseTransport();
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  const recorder = new DispatchBlockedRecorder(true);
  runtime.setRunRecorder(recorder as unknown as RunRecordWriter);
  const events: Array<{ method: string; message: unknown }> = [];
  runtime.onEvent((event) => {
    if (event.method === "runRecord/writeFailed") {
      events.push({ method: event.method, message: event.params.message });
    }
  });

  const agent = runtime.agent("abandoned", { engine: "codex" });
  await recorder.dispatchStarted;
  await runtime.close("interrupted");

  // The second event is the close-time replacement write. Its failure does
  // not escape close() or create an invented agent failure.
  assert.deepEqual(events, [
    { method: "runRecord/writeFailed", message: "disk full" }
  ]);
  recorder.releaseDispatch();
  await assert.rejects(agent, EngineShutdownError);
});

test("runtime close terminalises an unsettled dispatch record", async () => {
  const transport = new NonSettlingCloseTransport();
  const recorder = new DispatchBlockedRecorder();
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder(recorder as unknown as RunRecordWriter);

  const agent = runtime.agent("abandoned", { engine: "codex" });
  await recorder.dispatchStarted;
  await runtime.close("interrupted");

  assert.equal(recorder.records.length, 2);
  assert.equal(recorder.records[0]?.status, "in-progress");
  assert.equal(recorder.records[1]?.status, "abandoned");
  assert.deepEqual(recorder.records[1]?.attempts, []);
  recorder.releaseDispatch();
  await assert.rejects(agent, EngineShutdownError);
});

// The Claude engine is now implemented; it is driven through the runtime with a
// fake control plane in test/unit/claude-engine.test.ts. Routing to it (and the
// isolation:'worktree' rejection) is covered there.


test("an unenforceable capability strip fails loud before any worker spawns", async () => {
  // A restriction the author asked for and did not get must never dispatch
  // silently. An adapter with no capability table
  // cannot enforce anything, so the strip is rejected pre-spawn: no
  // invocation, no progress entry, no run record.
  const invocations: string[] = [];
  const engine: EngineAdapter = {
    name: "opencode",
    concurrency: 1,
    schedule: async (task) => task(),
    createInvocation: () => {
      invocations.push("spawned");
      return { runAttempt: async () => turn("never") };
    },
    close: async () => undefined
  };
  const records: unknown[] = [];
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([engine]),
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  await assert.rejects(
    () => runtime.agent("restricted work", { engine: "opencode", strip: ["skills"] }),
    CapabilityStripUnsupportedError
  );
  assert.deepEqual(invocations, []);
  assert.deepEqual(records, []);
  await runtime.close();
});

test("a config-enforced strip reaches the engine and the durable record", async () => {
  const seenStrips: Array<readonly string[] | undefined> = [];
  const engine: EngineAdapter = {
    name: "claude",
    concurrency: 1,
    capabilities: {
      skills: { route: "config", detail: "settings deny rules" },
      agents: { route: "config", detail: "settings deny rules" }
    },
    schedule: async (task) => task(),
    createInvocation: (_prompt, options) => {
      seenStrips.push(options.strip);
      return { runAttempt: async () => turn("done") };
    },
    close: async () => undefined
  };
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([engine]),
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  await runtime.agent("restricted work", { engine: "claude", strip: ["skills"] });

  assert.deepEqual(seenStrips, [["skills"]]);
  assert.deepEqual(records[0]?.strip, { requested: ["skills"], enforcement: { skills: "config" } });
  await runtime.close();
});

test("run-wide and per-call strips unite; a call cannot lift the run-wide one", async () => {
  const seenStrips: Array<readonly string[] | undefined> = [];
  const engine: EngineAdapter = {
    name: "claude",
    concurrency: 1,
    capabilities: {
      skills: { route: "config", detail: "settings deny rules" },
      agents: { route: "config", detail: "settings deny rules" }
    },
    schedule: async (task) => task(),
    createInvocation: (_prompt, options) => {
      seenStrips.push(options.strip);
      return { runAttempt: async () => turn("done") };
    },
    close: async () => undefined
  };
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([engine]),
    defaultMaxAttempts: 1,
    strip: ["agents"]
  });

  await runtime.agent("adds one", { engine: "claude", strip: ["skills"] });
  await runtime.agent("adds none", { engine: "claude" });

  assert.deepEqual(seenStrips, [
    ["agents", "skills"],
    ["agents"]
  ]);
  await runtime.close();
});

test("an absent capability is satisfied by construction and recorded as absent", async () => {
  // Codex's shape: the capability does not exist on the tool surface, so the
  // request is vacuously met — the worker dispatches, and the archive shows
  // the absent route rather than a silent skip.
  const records: RuntimeAgentRecord[] = [];
  const engine: EngineAdapter = {
    name: "codex",
    concurrency: 1,
    capabilities: {
      skills: { route: "absent", detail: "no skill system" },
      agents: { route: "absent", detail: "no subagent tool" }
    },
    schedule: async (task) => task(),
    createInvocation: () => ({ runAttempt: async () => turn("ok") }),
    close: async () => undefined
  };
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([engine]),
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  const output = await runtime.agent("unrestricted anyway", { engine: "codex", strip: ["skills"] });

  assert.equal(output, "ok");
  assert.deepEqual(records.at(-1)?.strip, { requested: ["skills"], enforcement: { skills: "absent" } });
  await runtime.close();
});

test("a malformed strip value is rejected before dispatch", async () => {
  const runtime = new EnsembleRuntime({
    transport: new FakeTransport([]),
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  await assert.rejects(
    () => runtime.agent("never starts", { engine: "codex", strip: ["shells"] as never }),
    InvalidAgentOptionValueError
  );
  await runtime.close();
});

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

test("an identified operational failure inside parallel resolves its envelope, never bare null", async () => {
  // agent() attaches the call's declared identity to the operational
  // failure it throws, and the combinator's collapse resolves the
  // envelope. An unidentified sibling still collapses to bare null.
  const engine: EngineAdapter = {
    name: "claude",
    concurrency: 2,
    schedule: async (task) => task(),
    createInvocation: () => ({
      runAttempt: async () => {
        throw new Error("worker transport died");
      }
    }),
    close: async () => undefined
  };
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([engine]),
    cwd: "/fake/repo",
    defaultMaxAttempts: 1
  });

  const results = await parallel<unknown>(
    [
      () => runtime.agent("fail identified", { engine: "claude", identity: true, label: "verify", phase: "check" }),
      () => runtime.agent("fail bare", { engine: "claude" })
    ],
    () => undefined
  );

  assert.deepEqual(results, [{ label: "verify", phase: "check", output: null }, null]);
});
