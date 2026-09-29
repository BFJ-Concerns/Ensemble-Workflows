import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeEngineAdapter, EngineRegistry } from "../../src/engines.js";
import { claudeCacheTtlToMs } from "../../src/claude-engine.js";
import { validateEngineDefaults } from "../../src/engine-option-validation.js";
import {
  ClaudeDispatchError,
  ClaudeRegistrationTimeoutError,
  EngineShutdownError,
  InvalidAgentOptionValueError,
  failedTurnResultOf,
  partialWorkerTextOf
} from "../../src/errors.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { usageSince } from "../../src/claude-transcript.js";

import { RunRecordWriter } from "../../src/run-record.js";
import type { RuntimeAgentRecord } from "../../src/run-record.js";
import type { TranscriptEntry } from "../../src/claude-transcript.js";
import type {
  ClaudeControlPlane,
  ClaudeDispatchOptions,
  ClaudeSessionHandle,
  ClaudeSessionStatus,
  ValveDelivery
} from "../../src/claude-control-plane.js";

/**
 * One scripted worker turn — what a single dispatch or steer produces:
 *
 * - `busyPolls` — how many `poll()`s report `busy` (generating) before the turn
 *   settles. Default 0 (settles immediately).
 * - `outcome` — `complete` (a finished turn) or `blocked` (awaiting input).
 *   Default `complete`.
 * - `assistant` — the message appended to the transcript, with its `stop_reason`
 *   (default `end_turn`). Omitted for a `blocked` turn (nothing settled yet).
 *
 * The fake deliberately reproduces the live `claude 2.1.178` quirk: once a turn
 * settles, `poll()` returns `status: idle` but `state: working` (NOT `done`) —
 * so these tests prove completion is detected from the transcript, not `state`.
 */
interface ScriptedTurn {
  busyPolls?: number;
  outcome?: "complete" | "blocked";
  /**
   * `effort` scripts what the fake CLI reports serving: unset mirrors the
   * real CLI (the dispatched `--effort`, or its `medium` default); a string
   * overrides it (a flag the CLI ran at another level); `null` omits the
   * field, as a Claude Code build older than 2.1.283 would.
   */
  assistant?: {
    text?: string;
    stop?: string | null;
    /** The API message id; rows sharing one are one call to the usage reader. */
    id?: string;
    output?: number;
    input?: number;
    cached?: number;
    model?: string;
    effort?: string | null;
  };
}

class FakeControlPlane implements ClaudeControlPlane {
  dispatchCount = 0;
  steerCount = 0;
  stopCount = 0;
  pollCount = 0;
  transcriptReadsAfterSteer = 0;
  readonly dispatched: ClaudeDispatchOptions[] = [];
  readonly steered: string[] = [];

  #dir: string;
  #turns: ScriptedTurn[];
  #tmux: boolean;
  #steerSucceeds: boolean;
  #steerConsumesTurn: boolean;
  #dispatchGate: DispatchGate | undefined;
  #refuseDispatch: string | undefined;
  #registrationTimeout: string | undefined;
  #steered = false;

  #sessionSeq = 0;
  #handle: ClaudeSessionHandle | null = null;
  #path: string | null = null;
  #dispatchedEffort: string | undefined;
  #present = false;
  #busyRemaining = 0;
  #outcome: "complete" | "blocked" = "complete";

  constructor(
    dir: string,
    turns: ScriptedTurn[],
    options: FakeControlPlaneOptions = {}
  ) {
    this.#dir = dir;
    this.#turns = [...turns];
    this.#tmux = options.tmux ?? true;
    this.#steerSucceeds = options.steerSucceeds ?? true;
    this.#steerConsumesTurn = options.steerConsumesTurn ?? true;
    this.#dispatchGate = options.dispatchGate;
    this.#refuseDispatch = options.refuseDispatch;
    this.#registrationTimeout = options.registrationTimeout;
  }

  async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
    this.dispatchCount += 1;
    this.dispatched.push(options);
    if (this.#refuseDispatch !== undefined) {
      throw new ClaudeDispatchError(this.#refuseDispatch);
    }
    if (this.#registrationTimeout !== undefined) {
      throw new ClaudeRegistrationTimeoutError(this.#registrationTimeout);
    }
    this.#sessionSeq += 1;
    this.#dispatchedEffort = options.effort;
    const sessionId = `fake-session-${this.#sessionSeq}`;
    this.#path = path.join(this.#dir, `${sessionId}.jsonl`);
    this.#handle = { id: `fake-${this.#sessionSeq}`, sessionId, name: options.name, cwd: options.cwd };
    this.#present = true;
    await this.#consume("write");
    this.#dispatchGate?.arrived();
    await this.#dispatchGate?.release;
    return this.#handle;
  }

  async poll(): Promise<ClaudeSessionStatus> {
    this.pollCount += 1;
    if (!this.#present) {
      return { status: "absent", state: "unknown", present: false };
    }
    if (this.#busyRemaining > 0) {
      this.#busyRemaining -= 1;
      return { status: "busy", state: "working", present: true };
    }
    if (this.#outcome === "blocked") {
      return { status: "idle", state: "blocked", present: true, waitingFor: "input" };
    }
    // Settled: status idle, but state stuck at "working" — the live quirk.
    return { status: "idle", state: "working", present: true };
  }

  async transcriptPath(): Promise<string | null> {
    if (this.#steered) {
      this.transcriptReadsAfterSteer += 1;
    }
    return this.#path;
  }

  async steer(_handle: ClaudeSessionHandle, message: string): Promise<ValveDelivery> {
    this.steerCount += 1;
    this.steered.push(message);
    this.#steered = true;
    if (!this.#steerSucceeds) {
      return { delivered: false, reason: "fake valve refused" };
    }
    if (this.#steerConsumesTurn) {
      await this.#consume("append");
    }
    return { delivered: true };
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.#present = false;
  }

  async tmuxAvailable(): Promise<boolean> {
    return this.#tmux;
  }

  // Consume the next scripted turn: set busy/outcome and write/append its
  // assistant message. A missing turn means "settle complete, produce nothing".
  async #consume(mode: "write" | "append"): Promise<void> {
    const turn = this.#turns.shift();
    this.#busyRemaining = turn?.busyPolls ?? 0;
    this.#outcome = turn?.outcome ?? "complete";
    const line = turn?.assistant !== undefined ? `${assistantLine(turn.assistant, this.#dispatchedEffort)}\n` : "";
    if (this.#path === null) {
      return;
    }
    if (mode === "write") {
      await writeFile(this.#path, line);
    } else if (line.length > 0) {
      await appendFile(this.#path, line);
    }
  }
}

interface DispatchGate {
  arrived: () => void;
  release: Promise<void>;
}

interface FakeControlPlaneOptions {
  tmux?: boolean;
  /** When set, `dispatch()` throws a `ClaudeDispatchError` carrying this text: Claude Code refused before any session existed. */
  refuseDispatch?: string;
  /** When set, `dispatch()` throws a `ClaudeRegistrationTimeoutError`: the daemon took the dispatch but never registered the session. */
  registrationTimeout?: string;
  steerSucceeds?: boolean;
  steerConsumesTurn?: boolean;
  dispatchGate?: DispatchGate;
}

function assistantLine(
  assistant: ScriptedTurn["assistant"] & object & { creation?: number },
  dispatchedEffort?: string
): string {
  // The served effort as Claude Code 2.1.283 writes it: a top-level field on
  // the assistant entry, reporting the level the CLI ran at.
  const effort = assistant.effort === undefined ? dispatchedEffort ?? "medium" : assistant.effort;
  const content =
    assistant.text !== undefined
      ? [{ type: "text", text: assistant.text }]
      : [{ type: "thinking", thinking: "…" }];
  const hasUsage =
    assistant.output !== undefined ||
    assistant.input !== undefined ||
    assistant.cached !== undefined ||
    assistant.creation !== undefined;
  const usage = hasUsage
    ? {
        input_tokens: assistant.input ?? 0,
        output_tokens: assistant.output ?? 0,
        cache_read_input_tokens: assistant.cached ?? 0,
        cache_creation_input_tokens: assistant.creation ?? 0
      }
    : undefined;
  return JSON.stringify({
    type: "assistant",
    ...(effort !== null ? { effort } : {}),
    message: {
      role: "assistant",
      ...(assistant.id !== undefined ? { id: assistant.id } : {}),
      ...(assistant.model !== undefined ? { model: assistant.model } : {}),
      content,
      // `null` is a deliberate script value — a finished answer observed in a
      // real transcript can carry `stop_reason: null` — so only `undefined`
      // falls back to the terminal default.
      stop_reason: assistant.stop === undefined ? "end_turn" : assistant.stop,
      ...(usage !== undefined ? { usage } : {})
    }
  });
}

const okSchema = {
  type: "object",
  required: ["ok"],
  additionalProperties: false,
  properties: { ok: { type: "boolean" } }
};

// Fast, deterministic lifecycle config — no real waiting.
const fastConfig = { pollIntervalMs: 1, receiptTimeoutMs: 200, blockedRecoveryBound: 2 };

function makeRuntime(
  controlPlane: ClaudeControlPlane,
  options: {
    claudeBudget?: number;
    maxAttempts?: number;
    blockedRecoveryBound?: number;
    receiptTimeoutMs?: number;
    turnTimeoutMs?: number;
    firstLifeTimeoutMs?: number;
  } = {}
): EnsembleRuntime {
  let runtime: EnsembleRuntime | null = null;
  const adapter = new ClaudeEngineAdapter({
    concurrency: 4,
    cwd: "/fake/cwd",
    controlPlane,
    onEvent: (event) => runtime?.handleEngineEvent("claude", event),
    config: {
      ...fastConfig,
      ...(options.blockedRecoveryBound !== undefined ? { blockedRecoveryBound: options.blockedRecoveryBound } : {}),
      ...(options.receiptTimeoutMs !== undefined ? { receiptTimeoutMs: options.receiptTimeoutMs } : {}),
      ...(options.firstLifeTimeoutMs !== undefined ? { firstLifeTimeoutMs: options.firstLifeTimeoutMs } : {})
    }
  });
  runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    ...(options.claudeBudget === undefined ? {} : { budgetCeilings: { claude: options.claudeBudget } }),
    defaultTurnTimeoutMs: options.turnTimeoutMs ?? 5_000,
    defaultMaxAttempts: options.maxAttempts ?? 3
  });
  return runtime;
}

async function withControlPlane(
  turns: ScriptedTurn[],
  body: (controlPlane: FakeControlPlane) => Promise<void>,
  options: FakeControlPlaneOptions = {}
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-engine-"));
  try {
    await body(new FakeControlPlane(dir, turns, options));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a statically declared out-of-domain effort fails before the body runs", () => {
  // The defaults validator judges the canonical vocabulary — a bad
  // static declaration must not first fail at the first paid dispatch,
  // potentially after phases on other engines. Claude and Codex share the
  // one canonical set; the whole set is valid on both, clamping aside.
  assert.throws(() => validateEngineDefaults("claude", { effort: "extreme" }), InvalidAgentOptionValueError);
  assert.throws(() => validateEngineDefaults("codex", { effort: "extreme" }), InvalidAgentOptionValueError);
  assert.doesNotThrow(() => validateEngineDefaults("claude", { effort: "medium" }));
  assert.doesNotThrow(() => validateEngineDefaults("claude", { effort: "xhigh" }));
  assert.doesNotThrow(() => validateEngineDefaults("codex", { effort: "xhigh" }));
  assert.doesNotThrow(() => validateEngineDefaults("claude", {}));
});

test("claudeCacheTtlToMs parses the settings value formats and refuses the rest", () => {
  assert.equal(claudeCacheTtlToMs("1h"), 3_600_000);
  assert.equal(claudeCacheTtlToMs("5m"), 300_000);
  assert.equal(claudeCacheTtlToMs("30s"), 30_000);
  assert.equal(claudeCacheTtlToMs("90"), 90_000);
  assert.equal(claudeCacheTtlToMs("soon"), null);
  assert.equal(claudeCacheTtlToMs("0m"), null);
});

test("Claude rejects an out-of-domain effort before any worker spawns", async () => {
  await withControlPlane([{ assistant: { text: "ran at medium" } }], async (controlPlane) => {
    const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });

    // The CLI silently runs an unknown effort at its default (measured
    // 2026-08-30), so the adapter's conversion is the only loud boundary
    // an author gets — nothing outside the canonical vocabulary may pass.
    assert.throws(
      () => adapter.createInvocation("work", { effort: "definitely-invalid" }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidAgentOptionValueError);
        assert.match(error.message, /minimal \| low \| medium \| high \| xhigh/);
        return true;
      }
    );
    assert.throws(
      () => adapter.createSession({ effort: "definitely-invalid" }),
      InvalidAgentOptionValueError
    );
    assert.equal(controlPlane.dispatchCount, 0);

    // The discriminating positive arm: a canonical level still dispatches.
    const invocation = adapter.createInvocation("work", { effort: "medium" });
    assert.equal((await invocation.runAttempt({ attempt: 1 })).text, "ran at medium");
    assert.equal(controlPlane.dispatched[0]?.effort, "medium");
    await adapter.close();
  });
});

test("a canonical level outside Claude's native domain clamps to the nearest native level, and the served level is read from the transcript", async () => {
  await withControlPlane(
    [
      { assistant: { text: "ran clamped low" } },
      { assistant: { text: "ran at xhigh" } },
      { assistant: { text: "ran at the default", effort: "medium" } },
      { assistant: { text: "older build", effort: null } }
    ],
    async (controlPlane) => {
      const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });

      // minimal → low: the one canonical level the CLI lacks. The worker is
      // dispatched with the native value, and the result reports the level
      // the CLI's transcript says it served — here the same value, so a
      // clamped dispatch is observable in the record as what ran.
      const floor = adapter.createInvocation("work", { effort: "minimal" });
      const floorResult = await floor.runAttempt({ attempt: 1 });
      assert.equal(controlPlane.dispatched[0]?.effort, "low");
      assert.equal(floorResult.resolvedEffort, "low");

      // xhigh is native (Claude Code 2.1.283): dispatched unchanged.
      const ceiling = adapter.createInvocation("work", { effort: "xhigh" });
      assert.equal((await ceiling.runAttempt({ attempt: 1 })).resolvedEffort, "xhigh");
      assert.equal(controlPlane.dispatched[1]?.effort, "xhigh");

      // The discriminating case: the transcript reports a level other than
      // the one dispatched (a flag the CLI ran at its default). The record
      // must carry what was served, never an echo of the request.
      const ignored = adapter.createInvocation("work", { effort: "high" });
      assert.equal((await ignored.runAttempt({ attempt: 1 })).resolvedEffort, "medium");

      // A transcript with no effort field reports nothing: unknown, not a
      // copy of the dispatched flag.
      const unreported = adapter.createInvocation("work", { effort: "high" });
      assert.equal((await unreported.runAttempt({ attempt: 1 })).resolvedEffort, undefined);
      await adapter.close();
    }
  );
});

test("Claude adapter close stops an active session and winds down its poll loop", async () => {
  await withControlPlane([{ busyPolls: Number.MAX_SAFE_INTEGER, assistant: { text: "partial from Claude", stop: "tool_use" } }], async (controlPlane) => {
    // A long poll interval: without the abortable delay, close() would sit
    // out the full minute before the loop noticed anything.
    const adapter = new ClaudeEngineAdapter({
      controlPlane,
      config: { pollIntervalMs: 60_000 }
    });
    const invocation = adapter.createInvocation("keep working", {});
    const attempt = invocation.runAttempt({ attempt: 1 });
    while (controlPlane.pollCount === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await adapter.close();

    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof EngineShutdownError);
      assert.equal(partialWorkerTextOf(error), "partial from Claude");
      return true;
    });
    assert.equal(controlPlane.stopCount, 1);
    assert.equal(controlPlane.pollCount, 1);
  });
});

test("an initial-dispatch interruption retains transcript evidence before teardown", async () => {
  let releaseDispatch: (() => void) | undefined;
  const dispatchReleased = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  let dispatchArrived: (() => void) | undefined;
  const dispatchArrivedPromise = new Promise<void>((resolve) => {
    dispatchArrived = resolve;
  });

  await withControlPlane(
    [{ busyPolls: Number.MAX_SAFE_INTEGER, assistant: { text: "raced evidence", stop: "tool_use", model: "claude-raced" } }],
    async (controlPlane) => {
      const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });
      const invocation = adapter.createInvocation("keep working", {});
      const attempt = invocation.runAttempt({ attempt: 1 });
      await dispatchArrivedPromise;

      const close = adapter.close();
      let closeCompleted = false;
      void close.then(() => {
        closeCompleted = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const closeCompletedBeforeDispatchReleased = closeCompleted;
      releaseDispatch?.();
      await close;

      await assert.rejects(attempt, (error: unknown) => {
        assert.ok(error instanceof EngineShutdownError);
        assert.equal(partialWorkerTextOf(error), "raced evidence");
        assert.equal(failedTurnResultOf(error)?.text, "raced evidence");
        assert.equal(failedTurnResultOf(error)?.resolvedModel, "claude-raced");
        return true;
      });
      assert.equal(closeCompletedBeforeDispatchReleased, true, "close must not wait for the in-flight dispatch");
      assert.equal(controlPlane.stopCount, 1);
    },
    { dispatchGate: { arrived: () => dispatchArrived?.(), release: dispatchReleased } }
  );
});

test("Claude interruption retains transcript-proved turn evidence in the archive", async () => {
  await withControlPlane(
    [
      {
        busyPolls: Number.MAX_SAFE_INTEGER,
        assistant: { text: "partial from Claude", stop: "tool_use", model: "claude-served", input: 120, output: 30, cached: 9 }
      }
    ],
    async (controlPlane) => {
      const store = await mkdtemp(path.join(tmpdir(), "ensemble-claude-interruption-archive-"));
      const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-claude-interruption-cwd-"));
      const runtime = makeRuntime(controlPlane);
      try {
        const writer = await RunRecordWriter.start({
          storeDir: store,
          cwd,
          runUuid: "run-claude-interruption",
          workflowPath: path.join(cwd, "workflow.js"),
          workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
          args: [],
          cliFlags: { jsonArgs: false }
        });
        runtime.setRunRecorder(writer);
        const agent = runtime.agent("keep working", { engine: "claude" });
        while (controlPlane.pollCount === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }

        await runtime.close();

        await assert.rejects(agent, EngineShutdownError);
        await writer.finish({ status: "interrupted", exitCode: 1, result: null });

        // This is a cold read of the durable record, not the runtime's
        // in-memory callback argument. An archive consumer must retain every
        // evidence form the interrupted Claude turn had already produced.
        const archived = JSON.parse(
          await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")
        ) as {
          status: string;
          usage: { summary?: { totalTokens: number } };
          transcripts: Array<{ path: string; partial: boolean }>;
          attempts: Array<{
            raw_output: string | null;
            resolved_model: string | null;
            resolved_effort: string | null;
            token_usage_events: Array<{ total: object }>;
          }>;
        };
        const attempt = archived.attempts[0];
        assert.equal(archived.status, "interrupted");
        assert.equal(attempt?.raw_output, "partial from Claude");
        assert.equal(attempt?.resolved_model, "claude-served");
        // The served effort is failure evidence like the served model: the
        // transcript reported it before the interruption, so the record keeps it.
        assert.equal(attempt?.resolved_effort, "medium");
        assert.equal(archived.transcripts.length, 1);
        assert.equal(archived.transcripts[0]?.partial, true);
        assert.match(
          await readFile(path.join(writer.archiveDir, archived.transcripts[0]!.path), "utf8"),
          /partial from Claude/
        );
        assert.deepEqual(attempt?.token_usage_events.at(-1)?.total, {
          inputTokens: 120,
          outputTokens: 30,
          cachedInputTokens: 9,
          cacheCreationInputTokens: 0,
          totalTokens: 159
        });
        assert.equal(archived.usage.summary?.totalTokens, 159);
      } finally {
        await runtime.close();
        await rm(store, { recursive: true, force: true });
        await rm(cwd, { recursive: true, force: true });
      }
    }
  );
});

test("Claude adapter forgets an invocation once its own close completes", async () => {
  await withControlPlane([{ assistant: { text: "done" } }], async (controlPlane) => {
    const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });
    const invocation = adapter.createInvocation("finish", {});

    assert.equal((await invocation.runAttempt({ attempt: 1 })).text, "done");
    await invocation.close?.();
    assert.equal(controlPlane.stopCount, 1);

    // Adapter close finds nothing left to cancel: no second stop.
    await adapter.close();
    assert.equal(controlPlane.stopCount, 1);
  });
});

test("completion is read from the transcript even when state never reports done", async () => {
  // The worker settles to status:idle / state:working (the live quirk) after one
  // busy poll; only the transcript's end_turn marks the turn complete.
  await withControlPlane([{ busyPolls: 1, assistant: { text: '{"ok":true}' } }], async (controlPlane) => {
    const runtime = makeRuntime(controlPlane);
    try {
      const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
      assert.deepEqual(result, { ok: true });
      assert.equal(controlPlane.dispatchCount, 1);
      assert.equal(controlPlane.steerCount, 0);
      assert.match(controlPlane.dispatched[0]?.prompt ?? "", /may surround the value with prose.*markdown code fences/);
      assert.doesNotMatch(controlPlane.dispatched[0]?.prompt ?? "", /exactly one JSON value/);
      // close() runs in the shared loop's finally → the session is torn down.
      assert.equal(controlPlane.stopCount, 1);
    } finally {
      await runtime.close();
    }
  });
});

test("a per-call cwd reaches Claude dispatch and overrides the adapter cwd", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-claude-per-call-cwd-"));
  try {
    await withControlPlane([{ assistant: { text: "ok" } }], async (controlPlane) => {
      const runtime = makeRuntime(controlPlane);
      try {
        await runtime.agent("read", { engine: "claude", cwd: directory });
        assert.equal(controlPlane.dispatched[0]?.cwd, directory);
      } finally {
        await runtime.close();
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an agents strip denies Claude spawn, discovery, and messaging tools", async () => {
  await withControlPlane([{ assistant: { text: "ok" } }], async (controlPlane) => {
    const runtime = makeRuntime(controlPlane);
    try {
      await runtime.agent("restricted", { engine: "claude", strip: ["skills", "agents"] });
      assert.deepEqual(controlPlane.dispatched[0]?.permissionDenyRules, [
        "Skill",
        "Task",
        "Agent",
        "ListAgents",
        "SendMessage"
      ]);
    } finally {
      await runtime.close();
    }
  });
});

test("an unstripped Claude dispatch carries no permission deny rules", async () => {
  await withControlPlane([{ assistant: { text: "ok" } }], async (controlPlane) => {
    const runtime = makeRuntime(controlPlane);
    try {
      await runtime.agent("unrestricted", { engine: "claude" });
      assert.equal(controlPlane.dispatched[0]?.permissionDenyRules, undefined);
    } finally {
      await runtime.close();
    }
  });
});

test("a text agent returns the bare final assistant message", async () => {
  await withControlPlane([{ assistant: { text: "the plain answer" } }], async (controlPlane) => {
    const runtime = makeRuntime(controlPlane);
    try {
      const result = await runtime.agent("say something", { engine: "claude" });
      assert.equal(result, "the plain answer");
    } finally {
      await runtime.close();
    }
  });
});

test("schema-invalid output is corrected in-session through the valve, not a redispatch", async () => {
  await withControlPlane(
    [
      // Parses cleanly but violates the schema (ok must be boolean) → the failure
      // carries the ajv errors, which the correction prompt feeds back in-session.
      { assistant: { text: '{"ok":"not a boolean"}' } },
      { busyPolls: 1, assistant: { text: '{"ok":true}' } }
    ],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 3 });
      try {
        const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
        assert.deepEqual(result, { ok: true });
        // The heart of the unit: one dispatch, one in-session steer — context preserved.
        assert.equal(controlPlane.dispatchCount, 1);
        assert.equal(controlPlane.steerCount, 1);
        assert.match(controlPlane.steered[0] ?? "", /did not satisfy the required schema/);
        assert.match(controlPlane.steered[0] ?? "", /Validation errors/);
        assert.match(controlPlane.steered[0] ?? "", /may surround the value with prose or markdown fences/);
      } finally {
        await runtime.close();
      }
    }
  );
});

test("unparseable output is corrected in-session with the invalid-JSON prompt", async () => {
  await withControlPlane(
    [
      { assistant: { text: "not json at all" } },
      { assistant: { text: '{"ok":true}' } }
    ],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 3 });
      try {
        const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
        assert.deepEqual(result, { ok: true });
        assert.equal(controlPlane.dispatchCount, 1);
        assert.equal(controlPlane.steerCount, 1);
        assert.match(controlPlane.steered[0] ?? "", /not valid JSON/);
        assert.match(controlPlane.steered[0] ?? "", /may surround the value with prose or markdown fences/);
      } finally {
        await runtime.close();
      }
    }
  );
});

test("schema agent returns null after the bounded attempts when correction never satisfies", async () => {
  await withControlPlane(
    [
      { assistant: { text: "nope" } },
      { assistant: { text: "still nope" } }
    ],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 2 });
      try {
        const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
        assert.equal(result, null);
        assert.equal(controlPlane.dispatchCount, 1);
        assert.equal(controlPlane.steerCount, 1);
        assert.equal(controlPlane.stopCount, 1);
      } finally {
        await runtime.close();
      }
    }
  );
});

test("a blocked worker is recovered with a bounded nudge through the valve", async () => {
  await withControlPlane(
    [
      { outcome: "blocked" },
      { busyPolls: 1, assistant: { text: '{"ok":true}' } }
    ],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { blockedRecoveryBound: 2 });
      try {
        const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
        assert.deepEqual(result, { ok: true });
        assert.equal(controlPlane.dispatchCount, 1);
        // One nudge steer recovered it; no extra dispatch.
        assert.equal(controlPlane.steerCount, 1);
        assert.match(controlPlane.steered[0] ?? "", /waiting for input/);
      } finally {
        await runtime.close();
      }
    }
  );
});

test("blocked recovery stops after a failed steer instead of claiming the nudge landed", async () => {
  await withControlPlane(
    [{ outcome: "blocked" }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 1, blockedRecoveryBound: 2 });
      try {
        const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
        assert.equal(result, null);
        assert.equal(controlPlane.steerCount, 1);
        assert.equal(controlPlane.stopCount, 1);
      } finally {
        await runtime.close();
      }
    },
    { steerSucceeds: false }
  );
});

test("blocked recovery requires a receipt before another nudge", async () => {
  await withControlPlane(
    [{ outcome: "blocked" }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, {
        maxAttempts: 1,
        blockedRecoveryBound: 2,
        receiptTimeoutMs: 10
      });
      try {
        const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
        assert.equal(result, null);
        assert.equal(controlPlane.steerCount, 1);
        assert.ok(controlPlane.transcriptReadsAfterSteer > 0);
        assert.equal(controlPlane.stopCount, 1);
      } finally {
        await runtime.close();
      }
    },
    { steerConsumesTurn: false }
  );
});

test("a worker blocked past the recovery bound fails gracefully to null, never hangs", async () => {
  await withControlPlane(
    [
      { outcome: "blocked" },
      { outcome: "blocked" }
    ],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 1, blockedRecoveryBound: 1 });
      try {
        const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
        assert.equal(result, null);
        assert.equal(controlPlane.steerCount, 1); // one nudge, then gave up
        assert.equal(controlPlane.stopCount, 1); // torn down on graceful failure
      } finally {
        await runtime.close();
      }
    }
  );
});

test("a blocked Claude worker preserves transcript text and its diagnostic in the attempt record", async () => {
  await withControlPlane(
    [{ outcome: "blocked", assistant: { text: "Claude reached the evidence", stop: "tool_use" } }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 1, blockedRecoveryBound: 0 });
      const records: RuntimeAgentRecord[] = [];
      runtime.setRunRecorder({
        recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
      } as unknown as RunRecordWriter);
      try {
        assert.equal(await runtime.agent("decide", { engine: "claude" }), null);
        const settledRecord = records.at(-1);
        assert.equal(settledRecord?.attempts[0]?.rawOutput, "Claude reached the evidence");
        assert.equal(settledRecord?.attempts[0]?.failure?.kind, "claude-blocked");
        assert.match(settledRecord?.attempts[0]?.failure?.message ?? "", /blocked awaiting input/);
      } finally {
        await runtime.close();
      }
    }
  );
});

test("a served model the transcript already named survives an operational failure", async () => {
  await withControlPlane(
    [{ outcome: "blocked", assistant: { text: "made a start", stop: "tool_use", model: "claude-served" } }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 1, blockedRecoveryBound: 0 });
      const records: RuntimeAgentRecord[] = [];
      runtime.setRunRecorder({
        recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
      } as unknown as RunRecordWriter);
      try {
        assert.equal(await runtime.agent("decide", { engine: "claude" }), null);
        // The turn failed and produced no result value, but the transcript
        // had already named the served model — a result-less failure must
        // not un-learn evidence the engine had (failures carry their
        // evidence), so the record keeps it beside the failed attempt.
        const settledRecord = records.at(-1);
        assert.equal(settledRecord?.resolvedModel, "claude-served");
        assert.equal(settledRecord?.attempts[0]?.failure?.kind, "claude-blocked");
      } finally {
        await runtime.close();
      }
    }
  );
});

test("Claude operational failures retain partial text across three governed attempts", async () => {
  await withControlPlane(
    [
      { outcome: "blocked", assistant: { text: "partial one", stop: "tool_use" } },
      { outcome: "blocked", assistant: { text: "partial two", stop: "tool_use" } },
      { outcome: "blocked", assistant: { text: "partial three", stop: "tool_use" } }
    ],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 3, blockedRecoveryBound: 0 });
      const records: RuntimeAgentRecord[] = [];
      runtime.setRunRecorder({
        recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
      } as unknown as RunRecordWriter);
      try {
        const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
        assert.equal(result, null);
        assert.equal(controlPlane.dispatchCount, 3);
        assert.deepEqual(
          records.at(-1)?.attempts.map((attempt) => attempt.rawOutput),
          ["partial one", "partial two", "partial three"]
        );
        assert.deepEqual(
          records.at(-1)?.attempts.map((attempt) => attempt.failure?.kind),
          ["claude-blocked", "claude-blocked", "claude-blocked"]
        );
      } finally {
        await runtime.close();
      }
    }
  );
});

test("a failed correction does not attach text from the previous turn", async () => {
  await withControlPlane(
    [{ assistant: { text: "stale previous answer" } }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 2 });
      const records: RuntimeAgentRecord[] = [];
      runtime.setRunRecorder({
        recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
      } as unknown as RunRecordWriter);
      try {
        const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
        assert.equal(result, null);
        const settledRecord = records.at(-1);
        assert.equal(settledRecord?.attempts[0]?.rawOutput, "stale previous answer");
        // The failed correction produced no output: `null`, not an empty answer.
        assert.equal(settledRecord?.attempts[1]?.rawOutput, null);
      } finally {
        await runtime.close();
      }
    },
    { steerSucceeds: false }
  );
});

test("without the valve, correction degrades to a fresh re-dispatch", async () => {
  await withControlPlane(
    [
      { assistant: { text: "not json" } },
      { assistant: { text: '{"ok":true}' } }
    ],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 2 });
      try {
        const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
        assert.deepEqual(result, { ok: true });
        // No valve → two dispatches, zero steers; the first session was torn down.
        assert.equal(controlPlane.dispatchCount, 2);
        assert.equal(controlPlane.steerCount, 0);
        assert.ok(controlPlane.stopCount >= 1);
        // The re-dispatch prompt carries the prior failure so it isn't blind.
        assert.match(controlPlane.dispatched[1]?.prompt ?? "", /A previous attempt failed/);
      } finally {
        await runtime.close();
      }
    },
    { tmux: false }
  );
});

test("Claude worker tokens feed the Claude budget via the synthetic usage event", async () => {
  await withControlPlane(
    [{ assistant: { text: '{"ok":true}', input: 5, output: 10, cached: 2 } }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane);
      try {
        await runtime.agent("decide", { engine: "claude", schema: okSchema });
        // totalTokens = input(5) + cached(2) + output(10), recorded as last-delta.
        assert.equal(runtime.budget.spent("claude"), 17);
        assert.equal(runtime.budget.spent("codex"), 0);
        assert.equal("reasoningOutputTokens" in runtime.budget.events[0]!.event.last, false);
      } finally {
        await runtime.close();
      }
    }
  );
});

test("Claude records the served model from its archived transcript", async () => {
  await withControlPlane(
    [{ assistant: { text: "done", model: "claude-served" } }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane);
      let resolvedModel: string | null = null;
      runtime.setRunRecorder({
        recordAgent: async (record) => {
          resolvedModel = record.resolvedModel;
        }
      } as RunRecordWriter);
      try {
        await runtime.agent("work", { engine: "claude" });
        assert.equal(resolvedModel, "claude-served");
      } finally {
        await runtime.close();
      }
    }
  );
});

test("the budget ceiling blocks a later Claude agent once exhausted", async () => {
  await withControlPlane(
    [
      { assistant: { text: "first", output: 10 } },
      { assistant: { text: "second", output: 10 } }
    ],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { claudeBudget: 5 });
      try {
        await runtime.agent("first", { engine: "claude" });
        assert.ok(runtime.budget.spent("claude") >= 5);
        assert.equal(runtime.budget.remaining("codex"), Number.POSITIVE_INFINITY);
        await assert.rejects(() => runtime.agent("second", { engine: "claude" }), /Token budget exhausted/);
      } finally {
        await runtime.close();
      }
    }
  );
});

test("an unreadable transcript fails gracefully rather than throwing out of agent()", async () => {
  // A worker that settles (status idle) but exposes no transcript file → the
  // turn never reads complete → bounded poll timeout → empty turn → null, no throw.
  const controlPlane = new MissingTranscriptControlPlane();
  const runtime = makeRuntime(controlPlane, { maxAttempts: 1, turnTimeoutMs: 50 });
  try {
    const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
    assert.equal(result, null);
    assert.ok(controlPlane.stopCount >= 1);
  } finally {
    await runtime.close();
  }
});

test("a worker that never shows life fails fast with a distinct recorded failure", async () => {
  const controlPlane = new MissingTranscriptControlPlane();
  const runtime = makeRuntime(controlPlane, {
    maxAttempts: 1,
    turnTimeoutMs: 5_000,
    firstLifeTimeoutMs: 20
  });
  const records: RuntimeAgentRecord[] = [];
  runtime.setRunRecorder({
    recordAgent: async (record: RuntimeAgentRecord) => {
      records.push(structuredClone(record));
    }
  } as unknown as RunRecordWriter);

  const startedAt = Date.now();
  try {
    const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
    assert.equal(result, null);
    assert.ok(Date.now() - startedAt < 500, "mute worker should not consume the full turn timeout");
    assert.equal(records.at(-1)?.attempts[0]?.failure?.kind, "claude-first-life-timeout");
    assert.match(records.at(-1)?.attempts[0]?.failure?.message ?? "", /no sign of life/);
  } finally {
    await runtime.close();
  }
});

test("a slow worker survives the first-life guard once its transcript appears", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-slow-alive-"));
  try {
    const controlPlane = new SlowAliveControlPlane(dir);
    const runtime = makeRuntime(controlPlane, {
      maxAttempts: 1,
      turnTimeoutMs: 1_000,
      firstLifeTimeoutMs: 5
    });
    try {
      const result = await runtime.agent("decide", { engine: "claude", schema: okSchema });
      assert.deepEqual(result, { ok: true });
      assert.ok(controlPlane.pollCount >= 3);
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A control plane whose session settles (idle) but exposes no transcript path,
// exercising the never-completes → graceful poll-timeout path.
class MissingTranscriptControlPlane implements ClaudeControlPlane {
  stopCount = 0;
  #present = false;

  async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
    this.#present = true;
    return { id: "missing-1", sessionId: "missing-session-1", name: options.name, cwd: options.cwd };
  }

  async poll(): Promise<ClaudeSessionStatus> {
    return this.#present
      ? { status: "idle", state: "working", present: true }
      : { status: "absent", state: "unknown", present: false };
  }

  async transcriptPath(): Promise<string | null> {
    return null;
  }

  async steer(): Promise<ValveDelivery> {
    return { delivered: false, reason: "fake valve refused" };
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.#present = false;
  }

  async tmuxAvailable(): Promise<boolean> {
    return true;
  }
}

class SlowAliveControlPlane implements ClaudeControlPlane {
  pollCount = 0;
  #path: string;
  #present = false;

  constructor(dir: string) {
    this.#path = path.join(dir, "slow-alive.jsonl");
  }

  async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
    this.#present = true;
    // The persisted user entry proves dispatch reached the worker. Assistant
    // output may legitimately take much longer and is governed by timeoutMs.
    await writeFile(this.#path, `${JSON.stringify({ type: "user", message: { role: "user", content: "decide" } })}\n`);
    return { id: "slow-1", sessionId: "slow-alive", name: options.name, cwd: options.cwd };
  }

  async poll(): Promise<ClaudeSessionStatus> {
    this.pollCount += 1;
    if (this.pollCount === 3) {
      await appendFile(this.#path, `${assistantLine({ text: '{"ok":true}' })}\n`);
      return { status: "idle", state: "working", present: true };
    }
    return { status: "busy", state: "working", present: this.#present };
  }

  async transcriptPath(): Promise<string | null> {
    return this.#present ? this.#path : null;
  }

  async steer(): Promise<ValveDelivery> {
    return { delivered: false, reason: "fake valve refused" };
  }

  async stop(): Promise<void> {
    this.#present = false;
  }

  async tmuxAvailable(): Promise<boolean> {
    return true;
  }
}

test("a Claude dispatch never carries the engine's own fallback-model switch", async () => {
  // Every fallback step is the harness's own recorded dispatch: the
  // control plane's dispatch options have no fallback field at all, so a
  // chained call reaches Claude Code with its pinned model and nothing
  // that could let the engine swap models behind the record's back.
  await withControlPlane([{ assistant: { text: "ok" } }], async (controlPlane) => {
    const runtime = makeRuntime(controlPlane);
    try {
      await runtime.agent("say something", {
        engine: "claude",
        model: "opus",
        fallback: [{ engine: "claude", model: "sonnet" }]
      });
      assert.equal(controlPlane.dispatched[0]?.model, "opus");
      assert.equal("fallbackModel" in (controlPlane.dispatched[0] ?? {}), false);
    } finally {
      await runtime.close();
    }
  });
});

test("an unpinned Claude call emits a visibility event; a pinned one does not", async () => {
  await withControlPlane(
    [{ assistant: { text: "one" } }, { assistant: { text: "two" } }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane);
      const unpinned: unknown[] = [];
      runtime.onEvent((event) => {
        if (event.method === "claude/unpinnedModel") {
          unpinned.push(event.params.agentId);
        }
      });
      try {
        await runtime.agent("first", { engine: "claude", label: "loose" });
        await runtime.agent("second", { engine: "claude", model: "opus" });
        assert.deepEqual(unpinned, [1]);
      } finally {
        await runtime.close();
      }
    }
  );
});

test("a finished answer is collected while descendants keep the session busy", async () => {
  // The live failure this guards against: a process the worker itself spawned
  // held the roster at `busy` for 22+ minutes after a complete answer was on
  // disk. busyPolls never runs out here — only the transcript can end the
  // turn, so a build that gates the transcript read on "not busy" times out.
  await withControlPlane(
    [{ busyPolls: Number.MAX_SAFE_INTEGER, assistant: { text: "collected promptly" } }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane);
      try {
        const result = await runtime.agent("finish while your child runs", { engine: "claude" });
        assert.equal(result, "collected promptly");
        assert.equal(controlPlane.stopCount, 1);
      } finally {
        await runtime.close();
      }
    }
  );
});

test("an uncollectable settled session fails loudly with its partial text retained", async () => {
  // A settled daemon beside a transcript that never proves the turn complete
  // is what a killed worker's partial answer looks like (`stop_reason: null`
  // on the final assistant entry). Collection must fail loudly with the
  // partial retained as evidence — never spin, and never promote the partial
  // to a success a downstream stage would trust.
  await withControlPlane([{ assistant: { text: "half an answer", stop: null } }], async (controlPlane) => {
    const runtime = makeRuntime(controlPlane, { maxAttempts: 1 });
    const records: RuntimeAgentRecord[] = [];
    runtime.setRunRecorder({
      recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
    } as unknown as RunRecordWriter);
    try {
      assert.equal(await runtime.agent("decide", { engine: "claude" }), null);
      const settledRecord = records.at(-1);
      assert.equal(settledRecord?.attempts[0]?.failure?.kind, "claude-collection-error");
      assert.match(
        settledRecord?.attempts[0]?.failure?.message ?? "",
        /settled but its transcript never proved the turn complete/
      );
      assert.equal(settledRecord?.attempts[0]?.rawOutput, "half an answer");
      assert.equal(controlPlane.stopCount, 1);
    } finally {
      await runtime.close();
    }
  });
});

test("a settled session with no assistant text fails loudly with the collection diagnostic", async () => {
  // The same bound with nothing on disk at all: the leg cannot be collected,
  // and that is a named failure consuming its attempt — never a silent spin
  // behind a worker that will never say more.
  await withControlPlane([{}], async (controlPlane) => {
    const runtime = makeRuntime(controlPlane, { maxAttempts: 1 });
    const records: RuntimeAgentRecord[] = [];
    runtime.setRunRecorder({
      recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
    } as unknown as RunRecordWriter);
    try {
      assert.equal(await runtime.agent("decide", { engine: "claude" }), null);
      const settledRecord = records.at(-1);
      assert.equal(settledRecord?.attempts[0]?.failure?.kind, "claude-collection-error");
      assert.equal(controlPlane.stopCount, 1);
    } finally {
      await runtime.close();
    }
  });
});

test("Claude reports liveness evidence when the transcript first shows this turn's output", async () => {
  await withControlPlane([{ busyPolls: 2, assistant: { text: "ok" } }], async (controlPlane) => {
    const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });
    const invocation = adapter.createInvocation("go", {});
    let evidence = 0;
    const result = await invocation.runAttempt({
      attempt: 1,
      onLiveEvidence: () => {
        evidence += 1;
      }
    });
    assert.equal(result.text, "ok");
    assert.equal(evidence, 1);
    await invocation.close?.();
  });
});

test("Claude liveness evidence waits for an assistant entry, not the persisted prompt", async () => {
  // The transcript's first entry is routinely the persisted user prompt
  // (SlowAliveControlPlane reproduces that platform behaviour). Evidence
  // must not fire until the worker's own assistant entry lands — a stamp on
  // the prompt entry would certify output that never happened.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-evidence-order-"));
  try {
    const controlPlane = new SlowAliveControlPlane(dir);
    const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });
    const invocation = adapter.createInvocation("go", {});
    let evidenceAtPollCount = -1;
    const result = await invocation.runAttempt({
      attempt: 1,
      onLiveEvidence: () => {
        evidenceAtPollCount = controlPlane.pollCount;
      }
    });
    assert.equal(result.text, '{"ok":true}');
    // The assistant entry is appended at the third poll; earlier evidence
    // could only have come from the prompt entry.
    assert.ok(evidenceAtPollCount >= 3, `evidence fired at poll ${evidenceAtPollCount}`);
    await invocation.close?.();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a client diagnostic in place of a model reply is archived as a failure, not an answer", async () => {
  await withControlPlane(
    [
      {
        assistant: {
          text: "API Error: 400 unknown provider for model definitely-not-a-model",
          stop: "stop_sequence",
          model: "<synthetic>"
        }
      }
    ],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 1 });
      const records: RuntimeAgentRecord[] = [];
      runtime.setRunRecorder({
        recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
      } as unknown as RunRecordWriter);
      try {
        const result = await runtime.agent("decide", { engine: "claude", model: "definitely-not-a-model", schema: okSchema });
        assert.equal(result, null);
        const settled = records.at(-1);
        assert.equal(settled?.status, "failed");
        assert.equal(settled?.attempts[0]?.failure?.kind, "claude-worker-diagnostic");
        assert.match(settled?.attempts[0]?.failure?.message ?? "", /unknown provider/);
        // The placeholder Claude Code writes on its own diagnostic is not a
        // served model: recording it would name a model that never ran.
        assert.equal(settled?.resolvedModel, null);
        assert.equal(settled?.validatedOutput, null);
        // The diagnostic is the failure's message and nothing else. A cold
        // consumer reading raw_output must not find an API error string
        // sitting where the worker's own text belongs; no output was produced,
        // which the archive encodes as `null`.
        assert.equal(settled?.rawOutput, null);
        assert.equal(settled?.attempts[0]?.rawOutput, null);
      } finally {
        await runtime.close();
      }
    }
  );
});

test("a real served model is still recorded on a completed Claude turn", async () => {
  await withControlPlane(
    [{ assistant: { text: '{"ok":true}', model: "claude-served" } }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 1 });
      const records: RuntimeAgentRecord[] = [];
      runtime.setRunRecorder({
        recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
      } as unknown as RunRecordWriter);
      try {
        assert.deepEqual(await runtime.agent("decide", { engine: "claude", schema: okSchema }), { ok: true });
        const settled = records.at(-1);
        assert.equal(settled?.status, "complete");
        assert.equal(settled?.resolvedModel, "claude-served");
      } finally {
        await runtime.close();
      }
    }
  );
});

test("a Claude attempt whose engine reports no duration still measures itself", async () => {
  await withControlPlane(
    [{ busyPolls: 2, assistant: { text: '{"ok":true}' } }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 1 });
      const records: RuntimeAgentRecord[] = [];
      runtime.setRunRecorder({
        recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
      } as unknown as RunRecordWriter);
      try {
        assert.deepEqual(await runtime.agent("decide", { engine: "claude", schema: okSchema }), { ok: true });
        const attempt = records.at(-1)?.attempts[0];
        const startedAt = Date.parse(attempt?.startedAt ?? "");
        const endedAt = Date.parse(attempt?.endedAt ?? "");
        assert.ok(typeof attempt?.durationMs === "number", "the attempt carries a measured duration");
        assert.equal(attempt?.durationMs, Math.max(0, endedAt - startedAt));
      } finally {
        await runtime.close();
      }
    }
  );
});

test("a failed Claude turn publishes the spend its transcript already proved", async () => {
  await withControlPlane(
    [{ outcome: "blocked", assistant: { text: "made a start", stop: "tool_use", input: 120, output: 30, cached: 9 } }],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 1, blockedRecoveryBound: 0 });
      const records: RuntimeAgentRecord[] = [];
      runtime.setRunRecorder({
        recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
      } as unknown as RunRecordWriter);
      try {
        assert.equal(await runtime.agent("decide", { engine: "claude" }), null);
        const attempt = records.at(-1)?.attempts[0];
        assert.equal(attempt?.failure?.kind, "claude-blocked");
        // The archived transcript is the reconciliation source: the failed
        // attempt's usage must be exactly what that transcript's own usage
        // entries prove, not zero and not an inference.
        const archived = attempt?.transcripts[0];
        assert.ok(archived !== undefined, "the failed attempt kept its transcript");
        const proved = usageSince(parseTranscript(archived.content));
        assert.equal(proved.totalTokens, 159);
        assert.deepEqual(attempt?.tokenUsageEvents.at(-1)?.total, proved);
      } finally {
        await runtime.close();
      }
    }
  );
});

test("a client diagnostic in place of a model reply still keeps the transcript as attempt evidence", async () => {
  await withControlPlane(
    [
      {
        assistant: {
          text: "API Error: 400 unknown provider for model definitely-not-a-model",
          stop: "stop_sequence",
          model: "<synthetic>",
          input: 11,
          output: 4
        }
      }
    ],
    async (controlPlane) => {
      const runtime = makeRuntime(controlPlane, { maxAttempts: 1 });
      const records: RuntimeAgentRecord[] = [];
      runtime.setRunRecorder({
        recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
      } as unknown as RunRecordWriter);
      try {
        assert.equal(await runtime.agent("decide", { engine: "claude", model: "definitely-not-a-model", schema: okSchema }), null);
        const attempt = records.at(-1)?.attempts[0];
        assert.equal(attempt?.failure?.kind, "claude-worker-diagnostic");
        // The turn really happened and left a transcript; dropping it would
        // make the archive report that the engine produced none.
        assert.equal(attempt?.transcripts.length, 1);
        assert.match(attempt?.transcripts[0]?.content ?? "", /unknown provider/);
        // The diagnostic stays a failure and the placeholder stays no model:
        // retaining the evidence reclassifies nothing.
        assert.equal(records.at(-1)?.resolvedModel, null);
        assert.equal(attempt?.rawOutput, null);
      } finally {
        await runtime.close();
      }
    }
  );
});

/**
 * A turn of two API calls, the first written across three rows (thinking,
 * text, tool_use) that each repeat the call's usage — the shape Claude Code
 * persists — arriving over successive polls.
 */
class SplitRowsControlPlane implements ClaudeControlPlane {
  pollCount = 0;
  #path: string;
  #present = false;

  constructor(dir: string) {
    this.#path = path.join(dir, "split-rows.jsonl");
  }

  async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
    this.#present = true;
    const firstCall = { id: "msg_first_call", stop: "tool_use", input: 100, output: 10, cached: 50, creation: 20 };
    await writeFile(
      this.#path,
      `${assistantLine({ ...firstCall })}\n${assistantLine({ ...firstCall, text: "looking" })}\n`
    );
    return { id: "split-rows-1", sessionId: "split-rows", name: options.name, cwd: options.cwd };
  }

  async poll(): Promise<ClaudeSessionStatus> {
    this.pollCount += 1;
    if (this.pollCount === 2) {
      // The first call's third row lands alone — no new spend, and the
      // next read must emit no event for it.
      await appendFile(
        this.#path,
        `${assistantLine({ id: "msg_first_call", stop: "tool_use", input: 100, output: 10, cached: 50, creation: 20 })}\n`
      );
    }
    if (this.pollCount === 3) {
      // Then the second call: a smaller context than the first, its own charge.
      await appendFile(this.#path, `${assistantLine({ id: "msg_second_call", text: '{"ok":true}', input: 40, output: 7, cached: 30 })}\n`);
    }
    return { status: this.pollCount >= 3 ? "idle" : "busy", state: "working", present: this.#present };
  }

  async transcriptPath(): Promise<string | null> {
    return this.#present ? this.#path : null;
  }

  async steer(): Promise<ValveDelivery> {
    return { delivered: false, reason: "fake valve refused" };
  }

  async stop(): Promise<void> {
    this.#present = false;
  }

  async tmuxAvailable(): Promise<boolean> {
    return true;
  }
}

test("usage is charged once per API call, however many rows a call spans, and summed across the turn's calls", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-split-rows-"));
  try {
    const controlPlane = new SplitRowsControlPlane(dir);
    const runtime = makeRuntime(controlPlane, { maxAttempts: 1 });
    try {
      assert.deepEqual(await runtime.agent("decide", { engine: "claude", schema: okSchema }), { ok: true });
      // First call: 100 input + 70 cached (50 read + 20 created) + 10 output
      // = 180, seen on two rows at dispatch and a third, alone, on the next
      // poll — charged once. Second call: 40 + 30 + 7 = 77, its own context
      // billed beside the first's, not in place of it.
      assert.equal(runtime.budget.spent("claude"), 180 + 77);
      const deltas = runtime.budget.events.map((entry) => entry.event.last);
      assert.equal(deltas.length, 2, "the repeated row, read on its own poll, emits no event of its own");
      assert.deepEqual(
        deltas.map((delta) => [delta.inputTokens, delta.cachedInputTokens, delta.outputTokens, delta.totalTokens]),
        [
          [100, 70, 10, 180],
          [40, 30, 7, 77]
        ]
      );
      // The archived event's total is the turn's usage as the record will
      // summarise it — the same arithmetic on both surfaces. The creation
      // split travels on the raw payload only (the budget vocabulary drops
      // it), so it is read there.
      const finalRaw = (
        runtime.budget.events.at(-1)?.event.raw as { tokenUsage: { total: Record<string, number> } }
      ).tokenUsage.total;
      assert.deepEqual(finalRaw, {
        cachedInputTokens: 100,
        cacheCreationInputTokens: 20,
        inputTokens: 140,
        outputTokens: 17,
        totalTokens: 257
      });
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A worker that backgrounds its command and ends its turn with an interim
 * message — the shape Claude Code persists — then is woken by the task's
 * notification on a later poll and gives its real answer.
 */
class BackgroundTaskControlPlane implements ClaudeControlPlane {
  pollCount = 0;
  readonly snapshots: Array<{ poll: number; waitingOn: unknown }> = [];
  #path: string;
  #present = false;
  #wakeAtPoll: number | null;
  #observe: (() => unknown) | undefined;

  /** The wake's notification rows land at `wakeAtPoll`; the model's reply two polls later, as it does live. */
  constructor(dir: string, options: { wakeAtPoll: number | null; observe?: () => unknown }) {
    this.#path = path.join(dir, "background-task.jsonl");
    this.#wakeAtPoll = options.wakeAtPoll;
    this.#observe = options.observe;
  }

  async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
    this.#present = true;
    const call = { type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "sleep 45", description: "Wait 45 seconds in background", run_in_background: true } };
    await writeFile(
      this.#path,
      [
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [call], stop_reason: "tool_use" } }),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Command running in background with ID: bya9z1l44. You will be notified when it completes." }] } }),
        assistantLine({ text: "The sleep is running in the background. I'll reply once it finishes.", output: 15 })
      ].join("\n") + "\n"
    );
    return { id: "background-1", sessionId: "background", name: options.name, cwd: options.cwd };
  }

  async poll(): Promise<ClaudeSessionStatus> {
    this.pollCount += 1;
    this.snapshots.push({ poll: this.pollCount, waitingOn: this.#observe?.() });
    if (this.#wakeAtPoll !== null && this.pollCount === this.#wakeAtPoll) {
      const block = "<task-notification>\n<task-id>bya9z1l44</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command \"Wait 45 seconds in background\" completed (exit code 0)</summary>\n</task-notification>";
      await appendFile(
        this.#path,
        [
          JSON.stringify({ type: "queue-operation", operation: "enqueue", content: block }),
          JSON.stringify({ type: "user", message: { role: "user", content: block }, origin: { kind: "task-notification" } })
        ].join("\n") + "\n"
      );
    }
    if (this.#wakeAtPoll !== null && this.pollCount === this.#wakeAtPoll + 2) {
      // The model's reply to the wake — the answer — lands after the
      // notification rows, never in the same write.
      await appendFile(this.#path, `${assistantLine({ text: '{"ok":true}', output: 4 })}\n`);
    }
    // The daemon reports the session idle the whole time it waits for its
    // own notification — the same roster shape a settled-but-unproven
    // session shows, which must not be judged a collection failure here.
    return { status: "idle", state: "working", present: this.#present };
  }

  async transcriptPath(): Promise<string | null> {
    return this.#present ? this.#path : null;
  }

  async steer(): Promise<ValveDelivery> {
    return { delivered: false, reason: "fake valve refused" };
  }

  async stop(): Promise<void> {
    this.#present = false;
  }

  async tmuxAvailable(): Promise<boolean> {
    return true;
  }
}

test("a turn ending while a background task is outstanding is not collected; the reply after the task's wake is the answer", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-background-task-"));
  try {
    let runtime: EnsembleRuntime | null = null;
    // The wake lands well past SETTLED_CONFIRMATION_POLLS: an idle daemon
    // beside an outstanding task is the session waiting, not a collection
    // failure.
    const controlPlane = new BackgroundTaskControlPlane(dir, {
      wakeAtPoll: 12,
      observe: () => runtime?.progress.snapshot().agents[0]?.waitingOn ?? "no live agent"
    });
    runtime = makeRuntime(controlPlane, { maxAttempts: 1 });
    try {
      assert.deepEqual(await runtime.agent("sleep then answer", { engine: "claude", schema: okSchema }), { ok: true });
      assert.ok(controlPlane.pollCount >= 14, `collected before the reply that follows the wake, after ${controlPlane.pollCount} polls`);
      // Between the notification and the reply the wait still shows.
      const notified = controlPlane.snapshots.find((snapshot) => snapshot.poll === 13)?.waitingOn as { taskId?: string } | null;
      assert.equal(notified?.taskId, "bya9z1l44");
      // The live status showed the wait while it lasted, naming the task in
      // Claude Code's own words, and cleared once the task ended.
      const during = controlPlane.snapshots.find((snapshot) => snapshot.poll === 6)?.waitingOn as { kind: string; taskId: string; description: string; sinceMs: number };
      assert.equal(during.kind, "background-task");
      assert.equal(during.taskId, "bya9z1l44");
      assert.equal(during.description, "Wait 45 seconds in background");
      assert.equal(typeof during.sinceMs, "number");
      const record = runtime.lastAgentRecord();
      assert.equal(record?.status, "complete");
      assert.equal(record?.rawOutput, '{"ok":true}');
      const waits = record?.attempts[0]?.backgroundWaits ?? [];
      assert.equal(waits.length, 1);
      assert.equal(waits[0]?.taskId, "bya9z1l44");
      assert.equal(waits[0]?.description, "Wait 45 seconds in background");
      assert.ok(waits[0]?.endedAt !== null, "the wait closed when the notification landed");
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a background task that never wakes the session times the attempt out, with the open wait recorded and the interim text never the answer", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-background-task-timeout-"));
  try {
    const controlPlane = new BackgroundTaskControlPlane(dir, { wakeAtPoll: null });
    const runtime = makeRuntime(controlPlane, { maxAttempts: 1, turnTimeoutMs: 150 });
    try {
      assert.equal(await runtime.agent("sleep then answer", { engine: "claude", schema: okSchema }), null);
      const record = runtime.lastAgentRecord();
      assert.equal(record?.status, "timed-out");
      const attempt = record?.attempts[0];
      assert.equal(attempt?.failure?.kind, "claude-poll-timeout");
      assert.equal(attempt?.validatedOutput, null, "the interim message is never promoted to the answer");
      assert.equal(attempt?.backgroundWaits.length, 1);
      assert.equal(attempt?.backgroundWaits[0]?.taskId, "bya9z1l44");
      assert.equal(attempt?.backgroundWaits[0]?.endedAt, null, "an open wait names the task that never woke the session");
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** The archived transcript's own entries, as a cold consumer would parse them. */
function parseTranscript(content: string): TranscriptEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TranscriptEntry);
}

test("a failed Claude turn's spend and transcript read back cold from the archive", async () => {
  // The consumer here is a program parsing the durable record later, with no
  // run in memory: the failed attempt must be legible as spend that happened
  // and a transcript that exists, reconciled against the transcript's own
  // usage entries rather than against the writer's word for it.
  await withControlPlane(
    [{ outcome: "blocked", assistant: { text: "made a start", stop: "tool_use", input: 120, output: 30, cached: 9 } }],
    async (controlPlane) => {
      const store = await mkdtemp(path.join(tmpdir(), "ensemble-claude-failure-archive-"));
      const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-claude-failure-cwd-"));
      const runtime = makeRuntime(controlPlane, { maxAttempts: 1, blockedRecoveryBound: 0 });
      try {
        const writer = await RunRecordWriter.start({
          storeDir: store,
          cwd,
          runUuid: "run-claude-failure",
          workflowPath: path.join(cwd, "workflow.js"),
          workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
          args: [],
          cliFlags: { jsonArgs: false }
        });
        runtime.setRunRecorder(writer);
        assert.equal(await runtime.agent("decide", { engine: "claude" }), null);
        await writer.finish({ status: "failed", exitCode: 1, result: null });

        const agent = JSON.parse(
          await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")
        ) as {
          status: string;
          usage: { summary?: { totalTokens: number; outputTokens: number }; unavailable?: string };
          transcripts: Array<{ path: string }> | { unavailable: string };
        };
        assert.equal(agent.status, "failed");
        // Not `{ unavailable: … }`: the turn spent tokens and left a
        // transcript, and the archive is where a budget or audit consumer
        // learns that.
        assert.ok(Array.isArray(agent.transcripts), "the failed agent lists its transcript");
        const archived = await readFile(path.join(writer.archiveDir, agent.transcripts[0]!.path), "utf8");
        const proved = usageSince(parseTranscript(archived));
        assert.equal(agent.usage.unavailable, undefined);
        assert.equal(agent.usage.summary?.totalTokens, proved.totalTokens);
        assert.equal(agent.usage.summary?.outputTokens, proved.outputTokens);
      } finally {
        await runtime.close();
        await rm(store, { recursive: true, force: true });
        await rm(cwd, { recursive: true, force: true });
      }
    }
  );
});

test("a dispatch Claude Code refused is rethrown as the substrate's refusal, never degraded to a failed turn", async () => {
  // No session existed, so there is no worker whose failure the
  // attempt could carry as a value. The engine lets the refusal through to
  // the runtime's spawn boundary instead of returning a failed result the
  // retry loop would spend the bound on.
  await withControlPlane(
    [],
    async (controlPlane) => {
      const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig, cwd: "/fake/scratch" });
      const invocation = adapter.createInvocation("blind stage", {});
      await assert.rejects(() => invocation.runAttempt({ attempt: 1 }), ClaudeDispatchError);
      assert.equal(controlPlane.dispatchCount, 1);
      assert.equal(controlPlane.stopCount, 0, "nothing was dispatched, so nothing is stopped");
      await adapter.close();
    },
    { refuseDispatch: "Claude Code refused to dispatch worker 'w' in /fake/scratch: Workspace not trusted." }
  );
});

test("a dispatch the daemon took but never registered degrades to a failed turn the loop spends and retries", async () => {
  // Not a refusal: Claude Code did not decline, and a session the roster has
  // not surfaced may exist. The engine returns the operational failure under
  // its own kind, so the shared loop spends an attempt and retries — the
  // dispatch bound, not the pre-spawn boundary, is the lever.
  await withControlPlane(
    [],
    async (controlPlane) => {
      const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig, cwd: "/fake/scratch" });
      const invocation = adapter.createInvocation("slow daemon", {});
      const result = await invocation.runAttempt({ attempt: 1 });
      assert.equal(result.attemptFailure?.kind, "claude-registration-timeout");
      assert.match(result.attemptFailure?.message ?? "", /did not register within 30000ms/);
      assert.equal(controlPlane.dispatchCount, 1);
      await adapter.close();
    },
    { registrationTimeout: "dispatched session 'w' in /fake/scratch did not register within 30000ms" }
  );
});
