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
  AgentCwdRejectedError,
  AgentOptionRejectedError,
  AgentPromptRejectedError,
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
  discoveredSkillCwds: Array<string | undefined> = [];
  #responses: TurnResult[];
  #skills: readonly string[];

  constructor(responses: TurnResult[], skills: readonly string[] = []) {
    this.#responses = responses;
    this.#skills = skills;
  }

  async listSkills(cwd?: string): Promise<readonly string[]> {
    this.discoveredSkillCwds.push(cwd);
    return this.#skills;
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
  assert.deepEqual(identified, { label: "finder", phase: "hunt", output: { answer: "yes" }, failure: null });

  const bare = await runtime.agent("go", { engine: "codex", schema });
  assert.deepEqual(bare, { answer: "yes" });
});

test("an identified schema collapse still carries the worker's identity", async () => {
  // The envelope wraps every resolution, the null collapse included — the
  // fan-in filtering idiom under identity is on `output`, and a failed leg
  // keeps saying which worker it was. The discrimination: this
  // exhausted collapse carries a non-null `failure`, so it can never be
  // mistaken in-script for a worker legitimately answering null.
  const runtime = new EnsembleRuntime({
    transport: new FakeTransport([turn("not json")]),
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });

  const collapsed = (await runtime.agent("go", {
    engine: "codex",
    schema,
    label: "verifier",
    identity: true
  })) as { label: string | null; phase: string | null; output: unknown; failure: { message: string } | null };
  assert.equal(collapsed.label, "verifier");
  assert.equal(collapsed.phase, null);
  assert.equal(collapsed.output, null);
  assert.ok(collapsed.failure !== null, "an exhausted collapse must carry its failure");
  assert.ok(collapsed.failure.message.length > 0);
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

test("an effort outside the canonical vocabulary is rejected before any worker spawns", async () => {
  // Harness-owned domain: the judgement runs at
  // agent(), spending nothing — the engine-judged alternative was measured
  // rejecting only after a live thread was paid for.
  const transport = new FakeTransport([]);
  const runtime = new EnsembleRuntime({ transport, concurrencyCaps: { codex: 1 }, defaultMaxAttempts: 1 });

  await assert.rejects(
    () => runtime.agent("go", { engine: "codex", effort: "sol-high" }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidAgentOptionValueError);
      assert.match(error.message, /minimal \| low \| medium \| high \| xhigh/);
      return true;
    }
  );
  assert.equal(transport.openedThreads.length, 0);
  assert.equal(transport.turns.length, 0);
});

test("a canonical effort passes through to the Codex turn natively", async () => {
  // Codex speaks the canonical vocabulary natively, so conversion is the
  // identity and the turn params carry the requested level unchanged.
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({ transport, concurrencyCaps: { codex: 1 }, defaultMaxAttempts: 1 });

  assert.equal(await runtime.agent("go", { engine: "codex", effort: "xhigh" }), "ok");
  assert.equal(transport.turns[0]?.options?.effort, "xhigh");
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
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-runtime-per-call-cwd-"));
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });

  try {
    await runtime.agent("read", { engine: "codex", cwd: directory });
    assert.deepEqual(transport.openedThreads, [{ cwd: directory }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("invalid prompts and missing per-call cwd reject before a Codex thread opens", async () => {
  for (const prompt of [123, "", " \t\n "]) {
    const transport = new FakeTransport([turn("unused")]);
    const runtime = new EnsembleRuntime({ transport, defaultMaxAttempts: 1 });
    const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
      prompt: unknown,
      options: Record<string, unknown>
    ) => Promise<unknown>;

    await assert.rejects(
      () => unsafeAgent(prompt, { engine: "codex" }),
      (error: unknown) => {
        assert.ok(error instanceof AgentPromptRejectedError);
        assert.match(error.message, prompt === 123 ? /must be a string, got number/ : /must be a non-empty string/);
        return true;
      }
    );
    assert.equal(transport.openedThreads.length, 0);
    assert.equal(transport.turns.length, 0);
  }

  const transport = new FakeTransport([turn("unused")]);
  const runtime = new EnsembleRuntime({ transport, defaultMaxAttempts: 1 });
  await assert.rejects(
    () => runtime.agent("never starts", { engine: "codex", cwd: "this-directory-does-not-exist" }),
    AgentCwdRejectedError
  );
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
    [new TurnTimeoutError("turn timed out", { kind: "turn", timeoutMs: 1_000, threadId: "thread-1" }), "timed-out"],
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

test("the shutdown tally is fixed at the moment the run ended, not at the moment it is read", async () => {
  const transport = new ClosingTransport(new EngineShutdownError("codex"));
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });

  const agent = runtime.agent("hang until the run ends", { engine: "codex" });
  await transport.started;
  await runtime.close("interrupted");
  await assert.rejects(agent, EngineShutdownError);

  // Teardown has now settled the leg, so the live progress model no longer
  // shows it in flight — which is exactly why a supervisor's tally cannot be
  // read from there after the fact.
  assert.equal(runtime.progress.snapshot().totals.active, 0);
  // The leg was in flight at the engine, so teardown reached it and its
  // record carries the run's shutdown status: it is cut short, not
  // abandoned, and the tally says the same thing the record does.
  assert.deepEqual(runtime.shutdownTally(), { done: 0, failed: 0, cutShort: 1, unsettled: 0 });
});

test("a leg that settles on its own account during teardown is tallied by its record", async () => {
  // The close-time classification decides teardown's actions, but the
  // tally follows the records: a worker whose turn completes while
  // teardown runs is done — a cut_short figure over a record reading
  // complete would make the sentinel disagree with the archive.
  let releaseTurn: ((result: TurnResult) => void) | null = null;
  let markStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const engine: EngineAdapter = {
    name: "codex",
    concurrency: 1,
    schedule: async (task) => task(),
    createInvocation: () => ({
      runAttempt: () =>
        new Promise<TurnResult>((resolve) => {
          releaseTurn = resolve;
          markStarted?.();
        })
    }),
    close: async () => {
      releaseTurn?.(turn("finished anyway"));
    }
  };
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry([engine]), defaultMaxAttempts: 1 });

  const agent = runtime.agent("outrace teardown", { engine: "codex" });
  await started;
  await runtime.close("interrupted");

  assert.equal(await agent, "finished anyway");
  assert.deepEqual(runtime.shutdownTally(), { done: 1, failed: 0, cutShort: 0, unsettled: 0 });
});

test("a queued leg the run's end cancels is recorded as queued, and still counts cut short", async () => {
  const transport = new ClosingTransport(new EngineShutdownError("codex"));
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({ transport, concurrencyCaps: { codex: 1 }, defaultMaxAttempts: 1 });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  const onWire = runtime.agent("hold the slot", { engine: "codex" });
  await transport.started;
  const queued = runtime.agent("wait in the queue", { engine: "codex" });
  // A held session's queued turn takes the same pre-start honesty as a
  // one-shot's.
  const session = runtime.createWorkerSession({ engine: "codex" });
  const queuedTurn = session.send("wait in the session queue");
  while (records.length < 3) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  // The dispatch write's continuation flips each leg's stage to
  // "admitting" one microtask after the recorder observed the write; let
  // it land so close() classifies queued legs, not mid-dispatch ones.
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.close("interrupted");
  await assert.rejects(onWire, EngineShutdownError);
  await assert.rejects(queued, EngineShutdownError);
  await assert.rejects(queuedTurn, EngineShutdownError);

  // The queued legs' turns never reached an engine, and their records say
  // so instead of claiming an in-flight turn they never had.
  for (const id of [2, 3]) {
    const settled = records.filter((record) => record.id === id).at(-1);
    assert.equal(settled?.status, "interrupted");
    assert.deepEqual(settled?.terminationCause, {
      kind: "run-interrupted",
      message: "the run ended (interrupted) before this worker's queued turn was dispatched"
    });
    assert.deepEqual(settled?.attempts, []);
  }
  // Every leg was settled by the run ending — on the wire or queued — so
  // all are cut short, per the tally's own definition.
  assert.deepEqual(runtime.shutdownTally(), { done: 0, failed: 0, cutShort: 3, unsettled: 0 });

  // close() is latched: a second call joins the first and must not rebuild
  // the tally from post-teardown progress totals, which count run-caused
  // settlements as failures.
  await runtime.close("failed");
  assert.deepEqual(runtime.shutdownTally(), { done: 0, failed: 0, cutShort: 3, unsettled: 0 });
});

test("a failed engine teardown rejects close() after cleanup completes, never silently", async () => {
  const engine: EngineAdapter = {
    name: "codex",
    concurrency: 1,
    schedule: async (task) => task(),
    createInvocation: () => ({ runAttempt: async () => turn("unused") }),
    close: async () => {
      throw new Error("engine cancel failed");
    }
  };
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry([engine]), defaultMaxAttempts: 1 });

  // The failure is not swallowed (the cancellation promise stays
  // attributable) — and it does not abort cleanup: the tally is still
  // published behind the rejection.
  await assert.rejects(() => runtime.close("interrupted"), /engine cancel failed/);
  assert.deepEqual(runtime.shutdownTally(), { done: 0, failed: 0, cutShort: 0, unsettled: 0 });
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
  // A leg whose turn never reached an engine is the one close() abandons —
  // no outcome was ever observed for it — and that is what `unsettled`
  // counts, distinct from a leg teardown cut short with a record.
  assert.deepEqual(runtime.shutdownTally(), { done: 0, failed: 0, cutShort: 0, unsettled: 1 });
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
  assert.deepEqual(records[0]?.strip, {
    requested: ["skills"],
    enforcement: { skills: { route: "config", detail: "settings deny rules" } }
  });
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
  // The capability does not exist on the engine's tool surface, so the
  // request is vacuously met — the worker dispatches, and the archive shows
  // the absent route rather than a silent skip. (Injected table: no shipped
  // adapter currently declares an absent route.)
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
  assert.deepEqual(records.at(-1)?.strip, {
    requested: ["skills"],
    enforcement: { skills: { route: "absent", detail: "no skill system" } }
  });
  await runtime.close();
});

test("a codex skills strip denies the stabilised discovery set; an unstripped call sends none", async () => {
  // The Codex enforcement route end-to-end through the real adapter: the
  // strip becomes thread/start's per-thread config overlay. The stabilised
  // discovery result carries filesystem and plugin-scope names. A dispatch
  // that asks for nothing carries no overlay or discovery request at all.
  const transport = new FakeTransport(
    [turn("restricted"), turn("unrestricted")],
    ["plugin-management:plugin-management", "repo-skill"]
  );
  const records: RuntimeAgentRecord[] = [];
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
  try {
    await runtime.agent("restricted work", { engine: "codex", strip: ["skills"] });
    await runtime.agent("unrestricted work", { engine: "codex" });

    assert.deepEqual(transport.discoveredSkillCwds, [process.cwd()]);
    assert.deepEqual(transport.openedThreads[0]?.threadConfig, {
      skills: {
        bundled: { enabled: false },
        config: [
          { name: "plugin-management:plugin-management", enabled: false },
          { name: "repo-skill", enabled: false }
        ]
      }
    });
    assert.ok(!("threadConfig" in (transport.openedThreads[1] ?? {})));
    assert.deepEqual(records[0]?.strip, {
      requested: ["skills"],
      enforcement: {
        skills: {
          route: "config",
          detail:
            "measured 2026-08-30 on codex-cli 0.151.0: thread/start disables bundled skills and denies every name only after app-server discovery grows then repeats, including plugin scope (up to 10 samples at 1000 ms spacing; re-verify per codex-cli upgrade)"
        }
      }
    });
  } finally {
    await runtime.close();
  }
});

test("codex skill discovery is paid once per transport and cwd, not per stripped dispatch", async () => {
  // The stabilisation loop is seconds of wall-clock inside a held admission
  // slot: sibling stripped dispatches, retries, and thread re-opens read
  // the cached result rather than re-paying it. Pre-fix, each dispatch ran
  // its own discovery.
  const transport = new FakeTransport([turn("one"), turn("two")], ["repo-skill"]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  try {
    await runtime.agent("first stripped", { engine: "codex", strip: ["skills"] });
    await runtime.agent("second stripped", { engine: "codex", strip: ["skills"] });
    assert.equal(transport.discoveredSkillCwds.length, 1);
    // Both dispatches still carry the complete overlay.
    for (const opened of transport.openedThreads) {
      assert.deepEqual(opened.threadConfig, {
        skills: { bundled: { enabled: false }, config: [{ name: "repo-skill", enabled: false }] }
      });
    }
  } finally {
    await runtime.close();
  }
});

test("a codex session under a skills strip pays discovery once across its turns", async () => {
  const transport = new FakeTransport([turn("one"), turn("two")], ["repo-skill"]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  try {
    const session = runtime.createWorkerSession({ engine: "codex", strip: ["skills"] });
    await session.send("first turn");
    await session.send("second turn");
    assert.equal(transport.discoveredSkillCwds.length, 1, "one discovery serves the session's whole life");
    assert.deepEqual(transport.openedThreads[0]?.threadConfig, {
      skills: { bundled: { enabled: false }, config: [{ name: "repo-skill", enabled: false }] }
    });
    await session.close();
  } finally {
    await runtime.close();
  }
});

test("a Codex skills strip fails loud before a thread opens when discovery is unavailable", async () => {
  const transport = new FakeTransport([]);
  Object.defineProperty(transport, "listSkills", { value: undefined });
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  await assert.rejects(
    () => runtime.agent("never starts", { engine: "codex", strip: ["skills"] }),
    CapabilityStripUnsupportedError
  );
  assert.deepEqual(transport.openedThreads, []);
  await runtime.close();
});

test("a Codex agents-only strip keeps skills untouched", async () => {
  const transport = new FakeTransport([turn("restricted")], ["should-not-be-read"]);
  const records: RuntimeAgentRecord[] = [];
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
  try {
    await runtime.agent("restricted work", { engine: "codex", strip: ["agents"] });
    assert.deepEqual(transport.discoveredSkillCwds, []);
    assert.deepEqual(transport.openedThreads, [{ cwd: process.cwd(), threadConfig: { agents: { enabled: false } } }]);
    assert.deepEqual(records[0]?.strip, {
      requested: ["agents"],
      enforcement: {
        agents: {
          route: "config",
          detail:
            "measured 2026-08-28 on codex-cli 0.149.1: thread/start config overlay agents.enabled=false removes the collaboration tool namespace"
        }
      }
    });
  } finally {
    await runtime.close();
  }
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

test("a non-Error rejection cannot shed an identified leg's discrimination", async () => {
  // Promises may reject with any value; the identity carrier is a property
  // on an Error, so agent() wraps a non-Error rejection rather than let the
  // rejection's spelling reopen the silent-empty-success case.
  const engine: EngineAdapter = {
    name: "claude",
    concurrency: 1,
    schedule: async (task) => task(),
    createInvocation: () => ({
      runAttempt: () => Promise.reject("string rejection, not an Error")
    }),
    close: async () => undefined
  };
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([engine]),
    cwd: "/fake/repo",
    defaultMaxAttempts: 1
  });

  const results = await parallel<unknown>(
    [() => runtime.agent("fail oddly", { engine: "claude", identity: true, label: "verify" })],
    () => undefined
  );
  const [identified] = results as [{ label: string | null; output: unknown; failure: { message: string } | null }];
  assert.equal(identified.label, "verify");
  assert.equal(identified.output, null);
  assert.ok(identified.failure !== null, "the wrapped rejection still carries the discrimination");
  assert.match(identified.failure.message, /string rejection, not an Error/);
});

test("an identified operational failure inside parallel resolves its envelope, never bare null", async () => {
  // An identified operational failure resolves to an envelope carrying
  // the call's identity and failure account. parallel() preserves that
  // value; the unidentified sibling resolves to bare null.
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

  const [identified, bare] = results as [
    { label: string | null; phase: string | null; output: unknown; failure: { message: string } | null },
    unknown
  ];
  assert.equal(bare, null);
  assert.equal(identified.label, "verify");
  assert.equal(identified.phase, "check");
  assert.equal(identified.output, null);
  assert.ok(identified.failure !== null, "a collapsed identified leg must carry its failure");
  assert.ok(identified.failure.message.length > 0);
});

test("an engine-reported attempt duration is recorded as the engine measured it", async () => {
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({
    transport: new FakeTransport([turn('{"ok":true}')]),
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  await runtime.agent("read", { engine: "codex" });

  // turn() reports 10ms; the record must not substitute its own wall clock
  // for a duration the engine actually observed.
  assert.equal(records.at(-1)?.attempts[0]?.durationMs, 10);
  await runtime.close();
});

test("a run that ends under an in-flight turn names itself as the cause, agent and attempt alike", async () => {
  for (const [status, expectedKind] of [
    ["interrupted", "run-interrupted"],
    ["timed-out", "run-timed-out"]
  ] as const) {
    const records: RuntimeAgentRecord[] = [];
    const transport = new ClosingTransport(new AppServerExitedError("codex app-server closed"));
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

    const agent = runtime.agent("run past the end", { engine: "codex" });
    await transport.started;
    await runtime.close(status);
    await assert.rejects(agent, AppServerExitedError);

    // The runtime settles the status and the cause together: a consumer must
    // not have to infer why a worker is interrupted or timed out.
    const settled = records.at(-1);
    assert.equal(settled?.status, status);
    assert.deepEqual(settled?.terminationCause, {
      kind: expectedKind,
      message: `the run ended (${status}) while this worker's turn was in flight`
    });

    // The attempt is where a consumer walking the record reads a cause, so
    // it must not report the run's own teardown as an engine fault. The
    // transport symptom is kept beside it rather than destroyed.
    const attempt = settled?.attempts.at(-1);
    assert.deepEqual(attempt?.failure, {
      kind: expectedKind,
      message: `the run ended (${status}) while this worker's turn was in flight`
    });
    assert.deepEqual(attempt?.observedFailure, {
      kind: "AppServerExitedError",
      message: "codex app-server closed"
    });
  }
});

test("an engine's own failure stays the attempt's cause, with nothing beside it", async () => {
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

  await assert.rejects(() => runtime.agent("survive the transport", { engine: "codex" }), AppServerExitedError);

  const attempt = records.at(-1)?.attempts.at(-1);
  assert.deepEqual(attempt?.failure, {
    kind: "AppServerExitedError",
    message: "transport exited unexpectedly"
  });
  assert.equal(attempt?.observedFailure, null);
  assert.equal(records.at(-1)?.terminationCause, null);
});

test("a dispatch the engine refuses before any attempt records the engine's own diagnostic", async () => {
  // The raising case for this record's truthfulness: a call naming a model
  // the engine does not serve is rejected as the invocation is created, so
  // no attempt is ever pushed. The record must still say why — a `failed`
  // status beside a null cause and an empty attempts array leaves a cold
  // consumer unable to distinguish an explicit refusal from a lost account.
  const engine: EngineAdapter = {
    name: "codex",
    concurrency: 1,
    schedule: async (task) => task(),
    createInvocation: () => {
      // Stands for the engine's own rejection, carrying its wording: the
      // adapter raises whatever its transport reported rather than a
      // runtime-shaped error.
      const rejection = new Error("model 'gpt-5.6-nonesuch' is not available");
      rejection.name = "ModelNotFoundError";
      throw rejection;
    },
    close: async () => undefined
  };
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry([engine]), defaultMaxAttempts: 1 });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  await assert.rejects(
    () => runtime.agent("work the engine will not take", { engine: "codex", model: "gpt-5.6-nonesuch" }),
    /model 'gpt-5\.6-nonesuch' is not available/
  );

  const settled = records.at(-1);
  assert.equal(settled?.status, "failed");
  assert.deepEqual(settled?.attempts, []);
  assert.deepEqual(settled?.terminationCause, {
    kind: "ModelNotFoundError",
    message: "model 'gpt-5.6-nonesuch' is not available"
  });
  await runtime.close();
});

test("a refusal the runtime cannot read an account from records the absence and its reason", async () => {
  // The honesty rule in its other direction. Where an engine's rejection
  // arrives as something with no legible account, the record must neither
  // crash the settlement nor publish wording the engine never produced: it
  // says the account is unavailable and names the shape it holds, so a cold
  // consumer can tell an engine that said nothing from a lost diagnostic.
  const undescribable = { toString: () => { throw new Error("this value refuses to describe itself"); } };
  const silentError = new Error("");
  silentError.name = "SilentEngineError";

  const cases: { label: string; rejection: unknown; expected: string }[] = [
    {
      label: "an Error carrying no message",
      rejection: silentError,
      expected: "the agent failed with no attempt recorded and the rejection the runtime holds (SilentEngineError) carried no message"
    },
    {
      label: "a plain object with nothing to say",
      rejection: { code: 7 },
      expected:
        "the agent failed with no attempt recorded and the rejection the runtime holds (a value of type object) could not be described"
    },
    {
      label: "a value whose own toString throws",
      rejection: undescribable,
      expected:
        "the agent failed with no attempt recorded and the rejection the runtime holds (a value of type object) could not be described"
    }
  ];

  for (const { label, rejection, expected } of cases) {
    const engine: EngineAdapter = {
      name: "codex",
      concurrency: 1,
      schedule: async (task) => task(),
      createInvocation: () => {
        throw rejection;
      },
      close: async () => undefined
    };
    const records: RuntimeAgentRecord[] = [];
    const runtime = new EnsembleRuntime({ engines: new EngineRegistry([engine]), defaultMaxAttempts: 1 });
    runtime.setRunRecorder({
      recordAgent: async (record) => {
        records.push(structuredClone(record));
      }
    } as RunRecordWriter);

    await assert.rejects(() => runtime.agent(`dispatch rejected by ${label}`, { engine: "codex" }));

    // The refusal still settles the record the dispatch wrote, rather than
    // leaving the in-progress write as the archive's last word on it.
    assert.equal(records.length, 2, label);
    assert.equal(records[0]?.status, "in-progress", label);
    const settled = records.at(-1);
    assert.equal(settled?.status, "failed", label);
    assert.deepEqual(settled?.attempts, [], label);
    // Not a generic "failed": the kind marks the account as unavailable and
    // the message says why it is unavailable rather than inventing a cause.
    assert.deepEqual(settled?.terminationCause, { kind: "unavailable", message: expected }, label);
    await runtime.close();
  }
});

test("a thrown string reaches the record as the words the engine actually threw", async () => {
  // A non-Error rejection still carries a real account when it has one; the
  // unavailable branch must not swallow it.
  const engine: EngineAdapter = {
    name: "codex",
    concurrency: 1,
    schedule: async (task) => task(),
    createInvocation: () => {
      throw "unknown model: gpt-5.6-nonesuch";
    },
    close: async () => undefined
  };
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry([engine]), defaultMaxAttempts: 1 });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  await assert.rejects(() => runtime.agent("work the engine will not take", { engine: "codex" }));

  assert.deepEqual(records.at(-1)?.terminationCause, {
    kind: "error",
    message: "unknown model: gpt-5.6-nonesuch"
  });
  await runtime.close();
});
