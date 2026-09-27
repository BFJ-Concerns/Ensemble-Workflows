import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { appServerErrorFromPayload } from "../../src/app-server.js";
import { CodexEngineAdapter, EngineRegistry } from "../../src/engines.js";
import { parallel } from "../../src/hooks.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import {
  AgentCwdRejectedError,
  AgentOptionRejectedError,
  AgentPromptRejectedError,
  AppServerExitedError,
  AppServerFirstOutputTimeoutError,
  AppServerOverloadedError,
  AppServerStartupTimeoutError,
  AppServerSystemError,
  BudgetExceededError,
  ClaudeDispatchError,
  CodexSchemaSubsetUnsupportedError,
  CodexSubstrateRefusedError,
  EngineShutdownError,
  CapabilityStripUnsupportedError,
  FallbackTargetRejectedError,
  InvalidAgentOptionValueError,
  InvalidAgentSchemaError,
  MissingEngineError,
  RemovedAgentOptionError,
  TurnTimeoutError,
  WorktreePlacementRejectedError
} from "../../src/errors.js";

import type { RunRecordWriter, RuntimeAgentRecord } from "../../src/run-record.js";
import { Scheduler } from "../../src/scheduler.js";

import type { EngineAdapter, EngineAttemptResult, EngineInvocation, EngineTurnOptions } from "../../src/engines.js";

import type {
  AgentOptions,
  EngineName,
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

// ---------------------------------------------------------------------------
// Once a worker has spawned, its failure is a value: the same three
// settlements on the text shape as on the schema shape, the account on the
// record and the identity envelope, the failure announced as an event — and
// the spawn boundary, on whose far side every rejection still throws.

test("a text call's exhausted attempts resolve null with the account on the record, exactly as a schema call's do", async () => {
  // Empty answers exhaust the bound on both shapes; neither throws, both
  // settle `failed` with the same per-attempt evidence.
  for (const shape of ["text", "schema"] as const) {
    const transport = new FakeTransport([turn(""), turn("   ")]);
    const records: RuntimeAgentRecord[] = [];
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    const runtime = new EnsembleRuntime({ transport, concurrencyCaps: { codex: 1 }, defaultMaxAttempts: 2 });
    runtime.setRunRecorder({
      recordAgent: async (record) => {
        records.push(structuredClone(record));
      }
    } as RunRecordWriter);
    runtime.onEvent((event) => {
      if (event.method.endsWith("/agentFailed")) {
        events.push({ method: event.method, params: event.params });
      }
    });

    const value = await runtime.agent("say something", {
      engine: "codex",
      label: "quiet",
      ...(shape === "schema" ? { schema } : {})
    });

    assert.equal(value, null, shape);
    assert.equal(transport.turns.length, 2, shape);
    const settled = records.at(-1);
    assert.equal(settled?.status, "failed", shape);
    assert.deepEqual(
      settled?.attempts.map((attempt) => attempt.failure?.kind),
      ["empty-output", "empty-output"],
      shape
    );
    // The account the script no longer receives as a throw is announced
    // instead, under the engine's tag, with the record's own words.
    assert.deepEqual(
      events,
      [
        {
          method: "codex/agentFailed",
          params: {
            agentId: 1,
            label: "quiet",
            phase: null,
            status: "failed",
            attempts: 2,
            failure: { kind: "empty-output", message: "agent returned empty text on attempt 2" },
            // An answered failure has no thrown error for the diagnosis
            // seam to present; the notice reads the record's own account.
            diagnosis: null
          }
        }
      ],
      shape
    );
    // A failed worker never joins the completed-output salvage list.
    assert.deepEqual(runtime.completedOutputs(), [], shape);
    await runtime.close();
  }
});

test("a transport error mid-attempt resolves null with the thrown failure's class on the record", async () => {
  // The thrown shape (the Codex transport's): the loop records the throw,
  // the settlement reads its evidence, and the call resolves the value —
  // the throw itself is never the script's to catch.
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

  const identified = await runtime.agent("ride the transport", { engine: "codex", identity: true, label: "rider" });

  // The identity envelope's discrimination carries the same account.
  assert.deepEqual(identified, {
    label: "rider",
    phase: null,
    output: null,
    failure: { message: "AppServerExitedError: transport exited unexpectedly" }
  });
  assert.equal(records.at(-1)?.status, "failed");
  assert.equal(records.at(-1)?.attempts.at(-1)?.failure?.kind, "AppServerExitedError");
  await runtime.close();
});

test("a bare text call inside parallel resolves null in its slot, never a thunk collapse", async () => {
  // The combinators' catch is for thunks that throw; a dispatched worker's
  // failure never reaches it. The slot holds the worker's own null, and an
  // identified sibling's envelope discriminates the failure in-script.
  const engine: EngineAdapter = {
    name: "claude",
    concurrency: 2,
    schedule: async (task) => task(),
    createInvocation: (prompt) => ({
      runAttempt: async () => {
        if (prompt === "fail") {
          throw new Error("worker transport died");
        }
        return turn("answered");
      }
    }),
    close: async () => undefined
  };
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry([engine]), cwd: "/fake/repo", defaultMaxAttempts: 1 });
  const collapses: string[] = [];

  const results = await parallel<unknown>(
    [
      () => runtime.agent("fail", { engine: "claude" }),
      () => runtime.agent("fail", { engine: "claude", identity: true, label: "checked" }),
      () => runtime.agent("answer", { engine: "claude" })
    ],
    (message) => collapses.push(message)
  );

  assert.deepEqual(results, [
    null,
    { label: "checked", phase: null, output: null, failure: { message: "Error: worker transport died" } },
    "answered"
  ]);
  assert.deepEqual(collapses, [], "no thunk collapsed: the failures were values");
  await runtime.close();
});

test("the spawn boundary: an engine refusing the dispatch itself still throws, with no attempt on the record", async () => {
  // No worker existed, so there is nothing to resolve a value for — the
  // refusal stays loud, and the record says why.
  const engine: EngineAdapter = {
    name: "codex",
    concurrency: 1,
    schedule: async (task) => task(),
    createInvocation: () => {
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
    () => runtime.agent("never dispatched", { engine: "codex", model: "gpt-5.6-nonesuch" }),
    /model 'gpt-5\.6-nonesuch' is not available/
  );
  assert.deepEqual(records.at(-1)?.attempts, []);
  assert.equal(records.at(-1)?.status, "failed");
  await runtime.close();
});

test("the spawn boundary: the run's own ending still throws through a dispatched leg", async () => {
  // A leg torn down by the run closing is not the worker failing: the
  // throw is how a bare await and the combinators alike see the run stop,
  // and the record carries the run's settlement, not a worker failure.
  const transport = new ClosingTransport(new EngineShutdownError("codex"));
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({ transport, concurrencyCaps: { codex: 1 }, defaultMaxAttempts: 1 });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  const leg = runtime.agent("outlive the run", { engine: "codex" });
  await transport.started;
  await runtime.close("interrupted");

  await assert.rejects(leg, EngineShutdownError);
  assert.equal(records.at(-1)?.status, "interrupted");
  assert.equal(records.at(-1)?.terminationCause?.kind, "run-interrupted");
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

  const records: RuntimeAgentRecord[] = [];
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  // The rejection arrives after the turn was dispatched, so it is the
  // worker's failure and the call resolves null — the distinguishing
  // class and the server's own diagnostic ride the attempt record.
  assert.equal(await runtime.agent("return JSON", { engine: "codex", schema }), null);
  const failure = records.at(-1)?.attempts.at(-1)?.failure;
  assert.equal(failure?.kind, "CodexSchemaSubsetUnsupportedError");
  assert.match(failure?.message ?? "", /outside Codex's accepted subset or malformed/);
  assert.doesNotMatch(failure?.message ?? "", /turn\/start failed/);
  assert.match(failure?.message ?? "", /-32602/);
  assert.match(failure?.message ?? "", /invalid_json_schema/);
  assert.match(failure?.message ?? "", /required key missing from properties/);
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
  // bound: every attempt runs, and the exhausted transport failure resolves
  // as the call's value with the account on the record.
  assert.equal(await runtime.agent("overloaded", { engine: "codex" }), null);

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

  assert.equal(await runtime.agent("commit then fail", { engine: "codex", isolation: "worktree" }), null);

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

  // The worker answered; its placement's finalisation failed after the
  // fact. That failure settles the dispatched leg as a value, with the
  // finalisation error as the record's account and the event still raised.
  assert.equal(await runtime.agent("commit before removing the worktree path", { engine: "codex", isolation: "worktree" }), null);

  assert.deepEqual(records.at(-1)?.terminationCause, {
    kind: "Error",
    message: finalisationError.message
  });
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

  assert.equal(await runtime.agent("commit then fail", { engine: "codex", isolation: "worktree" }), null);

  // The worker's own failure is the attempt's account; the finalisation
  // failure that followed is reported as its event, not promoted over it.
  assert.equal(records.at(-1)?.attempts.at(-1)?.failure?.message, workerError.message);
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

  // An engine that refuses the call as the invocation is created — after
  // the placement opened, before any worker spawned — must still see its
  // worktree finalised.
  const refusing: EngineAdapter = {
    name: "codex",
    concurrency: 1,
    schedule: async (task) => task(),
    createInvocation: () => {
      throw new InvalidAgentOptionValueError("effort", "sideways", "a canonical level");
    },
    close: async () => undefined
  };
  const refusingRuntime = new EnsembleRuntime({
    engines: new EngineRegistry([refusing]),
    cwd: "/fake/repo",
    defaultMaxAttempts: 1,
    worktreeManager
  });

  await assert.rejects(
    () =>
      refusingRuntime.agent("never starts", {
        engine: "codex",
        isolation: "worktree"
      }),
    InvalidAgentOptionValueError
  );

  assert.equal(transport.openedThreads.length, 0);
  assert.equal(worktreeManager.finished.length, 1);
  assert.equal(refusingRuntime.worktrees[0]?.removed, true);
  void runtime;
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

test("a cwd that refuses to describe itself is rejected by name, not by its own throw", async () => {
  const transport = new FakeTransport([turn("unused")]);
  const runtime = new EnsembleRuntime({ transport, defaultMaxAttempts: 1 });
  const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
    prompt: string,
    options: Record<string, unknown>
  ) => Promise<unknown>;

  // Every trap throws a plain object, so the value refuses both routes the
  // rejection message could take to describe it (`JSON.stringify` enumerates
  // its keys; `String` asks it for a primitive). Untyped, `cwd` reaches
  // `path.resolve` inside the placement check and this bare object comes back
  // out of agent() in place of any rejection — undescribable to the operator
  // and to the archive's terminal error alike.
  const opaque = { reason: "not an Error and describes nothing" };
  const undescribableCwd = new Proxy(
    {},
    {
      ownKeys() {
        throw opaque;
      },
      getOwnPropertyDescriptor() {
        throw opaque;
      },
      get() {
        throw opaque;
      }
    }
  );

  await assert.rejects(
    () => unsafeAgent("never starts", { engine: "codex", cwd: undescribableCwd }),
    (error: unknown) => {
      assert.ok(error instanceof AgentOptionRejectedError);
      assert.match(error.message, /option "cwd"/);
      assert.match(error.message, /expected a string path/);
      // The message had to be built over a value that throws from both
      // description routes; a formatter that let that throw escape would
      // destroy the very rejection it was describing.
      assert.match(error.message, /cannot be described/);
      return true;
    }
  );
  assert.equal(transport.openedThreads.length, 0);
  assert.equal(transport.turns.length, 0);
});

test("a cwd whose property access throws is rejected by name, not by the author's own error", async () => {
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

  // The reproduction as it actually occurs: not a hostile *value* but an
  // options object that refuses the read. Nothing downstream checks `cwd`
  // before using it, so without a named rejection this error escapes from
  // inside the placement check as the call's entire outcome — naming no
  // option, and reaching the operator and the archive's terminal error as
  // whatever the workflow's object chose to raise.
  const options: Record<string, unknown> = { engine: "codex" };
  const refusal = new Error("cwd getter witness");
  Object.defineProperty(options, "cwd", {
    enumerable: true,
    get() {
      throw refusal;
    }
  });

  await assert.rejects(
    () => unsafeAgent("never starts", options),
    (error: unknown) => {
      assert.ok(error instanceof AgentOptionRejectedError);
      assert.match(error.message, /option "cwd"/);
      assert.match(error.message, /reading its value threw/);
      assert.match(error.message, /expected a string path/);
      assert.equal((error as Error).cause, refusal);
      return true;
    }
  );
  assert.equal(transport.openedThreads.length, 0);
  assert.equal(transport.turns.length, 0);
});

test("a cwd is read once, so it cannot answer differently after the call is admitted", async () => {
  const transport = new FakeTransport([turn("done")]);
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
  const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
    prompt: string,
    options: Record<string, unknown>
  ) => Promise<unknown>;

  // The harder half of the reported route: an accessor that answers once and
  // refuses afterwards. A value read afresh at each use is judged on the
  // first answer and used on a later one, and the later refusal lands
  // wherever the next read happens to be — the placement check before the
  // record is written, or the placement that opens after it, so the call
  // dies with no agent record while the run's manifest still seals cleanly.
  let reads = 0;
  const options: Record<string, unknown> = { engine: "codex" };
  Object.defineProperty(options, "cwd", {
    enumerable: true,
    get() {
      reads += 1;
      if (reads > 1) {
        throw new Error("cwd getter witness");
      }
      return ".";
    }
  });

  const output = await unsafeAgent("runs to completion", options);

  assert.equal(output, "done");
  assert.equal(reads, 1);
  assert.equal(transport.turns.length, 1);
  assert.equal(records.at(-1)?.resolvedCwd, path.resolve("."));
  assert.equal(records.at(-1)?.status, "complete");
});

test("a cwd snapshot preserves other options supplied by a Proxy get trap", async () => {
  const transport = new FakeTransport([turn("done")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
    prompt: string,
    options: Record<string, unknown>
  ) => Promise<unknown>;

  let cwdReads = 0;
  const options = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === "cwd") {
          cwdReads += 1;
          if (cwdReads > 1) throw new Error("second cwd read escaped the snapshot");
          return ".";
        }
        if (property === "engine") return "codex";
        if (property === "timeoutMs") return 1_234;
        return undefined;
      }
    }
  );

  assert.equal(await unsafeAgent("runs to completion", options), "done");
  assert.equal(cwdReads, 1);
  assert.equal(transport.turns.length, 1);
  assert.equal(transport.turns[0]?.options.timeoutMs, 1_234);
});

test("an inherited cwd getter that first returns undefined cannot throw after its snapshot", async () => {
  const transport = new FakeTransport([turn("done")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
    prompt: string,
    options: Record<string, unknown>
  ) => Promise<unknown>;

  let reads = 0;
  const options = Object.create({
    get cwd() {
      reads += 1;
      if (reads > 1) throw new Error("second inherited cwd read escaped the snapshot");
      return undefined;
    }
  }) as Record<string, unknown>;
  options.engine = "codex";

  assert.equal(await unsafeAgent("runs to completion", options), "done");
  assert.equal(reads, 1);
  assert.equal(transport.turns.length, 1);
});

test("an inherited cwd getter that later returns a path cannot alter its undefined snapshot", async () => {
  const transport = new FakeTransport([turn("done")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
    prompt: string,
    options: Record<string, unknown>
  ) => Promise<unknown>;

  let reads = 0;
  const options = Object.create({
    get cwd() {
      reads += 1;
      return reads === 1 ? undefined : ".";
    }
  }) as Record<string, unknown>;
  options.engine = "codex";

  assert.equal(await unsafeAgent("runs to completion", options), "done");
  assert.equal(reads, 1);
  assert.equal(transport.turns.length, 1);
});

test("a Proxy cannot use cwd membership to return a live options object after its snapshot", async () => {
  const transport = new FakeTransport([turn("done")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
    prompt: string,
    options: Record<string, unknown>
  ) => Promise<unknown>;

  let cwdReads = 0;
  let cwdMembershipChecks = 0;
  const options = new Proxy<Record<string, unknown>>(
    { engine: "codex", cwd: "." },
    {
      get(target, property, receiver) {
        if (property === "cwd") {
          cwdReads += 1;
          if (cwdReads > 1) throw new Error("second cwd read escaped the snapshot");
        }
        return Reflect.get(target, property, receiver);
      },
      has(target, property) {
        if (property === "cwd") {
          cwdMembershipChecks += 1;
          return false;
        }
        return Reflect.has(target, property);
      }
    }
  );

  assert.equal(await unsafeAgent("runs to completion", options), "done");
  assert.equal(cwdReads, 1);
  assert.equal(cwdMembershipChecks, 0);
  assert.equal(transport.turns.length, 1);
});

test("a throwing Proxy cwd membership trap cannot escape the cwd snapshot", async () => {
  const transport = new FakeTransport([turn("done")]);
  const runtime = new EnsembleRuntime({
    transport,
    concurrencyCaps: { codex: 1 },
    defaultMaxAttempts: 1
  });
  const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
    prompt: string,
    options: Record<string, unknown>
  ) => Promise<unknown>;

  const membershipRefusal = new Error("cwd membership witness");
  const options = new Proxy<Record<string, unknown>>(
    { engine: "codex", cwd: "." },
    {
      has(target, property) {
        if (property === "cwd") throw membershipRefusal;
        return Reflect.has(target, property);
      }
    }
  );

  assert.equal(await unsafeAgent("runs to completion", options), "done");
  assert.equal(transport.turns.length, 1);
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

test("an unpinned answer names the engine-reported model, not an absent request pin", async () => {
  for (const engine of ["codex", "claude"] as const) {
    const model = engine === "codex" ? "gpt-served" : "claude-served";
    const worker = new ChainEngine(engine, [async () => ({ ...turn("answered"), resolvedModel: model })]);
    const { runtime, records } = chainRuntime([worker], 1);

    assert.equal(await runtime.agent("work", { engine }), "answered");
    const settled = records.at(-1)!;
    assert.equal(settled.model, null);
    assert.equal(settled.resolvedModel, model);
    assert.deepEqual(settled.answeredBy, { entry: -1, engine, model });
    await runtime.close();
  }
});

test("an answer with no served-model report does not claim its requested pin", async () => {
  const worker = new ChainEngine("codex", [answers("answered")]);
  const { runtime, records } = chainRuntime([worker], 1);

  assert.equal(await runtime.agent("work", { engine: "codex", model: "gpt-requested" }), "answered");
  const settled = records.at(-1)!;
  assert.equal(settled.model, "gpt-requested");
  assert.equal(settled.attempts[0]?.resolvedModel, null);
  assert.deepEqual(settled.answeredBy, { entry: -1, engine: "codex", model: null });
  await runtime.close();
});

test("each held turn's attempt retains the worker's observed model", async () => {
  const model = "gpt-served";
  const transport = new FakeTransport([
    { ...turn("first"), resolvedModel: model },
    turn("second"),
    turn("third")
  ]);
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({ transport, concurrencyCaps: { codex: 1 }, defaultMaxAttempts: 1 });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);
  const session = runtime.createWorkerSession({ engine: "codex" });

  for (const prompt of ["first", "second", "third"]) {
    assert.equal(await session.send(prompt), prompt);
  }

  const settled = records.filter((record) => record.status === "complete");
  assert.equal(transport.openedThreads.length, 1);
  assert.deepEqual(settled.map((record) => record.session?.turn), [1, 2, 3]);
  assert.deepEqual(settled.map((record) => record.attempts[0]?.resolvedModel), [model, model, model]);
  assert.deepEqual(settled.map((record) => record.answeredBy?.model), [model, model, model]);
  await session.close();
  await runtime.close();
});

test("a held turn that answered empty acquires no served-model claim", async () => {
  // The carry-forward is for answers from the observed worker; an empty
  // answer produced nothing to attribute to it, and the carry resumes on the
  // next real answer.
  const model = "gpt-served";
  const transport = new FakeTransport([
    { ...turn("first"), resolvedModel: model },
    turn(""),
    turn("third")
  ]);
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({ transport, concurrencyCaps: { codex: 1 }, defaultMaxAttempts: 1 });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);
  const session = runtime.createWorkerSession({ engine: "codex" });

  assert.equal(await session.send("first"), "first");
  assert.equal(await session.send("second"), null);
  assert.equal(await session.send("third"), "third");

  const settled = [1, 2, 3].map((turnNumber) => records.filter((record) => record.session?.turn === turnNumber).at(-1)!);
  assert.deepEqual(settled.map((record) => record.attempts[0]?.resolvedModel), [model, null, model]);
  assert.deepEqual(settled.map((record) => record.answeredBy?.model ?? null), [model, null, model]);
  await session.close();
  await runtime.close();
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

  assert.equal(await runtime.agent("doomed prompt", { engine: "codex" }), null);

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

  assert.equal(await runtime.agent("record the engine cause", { engine: "codex" }), null);

  assert.deepEqual(records.at(-1)?.attempts.at(-1)?.appServerDiagnostic, {
    code: -32001,
    message: "backpressure from fixture",
    payload: '{"queue":"saturated"}'
  });
});

test("terminal timeout and shutdown errors retain their agent statuses with two transition writes", async () => {
  // A turn deadline is the worker's own failure and resolves as a value; a
  // shutdown is the run ending and still throws, at the spawn boundary.
  for (const [error, expected, resolution] of [
    [new TurnTimeoutError("turn timed out", { kind: "turn", timeoutMs: 1_000, threadId: "thread-1" }), "timed-out", "value"],
    [new EngineShutdownError("codex"), "interrupted", "throw"]
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

    if (resolution === "value") {
      assert.equal(await runtime.agent("stop", { engine: "codex" }), null);
    } else {
      await assert.rejects(() => runtime.agent("stop", { engine: "codex" }), error.constructor);
    }

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

  assert.equal(await runtime.agent("survive the transport", { engine: "codex" }), null);

  assert.equal(records.length, 2);
  assert.equal(records[0]?.status, "in-progress");
  assert.equal(records[1]?.status, "failed");
  assert.equal(records[1]?.attempts.at(-1)?.failure?.kind, "AppServerExitedError");
});

test("thrown non-shutdown failures retain failed status while the runtime closes", async () => {
  for (const error of [
    new Error("worker failed"),
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
    // The worker failed on its own account during teardown, so the call
    // resolves its value; only a run-caused settlement would throw.
    assert.equal(await agent, null);

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

test("the retired fallbackModel option is rejected by name, pointing at the chain that replaced it", async () => {
  const transport = new FakeTransport([turn("never reached")]);
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
    () => unsafeAgent("read", { engine: "claude", fallbackModel: "sonnet" }),
    (error: unknown) => {
      assert.ok(error instanceof RemovedAgentOptionError);
      assert.match(error.message, /"fallbackModel" was removed/);
      assert.match(error.message, /fallback: \[\{ engine, model, effort\? \}/);
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

  assert.equal(await runtime.agent("survive the transport", { engine: "codex" }), null);

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

// ---------------------------------------------------------------------------
// The fallback chain and availability classification. The fakes
// are scripted adapters recording which engine and which target options
// each dispatch reached — the chain's whole point is *which target answered*,
// so the dispatch log is the assertions' evidence, alongside the attempt
// records the chain wrote.
// ---------------------------------------------------------------------------

/**
 * One scripted engine: each createInvocation consumes the next step for its
 * model. The cap is the adapter's own — the runtime reads an injected
 * adapter's `concurrency`, never the `concurrencyCaps` option, which only
 * shapes the default registry — so a test that wants a cap of one says so
 * here.
 */
class ChainEngine implements EngineAdapter {
  readonly concurrency: number;
  readonly dispatches: Array<{ model: string | undefined; effort: string | undefined; prompt: string }> = [];
  readonly scheduler: Scheduler;
  #steps: Array<() => Promise<EngineAttemptResult>>;

  constructor(
    readonly name: EngineName,
    steps: Array<() => Promise<EngineAttemptResult>>,
    concurrency = 4
  ) {
    this.#steps = [...steps];
    this.concurrency = concurrency;
    this.scheduler = new Scheduler(concurrency);
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule(task);
  }

  createInvocation(prompt: string, options: EngineTurnOptions): EngineInvocation {
    this.dispatches.push({ model: options.model, effort: options.effort, prompt });
    return {
      runAttempt: async () => {
        const step = this.#steps.shift();
        assert.ok(step, `${this.name} engine ran out of scripted steps`);
        return step();
      }
    };
  }

  async close(): Promise<void> {}
}

/** A Codex refusal as the transport raises it: the app-server's own code riding the error. */
function codexRefusal(code: string): () => Promise<EngineAttemptResult> {
  return async () => {
    throw appServerErrorFromPayload("turn notification", { code, message: `refused: ${code}` });
  };
}

/** A Claude refusal as the engine returns it: a failed result carrying the API's status and code. */
function claudeRefusal(status: number, code: string): () => Promise<EngineAttemptResult> {
  return async () => ({
    ...turn(""),
    attemptFailure: { kind: "claude-worker-diagnostic", message: `API Error: Request rejected (${status})` },
    diagnostics: { apiError: { status, code } }
  });
}

function answers(text: string, resolvedModel?: string): () => Promise<EngineAttemptResult> {
  return async () => ({ ...turn(text), ...(resolvedModel === undefined ? {} : { resolvedModel }) });
}

function chainRuntime(engines: EngineAdapter[], defaultMaxAttempts = 3): {
  runtime: EnsembleRuntime;
  records: RuntimeAgentRecord[];
} {
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry(engines),
    cwd: "/fake/repo",
    defaultMaxAttempts
  });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);
  return { runtime, records };
}

test("an availability refusal advances the chain to the next target on the same engine, costing no attempt", async () => {
  const codex = new ChainEngine("codex", [codexRefusal("usageLimitExceeded"), answers("from the fallback", "gpt-served-fallback")]);
  const { runtime, records } = chainRuntime([codex], 1);

  const output = await runtime.agent("work", {
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    fallback: [{ engine: "codex", model: "gpt-5.6-terra" }]
  });

  assert.equal(output, "from the fallback");
  // Two dispatches on one engine: the pin, then the chain entry — which took
  // the call's own effort because it named none.
  assert.deepEqual(
    codex.dispatches.map((dispatch) => [dispatch.model, dispatch.effort]),
    [
      ["gpt-5.6-sol", "high"],
      ["gpt-5.6-terra", "high"]
    ]
  );
  const settled = records.at(-1)!;
  assert.equal(settled.status, "complete");
  // maxAttempts 1 and yet two attempt records: the refusal consumed none.
  assert.deepEqual(
    settled.attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.target, attempt.classification]),
    [
      [1, "failed", { engine: "codex", model: "gpt-5.6-sol" }, { class: "availability", rule: "codex.usage-limit" }],
      [2, "complete", { engine: "codex", model: "gpt-5.6-terra" }, null]
    ]
  );
  assert.deepEqual(settled.fallback, [{ engine: "codex", model: "gpt-5.6-terra" }]);
  assert.deepEqual(settled.answeredBy, { entry: 0, engine: "codex", model: "gpt-served-fallback" });
  await runtime.close();
});

test("a cross-engine advance releases the refused engine's slot and re-admits on the next engine", async () => {
  // Codex cap 1: if the refused Codex slot were held across the Claude step,
  // the second Codex call queued behind it could never start until the
  // Claude answer landed. The release is observed by that second call
  // running while the first is still waiting on Claude.
  let releaseClaude: () => void = () => undefined;
  const claudeGate = new Promise<void>((resolve) => {
    releaseClaude = resolve;
  });
  const codex = new ChainEngine("codex", [codexRefusal("serverOverloaded"), answers("second codex call")], 1);
  const claude = new ChainEngine(
    "claude",
    [
      async () => {
        await claudeGate;
        return turn("from claude");
      }
    ],
    1
  );
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([codex, claude]),
    cwd: "/fake/repo",
    defaultMaxAttempts: 1
  });
  // The discriminating fact: both caps really are one at the admission
  // controller, so a held Codex slot would starve the second call.
  assert.deepEqual(
    Object.entries(runtime.progress.snapshot().engines).map(([name, engine]) => [name, engine.cap]),
    [
      ["codex", 1],
      ["claude", 1]
    ]
  );
  const first = runtime.agent("chained", {
    engine: "codex",
    model: "gpt-5.6-sol",
    fallback: [{ engine: "claude", model: "opus", effort: "low" }]
  });
  // Wait until the chained call has reached Claude (its dispatch recorded).
  while (claude.dispatches.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  // Settles while the chained call is still waiting on Claude: the Codex
  // slot the refused target held has been released.
  const second = await runtime.agent("independent", { engine: "codex", model: "gpt-5.6-terra" });
  assert.equal(second, "second codex call");
  releaseClaude();
  assert.equal(await first, "from claude");
  assert.deepEqual(claude.dispatches[0], { model: "opus", effort: "low", prompt: "chained" });
  await runtime.close();
});

test("an output failure retries in place and never advances the chain", async () => {
  const codex = new ChainEngine("codex", [answers("not json"), answers("still not json")]);
  const claude = new ChainEngine("claude", [answers('{"answer":"yes"}')]);
  const { runtime, records } = chainRuntime([codex, claude], 2);

  const output = await runtime.agent("return JSON", {
    engine: "codex",
    model: "gpt-5.6-sol",
    schema,
    fallback: [{ engine: "claude", model: "opus" }]
  });

  // Both attempts on the pinned target, the chain untouched, the collapse
  // returned as it always was: a bad answer is the prompt's problem.
  assert.equal(output, null);
  assert.equal(codex.dispatches.length, 1);
  assert.equal(claude.dispatches.length, 0);
  const settled = records.at(-1)!;
  assert.deepEqual(
    settled.attempts.map((attempt) => [attempt.target.model, attempt.classification]),
    [
      ["gpt-5.6-sol", { class: "output", rule: "output" }],
      ["gpt-5.6-sol", { class: "output", rule: "output" }]
    ]
  );
  assert.equal(settled.answeredBy, null);
  await runtime.close();
});

test("the bound counts answered attempts across the chain, and a refusal on the last target keeps in-place retry", async () => {
  // Two bad answers on the pin, then an allowance wall: a per-target bound
  // or a refusal charged as an attempt would hand the fallback nothing. The
  // fallback answers on its first try and the record shows all four.
  const codex = new ChainEngine("codex", [answers(""), answers(""), codexRefusal("usageLimitExceeded")]);
  const claude = new ChainEngine("claude", [answers("finally")]);
  const { runtime, records } = chainRuntime([codex, claude], 3);

  const output = await runtime.agent("work", {
    engine: "codex",
    model: "gpt-5.6-sol",
    fallback: [{ engine: "claude", model: "opus" }]
  });
  assert.equal(output, "finally");
  const settled = records.at(-1)!;
  assert.deepEqual(
    settled.attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.target.engine, attempt.classification?.class ?? null]),
    [
      [1, "failed", "codex", "output"],
      [2, "failed", "codex", "output"],
      [3, "failed", "codex", "availability"],
      [4, "complete", "claude", null]
    ]
  );
  await runtime.close();
});

test("every target refused fails the call with the last target's own failure, every attempt classified", async () => {
  // The last target keeps today's behaviour whole: its availability failure
  // is the call's failure — here Claude's operational failure surfacing as
  // the empty-output exhaustion it always was — never a new error class.
  const codex = new ChainEngine("codex", [codexRefusal("usageLimitExceeded")]);
  const claude = new ChainEngine("claude", [claudeRefusal(429, "rate_limit")]);
  const { runtime, records } = chainRuntime([codex, claude], 1);

  assert.equal(
    await runtime.agent("work", { engine: "codex", model: "gpt-5.6-sol", fallback: [{ engine: "claude", model: "opus" }] }),
    null
  );
  const settled = records.at(-1)!;
  assert.equal(settled.status, "failed");
  assert.equal(settled.answeredBy, null);
  assert.match(settled.attempts.at(-1)?.failure?.message ?? "", /Request rejected \(429\)/);
  assert.deepEqual(
    settled.attempts.map((attempt) => attempt.classification),
    [
      { class: "availability", rule: "codex.usage-limit" },
      { class: "availability", rule: "claude.rate-limit" }
    ]
  );
  await runtime.close();
});

test("with no chain declared, an availability failure is the call's own failure, exactly as before", async () => {
  const codex = new ChainEngine("codex", [codexRefusal("usageLimitExceeded")]);
  const { runtime, records } = chainRuntime([codex], 1);

  assert.equal(await runtime.agent("work", { engine: "codex" }), null);
  const settled = records.at(-1)!;
  assert.equal(settled.status, "failed");
  assert.equal(settled.attempts[0]?.failure?.kind, "AppServerRequestError");
  // Classified all the same: the archive can be asked how often the tier
  // refused, chain or no chain.
  assert.deepEqual(settled.attempts[0]?.classification, { class: "availability", rule: "codex.usage-limit" });
  assert.deepEqual(settled.attempts[0]?.target, { engine: "codex", model: null });
  await runtime.close();
});

test("a malformed or opencode chain entry is rejected before any worker spawns", async () => {
  const codex = new ChainEngine("codex", []);
  const { runtime } = chainRuntime([codex], 1);
  const unsafeAgent = runtime.agent.bind(runtime) as unknown as (
    prompt: string,
    options: Record<string, unknown>
  ) => Promise<unknown>;

  for (const [chain, expected] of [
    [[{ engine: "opencode", model: "glm-5.2" }], /entry 0 names the opencode engine/],
    [[{ engine: "claude" }], /entry 0 must name its model/],
    [[{ engine: "claude", model: "opus", effort: "ultra" }], /entry 0 effort must be one of/],
    [[{ engine: "claude", model: "opus", cwd: "/elsewhere" }], /unrecognised key "cwd"/],
    ["opus", /must be an array/]
  ] as const) {
    await assert.rejects(
      () => unsafeAgent("work", { engine: "codex", fallback: chain }),
      (error: unknown) => {
        assert.ok(error instanceof FallbackTargetRejectedError);
        assert.match(error.message, expected);
        return true;
      }
    );
  }
  // An entry naming an engine this runtime does not carry: the validator
  // admits it, the runtime refuses it.
  await assert.rejects(
    () => runtime.agent("work", { engine: "codex", fallback: [{ engine: "claude", model: "opus" }] }),
    /the claude engine is not available to this run/
  );
  assert.equal(codex.dispatches.length, 0);
  await runtime.close();
});

test("a cross-engine advance re-resolves the capability strip against the answering engine and archives that route", async () => {
  // Enforcement routes are engine-specific: archiving Codex's route for a
  // Claude worker would let a reader believe the wrong mechanism restricted
  // the worker that actually answered. The chain re-resolves on advance.
  const codex = new ChainEngine("codex", [codexRefusal("usageLimitExceeded")]);
  const claude = new ChainEngine("claude", [answers("from claude")]);
  Object.assign(codex, { capabilities: { skills: { route: "config", detail: "thread/start overlay" }, agents: { route: "config", detail: "thread/start overlay" } } });
  Object.assign(claude, { capabilities: { skills: { route: "config", detail: "settings deny rules" }, agents: { route: "config", detail: "settings deny rules" } } });
  const { runtime, records } = chainRuntime([codex, claude], 1);

  await runtime.agent("restricted", {
    engine: "codex",
    model: "gpt-5.6-sol",
    strip: ["skills"],
    fallback: [{ engine: "claude", model: "opus" }]
  });
  const settled = records.at(-1)!;
  assert.deepEqual(settled.strip, {
    requested: ["skills"],
    enforcement: { skills: { route: "config", detail: "settings deny rules" } }
  });
  // The dispatch-time record (before any attempt) carried the declared
  // engine's route; the settlement carries the answering engine's.
  assert.deepEqual(records[0]?.strip?.enforcement, { skills: { route: "config", detail: "thread/start overlay" } });
  await runtime.close();
});

test("a chained leg's queued and execution times accumulate across the re-admission, never overwriting each other", async () => {
  const codex = new ChainEngine("codex", [codexRefusal("serverOverloaded")]);
  const claude = new ChainEngine("claude", [
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return turn("from claude");
    }
  ]);
  const { runtime, records } = chainRuntime([codex, claude], 1);

  await runtime.agent("timed", { engine: "codex", model: "gpt-5.6-sol", fallback: [{ engine: "claude", model: "opus" }] });
  const settled = records.at(-1)!;
  // Execution spans both engines' work (at least the Claude step's 30ms);
  // queued time is only the waits, never a re-count of earlier execution.
  assert.ok(settled.executionMs >= 30, `executionMs ${settled.executionMs}`);
  assert.ok(settled.queuedMs < settled.executionMs, `queuedMs ${settled.queuedMs} should not absorb execution`);
  await runtime.close();
});

// ---------------------------------------------------------------------------
// One retry rule on every engine: a thrown Codex
// failure spends an attempt and retries within the bound exactly as an
// empty answer does, the failure carried into the next attempt.
// ---------------------------------------------------------------------------

/** A transport whose first turns throw the scripted failures and whose next answers, recording every prompt it was sent. */
class ThrowThenAnswerTransport implements RuntimeTransport {
  readonly cwd = "/fake/repo";
  readonly prompts: string[] = [];
  #failures: Error[];
  #answer: string;

  constructor(failures: Error[], answer: string) {
    this.#failures = [...failures];
    this.#answer = answer;
  }

  async openThread(): Promise<string> {
    return "thread-1";
  }

  async runTurn(_threadId: string, prompt: string): Promise<TurnResult> {
    this.prompts.push(prompt);
    const failure = this.#failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    return turn(this.#answer);
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

test("a thrown Codex failure spends an attempt and retries within the bound, carried into the next attempt's prompt", async () => {
  const deadline = new TurnTimeoutError("turn on thread-1 timed out after 50ms", {
    kind: "turn",
    timeoutMs: 50,
    threadId: "thread-1"
  });
  const threadFailed = new AppServerSystemError("turn notification", { code: "threadFailed", message: "the thread failed" });
  const transport = new ThrowThenAnswerTransport([deadline, threadFailed], "third time lucky");
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({ transport, concurrencyCaps: { codex: 1 }, defaultMaxAttempts: 3 });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  assert.equal(await runtime.agent("keep trying", { engine: "codex" }), "third time lucky");

  // Three dispatches, the second and third told what went wrong before —
  // the same correction shape an empty answer gets.
  assert.equal(transport.prompts.length, 3);
  assert.equal(transport.prompts[0], "keep trying");
  assert.match(transport.prompts[1]!, /A previous attempt failed \(TurnTimeoutError\): turn on thread-1 timed out after 50ms/);
  assert.match(transport.prompts[2]!, /A previous attempt failed \(AppServerSystemError\): turn notification failed \(threadFailed\): the thread failed/);
  const settled = records.at(-1)!;
  assert.equal(settled.status, "complete");
  assert.deepEqual(
    settled.attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.failure?.kind ?? null, attempt.classification]),
    [
      [1, "failed", "TurnTimeoutError", { class: "unclassified", rule: "codex.deadline" }],
      // The app-server's code is not one the table reads: recorded with the
      // honest null rule, and retried under the one rule all the same.
      [2, "failed", "AppServerSystemError", { class: "unclassified", rule: null }],
      [3, "complete", null, null]
    ]
  );
  await runtime.close();
});

test("each named Codex post-spawn failure exhausts the bound and settles with the last attempt's own cause", async () => {
  for (const [error, status, causeKind] of [
    [
      new TurnTimeoutError("turn on thread-1 timed out after 1000ms", { kind: "turn", timeoutMs: 1_000, threadId: "thread-1" }),
      "timed-out",
      "turn-timeout"
    ],
    [
      new TurnTimeoutError("turn/start request 7 timed out after 500ms", { kind: "request", timeoutMs: 500, method: "turn/start" }),
      "timed-out",
      "request-timeout"
    ],
    [new AppServerFirstOutputTimeoutError(250), "failed", null],
    [new AppServerSystemError("turn notification", { code: "threadFailed", message: "the thread failed" }), "failed", null]
  ] as const) {
    const label = error.name;
    const transport = new ErrorTransport(error);
    const records: RuntimeAgentRecord[] = [];
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    const runtime = new EnsembleRuntime({ transport, concurrencyCaps: { codex: 1 }, defaultMaxAttempts: 3 });
    runtime.setRunRecorder({
      recordAgent: async (record) => {
        records.push(structuredClone(record));
      }
    } as RunRecordWriter);
    runtime.onEvent((event) => {
      if (event.method.endsWith("/agentFailed")) {
        events.push({ method: event.method, params: event.params });
      }
    });

    assert.equal(await runtime.agent("exhaust the bound", { engine: "codex", label: "stubborn" }), null, label);

    const settled = records.at(-1)!;
    assert.equal(settled.attempts.length, 3, label);
    assert.deepEqual(
      settled.attempts.map((attempt) => attempt.failure?.kind),
      [error.name, error.name, error.name],
      label
    );
    // The exhausting throw settles the record as a single-attempt throw
    // did: a deadline keeps `timed-out` and its kind, and the notice
    // carries the diagnosis seam's rendering rather than the class name.
    assert.equal(settled.status, status, label);
    assert.equal(settled.terminationCause?.kind ?? null, causeKind, label);
    assert.equal(events.length, 1, label);
    assert.equal(events[0]?.method, "codex/agentFailed", label);
    assert.equal(events[0]?.params.attempts, 3, label);
    assert.deepEqual(events[0]?.params.failure, { kind: error.name, message: error.message }, label);
    if (error instanceof TurnTimeoutError) {
      assert.match(String(events[0]?.params.diagnosis), /deadline/, label);
    }
    await runtime.close();
  }
});

test("the spawn boundary holds under the one rule: a pre-spawn rejection raised mid-attempt is never retried", async () => {
  // A strip found unenforceable as the thread is configured is the live
  // case; any member of the family thrown from an attempt behaves the same.
  let dispatches = 0;
  const engine: EngineAdapter = {
    name: "codex",
    concurrency: 1,
    schedule: async (task) => task(),
    createInvocation: () => ({
      runAttempt: async () => {
        dispatches += 1;
        throw new AgentOptionRejectedError("option judged as the thread was configured");
      }
    }),
    close: async () => undefined
  };
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry([engine]), defaultMaxAttempts: 3 });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  await assert.rejects(() => runtime.agent("configure", { engine: "codex" }), AgentOptionRejectedError);
  assert.equal(dispatches, 1);
  assert.equal(records.at(-1)?.attempts.length, 1);
  await runtime.close();
});

// ---------------------------------------------------------------------------
// A dispatch Claude Code refused before the session existed is a
// substrate refusal — recorded with its class, never a spent attempt,
// advancing the chain or failing the run.
// ---------------------------------------------------------------------------

const REFUSAL_TEXT =
  "Claude Code refused to dispatch worker 'ensemble-1' in /scratch/blind (workspace declared sandboxed via CLAUDE_CODE_SANDBOXED): " +
  "Workspace not trusted. Run `claude` in /scratch/blind once and accept the trust prompt, then retry.";

/** A Claude dispatch refusal as the engine throws it: the control plane's error, no session behind it. */
function claudeDispatchRefused(): () => Promise<EngineAttemptResult> {
  return async () => {
    throw new ClaudeDispatchError(REFUSAL_TEXT);
  };
}

test("a refused Claude dispatch with no chain entry left throws out of agent(), recorded once and unspent", async () => {
  const claude = new ChainEngine("claude", [claudeDispatchRefused()]);
  const { runtime, records } = chainRuntime([claude], 3);

  await assert.rejects(() => runtime.agent("blind stage", { engine: "claude", model: "opus" }), ClaudeDispatchError);

  // The bound was 3 and the refusal identical each time it would have been
  // retried: one dispatch, one refused attempt on the record, and the
  // refusal itself is what the script (and the run) sees.
  assert.equal(claude.dispatches.length, 1);
  const settled = records.at(-1)!;
  assert.equal(settled.status, "failed");
  assert.deepEqual(
    settled.attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.target, attempt.classification]),
    [[1, "failed", { engine: "claude", model: "opus" }, { class: "availability", rule: "claude.dispatch-refused" }]]
  );
  assert.deepEqual(settled.attempts[0]?.failure, { kind: "ClaudeDispatchError", message: REFUSAL_TEXT });
  assert.equal(settled.answeredBy, null);
  await runtime.close();
});

test("a refused Claude dispatch advances the chain where an entry remains, costing no attempt", async () => {
  const claude = new ChainEngine("claude", [claudeDispatchRefused()]);
  const codex = new ChainEngine("codex", [answers("from codex", "gpt-served-after-claude")]);
  const { runtime, records } = chainRuntime([claude, codex], 1);

  const output = await runtime.agent("blind stage", {
    engine: "claude",
    model: "opus",
    fallback: [{ engine: "codex", model: "gpt-6-sol" }]
  });

  assert.equal(output, "from codex");
  assert.equal(claude.dispatches.length, 1);
  const settled = records.at(-1)!;
  assert.equal(settled.status, "complete");
  // maxAttempts 1 and two attempt records: the refusal consumed none.
  assert.deepEqual(
    settled.attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.target, attempt.classification]),
    [
      [1, "failed", { engine: "claude", model: "opus" }, { class: "availability", rule: "claude.dispatch-refused" }],
      [2, "complete", { engine: "codex", model: "gpt-6-sol" }, null]
    ]
  );
  assert.deepEqual(settled.answeredBy, { entry: 0, engine: "codex", model: "gpt-served-after-claude" });
  await runtime.close();
});

test("a refused Claude dispatch propagates through parallel(), failing the run rather than nulling the slot", async () => {
  // The failure cross-engine verification exists to prevent: a fan-out
  // whose Claude legs were all refused must not read as a two-family result
  // with the Claude half `null`.
  const claude = new ChainEngine("claude", [claudeDispatchRefused(), claudeDispatchRefused()]);
  const { runtime } = chainRuntime([claude], 3);

  await assert.rejects(
    () =>
      parallel(
        [
          () => runtime.agent("first blind leg", { engine: "claude", model: "opus" }),
          () => runtime.agent("second blind leg", { engine: "claude", model: "opus" })
        ],
        () => undefined
      ),
    ClaudeDispatchError
  );
  await runtime.close();
});

// ---------------------------------------------------------------------------
// The pre-spawn boundary on Codex: a substrate that never started (or is
// already gone) when a thread is asked for is a substrate refusal, not a
// spent attempt.
// ---------------------------------------------------------------------------

/** A transport whose substrate never comes up: every thread open fails the handshake. */
class UnstartableTransport implements RuntimeTransport {
  readonly cwd = "/fake/repo";
  opens = 0;

  async openThread(): Promise<string> {
    this.opens += 1;
    throw new AppServerStartupTimeoutError(50);
  }

  async runTurn(): Promise<TurnResult> {
    throw new Error("a thread was never opened, so no turn can run");
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

test("a Codex substrate that cannot start refuses the dispatch pre-spawn: one recorded, unspent attempt and a throw", async () => {
  const transport = new UnstartableTransport();
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({ transport, cwd: "/fake/repo", concurrencyCaps: { codex: 1 }, defaultMaxAttempts: 3 });
  runtime.setRunRecorder({
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);

  await assert.rejects(() => runtime.agent("never served", { engine: "codex" }), CodexSubstrateRefusedError);

  // The bound was 3, the refusal identical each time: one thread open, one
  // refused attempt with its class, and the run sees the refusal itself.
  assert.equal(transport.opens, 1);
  const settled = records.at(-1)!;
  assert.equal(settled.status, "failed");
  assert.deepEqual(
    settled.attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.failure?.kind, attempt.classification]),
    [[1, "failed", "CodexSubstrateRefusedError", { class: "availability", rule: "codex.substrate-refused" }]]
  );
  assert.match(
    settled.attempts[0]?.failure?.message ?? "",
    /Codex app-server could not serve a thread in \/fake\/repo: codex app-server initialize handshake timed out after 50ms/
  );
  await runtime.close();
});

test("a Codex substrate refusal advances the chain to a Claude target, costing no attempt", async () => {
  const transport = new UnstartableTransport();
  const codex = new CodexEngineAdapter({ transport, concurrency: 1 });
  const claude = new ChainEngine("claude", [answers("from claude", "claude-served-after-codex")]);
  const { runtime, records } = chainRuntime([codex, claude], 1);

  const output = await runtime.agent("blind stage", {
    engine: "codex",
    model: "gpt-6-sol",
    fallback: [{ engine: "claude", model: "opus" }]
  });

  assert.equal(output, "from claude");
  assert.equal(transport.opens, 1);
  const settled = records.at(-1)!;
  assert.equal(settled.status, "complete");
  assert.deepEqual(
    settled.attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.target, attempt.classification]),
    [
      [1, "failed", { engine: "codex", model: "gpt-6-sol" }, { class: "availability", rule: "codex.substrate-refused" }],
      [2, "complete", { engine: "claude", model: "opus" }, null]
    ]
  );
  assert.deepEqual(settled.answeredBy, { entry: 0, engine: "claude", model: "claude-served-after-codex" });
  await runtime.close();
});
