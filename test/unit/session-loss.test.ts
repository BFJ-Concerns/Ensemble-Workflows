import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runEnsembleCli } from "../../src/cli.js";
import { EngineRegistry } from "../../src/engines.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { Scheduler } from "../../src/scheduler.js";
import { claudeRefusal } from "./chain-engine-fakes.js";

import type {
  EngineAdapter,
  EngineAttemptResult,
  EngineInvocation,
  EngineSessionLoss,
  EngineSessionObserver,
  EngineTurnOptions,
  EngineWorkerSession
} from "../../src/engines.js";
import type { RunRecordWriter, RuntimeAgentRecord, SessionEventRecord } from "../../src/run-record.js";
import type { EngineName, RuntimeEvent } from "../../src/types.js";

type Step = () => Promise<EngineAttemptResult>;

/**
 * One scripted held worker per engine: every attempt of every turn consumes
 * the next step, and `attempts` logs the prompt each one was asked under, so
 * a test reads how many attempts a turn cost straight off the log.
 * `observers` keeps what the runtime handed each session it asked for, in
 * order, so a test reports a worker lost at whatever moment it chooses.
 */
class HeldEngine implements EngineAdapter {
  readonly concurrency = 4;
  readonly attempts: string[] = [];
  readonly observers: EngineSessionObserver[] = [];
  #scheduler = new Scheduler(this.concurrency);
  #steps: Step[];

  constructor(
    readonly name: EngineName,
    steps: Step[]
  ) {
    this.#steps = [...steps];
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(task);
  }

  createInvocation(prompt: string): EngineInvocation {
    return {
      runAttempt: async () => {
        this.attempts.push(prompt);
        const step = this.#steps.shift();
        assert.ok(step, `${this.name} engine ran out of scripted steps`);
        return step();
      }
    };
  }

  createSession(_options: EngineTurnOptions, observer: EngineSessionObserver): EngineWorkerSession {
    this.observers.push(observer);
    return {
      beginTurn: (prompt) => this.createInvocation(prompt),
      close: async () => {}
    };
  }

  async close(): Promise<void> {}
}

function answer(text: string): Step {
  return async () => ({ text, deltaText: text, durationMs: 10, firstDeltaMs: 5, items: {}, tokenUsageEvents: [] });
}

/** The failed turn a held worker's engine returns once it has established the worker is gone. */
function sessionLost(message = "the held worker left the engine's roster"): Step {
  return async () => ({
    text: "",
    deltaText: "",
    durationMs: null,
    firstDeltaMs: null,
    items: {},
    tokenUsageEvents: [],
    attemptFailure: { kind: "session-lost", message }
  });
}

const LOSS: EngineSessionLoss = {
  nativeSession: "native-session-1",
  reason: "the worker left the engine's roster and did not return",
  observedAt: Date.UTC(2026, 10, 12, 18, 0, 0)
};

/**
 * A runtime over the given engines. Settled agent records land in
 * `records`, archived session events in `sessionEvents`, and every runtime
 * event in `events`.
 */
function recordingRuntime(engines: EngineAdapter[]): {
  runtime: EnsembleRuntime;
  records: RuntimeAgentRecord[];
  sessionEvents: SessionEventRecord[];
  events: RuntimeEvent[];
} {
  const records: RuntimeAgentRecord[] = [];
  const sessionEvents: SessionEventRecord[] = [];
  const events: RuntimeEvent[] = [];
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry(engines), cwd: "/fake/repo", defaultMaxAttempts: 3 });
  const recordAttemptStart: RunRecordWriter["recordAttemptStart"] = async () => {};
  const recordAttemptEnd: RunRecordWriter["recordAttemptEnd"] = async () => {};
  runtime.setRunRecorder({
    recordAttemptStart,
    recordAttemptEnd,
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    },
    recordSessionEvent: async (event) => {
      sessionEvents.push(event);
    }
  } as RunRecordWriter);
  runtime.onEvent((event) => events.push(event));
  return { runtime, records, sessionEvents, events };
}

class CaptureStream extends Writable {
  #chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.#chunks.join("");
  }
}

for (const engine of ["claude", "codex"] as const) {
  for (const shape of ["text", "schema"] as const) {
    test(`a lost ${engine} held worker settles its ${shape} turn on one recorded attempt, without a retry`, async () => {
      const held = new HeldEngine(engine, [answer("first answer"), sessionLost(), answer("a retry must never ask for this")]);
      const { runtime, records } = recordingRuntime([held]);
      const session = runtime.createWorkerSession({ engine, model: "held-model" });

      try {
        assert.equal(await session.send("first turn"), "first answer");
        const turn = shape === "schema" ? { schema: { type: "object" } } : {};
        assert.equal(await session.send("turn after the loss", turn), null);

        assert.deepEqual(held.attempts, ["first turn", "turn after the loss"]);
        const failed = records.at(-1)!;
        assert.equal(failed.status, "failed");
        assert.deepEqual(failed.session, { id: session.id, turn: 2 });
        assert.equal(failed.attempts.length, 1);
        assert.deepEqual(failed.attempts[0]?.failure, {
          kind: "session-lost",
          message: "the held worker left the engine's roster"
        });
        assert.deepEqual(failed.attempts[0]?.classification, { class: "unclassified", rule: "session.lost" });
        assert.equal(failed.attempts[0]?.chainDecision, null);
      } finally {
        await session.close();
        await runtime.close();
      }
    });
  }
}

test("a worker lost on its creating turn leaves the session's fallback chain unconsulted", async () => {
  const held = new HeldEngine("claude", [sessionLost(), answer("a retry must never ask for this")]);
  const fallback = new HeldEngine("codex", [answer("a lost session's turn must never move here")]);
  const { runtime, records } = recordingRuntime([held, fallback]);
  const session = runtime.createWorkerSession({
    engine: "claude",
    model: "held-model",
    fallback: [{ engine: "codex", model: "fallback-model" }]
  });

  try {
    assert.equal(await session.send("creating turn"), null);

    assert.deepEqual(held.attempts, ["creating turn"]);
    assert.deepEqual(fallback.attempts, []);
    const failed = records.at(-1)!;
    assert.equal(failed.attempts.length, 1);
    assert.equal(failed.attempts[0]?.failure?.kind, "session-lost");
    assert.equal(failed.attempts[0]?.chainDecision, "chain-not-consulted");
    assert.equal(failed.answeredBy, null);
  } finally {
    await session.close();
    await runtime.close();
  }
});

test("a worker reported lost between turns is on the handle, announced and archived before any send", async () => {
  const held = new HeldEngine("claude", [answer("first answer"), sessionLost(LOSS.reason)]);
  const { runtime, records, sessionEvents, events } = recordingRuntime([held]);
  const session = runtime.createWorkerSession({ engine: "claude", model: "held-model", label: "keeper" });

  try {
    assert.equal(await session.send("first turn"), "first answer");
    assert.equal(session.lost, false);

    held.observers[0]!.onLost(LOSS);

    const expected: SessionEventRecord = {
      sessionId: session.id,
      engine: "claude",
      event: "lost",
      nativeSession: LOSS.nativeSession,
      turnsSettled: 1,
      turnInFlight: null,
      reason: LOSS.reason,
      observedAt: LOSS.observedAt
    };
    assert.equal(session.lost, true);
    assert.deepEqual(sessionEvents, [expected]);
    assert.deepEqual(
      events.filter((event) => event.method === "session/lost"),
      [{ method: "session/lost", params: { ...expected, label: "keeper" }, receivedAt: LOSS.observedAt }]
    );
    // The turn that settled before the loss keeps the outcome it had.
    assert.equal(records.at(-1)?.status, "complete");

    // One loss, one event: a second report changes nothing.
    held.observers[0]!.onLost({ ...LOSS, reason: "reported again" });
    assert.equal(sessionEvents.length, 1);

    // The send still dispatches, and the engine fails it on the one attempt.
    assert.equal(await session.send("turn after the loss"), null);
    assert.equal(records.at(-1)?.attempts[0]?.failure?.kind, "session-lost");
  } finally {
    await session.close();
    await runtime.close();
  }
});

test("a loss an attempt finds names the turn in flight, and that turn's record carries the failure", async () => {
  const held: HeldEngine = new HeldEngine("codex", [
    answer("first answer"),
    async () => {
      held.observers[0]!.onLost(LOSS);
      return sessionLost(LOSS.reason)();
    }
  ]);
  const { runtime, records, sessionEvents } = recordingRuntime([held]);
  const session = runtime.createWorkerSession({ engine: "codex" });

  try {
    assert.equal(await session.send("first turn"), "first answer");
    assert.equal(await session.send("turn that finds the loss"), null);

    assert.deepEqual(
      sessionEvents.map(({ turnsSettled, turnInFlight }) => ({ turnsSettled, turnInFlight })),
      [{ turnsSettled: 1, turnInFlight: 2 }]
    );
    assert.deepEqual(records.at(-1)?.session, { id: session.id, turn: 2 });
    assert.equal(records.at(-1)?.attempts.length, 1);
    assert.equal(records.at(-1)?.attempts[0]?.failure?.kind, "session-lost");
  } finally {
    await session.close();
    await runtime.close();
  }
});

test("a worker that ends because its session was closed is not a loss", async () => {
  const held = new HeldEngine("claude", [answer("first answer")]);
  const { runtime, sessionEvents, events } = recordingRuntime([held]);
  const session = runtime.createWorkerSession({ engine: "claude" });

  try {
    assert.equal(await session.send("first turn"), "first answer");
    await session.close();

    held.observers[0]!.onLost(LOSS);

    assert.equal(session.lost, false);
    assert.deepEqual(sessionEvents, []);
    assert.deepEqual(events.filter((event) => event.method === "session/lost"), []);
  } finally {
    await runtime.close();
  }
});

test("a report from a worker a fallback step replaced is not the session's loss", async () => {
  const refused = new HeldEngine("claude", [claudeRefusal(429, "rate_limit_error")]);
  const answering = new HeldEngine("codex", [answer("fallback answer")]);
  const { runtime, sessionEvents } = recordingRuntime([refused, answering]);
  const session = runtime.createWorkerSession({
    engine: "claude",
    model: "held-model",
    fallback: [{ engine: "codex", model: "fallback-model" }]
  });

  try {
    assert.equal(await session.send("creating turn"), "fallback answer");

    refused.observers[0]!.onLost(LOSS);
    assert.equal(session.lost, false);
    assert.deepEqual(sessionEvents, []);

    answering.observers[0]!.onLost({ ...LOSS, nativeSession: "thread-9" });
    assert.equal(session.lost, true);
    assert.deepEqual(sessionEvents.map(({ engine, nativeSession }) => ({ engine, nativeSession })), [
      { engine: "codex", nativeSession: "thread-9" }
    ]);
  } finally {
    await session.close();
    await runtime.close();
  }
});

test("a run says a session lost its worker on stderr and in the manifest's session_events", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-session-loss-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `export const meta = { name: "session-loss" };
const keeper = session({ engine: "claude", label: "keeper" });
const first = await keeper.send("first turn");
const second = await keeper.send("second turn");
return { first, second, lost: keeper.lost };
`
  );
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  try {
    const exitCode = await runEnsembleCli([script], {
      cwd: directory,
      stdout,
      stderr,
      runRecordDir: path.join(directory, "store"),
      statusDir: null,
      createRuntime: async () => {
        const held: HeldEngine = new HeldEngine("claude", [
          answer("first answer"),
          async () => {
            held.observers[0]!.onLost(LOSS);
            return sessionLost(LOSS.reason)();
          }
        ]);
        return new EnsembleRuntime({ engines: new EngineRegistry([held]), defaultMaxAttempts: 3 });
      }
    });

    assert.equal(exitCode, 0, stderr.text());
    assert.deepEqual(JSON.parse(stdout.text()), { first: "first answer", second: null, lost: true });
    assert.ok(
      stderr.text().includes(
        `[claude] session 1 (keeper) lost its worker during turn 2: ${LOSS.reason}; ` +
          "its context is gone and each later send fails with session-lost\n"
      ),
      stderr.text()
    );
    const announced = /^\[run-record-archive\] (.*)$/m.exec(stderr.text());
    assert.ok(announced, stderr.text());
    const archive = JSON.parse(announced[1]!) as { archive_path: string };
    const manifest = JSON.parse(await readFile(path.join(archive.archive_path, "manifest.json"), "utf8")) as {
      session_events: unknown[];
    };
    assert.deepEqual(manifest.session_events, [
      {
        session_id: 1,
        engine: "claude",
        event: "lost",
        native_session: LOSS.nativeSession,
        turns_settled: 1,
        turn_in_flight: 2,
        reason: LOSS.reason,
        at: new Date(LOSS.observedAt).toISOString()
      }
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
