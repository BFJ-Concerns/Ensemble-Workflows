import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeEngineAdapter, EngineRegistry } from "../../src/engines.js";
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
import { parallel, pipeline } from "../../src/hooks.js";
import { usageSince } from "../../src/claude-transcript.js";

import { RunRecordWriter } from "../../src/run-record.js";
import type { RuntimeAgentRecord } from "../../src/run-record.js";
import type { TranscriptEntry } from "../../src/claude-transcript.js";
import type {
  ClaudeControlPlane,
  ClaudeDispatchOptions,
  ClaudeSessionHandle,
  ClaudeSessionStatus,
  ValveSubmission
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
  #openingArrival: (sent: string) => string | null;
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
    this.#openingArrival = options.openingArrival ?? ((sent) => sent);
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
    // A new session's transcript opens with its own record of the prompt it
    // was launched with — the opening's receipt — and then takes the first
    // scripted turn.
    const arrived = this.#openingArrival(options.prompt);
    await writeFile(this.#path, arrived === null ? "" : `${submissionRow(arrived)}\n`);
    await this.#consume();
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

  async steer(_handle: ClaudeSessionHandle, message: string): Promise<ValveSubmission> {
    this.steerCount += 1;
    this.steered.push(message);
    this.#steered = true;
    if (!this.#steerSucceeds) {
      return { submitted: false, reason: "fake valve refused" };
    }
    if (this.#steerConsumesTurn) {
      // The session records what it received as its own user row — the
      // receipt the engine reads — then takes the next scripted turn.
      if (this.#path !== null) {
        await appendFile(this.#path, `${submissionRow(message)}\n`);
      }
      await this.#consume();
    }
    return { submitted: true };
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.#present = false;
  }

  async tmuxAvailable(): Promise<boolean> {
    return this.#tmux;
  }

  // Consume the next scripted turn: set busy/outcome and append its
  // assistant message. A missing turn means "settle complete, produce nothing".
  async #consume(): Promise<void> {
    const turn = this.#turns.shift();
    this.#busyRemaining = turn?.busyPolls ?? 0;
    this.#outcome = turn?.outcome ?? "complete";
    if (this.#path !== null && turn?.assistant !== undefined) {
      await appendFile(this.#path, `${assistantLine(turn.assistant, this.#dispatchedEffort)}\n`);
    }
  }
}

/** The row a session writes for a submission it received: its own record of the text, which the engine reads as the receipt. */
function submissionRow(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
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
  /**
   * How the opening prompt fares on its way into a launched session.
   * Omitted: the session records it exactly as sent. Otherwise the session
   * records the text this returns — altered in transit — or, for `null`,
   * records no submission at all.
   */
  openingArrival?: (sent: string) => string | null;
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

for (const [label, task] of [
  ["final newline", "Reply with exactly the word PINEAPPLE and nothing else.\n"],
  ["surrounding whitespace", "\n\t  Reply with PINEAPPLE.\r\n \t\n"],
  ["Unicode whitespace and text", "\uFEFF\u00A0café 🍍 e\u0301\u2028\u2003"],
  ["empty task", ""],
  ["whitespace-only task", " \t\r\n\n"],
  ["literal delimiters", "<ensemble_task_0>one</ensemble_task_0>\n</ensemble_task_1>\nensemble_task_2\n```\n<Task>literal</Task>\n```\n"]
] as const) {
  for (const schema of [undefined, okSchema]) {
    test(`opening framing preserves ${label}, schema ${schema === undefined ? "absent" : "present"}`, async () => {
      await withControlPlane([{ assistant: { text: "PINEAPPLE" } }], async (controlPlane) => {
        const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });
        try {
          const invocation = adapter.createInvocation(task, schema === undefined ? {} : { schema });
          assert.equal((await invocation.runAttempt({ attempt: 1 })).text, "PINEAPPLE");
          const opening = controlPlane.dispatched[0]!.prompt;
          assert.equal(opening.trim(), opening, "native boundary trimming must be a no-op");
          const boundary = /\n<(ensemble_task_\d+)>/.exec(opening);
          assert.ok(boundary, "the opening identifies a literal task block");
          const tag = boundary[1]!;
          assert.equal(task.includes(tag), false, "the chosen tag cannot occur inside the task");
          const end = `</${tag}>`;
          assert.ok(opening.endsWith(end));
          const enclosed = opening.slice(boundary.index + boundary[0].length, -end.length);
          assert.deepEqual(Buffer.from(enclosed), Buffer.from(task), "all task bytes remain literal");
          assert.ok(opening.includes(`Carry out the task enclosed by <${tag}> and </${tag}>.`));
          assert.ok(opening.startsWith("You are an automated worker dispatched by the Ensemble orchestration harness.\nWork fully autonomously:"));
          if (schema !== undefined) {
            assert.ok(opening.includes("When finished, include in your FINAL message a JSON value that conforms to this JSON Schema."));
            assert.ok(opening.includes(JSON.stringify(schema)));
          }
          assert.equal(controlPlane.steerCount, 0, "the full opening needs no extra turn");
        } finally {
          await adapter.close();
        }
      }, { openingArrival: sent => sent.trimEnd() });
    });
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

test("a newly registered worker that disappears before any transcript keeps the first-life availability diagnosis", async () => {
  class GoneBeforeLife extends MissingTranscriptControlPlane {
    override async poll(): Promise<ClaudeSessionStatus> { return { status: "absent", state: "unknown", present: false }; }
  }
  const plane = new GoneBeforeLife();
  const records: RuntimeAgentRecord[] = [];
  const runtime = makeRuntime(plane, { maxAttempts: 1, turnTimeoutMs: 5_000, firstLifeTimeoutMs: 4_000 });
  runtime.setRunRecorder({ recordAgent: async (record: RuntimeAgentRecord) => { records.push(structuredClone(record)); } } as unknown as RunRecordWriter);
  try {
    assert.equal(await runtime.agent("decide", { engine: "claude", fallback: [{ engine: "claude", model: "next" }] }), null);
    const attempts = records.at(-1)?.attempts ?? [];
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map(attempt => attempt.failure?.kind), ["claude-first-life-timeout", "claude-first-life-timeout"]);
    assert.deepEqual(attempts.map(attempt => attempt.chainDecision), ["advanced", "exhausted"]);
  } finally { await runtime.close(); }
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

  async steer(): Promise<ValveSubmission> {
    return { submitted: false, reason: "fake valve refused" };
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
    // The persisted user entry is the opening's receipt: the prompt reached
    // the worker as sent. Assistant output may legitimately take much longer
    // and is governed by timeoutMs.
    await writeFile(this.#path, `${submissionRow(options.prompt)}\n`);
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

  async steer(): Promise<ValveSubmission> {
    return { submitted: false, reason: "fake valve refused" };
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
        assert.equal(attempt?.transcripts[0]?.partial, false);
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
      `${submissionRow(options.prompt)}\n${assistantLine({ ...firstCall })}\n${assistantLine({ ...firstCall, text: "looking" })}\n`
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

  async steer(): Promise<ValveSubmission> {
    return { submitted: false, reason: "fake valve refused" };
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
/** A task's notification rows as Claude Code writes them (measured 2026-09-29, Claude Code 2.1.285). */
const backgroundTaskRows = {
  commandNotification: (taskId: string, toolUseId: string, description: string): string =>
    `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Background command "${description}" completed (exit code 0)</summary>\n</task-notification>`,
  monitorNotification: (taskId: string, event: string): string =>
    `<task-notification>\n<task-id>${taskId}</task-id>\n<summary>Monitor event: "background task completion"</summary>\n<event>${event}</event>\n</task-notification>`,
  /** The moment the task ends: bookkeeping about the queue, not a delivery. */
  enqueued: (block: string): string => JSON.stringify({ type: "queue-operation", operation: "enqueue", content: block }),
  /** Delivered to an idle session as its next user turn. */
  deliveredIdle: (block: string): string[] => [
    JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
    JSON.stringify({ type: "user", message: { role: "user", content: block }, origin: { kind: "task-notification" } })
  ],
  /** Delivered into a turn already in flight, as an attachment. */
  absorbedMidTurn: (block: string): string[] => [
    JSON.stringify({ type: "queue-operation", operation: "remove", content: block, reason: "absorbed_mid_turn" }),
    JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: block, commandMode: "task-notification" } })
  ]
};

/**
 * A session that backgrounds work and ends its turn on an interim message,
 * in the three shapes measured live. `slow`: the task ends long after the
 * interim turn, its notification enqueued and delivered together at
 * `wakeAtPoll`. `short`: the task ends within the interim turn, so its
 * notification is *enqueued before the interim reply* and delivered only at
 * `wakeAtPoll`. `monitor`: a Monitor armed on the command's output — at
 * `wakeAtPoll` the command's notification is delivered, the Monitor's event
 * is absorbed into the reply's turn after its tool rows, and the model
 * replies with the nonce;
 * the Monitor's expiry notice is delivered three polls later and answered
 * two after that. In every shape the model's reply lands two polls after a
 * delivery, never in the same write, as it does live.
 */
class BackgroundTaskControlPlane implements ClaudeControlPlane {
  pollCount = 0;
  readonly snapshots: Array<{ poll: number; waitingOn: unknown }> = [];
  #path: string;
  #present = false;
  #wakeAtPoll: number | null;
  #shape: "slow" | "short" | "monitor";
  #observe: (() => unknown) | undefined;

  constructor(dir: string, options: { wakeAtPoll: number | null; shape?: "slow" | "short" | "monitor"; observe?: () => unknown }) {
    this.#path = path.join(dir, "background-task.jsonl");
    this.#wakeAtPoll = options.wakeAtPoll;
    this.#shape = options.shape ?? "slow";
    this.#observe = options.observe;
  }

  async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
    this.#present = true;
    const call = { type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "sleep 45", description: "Wait 45 seconds in background", run_in_background: true } };
    const rows = [
      submissionRow(options.prompt),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [call], stop_reason: "tool_use" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Command running in background with ID: bya9z1l44. You will be notified when it completes." }] } })
    ];
    if (this.#shape === "short") {
      rows.push(backgroundTaskRows.enqueued(this.#commandBlock()));
    }
    if (this.#shape === "monitor") {
      const monitor = { type: "tool_use", id: "toolu_mon", name: "Monitor", input: { command: "tail -f /tmp/bya9z1l44.output", description: "background task completion" } };
      rows.push(
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [monitor], stop_reason: "tool_use" } }),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mon", content: "Monitor started (task b7zb0kfnb, expires in 1m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch)." }] } })
      );
    }
    rows.push(assistantLine({ text: "The sleep is running in the background. I'll reply once it finishes.", output: 15 }));
    await writeFile(this.#path, rows.join("\n") + "\n");
    return { id: "background-1", sessionId: "background", name: options.name, cwd: options.cwd };
  }

  #commandBlock(): string {
    return backgroundTaskRows.commandNotification("bya9z1l44", "toolu_bg", "Wait 45 seconds in background");
  }

  async poll(): Promise<ClaudeSessionStatus> {
    this.pollCount += 1;
    this.snapshots.push({ poll: this.pollCount, waitingOn: this.#observe?.() });
    const wake = this.#wakeAtPoll;
    if (wake !== null) {
      const rows: string[] = [];
      if (this.pollCount === wake) {
        if (this.#shape === "slow") {
          rows.push(backgroundTaskRows.enqueued(this.#commandBlock()));
        }
        rows.push(...backgroundTaskRows.deliveredIdle(this.#commandBlock()));
        if (this.#shape === "monitor") {
          // The measured order: the model's turn after the command's wake
          // reads the output file, and the Monitor's event is absorbed into
          // that turn — its tool rows first, the attachment after them.
          const read = { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/tmp/bya9z1l44.output" } };
          const event = backgroundTaskRows.monitorNotification("b7zb0kfnb", "NONCE-8bdca0417a34\n[exited with code 0]");
          rows.push(
            backgroundTaskRows.enqueued(event),
            JSON.stringify({ type: "assistant", message: { role: "assistant", content: [read], stop_reason: "tool_use" } }),
            JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "1\tNONCE-8bdca0417a34\n2\t[exited with code 0]" }] } }),
            ...backgroundTaskRows.absorbedMidTurn(event)
          );
        }
      }
      if (this.pollCount === wake + 2) {
        // The model's reply to the wake — the answer, unless a Monitor is
        // still watching — lands after the notification rows, never in the
        // same write.
        rows.push(assistantLine({ text: this.#shape === "monitor" ? '{"ok":false}' : '{"ok":true}', output: 4 }));
      }
      if (this.#shape === "monitor" && this.pollCount === wake + 5) {
        const expiry = backgroundTaskRows.monitorNotification("b7zb0kfnb", "[Monitor expired after 1m with 1 event delivered. Re-arm it if you still need the watch.]");
        rows.push(backgroundTaskRows.enqueued(expiry), ...backgroundTaskRows.deliveredIdle(expiry));
      }
      if (this.#shape === "monitor" && this.pollCount === wake + 7) {
        rows.push(assistantLine({ text: '{"ok":true}', output: 4 }));
      }
      if (rows.length > 0) {
        await appendFile(this.#path, rows.join("\n") + "\n");
      }
    }
    // The daemon reports the session idle the whole time it waits for its
    // own notification — the same roster shape a settled-but-unproven
    // session shows, which must not be judged a collection failure here.
    return { status: "idle", state: "working", present: this.#present };
  }

  async transcriptPath(): Promise<string | null> {
    return this.#present ? this.#path : null;
  }

  async steer(): Promise<ValveSubmission> {
    return { submitted: false, reason: "fake valve refused" };
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

test("a task that ends within the interim turn is still held for the reply after its delivery, never collected on the enqueue row", async () => {
  // The short-task shape (measured 2026-09-29: 3 of 24 short tasks answered
  // with interim text at the previous landing): the ending is enqueued
  // before the interim reply and delivered only once the session is idle.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-short-task-"));
  try {
    let runtime: EnsembleRuntime | null = null;
    const controlPlane = new BackgroundTaskControlPlane(dir, {
      shape: "short",
      wakeAtPoll: 12,
      observe: () => runtime?.progress.snapshot().agents[0]?.waitingOn ?? "no live agent"
    });
    runtime = makeRuntime(controlPlane, { maxAttempts: 1 });
    try {
      assert.deepEqual(await runtime.agent("run then answer", { engine: "claude", schema: okSchema }), { ok: true });
      assert.ok(controlPlane.pollCount >= 14, `collected before the reply that follows the delivery, after ${controlPlane.pollCount} polls`);
      // With the ending already enqueued, the wait still shows until the
      // delivery is answered.
      const during = controlPlane.snapshots.find((snapshot) => snapshot.poll === 6)?.waitingOn as { taskId?: string } | null;
      assert.equal(during?.taskId, "bya9z1l44");
      const record = runtime.lastAgentRecord();
      assert.equal(record?.status, "complete");
      assert.equal(record?.rawOutput, '{"ok":true}');
      const waits = record?.attempts[0]?.backgroundWaits ?? [];
      assert.equal(waits.length, 1);
      assert.ok(waits[0]?.endedAt !== null, "the wait closed at the reply after the delivery");
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Monitor's event keeps its wait open; its own expiry notice closes it, and the reply after that is the answer", async () => {
  // The Monitor shape (measured 2026-09-29: the wait never closed and the
  // call never settled at the previous landing): the command's wake is
  // answered with the nonce while the Monitor still watches, and the
  // answer is the reply after the Monitor's own notice.
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-monitor-task-"));
  try {
    let runtime: EnsembleRuntime | null = null;
    const controlPlane = new BackgroundTaskControlPlane(dir, {
      shape: "monitor",
      wakeAtPoll: 8,
      observe: () => runtime?.progress.snapshot().agents[0]?.waitingOn ?? "no live agent"
    });
    runtime = makeRuntime(controlPlane, { maxAttempts: 1 });
    try {
      assert.deepEqual(await runtime.agent("run, watch, answer", { engine: "claude", schema: okSchema }), { ok: true });
      assert.ok(controlPlane.pollCount >= 15, `collected before the reply that follows the Monitor's notice, after ${controlPlane.pollCount} polls`);
      // Before the wake the earliest open wait — the command's — shows;
      // once the command is answered the Monitor's wait is what remains.
      const before = controlPlane.snapshots.find((snapshot) => snapshot.poll === 4)?.waitingOn as { taskId?: string } | null;
      assert.equal(before?.taskId, "bya9z1l44");
      const between = controlPlane.snapshots.find((snapshot) => snapshot.poll === 12)?.waitingOn as { taskId?: string; description?: string } | null;
      assert.equal(between?.taskId, "b7zb0kfnb");
      assert.equal(between?.description, "background task completion");
      const record = runtime.lastAgentRecord();
      assert.equal(record?.status, "complete");
      assert.equal(record?.rawOutput, '{"ok":true}', "the reply after the command's wake is not the answer while the Monitor watches");
      const waits = record?.attempts[0]?.backgroundWaits ?? [];
      assert.deepEqual(waits.map((wait) => wait.taskId), ["bya9z1l44", "b7zb0kfnb"]);
      assert.ok(waits.every((wait) => wait.endedAt !== null), "both waits closed");
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
      assert.equal(attempt?.transcripts[0]?.partial, true,
        "an interim reply does not complete the transcript while its background task is outstanding");
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

// ---------------------------------------------------------------------------
// An opening prompt is delivered when its receipt verifies, not when the
// launch returns. These two are the rule for what a failed opening may do
// next: a session that took something keeps the call on its target, and
// only a launch that left no session lets the same prompt go to the next
// entry of the fallback chain. Each reads the control plane's own log —
// what was launched, on which model, and when a session was stopped.
// ---------------------------------------------------------------------------

test("an opening the session received altered stays on its target: each session is stopped before the next is launched, and the chain is never consulted", async () => {
  // Every launch delivers the prompt cut short, as a launch with a size
  // limit of its own would, so no attempt can verify.
  const cut = (sent: string): string => sent.slice(0, -1);
  await withControlPlane(
    [
      { assistant: { text: "reply to the cut prompt" } },
      { assistant: { text: "reply to the cut prompt" } },
      { assistant: { text: "reply to the cut prompt" } }
    ],
    async (controlPlane) => {
      const order: string[] = [];
      const launch = controlPlane.dispatch.bind(controlPlane);
      const stop = controlPlane.stop.bind(controlPlane);
      controlPlane.dispatch = async (options) => {
        order.push("launch");
        return launch(options);
      };
      controlPlane.stop = async () => {
        order.push("stop");
        return stop();
      };
      const runtime = makeRuntime(controlPlane);
      const records: RuntimeAgentRecord[] = [];
      runtime.setRunRecorder({
        recordAgent: async (record: RuntimeAgentRecord) => {
          records.push(structuredClone(record));
        }
      } as unknown as RunRecordWriter);
      try {
        // The session answered the cut prompt each time, and no reply is the
        // call's value: a reply to text nobody sent answers nothing.
        const result = await runtime.agent("decide", {
          engine: "claude",
          fallback: [{ engine: "claude", model: "sonnet" }]
        });
        assert.equal(result, null);

        // The discriminating assertions. Every launch is on the call's own
        // target: the chain entry's model was never launched, because a
        // session that took something is not an unavailable target.
        assert.deepEqual(controlPlane.dispatched.map((dispatched) => dispatched.model), [undefined, undefined, undefined]);
        // And no two sessions ever held the prompt at once: the one that
        // took the cut copy was stopped before the retry launched another.
        assert.deepEqual(order, ["launch", "stop", "launch", "stop", "launch", "stop"]);

        // Each attempt is a delivery failure that says so, classed as
        // neither availability nor output, keeping what the session wrote.
        const attempts = records.at(-1)?.attempts ?? [];
        assert.deepEqual(attempts.map((attempt) => attempt.failure?.kind), ["claude-delivery-error", "claude-delivery-error", "claude-delivery-error"]);
        assert.deepEqual(attempts.map((attempt) => attempt.classification), Array(3).fill({ class: "unclassified", rule: "claude.delivery" }));
        assert.deepEqual(attempts.map((attempt) => attempt.chainDecision), ["retried-in-place", "retried-in-place", "exhausted"]);
        assert.deepEqual(attempts.map((attempt) => attempt.rawOutput), Array(3).fill("reply to the cut prompt"));
        assert.match(
          attempts[0]?.failure?.message ?? "",
          /^the opening prompt was submitted, but the session received different text: sent \d+ UTF-8 bytes, sha256 [0-9a-f]{64}; received \d+ UTF-8 bytes, sha256 [0-9a-f]{64}$/
        );
      } finally {
        await runtime.close();
      }
    },
    { openingArrival: cut }
  );
});

test("a launch that left no session moves the call to its next chain entry, and that entry's opening is verified like any other", async () => {
  await withControlPlane([{ assistant: { text: "answer from the chain entry" } }], async (controlPlane) => {
    const launch = controlPlane.dispatch.bind(controlPlane);
    let launches = 0;
    controlPlane.dispatch = async (options) => {
      launches += 1;
      if (launches === 1) {
        // Nothing registered, so no session holds the prompt.
        throw new ClaudeRegistrationTimeoutError("dispatched session 'w' in /fake/cwd did not register within 30000ms");
      }
      return launch(options);
    };
    const runtime = makeRuntime(controlPlane);
    const records: RuntimeAgentRecord[] = [];
    runtime.setRunRecorder({
      recordAgent: async (record: RuntimeAgentRecord) => {
        records.push(structuredClone(record));
      }
    } as unknown as RunRecordWriter);
    try {
      const result = await runtime.agent("decide", {
        engine: "claude",
        fallback: [{ engine: "claude", model: "sonnet" }]
      });
      assert.equal(result, "answer from the chain entry");
      assert.equal(launches, 2);
      assert.deepEqual(controlPlane.dispatched.map((dispatched) => dispatched.model), ["sonnet"]);
      const attempts = records.at(-1)?.attempts ?? [];
      assert.deepEqual(attempts.map((attempt) => attempt.failure?.kind ?? null), ["claude-registration-timeout", null]);
      assert.deepEqual(attempts[0]?.classification, { class: "availability", rule: "claude.no-registration" });
      assert.equal(attempts[0]?.chainDecision, "advanced");
    } finally {
      await runtime.close();
    }
  });
});

test("Claude reports a readable transcript after an initially absent path", async () => {
  await withControlPlane([{ assistant: { text: "ok" } }], async (controlPlane) => {
    const lookup = controlPlane.transcriptPath.bind(controlPlane);
    let reads = 0;
    controlPlane.transcriptPath = async () => ++reads === 1 ? null : lookup();
    const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });
    const invocation = adapter.createInvocation("go", {});
    const paths: string[] = [];
    const result = await invocation.runAttempt({
      attempt: 1,
      onTranscriptPath: (file) => {
        paths.push(file);
        throw new Error("observer failed");
      }
    });
    assert.equal(result.text, "ok");
    assert.ok(reads >= 2);
    assert.ok(paths.length > 0, "transcript discovery must notify the observer after an initially absent path");
    assert.equal(await readFile(paths[0]!, "utf8"), result.transcripts![0]!.content);
    await invocation.close?.();
  });
});

test("Claude reports its transcript for every held-session turn and correction", async () => {
  await withControlPlane([
    { assistant: { text: "first" } },
    { assistant: { text: "second" } },
    { assistant: { text: "corrected" } }
  ], async (controlPlane) => {
    const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });
    const session = adapter.createSession({});
    const paths: string[][] = [[], [], []];
    try {
      const first = session.beginTurn("first", {});
      assert.equal((await first.runAttempt({ attempt: 1, onTranscriptPath: (file) => paths[0]!.push(file) })).text, "first");
      const second = session.beginTurn("second", {});
      assert.equal((await second.runAttempt({ attempt: 1, onTranscriptPath: (file) => paths[1]!.push(file) })).text, "second");
      assert.equal((await second.runAttempt({
        attempt: 2, previousFailure: { kind: "validation", message: "correct it" },
        onTranscriptPath: (file) => paths[2]!.push(file)
      })).text, "corrected");
      for (const captured of paths) {
        assert.ok(captured.length > 0, "each held turn and correction must publish its transcript path");
        assert.ok(captured.every((file) => file === paths[0]![0]));
      }
    } finally {
      await session.close();
    }
  });
});


test("Claude observes changed assistant output, served identity and usage without counting unchanged polls", async () => {
  await withControlPlane([{ busyPolls: 2, assistant: {
    text: "observed", model: "claude-served", effort: "high", input: 10, output: 4
  } }], async (controlPlane) => {
    const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });
    const invocation = adapter.createInvocation("go", {});
    let outputs = 0;
    const identities: unknown[] = [];
    let spent = 0;
    const result = await invocation.runAttempt({
      attempt: 1,
      onOutput: () => { outputs += 1; },
      onIdentity: (identity) => { identities.push(identity); },
      onUsage: (event) => { spent += event.last.totalTokens; }
    });
    assert.equal(outputs, 1, "unchanged polls must not advance the last-output stamp");
    assert.ok(identities.some((identity) => JSON.stringify(identity) === JSON.stringify({
      resolvedModel: "claude-served", resolvedEffort: "high"
    })));
    assert.equal(spent, result.tokenUsageEvents.reduce((sum, event) => sum + event.last.totalTokens, 0));
    assert.ok(spent > 0);
    await invocation.close?.();
  });
});


test("Claude continues reporting new assistant rows after the first output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-output-growth-"));
  try {
    const controlPlane = new SplitRowsControlPlane(dir);
    const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });
    const invocation = adapter.createInvocation("go", {});
    const observedAt: number[] = [];
    try {
      await invocation.runAttempt({ attempt: 1, onOutput: () => { observedAt.push(controlPlane.pollCount); } });
      assert.ok(observedAt.length >= 2, "each newly appended assistant batch must remain visible");
      assert.equal(observedAt.at(-1), 3);
    } finally { await invocation.close?.(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("a failed in-session correction retains the served identity in status and archive", async () => {
  await withControlPlane([{ assistant: { text: "not json", model: "claude-observed", effort: "high" } }], async (controlPlane) => {
    const runtime = makeRuntime(controlPlane, { maxAttempts: 2 });
    const records: RuntimeAgentRecord[] = [];
    runtime.setRunRecorder({ recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record)) } as unknown as RunRecordWriter);
    try {
      assert.equal(await runtime.agent("decide", { engine: "claude", schema: okSchema }), null);
      assert.equal(controlPlane.dispatchCount, 1);
      assert.equal(controlPlane.steerCount, 1);
      const agent = runtime.progress.snapshot().agents[0]!;
      assert.equal(agent.resolvedModel, "claude-observed");
      assert.equal(agent.resolvedEffort, "high");
      assert.equal(records.at(-1)?.resolvedModel, "claude-observed");
      assert.equal(records.at(-1)?.resolvedEffort, "high");
      assert.equal(records.at(-1)?.attempts[1]?.rawOutput, null);
    } finally { await runtime.close(); }
  }, { steerSucceeds: false });
});

test("a held Claude turn retains observed identity before new assistant output", async () => {
  await withControlPlane([
    { assistant: { text: "first", model: "claude-held", effort: "high" } },
    { busyPolls: 2 }
  ], async (controlPlane) => {
    const adapter = new ClaudeEngineAdapter({ controlPlane, config: fastConfig });
    const held = adapter.createSession({});
    try {
      await held.beginTurn("first", {}).runAttempt({ attempt: 1 });
      const observed: Array<{ resolvedModel: string | null; resolvedEffort: string | null }> = [];
      await held.beginTurn("second", {}).runAttempt({ attempt: 1, onIdentity: (identity) => observed.push(identity) });
      assert.ok(observed.length > 0, "the held turn must expose its identity while waiting");
      assert.ok(observed.every((identity) => identity.resolvedModel === "claude-held" && identity.resolvedEffort === "high"));
    } finally { await held.close(); await adapter.close(); }
  });
});


test("closing a held Claude session mid-turn stays a worker failure through combinators", async () => {
  for (const shape of ["parallel", "pipeline"]) {
    await withControlPlane([{ busyPolls: 10_000 }], async (controlPlane) => {
      let markPolled: (() => void) | undefined;
      const polled = new Promise<void>((resolve) => { markPolled = resolve; });
      const poll = controlPlane.poll.bind(controlPlane);
      controlPlane.poll = async () => {
        const status = await poll();
        markPolled?.();
        return status;
      };
      const runtime = makeRuntime(controlPlane, { maxAttempts: 3 });
      const session = runtime.createWorkerSession({ engine: "claude", model: "opus" });
      try {
        const send = () => session.send("work");
        const result = shape === "parallel"
          ? parallel([send], () => {})
          : pipeline(["item"], [send], () => {});
        await polled;
        await session.close();
        assert.deepEqual(await result, [null], shape);
        assert.equal(runtime.lastAgentRecord()?.status, "failed");
        assert.equal(runtime.lastAgentRecord()?.attempts[0]?.failure?.kind, "EngineShutdownError");
        assert.equal(runtime.lastAgentRecord()?.attempts.length, 3);
        assert.ok(runtime.lastAgentRecord()?.attempts.every((attempt) =>
          attempt.classification?.rule === "engine-shutdown"));
        assert.equal(controlPlane.dispatchCount, 1, "retry accounting never starts another worker");
      } finally {
        await runtime.close();
      }
    });
  }
});
test("a successful native turn retains the account of a launch that could not be safely discarded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-recovered-launch-"));
  const diagnostics = { claudeLaunch: { failure: "attachment outcome uncertain", cleanupConfirmed: false, command: { exitCode: 0 } } };
  class AccountedLaunch extends FakeControlPlane {
    override async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
      const handle = await super.dispatch(options);
      return { ...handle, launchFailure: { message: "attachment outcome uncertain", diagnostics } };
    }
  }
  const plane = new AccountedLaunch(dir, [{ assistant: { text: "answer" } }]);
  const records: RuntimeAgentRecord[] = [];
  const runtime = makeRuntime(plane, { maxAttempts: 1 });
  runtime.setRunRecorder({ recordAgent: async (record: RuntimeAgentRecord) => { records.push(structuredClone(record)); } } as unknown as RunRecordWriter);
  try {
    assert.equal(await runtime.agent("decide", { engine: "claude" }), "answer");
    assert.equal(records.at(-1)?.status, "complete");
    assert.deepEqual(records.at(-1)?.attempts[0]?.diagnostics, { ...diagnostics, worktrees: [] });
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const grows of [false, true]) {
  test(`pending held work is charged once across retries${grows ? " while later API usage still counts" : ""}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-pending-spend-"));
    class AbsentWhilePending extends FakeControlPlane {
      override async poll(): Promise<ClaudeSessionStatus> { return { status: "absent", state: "unknown", present: false }; }
    }
    const plane = new AbsentWhilePending(dir, [{ assistant: { id: "first-call", text: "working", input: 100, output: 10, stop: "tool_use" } }], { openingArrival: sent => sent.replace("decide ", "decide") });
    const runtime = makeRuntime(plane, { maxAttempts: 2 });
    const records: RuntimeAgentRecord[] = [];
    runtime.setRunRecorder({
      recordAttemptStart: async (_id: number, attempt: number) => {
        if (grows && attempt === 2) {
          const file = await plane.transcriptPath();
          assert.ok(file);
          await appendFile(file, assistantLine({ id: "later-call", text: "more work", input: 20, output: 5, stop: "tool_use" }) + "\n");
        }
      },
      recordAttemptEnd: async () => {},
      recordAgent: async (record: RuntimeAgentRecord) => { records.push(structuredClone(record)); }
    } as unknown as RunRecordWriter);
    try {
      const held = runtime.createWorkerSession({ engine: "claude" });
      assert.equal(await held.send("decide "), null);
      const attempts = records.at(-1)?.attempts ?? [];
      assert.equal(attempts.length, 2);
      assert.equal(plane.dispatchCount, 1);
      assert.equal(plane.steerCount, 0, "the retry submitted into unfinished pending work");
      assert.deepEqual(attempts.map(attempt => attempt.tokenUsageEvents.reduce((sum, event) => sum + event.last.totalTokens, 0)), [110, grows ? 25 : 0]);
      assert.equal(runtime.budget.spent("claude"), grows ? 135 : 110);
    } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const present of [false, true]) {
  test(`an unclean launch without a transcript stays non-availability while roster presence is ${present}`, async () => {
    class UncleanLaunch extends MissingTranscriptControlPlane {
      launches = 0;
      override async dispatch(options: ClaudeDispatchOptions): Promise<ClaudeSessionHandle> {
        this.launches += 1;
        return { ...await super.dispatch(options), launchFailure: {
          message: "launch cleanup remains unconfirmed",
          diagnostics: { claudeLaunch: { cleanupConfirmed: false, failure: "launch failed" } }
        } };
      }
      override async poll(): Promise<ClaudeSessionStatus> { return { status: present ? "busy" : "absent", state: "unknown", present }; }
      override async stop(): Promise<void> { /* The control plane cannot confirm removal. */ }
    }
    const plane = new UncleanLaunch();
    const runtime = makeRuntime(plane, { maxAttempts: 1, firstLifeTimeoutMs: present ? 1 : 5_000 });
    const records: RuntimeAgentRecord[] = [];
    runtime.setRunRecorder({ recordAgent: async (record: RuntimeAgentRecord) => { records.push(structuredClone(record)); } } as unknown as RunRecordWriter);
    try {
      assert.equal(await runtime.agent("decide", { engine: "claude", fallback: [{ engine: "claude", model: "unused" }] }), null);
      assert.equal(plane.launches, 1, "an unclean launch advanced fallback");
      assert.equal(records.at(-1)?.attempts[0]?.failure?.kind, "claude-delivery-error");
      assert.deepEqual(records.at(-1)?.attempts[0]?.classification, { class: "unclassified", rule: "claude.delivery" });
      assert.match(JSON.stringify(records.at(-1)?.attempts[0]?.diagnostics), /launch failed/);
    } finally { await runtime.close(); }
  });
}

for (const [altered, lateOpening] of [[true, false], [false, false], [false, true]] as const) {
  test(`a late recovery-nudge receipt ${altered ? "cannot verify an altered task" : lateOpening ? "can finish a late-verified task" : "can finish an already verified task"}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-nudge-receipt-"));
    class LateNudge extends FakeControlPlane {
      readonly messages: string[] = [];
      nudge: string | null = null;
      override async steer(handle: ClaudeSessionHandle, message: string): Promise<ValveSubmission> {
        this.messages.push(message);
        if (this.nudge === null) {
          this.nudge = message;
          return { submitted: true };
        }
        return super.steer(handle, message);
      }
    }
    const plane = new LateNudge(dir, [{ outcome: "blocked" }, { assistant: { text: "answer after exact redelivery" } }], {
      openingArrival: sent => lateOpening ? null : altered ? sent.replace("decide ", "decide") : sent
    });
    const runtime = makeRuntime(plane, { maxAttempts: 3, receiptTimeoutMs: 1, blockedRecoveryBound: 1 });
    const records: RuntimeAgentRecord[] = [];
    const nudgeAnswer = altered ? "answer to altered task" : "answer to verified task";
    runtime.setRunRecorder({
      recordAttemptStart: async (_id: number, attempt: number) => {
        if (lateOpening && attempt === 2) {
          const file = await plane.transcriptPath();
          assert.ok(file);
          await appendFile(file, submissionRow(plane.dispatched[0]!.prompt) + "\n");
        }
        if (attempt === (lateOpening ? 3 : 2)) {
          const file = await plane.transcriptPath();
          assert.ok(file && plane.nudge);
          await appendFile(file, submissionRow(plane.nudge) + "\n" + assistantLine({ id: "nudge-answer", text: nudgeAnswer }) + "\n");
        }
      },
      recordAttemptEnd: async () => {},
      recordAgent: async (record: RuntimeAgentRecord) => { records.push(structuredClone(record)); }
    } as unknown as RunRecordWriter);
    try {
      const held = runtime.createWorkerSession({ engine: "claude" });
      const result = await held.send("decide ");
      assert.equal(result, altered ? "answer after exact redelivery" : nudgeAnswer, JSON.stringify({ failures: records.at(-1)?.attempts.map(attempt => attempt.failure), messages: plane.messages }));
      assert.equal(plane.dispatchCount, 1);
      const attempts = records.at(-1)?.attempts ?? [];
      assert.equal(attempts.length, altered || lateOpening ? 3 : 2);
      if (altered) {
        assert.match(attempts[1]?.failure?.message ?? "", /^the opening prompt was submitted, but the session received different text:/);
        assert.equal(attempts[1]?.rawOutput, nudgeAnswer);
        assert.ok(plane.messages[1]?.endsWith(plane.dispatched[0]!.prompt), "the full opening was not redelivered");
      } else assert.equal(plane.messages.length, 1, "a verified task was redelivered after its nudge's receipt arrived");
    } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const shape of ["slow", "monitor"] as const) {
  test(`a pending nudge keeps the task collection window for ${shape === "slow" ? "background Bash" : "Monitor"} work`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-nudge-window-"));
    class NudgeWithBackgroundWork extends BackgroundTaskControlPlane {
      nudge: string | null = null;
      override async poll(): Promise<ClaudeSessionStatus> {
        return this.nudge === null ? { status: "idle", state: "blocked", present: true } : super.poll();
      }
      override async steer(_handle?: ClaudeSessionHandle, message?: string): Promise<ValveSubmission> {
        assert.ok(message);
        this.nudge = message;
        return { submitted: true };
      }
    }
    const plane = new NudgeWithBackgroundWork(dir, { wakeAtPoll: 3, shape });
    const runtime = makeRuntime(plane, { maxAttempts: 2, receiptTimeoutMs: 1 });
    const records: RuntimeAgentRecord[] = [];
    runtime.setRunRecorder({
      recordAttemptStart: async (_id: number, attempt: number) => {
        if (attempt === 2) {
          const file = await plane.transcriptPath();
          assert.ok(file && plane.nudge);
          await appendFile(file, submissionRow(plane.nudge) + "\n" + assistantLine({ text: "Still waiting for background work" }) + "\n");
        }
      },
      recordAttemptEnd: async () => {},
      recordAgent: async (record: RuntimeAgentRecord) => { records.push(structuredClone(record)); }
    } as unknown as RunRecordWriter);
    try {
      const held = runtime.createWorkerSession({ engine: "claude" });
      assert.equal(await held.send("decide"), '{"ok":true}');
      assert.ok(plane.pollCount >= (shape === "slow" ? 5 : 10), "the interim reply was collected before background completion");
      const waits = records.at(-1)?.attempts[1]?.backgroundWaits ?? [];
      assert.ok(waits.some(wait => wait.taskId === (shape === "slow" ? "bya9z1l44" : "b7zb0kfnb")));
    } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const [altered, lateCorrection] of [[true, false], [true, true], [false, false], [false, true]] as const) {
  test(`a late nudge receipt ${altered ? "cannot verify an altered" : "can finish a verified"} correction${lateCorrection ? " that arrived late" : ""}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-correction-nudge-"));
    class CorrectionNudge extends FakeControlPlane {
      readonly messages: string[] = [];
      correction: string | null = null;
      nudge: string | null = null;
      override async steer(handle: ClaudeSessionHandle, message: string): Promise<ValveSubmission> {
        this.messages.push(message);
        if (this.messages.length === 2) {
          this.nudge = message;
          return { submitted: true };
        }
        if (this.messages.length === 1) {
          this.correction = altered ? message + " " : message;
          const result = await super.steer(handle, this.correction);
          if (lateCorrection) {
            const file = await this.transcriptPath();
            assert.ok(file);
            await writeFile(file, (await readFile(file, "utf8")).replace(submissionRow(this.correction) + "\n", ""));
          }
          return result;
        }
        return super.steer(handle, message);
      }
    }
    const plane = new CorrectionNudge(dir, [
      { assistant: { text: "not JSON" } }, { outcome: "blocked" }, { assistant: { text: '{"ok":true}' } }
    ]);
    const runtime = makeRuntime(plane, { maxAttempts: 5, receiptTimeoutMs: 1, blockedRecoveryBound: 1 });
    const records: RuntimeAgentRecord[] = [];
    runtime.setRunRecorder({
      recordAttemptStart: async (_id: number, attempt: number) => {
        const file = await plane.transcriptPath();
        if (lateCorrection && attempt === 3) {
          assert.ok(file && plane.correction);
          await appendFile(file, submissionRow(plane.correction) + "\n");
        }
        if (attempt === (lateCorrection ? 4 : 3)) {
          assert.ok(file && plane.nudge);
          await appendFile(file, submissionRow(plane.nudge) + "\n" + assistantLine({ text: '{"ok":false}' }) + "\n");
        }
      },
      recordAttemptEnd: async () => {},
      recordAgent: async (record: RuntimeAgentRecord) => { records.push(structuredClone(record)); }
    } as unknown as RunRecordWriter);
    try {
      const held = runtime.createWorkerSession({ engine: "claude" });
      assert.deepEqual(await held.send("decide", { schema: okSchema }), { ok: altered });
      assert.equal(plane.dispatchCount, 1);
      assert.equal(plane.messages.length, altered ? 3 : 2);
      if (altered) {
        const attempt = records.at(-1)?.attempts[lateCorrection ? 3 : 2];
        assert.match(attempt?.failure?.message ?? "", /^the correction was submitted, but the session received different text:/);
        assert.equal(attempt?.rawOutput, '{"ok":false}');
      }
    } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
