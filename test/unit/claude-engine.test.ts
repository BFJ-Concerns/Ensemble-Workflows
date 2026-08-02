import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeEngineAdapter, EngineRegistry } from "../../src/engines.js";
import { EnsembleRuntime } from "../../src/runtime.js";

import type { RuntimeAgentRecord, RunRecordWriter } from "../../src/run-record.js";
import type {
  ClaudeControlPlane,
  ClaudeDispatchOptions,
  ClaudeSessionHandle,
  ClaudeSessionStatus
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
  assistant?: { text?: string; stop?: string; output?: number; input?: number; cached?: number; model?: string };
}

class FakeControlPlane implements ClaudeControlPlane {
  dispatchCount = 0;
  steerCount = 0;
  stopCount = 0;
  transcriptReadsAfterSteer = 0;
  readonly dispatched: ClaudeDispatchOptions[] = [];
  readonly steered: string[] = [];

  #dir: string;
  #turns: ScriptedTurn[];
  #tmux: boolean;
  #steerSucceeds: boolean;
  #steerConsumesTurn: boolean;
  #steered = false;

  #sessionSeq = 0;
  #handle: ClaudeSessionHandle | null = null;
  #path: string | null = null;
  #present = false;
  #busyRemaining = 0;
  #outcome: "complete" | "blocked" = "complete";

  constructor(
    dir: string,
    turns: ScriptedTurn[],
    options: { tmux?: boolean; steerSucceeds?: boolean; steerConsumesTurn?: boolean } = {}
  ) {
    this.#dir = dir;
    this.#turns = [...turns];
    this.#tmux = options.tmux ?? true;
    this.#steerSucceeds = options.steerSucceeds ?? true;
    this.#steerConsumesTurn = options.steerConsumesTurn ?? true;
  }

  async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
    this.dispatchCount += 1;
    this.dispatched.push(options);
    this.#sessionSeq += 1;
    const sessionId = `fake-session-${this.#sessionSeq}`;
    this.#path = path.join(this.#dir, `${sessionId}.jsonl`);
    this.#handle = { id: `fake-${this.#sessionSeq}`, sessionId, name: options.name, cwd: options.cwd };
    this.#present = true;
    await this.#consume("write");
    return this.#handle;
  }

  async poll(): Promise<ClaudeSessionStatus> {
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

  async steer(_handle: ClaudeSessionHandle, message: string): Promise<boolean> {
    this.steerCount += 1;
    this.steered.push(message);
    this.#steered = true;
    if (!this.#steerSucceeds) {
      return false;
    }
    if (this.#steerConsumesTurn) {
      await this.#consume("append");
    }
    return true;
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
    const line = turn?.assistant !== undefined ? `${assistantLine(turn.assistant)}\n` : "";
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

function assistantLine(assistant: ScriptedTurn["assistant"] & object): string {
  const content =
    assistant.text !== undefined
      ? [{ type: "text", text: assistant.text }]
      : [{ type: "thinking", thinking: "…" }];
  const hasUsage = assistant.output !== undefined || assistant.input !== undefined || assistant.cached !== undefined;
  const usage = hasUsage
    ? {
        input_tokens: assistant.input ?? 0,
        output_tokens: assistant.output ?? 0,
        cache_read_input_tokens: assistant.cached ?? 0,
        cache_creation_input_tokens: 0
      }
    : undefined;
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      ...(assistant.model !== undefined ? { model: assistant.model } : {}),
      content,
      stop_reason: assistant.stop ?? "end_turn",
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
  options: { tmux?: boolean; steerSucceeds?: boolean; steerConsumesTurn?: boolean } = {}
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-engine-"));
  try {
    await body(new FakeControlPlane(dir, turns, options));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
  await withControlPlane([{ assistant: { text: "ok" } }], async (controlPlane) => {
    const runtime = makeRuntime(controlPlane);
    try {
      await runtime.agent("read", { engine: "claude", cwd: "/per-call/cwd" });
      assert.equal(controlPlane.dispatched[0]?.cwd, "/per-call/cwd");
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
    assert.equal(records[0]?.attempts[0]?.failure?.kind, "claude-first-life-timeout");
    assert.match(records[0]?.attempts[0]?.failure?.message ?? "", /no sign of life/);
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

  async steer(): Promise<boolean> {
    return false;
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

  async steer(): Promise<boolean> {
    return false;
  }

  async stop(): Promise<void> {
    this.#present = false;
  }

  async tmuxAvailable(): Promise<boolean> {
    return true;
  }
}

test("fallbackModel rides the Claude dispatch as declared degradation", async () => {
  await withControlPlane([{ assistant: { text: "ok" } }], async (controlPlane) => {
    const runtime = makeRuntime(controlPlane);
    try {
      await runtime.agent("say something", { engine: "claude", model: "opus", fallbackModel: "sonnet" });
      assert.equal(controlPlane.dispatched[0]?.model, "opus");
      assert.equal(controlPlane.dispatched[0]?.fallbackModel, "sonnet");
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
