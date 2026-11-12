import assert from "node:assert/strict";
import test from "node:test";

import { EngineRegistry } from "../../src/engines.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { Scheduler } from "../../src/scheduler.js";

import type { EngineAdapter, EngineAttemptResult, EngineInvocation, EngineWorkerSession } from "../../src/engines.js";
import type { RunRecordWriter, RuntimeAgentRecord } from "../../src/run-record.js";
import type { EngineName } from "../../src/types.js";

type Step = () => Promise<EngineAttemptResult>;

/**
 * One scripted held worker per engine: every attempt of every turn consumes
 * the next step, and `attempts` logs the prompt each one was asked under, so
 * a test reads how many attempts a turn cost straight off the log.
 */
class HeldEngine implements EngineAdapter {
  readonly concurrency = 4;
  readonly attempts: string[] = [];
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

  createSession(): EngineWorkerSession {
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

/** A runtime over the given engines whose settled agent records land in `records`. */
function recordingRuntime(engines: EngineAdapter[]): { runtime: EnsembleRuntime; records: RuntimeAgentRecord[] } {
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry(engines), cwd: "/fake/repo", defaultMaxAttempts: 3 });
  const recordAttemptStart: RunRecordWriter["recordAttemptStart"] = async () => {};
  const recordAttemptEnd: RunRecordWriter["recordAttemptEnd"] = async () => {};
  runtime.setRunRecorder({
    recordAttemptStart,
    recordAttemptEnd,
    recordAgent: async (record) => {
      records.push(structuredClone(record));
    }
  } as RunRecordWriter);
  return { runtime, records };
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
