import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeEngineAdapter, CodexEngineAdapter, EngineRegistry, OpenCodeEngineAdapter } from "../../src/engines.js";
import {
  BudgetExceededError,
  EmptyAgentOutputError,
  InvalidAgentOptionValueError,
  MultiTurnUnsupportedError,
  SessionBusyError,
  SessionClosedError,
  UnrecognisedAgentOptionError
} from "../../src/errors.js";
import { EnsembleRuntime } from "../../src/runtime.js";

import type {
  ClaudeControlPlane,
  ClaudeDispatchOptions,
  ClaudeSessionHandle,
  ClaudeSessionStatus
} from "../../src/claude-control-plane.js";
import { RunRecordWriter } from "../../src/run-record.js";
import type { RuntimeAgentRecord } from "../../src/run-record.js";
import type { EngineAttemptResult } from "../../src/engines.js";
import type { OpenCodeRunner } from "../../src/opencode-engine.js";
import type { RuntimeTransport, ThreadStartOptions, TurnResult, TurnStartOptions } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Codex side: a scripted transport. Each runTurn consumes the next response;
// the recorded calls are the assertions' evidence — a session's whole point
// is *which thread* each turn landed on.
// ---------------------------------------------------------------------------

function turnResult(text: string, overrides: Partial<EngineAttemptResult> = {}): EngineAttemptResult {
  return {
    text,
    deltaText: text,
    durationMs: 5,
    firstDeltaMs: 1,
    items: {},
    tokenUsageEvents: [],
    ...overrides
  };
}

/** A usage event whose totals land in the budget ledger. */
function spendEvent(
  threadId: string,
  tokens: number,
  cumulativeTokens = tokens
): TurnResult["tokenUsageEvents"][number] {
  const last = { cachedInputTokens: 0, inputTokens: tokens, outputTokens: 0, totalTokens: tokens };
  const total = {
    cachedInputTokens: 0,
    inputTokens: cumulativeTokens,
    outputTokens: 0,
    totalTokens: cumulativeTokens
  };
  return {
    threadId,
    turnId: `${threadId}:turn`,
    last,
    total,
    raw: { threadId, turnId: `${threadId}:turn`, tokenUsage: { last, total } }
  };
}

class ScriptedTransport implements RuntimeTransport {
  readonly cwd = "/fake/repo";
  readonly openedThreads: ThreadStartOptions[] = [];
  readonly turns: Array<{ threadId: string; prompt: string; options: TurnStartOptions }> = [];

  #responses: EngineAttemptResult[];
  #onTurn: ((result: TurnResult) => void) | undefined;

  constructor(responses: EngineAttemptResult[], onTurn?: (result: TurnResult) => void) {
    this.#responses = [...responses];
    this.#onTurn = onTurn;
  }

  async openThread(options: ThreadStartOptions): Promise<string> {
    this.openedThreads.push(options);
    return `thread-${this.openedThreads.length}`;
  }

  async runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult> {
    this.turns.push({ threadId, prompt, options });
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error("ScriptedTransport ran out of responses");
    }
    this.#onTurn?.(response);
    return response;
  }

  async close(): Promise<void> {}
}

function codexRuntime(
  transport: RuntimeTransport,
  options: { concurrency?: number; codexBudget?: number; now?: () => number; staleAfterMs?: number } = {}
): EnsembleRuntime {
  let runtime: EnsembleRuntime | null = null;
  const adapter = new CodexEngineAdapter({ transport, concurrency: options.concurrency ?? 4 });
  runtime = new EnsembleRuntime({
    engines: new EngineRegistry([adapter]),
    ...(options.codexBudget !== undefined ? { budgetCeilings: { codex: options.codexBudget } } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.staleAfterMs !== undefined ? { codexSessionStaleAfterMs: options.staleAfterMs } : {}),
    defaultMaxAttempts: 3
  });
  return runtime;
}

test("a codex session holds one thread across turns, and each turn rides it", async () => {
  const transport = new ScriptedTransport([turnResult("first answer"), turnResult("second answer")]);
  const runtime = codexRuntime(transport);
  const session = runtime.createWorkerSession({ engine: "codex", model: "gpt-5.6-terra", effort: "low" });

  assert.equal(await session.send("first prompt"), "first answer");
  assert.equal(await session.send("second prompt"), "second answer");

  // One thread, both turns on it: the continuity a fresh-thread tree cannot show.
  assert.equal(transport.openedThreads.length, 1);
  assert.deepEqual(
    transport.turns.map((turn) => turn.threadId),
    ["thread-1", "thread-1"]
  );
  assert.deepEqual(
    transport.turns.map((turn) => turn.prompt),
    ["first prompt", "second prompt"]
  );
  // Model and effort fixed at creation ride every turn.
  for (const turn of transport.turns) {
    assert.equal(turn.options.model, "gpt-5.6-terra");
    assert.equal(turn.options.effort, "low");
  }
  await runtime.close();
});

test("a session turn's schema failure corrects in-session, on the same thread", async () => {
  const schema = {
    type: "object",
    required: ["ok"],
    additionalProperties: false,
    properties: { ok: { type: "boolean" } }
  };
  const transport = new ScriptedTransport([turnResult("not json at all"), turnResult('{"ok": true}')]);
  const runtime = codexRuntime(transport);
  const session = runtime.createWorkerSession({ engine: "codex" });

  assert.deepEqual(await session.send("produce the flag", { schema }), { ok: true });

  // The correction is a follow-up turn on the held thread — it names the
  // failure and does not restate the prompt the thread already holds.
  assert.equal(transport.openedThreads.length, 1);
  assert.equal(transport.turns.length, 2);
  assert.equal(transport.turns[1]?.threadId, "thread-1");
  assert.match(transport.turns[1]?.prompt ?? "", /invalid-json/);
  assert.ok(!(transport.turns[1]?.prompt ?? "").includes("produce the flag"));
  await runtime.close();
});

test("per-turn records carry session identity, their own prompts, and dispatch-time writes", async () => {
  const captured: RuntimeAgentRecord[] = [];
  const recorder = {
    recordAgent: async (record: RuntimeAgentRecord) => {
      captured.push(structuredClone(record));
    }
  } as unknown as RunRecordWriter;
  const transport = new ScriptedTransport([
    turnResult("one", { resolvedModel: "gpt-5.6-terra-2026-08-30", resolvedEffort: "low" }),
    turnResult("two")
  ]);
  const runtime = codexRuntime(transport);
  runtime.setRunRecorder(recorder);
  const session = runtime.createWorkerSession({ engine: "codex", label: "builder" });

  await session.send("restate the task");
  await session.send("now build it");

  // Two turns, four writes: each turn's in-progress dispatch write then its
  // settlement, exactly the one-shot record contract.
  assert.equal(captured.length, 4);
  const [firstDispatch, firstSettled, secondDispatch, secondSettled] = captured;
  assert.equal(firstDispatch?.status, "in-progress");
  assert.deepEqual(firstDispatch?.session, { id: 1, turn: 1 });
  assert.equal(firstDispatch?.prompt, "restate the task");
  assert.equal(firstSettled?.status, "complete");
  assert.equal(secondDispatch?.status, "in-progress");
  assert.deepEqual(secondDispatch?.session, { id: 1, turn: 2 });
  assert.equal(secondDispatch?.prompt, "now build it");
  assert.equal(secondDispatch?.resolvedModel, "gpt-5.6-terra-2026-08-30");
  assert.equal(secondDispatch?.resolvedEffort, "low");
  assert.deepEqual(secondSettled?.session, { id: 1, turn: 2 });
  assert.equal(secondSettled?.label, "builder");
  await runtime.close();
});

test("a failed first Codex turn carries served identity into the next dispatch", async () => {
  const captured: RuntimeAgentRecord[] = [];
  const recorder = {
    recordAgent: async (record: RuntimeAgentRecord) => {
      captured.push(structuredClone(record));
    }
  } as unknown as RunRecordWriter;
  const transport = new ScriptedTransport([
    turnResult("", {
      resolvedModel: "gpt-5.6-terra-2026-08-30",
      resolvedEffort: "low",
      attemptFailure: { kind: "empty-output", message: "the first turn failed after identifying its worker" }
    }),
    turnResult("recovered")
  ]);
  const runtime = codexRuntime(transport);
  runtime.setRunRecorder(recorder);
  const session = runtime.createWorkerSession({ engine: "codex", maxAttempts: 1 });

  await assert.rejects(session.send("first prompt"));
  await session.send("follow-up prompt");

  const secondDispatch = captured.find(
    (record) => record.session?.turn === 2 && record.status === "in-progress"
  );
  assert.equal(secondDispatch?.resolvedModel, "gpt-5.6-terra-2026-08-30");
  assert.equal(secondDispatch?.resolvedEffort, "low");
  await runtime.close();
});

test("a Codex follow-up record retains session identity, per-call usage, and honest transcript absence", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-session-archive-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd: process.cwd(),
    runUuid: "session-archive",
    workflowPath: path.join(process.cwd(), "session-workflow.js"),
    workflowSource: "export const meta = { task: 'session archive regression' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  const transport = new ScriptedTransport([
    turnResult("first", {
      resolvedModel: "gpt-5.6-terra-2026-08-30",
      resolvedEffort: "low",
      tokenUsageEvents: [spendEvent("thread-1", 10)],
      transcripts: [
        {
          filename: "first-turn.jsonl",
          format: "jsonl",
          source: "scripted-codex",
          threadId: "thread-1",
          content: '{"turn":1}\n'
        }
      ]
    }),
    turnResult("second", {
      // Codex reports a cumulative thread total as well as this turn's
      // delta. The archive summary must retain the latter's per-call shape.
      tokenUsageEvents: [spendEvent("thread-1", 20, 30)],
      // The transport is the capture owner. Its observed loss, not this
      // record's follow-up ordinal, must reach the archive reason.
      transcriptCapture: "lost",
      transcripts: [
        {
          filename: "empty-follow-up.jsonl",
          format: "jsonl",
          source: "scripted-codex",
          threadId: "thread-1",
          content: ""
        }
      ]
    })
  ]);
  const runtime = codexRuntime(transport);
  runtime.setRunRecorder(writer);
  const session = runtime.createWorkerSession({ engine: "codex", model: "gpt-5.6-terra", effort: "low" });

  try {
    await session.send("first prompt");
    await session.send("second prompt");
    await writer.finish({ status: "complete", exitCode: 0, result: null });

    const readAgent = async (id: string) =>
      JSON.parse(await readFile(path.join(writer.archiveDir, "agents", id, "agent.json"), "utf8")) as {
        resolved_model: string | null;
        resolved_effort: string | null;
        transcripts: Array<{ path: string }>;
        transcripts_unavailable: string | null;
        transcript_capture: "retained" | "lost" | null;
        usage: { summary?: { totalTokens: number } };
      };
    const first = await readAgent("000001");
    const second = await readAgent("000002");
    const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
      cost_rollup: { [engine: string]: { [model: string]: { tokens: { totalTokens: number } } } };
    };

    assert.equal(second.resolved_model, "gpt-5.6-terra-2026-08-30");
    assert.equal(second.resolved_effort, "low");
    assert.equal(first.usage.summary?.totalTokens, 10);
    assert.equal(second.usage.summary?.totalTokens, 20);
    assert.equal(manifest.cost_rollup.codex?.["gpt-5.6-terra-2026-08-30"]?.tokens.totalTokens, 30);
    assert.equal(first.transcripts.length, 1);
    assert.equal(first.transcripts_unavailable, null);
    assert.ok(
      (await readFile(path.join(writer.archiveDir, first.transcripts[0]!.path), "utf8")).length > 0,
      "a manifested transcript must name non-empty archived content"
    );
    assert.deepEqual(second.transcripts, []);
    assert.equal(second.transcript_capture, "lost");
    assert.equal(second.transcripts_unavailable, "session-client-capture-gap");
  } finally {
    await runtime.close();
    await rm(store, { recursive: true, force: true });
  }
});

// ScriptedTransport supplies transcript payloads directly, so this cold-read
// archive layer also passes against the broken app-server buffer. The
// discriminating fail-before is the app-server test above the transport seam.
test("a Codex held session cold-reads each scripted turn under its own agent record", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-session-transcript-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd: process.cwd(),
    runUuid: "session-transcript-capture",
    workflowPath: path.join(process.cwd(), "session-workflow.js"),
    workflowSource: "export const meta = { task: 'session transcript capture' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  const transport = new ScriptedTransport(
    ["first", "second", "third"].map((turn, index) =>
      turnResult(`${turn} answer`, {
        resolvedEffort: ["low", "high", "medium"][index]!,
        transcripts: [
          {
            filename: `${turn}-turn.jsonl`,
            format: "jsonl",
            source: "scripted-codex",
            threadId: "thread-1",
            content: JSON.stringify({ turn: index + 1 }) + "\n"
          }
        ]
      })
    )
  );
  const runtime = codexRuntime(transport);
  runtime.setRunRecorder(writer);
  const session = runtime.createWorkerSession({ engine: "codex" });

  try {
    await session.send("first prompt");
    await session.send("second prompt");
    await session.send("third prompt");
    await writer.finish({ status: "complete", exitCode: 0, result: null });

    const records = await Promise.all(
      ["000001", "000002", "000003"].map(async (id) => {
        const record = JSON.parse(await readFile(path.join(writer.archiveDir, "agents", id, "agent.json"), "utf8")) as {
          resolved_effort: string | null;
          transcripts: Array<{ path: string }>;
          transcripts_unavailable: string | null;
        };
        assert.equal(record.transcripts_unavailable, null);
        assert.equal(record.transcripts.length, 1);
        const transcript = record.transcripts[0]!;
        assert.match(transcript.path, new RegExp(`^agents/${id}/`));
        return {
          resolvedEffort: record.resolved_effort,
          path: transcript.path,
          content: await readFile(path.join(writer.archiveDir, transcript.path), "utf8")
        };
      })
    );

    assert.equal(new Set(records.map((record) => record.path)).size, 3);
    assert.deepEqual(records.map((record) => record.content), ["{\"turn\":1}\n", "{\"turn\":2}\n", "{\"turn\":3}\n"]);
    assert.deepEqual(records.map((record) => record.resolvedEffort), ["low", "high", "medium"]);
    assert.deepEqual(transport.turns.map((turn) => turn.threadId), ["thread-1", "thread-1", "thread-1"]);
  } finally {
    await runtime.close();
    await rm(store, { recursive: true, force: true });
  }
});

test("an idle session holds no engine-cap slot between turns", async () => {
  // Cap 1: if the idle session occupied the slot, the one-shot call below
  // could never be admitted and this test would hang (and time out).
  const transport = new ScriptedTransport([turnResult("session turn"), turnResult("one-shot answer")]);
  const runtime = codexRuntime(transport, { concurrency: 1 });
  const session = runtime.createWorkerSession({ engine: "codex" });

  await session.send("hold this context");
  assert.equal(await runtime.agent("independent work", { engine: "codex" }), "one-shot answer");
  await runtime.close();
});

test("each send is its own budget admission: a blown ceiling blocks the next turn pre-dispatch", async () => {
  const transport = new ScriptedTransport([
    turnResult("spent", { tokenUsageEvents: [spendEvent("thread-1", 500)] })
  ]);
  const runtime = codexRuntime(transport, { codexBudget: 100 });
  const session = runtime.createWorkerSession({ engine: "codex" });
  const captured: RuntimeAgentRecord[] = [];
  runtime.setRunRecorder({
    recordAgent: async (record: RuntimeAgentRecord) => {
      captured.push(structuredClone(record));
    }
  } as unknown as RunRecordWriter);

  await session.send("first turn spends past the ceiling");
  runtime.handleTransportEvent({
    method: "thread/tokenUsage/updated",
    params: spendEvent("thread-1", 500).raw,
    receivedAt: Date.now()
  });

  const recordsBefore = captured.length;
  await assert.rejects(session.send("second turn"), BudgetExceededError);
  // A blocked send is a pre-dispatch rejection: no engine reach, no record.
  assert.equal(transport.turns.length, 1);
  assert.equal(captured.length, recordsBefore);
  await runtime.close();
});

test("turns are strictly sequential: a send during an unsettled turn throws", async () => {
  let releaseTurn: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const transport = new ScriptedTransport([turnResult("held answer")]);
  const gatedTransport: RuntimeTransport = {
    cwd: transport.cwd,
    openThread: (options) => transport.openThread(options),
    runTurn: async (threadId, prompt, options) => {
      await gate;
      return transport.runTurn(threadId, prompt, options);
    },
    close: () => transport.close()
  };
  const runtime = codexRuntime(gatedTransport);
  const session = runtime.createWorkerSession({ engine: "codex" });

  const inFlight = session.send("long turn");
  await assert.rejects(session.send("overlapping"), SessionBusyError);
  releaseTurn?.();
  assert.equal(await inFlight, "held answer");
  await runtime.close();
});

test("session creation is validated pre-spawn: schema and unknown keys are rejected with nothing dispatched", async () => {
  const transport = new ScriptedTransport([]);
  const runtime = codexRuntime(transport);

  // schema is per-turn (send()'s), never a creation option.
  assert.throws(
    () => runtime.createWorkerSession({ engine: "codex", schema: { type: "object" } } as never),
    UnrecognisedAgentOptionError
  );
  assert.throws(
    () => runtime.createWorkerSession({ engine: "codex", identity: true } as never),
    UnrecognisedAgentOptionError
  );
  // Effort is fixed at creation and judged there against the canonical
  // vocabulary, before the held worker spawns.
  assert.throws(
    () => runtime.createWorkerSession({ engine: "codex", effort: "warp-speed" }),
    InvalidAgentOptionValueError
  );
  const session = runtime.createWorkerSession({ engine: "codex" });
  await assert.rejects(session.send("fine", { effort: "high" } as never), UnrecognisedAgentOptionError);
  assert.equal(transport.openedThreads.length, 0);
  await runtime.close();
});

test("an opencode session request fails loud before any worker spawns", async () => {
  const runnerCalls: string[] = [];
  const runner = {
    run: async () => {
      runnerCalls.push("run");
      throw new Error("never reached");
    },
    exportSession: async () => {
      runnerCalls.push("export");
      throw new Error("never reached");
    }
  } as unknown as OpenCodeRunner;
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ runner })]),
    defaultMaxAttempts: 1
  });

  assert.throws(() => runtime.createWorkerSession({ engine: "opencode" }), MultiTurnUnsupportedError);
  assert.deepEqual(runnerCalls, []);
  await runtime.close();
});

test("the staleness mark trips at the threshold, stays off when disabled, and never blocks a send", async () => {
  let clock = 1_000_000;
  const transport = new ScriptedTransport([
    turnResult("marked session turn 1"),
    turnResult("unmarked session turn 1"),
    turnResult("send to a stale session still executes")
  ]);
  const runtime = codexRuntime(transport, { now: () => clock, staleAfterMs: 1_000 });
  const marked = runtime.createWorkerSession({ engine: "codex" });
  const unmarked = runtime.createWorkerSession({ engine: "codex", stalenessMark: false });

  // Before the first turn there is nothing to be stale relative to.
  assert.equal(marked.stale, false);
  assert.equal(marked.idleMs, null);

  await marked.send("turn 1");
  await unmarked.send("turn 1");
  clock += 999;
  assert.equal(marked.stale, false);
  clock += 1;
  assert.equal(marked.stale, true);
  assert.equal(marked.idleMs, 1_000);
  // A marking-disabled session never reads marked, whatever its idle gap.
  assert.equal(unmarked.stale, false);

  // Advisory only: the send executes and the mark resets with the new turn.
  assert.equal(await marked.send("turn 2"), "send to a stale session still executes");
  assert.equal(marked.stale, false);
  await runtime.close();
});

test("a machine-declared Claude cache TTL sets the staleness cliff, so mark and cache share one clock", async () => {
  // create() wires the declared worker environment through to the session
  // threshold; construction is lazy, so no engine process ever starts.
  const declared = await EnsembleRuntime.create({
    workerEnvironment: { claude: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m" } }
  });
  assert.equal(declared.createWorkerSession({ engine: "claude" }).staleAfterMs, 300_000);
  await declared.close();

  const undeclared = await EnsembleRuntime.create({});
  assert.equal(undeclared.createWorkerSession({ engine: "claude" }).staleAfterMs, 3_600_000);
  await undeclared.close();

  // The explicit library option still outranks the declaration.
  const explicit = await EnsembleRuntime.create({
    workerEnvironment: { claude: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m" } },
    claudeSessionStaleAfterMs: 1_000
  });
  assert.equal(explicit.createWorkerSession({ engine: "claude" }).staleAfterMs, 1_000);
  await explicit.close();
});

// ---------------------------------------------------------------------------
// Claude side: the follow-up turn rides the valve into the *same* session.
// The scripted control plane reproduces the live daemon's settle quirk; a
// dispatch consumes one scripted turn, each steer appends the next.
// ---------------------------------------------------------------------------

interface ScriptedClaudeTurn {
  text?: string;
}

class SessionFakeControlPlane implements ClaudeControlPlane {
  dispatchCount = 0;
  stopCount = 0;
  readonly dispatched: ClaudeDispatchOptions[] = [];
  readonly steered: string[] = [];

  #dir: string;
  #turns: ScriptedClaudeTurn[];
  #tmux: boolean;
  #sessionSeq = 0;
  #path: string | null = null;
  #present = false;

  constructor(dir: string, turns: ScriptedClaudeTurn[], options: { tmux?: boolean } = {}) {
    this.#dir = dir;
    this.#turns = [...turns];
    this.#tmux = options.tmux ?? true;
  }

  async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
    this.dispatchCount += 1;
    this.dispatched.push(options);
    this.#sessionSeq += 1;
    const sessionId = `fake-session-${this.#sessionSeq}`;
    this.#path = path.join(this.#dir, `${sessionId}.jsonl`);
    this.#present = true;
    await writeFile(this.#path, this.#nextLine());
    return { id: `fake-${this.#sessionSeq}`, sessionId, name: options.name, cwd: options.cwd };
  }

  async poll(): Promise<ClaudeSessionStatus> {
    if (!this.#present) {
      return { status: "absent", state: "unknown", present: false };
    }
    // The live settle quirk: idle status, state stuck at "working".
    return { status: "idle", state: "working", present: true };
  }

  async transcriptPath(): Promise<string | null> {
    return this.#path;
  }

  async steer(_handle: ClaudeSessionHandle, message: string): Promise<boolean> {
    this.steered.push(message);
    if (this.#path !== null) {
      await appendFile(this.#path, this.#nextLine());
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

  #nextLine(): string {
    const turn = this.#turns.shift();
    if (turn?.text === undefined) {
      return "";
    }
    return `${JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: turn.text }], stop_reason: "end_turn" }
    })}\n`;
  }
}

async function withClaudeRuntime(
  turns: ScriptedClaudeTurn[],
  body: (runtime: EnsembleRuntime, controlPlane: SessionFakeControlPlane) => Promise<void>,
  options: { tmux?: boolean; now?: () => number; staleAfterMs?: number } = {}
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-worker-session-"));
  try {
    const controlPlane = new SessionFakeControlPlane(dir, turns, options);
    const adapter = new ClaudeEngineAdapter({
      concurrency: 4,
      cwd: "/fake/cwd",
      controlPlane,
      config: { pollIntervalMs: 1, receiptTimeoutMs: 200 }
    });
    const runtime = new EnsembleRuntime({
      engines: new EngineRegistry([adapter]),
      defaultTurnTimeoutMs: 5_000,
      defaultMaxAttempts: 2,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.staleAfterMs !== undefined ? { claudeSessionStaleAfterMs: options.staleAfterMs } : {})
    });
    await body(runtime, controlPlane);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a claude session's follow-up turn steers the created session, never a fresh dispatch", async () => {
  await withClaudeRuntime([{ text: "first reply" }, { text: "second reply" }], async (runtime, controlPlane) => {
    const session = runtime.createWorkerSession({ engine: "claude", model: "claude-opus-5" });

    assert.equal(await session.send("orient yourself"), "first reply");
    assert.equal(await session.send("now fix the tests"), "second reply");

    // One dispatch; the follow-up rode the valve, carrying the new prompt.
    assert.equal(controlPlane.dispatchCount, 1);
    assert.equal(controlPlane.steered.length, 1);
    assert.match(controlPlane.steered[0] ?? "", /now fix the tests/);
    assert.equal(controlPlane.stopCount, 0);

    await session.close();
    assert.equal(controlPlane.stopCount, 1);
    await runtime.close();
  });
});

test("a claude session is dispatched with the 1-hour cache TTL; a one-shot worker is not", async () => {
  await withClaudeRuntime([{ text: "session reply" }, { text: "one-shot reply" }], async (runtime, controlPlane) => {
    const session = runtime.createWorkerSession({ engine: "claude" });
    await session.send("loiter");
    await runtime.agent("one and done", { engine: "claude" });

    assert.equal(controlPlane.dispatched[0]?.cacheTtl, "1h");
    // The negative arm is the discriminating case: a blanket raise would
    // spend the write premium on workers that gain nothing from it.
    assert.equal(controlPlane.dispatched[1]?.cacheTtl, undefined);
    await runtime.close();
  });
});

test("a Claude session marks elapsed idle time without preventing its next send", async () => {
  let clock = 1_000_000;
  await withClaudeRuntime(
    [{ text: "marked first turn" }, { text: "disabled first turn" }, { text: "marked follow-up" }],
    async (runtime, controlPlane) => {
      const marked = runtime.createWorkerSession({ engine: "claude" });
      const disabled = runtime.createWorkerSession({ engine: "claude", stalenessMark: false });

      await marked.send("remember this");
      await disabled.send("do not mark this");
      clock += 999;
      // A genuine prior send is still below the configured cliff.
      assert.equal(marked.stale, false);
      assert.equal(marked.idleMs, 999);
      // Disabling the advisory mark survives the same elapsed gap.
      assert.equal(disabled.stale, false);
      clock += 1;
      assert.equal(marked.stale, true);
      assert.equal(marked.idleMs, 1_000);
      assert.equal(disabled.stale, false);

      // A stale mark reports an advisory state only: the follow-up still
      // reaches the existing Claude session through its valve.
      assert.equal(await marked.send("continue after idle"), "marked follow-up");
      assert.equal(controlPlane.dispatchCount, 2);
      assert.equal(controlPlane.steered.length, 1);
      assert.equal(marked.stale, false);
      await runtime.close();
    },
    { now: () => clock, staleAfterMs: 1_000 }
  );
});

test("without the valve a follow-up fails loud — the session never silently redispatches", async () => {
  await withClaudeRuntime(
    [{ text: "first reply" }],
    async (runtime, controlPlane) => {
      const session = runtime.createWorkerSession({ engine: "claude" });
      assert.equal(await session.send("orient yourself"), "first reply");

      await assert.rejects(session.send("follow up"), EmptyAgentOutputError);
      // The discriminating assertion: one dispatch, ever. A degraded
      // redispatch would answer this turn from a different session than
      // the one created, breaking the session's continuity.
      assert.equal(controlPlane.dispatchCount, 1);
      await runtime.close();
    },
    { tmux: false }
  );
});

test("the run's end closes every held session, and later sends throw", async () => {
  await withClaudeRuntime([{ text: "only reply" }], async (runtime, controlPlane) => {
    const session = runtime.createWorkerSession({ engine: "claude" });
    await session.send("hold this");
    assert.equal(controlPlane.stopCount, 0);

    await runtime.close();
    assert.equal(controlPlane.stopCount, 1);
    await assert.rejects(session.send("too late"), SessionClosedError);
  });
});
