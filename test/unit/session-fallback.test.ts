import assert from "node:assert/strict";
import test from "node:test";

import { appServerErrorFromPayload } from "../../src/app-server.js";
import { EngineRegistry } from "../../src/engines.js";
import type { EngineAttemptResult, EngineTurnOptions, EngineWorkerSession } from "../../src/engines.js";
import type { RunRecordWriter, RuntimeAgentRecord } from "../../src/run-record.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import type { FallbackTarget } from "../../src/types.js";
import { ChainEngine, claudeRefusal } from "./chain-engine-fakes.js";

/** Held turns use the same dispatch log and scripted steps as one-shot calls. */
class SessionChainEngine extends ChainEngine {
  createSession(options: EngineTurnOptions): EngineWorkerSession {
    return {
      beginTurn: (prompt) => this.createInvocation(prompt, options),
      close: async () => {}
    };
  }
}

function answer(text: string): () => Promise<EngineAttemptResult> {
  return async () => ({ text, deltaText: text, durationMs: 10, firstDeltaMs: 5, items: {}, tokenUsageEvents: [] });
}

for (const engine of ["codex", "claude"] as const) {
  test(`a ${engine} session's later availability failure fails the turn without consulting its fallback chain`, async () => {
    const refusal = engine === "claude" ? claudeRefusal(429, "rate_limit_error") : async () => {
      throw appServerErrorFromPayload("turn notification", { code: "usageLimitExceeded", message: "usage limit exceeded" });
    };
    const primary = new SessionChainEngine(engine, [answer("first answer"), refusal, answer("recovered answer")]);
    const fallbackEngine = engine === "codex" ? "claude" : "codex";
    const fallback = new SessionChainEngine(fallbackEngine, [answer("unexpected fallback answer")]);
    const records: RuntimeAgentRecord[] = [];
    const runtime = new EnsembleRuntime({
      engines: new EngineRegistry([primary, fallback]),
      cwd: "/fake/repo",
      defaultMaxAttempts: 1
    });
    const recordAttemptStart: RunRecordWriter["recordAttemptStart"] = async () => {};
    const recordAttemptEnd: RunRecordWriter["recordAttemptEnd"] = async () => {};
    runtime.setRunRecorder({
      recordAttemptStart,
      recordAttemptEnd,
      recordAgent: async (record) => { records.push(structuredClone(record)); }
    } as RunRecordWriter);
    const chain: FallbackTarget[] = [
      { engine, model: "same-engine-fallback" },
      { engine: fallbackEngine, model: "other-engine-fallback" }
    ];
    const session = runtime.createWorkerSession({ engine, model: "original-model", effort: "high", fallback: chain });

    try {
      assert.equal(await session.send("first turn"), "first answer");
      assert.equal(await session.send("unavailable turn"), null);
      const failed = records.at(-1)!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.session?.turn, 2);
      assert.equal(failed.fallback, null);
      assert.equal(failed.answeredBy, null);
      assert.equal(failed.attempts.length, 1);
      assert.equal(failed.attempts[0]?.classification?.class, "availability");
      assert.equal(failed.attempts[0]?.chainDecision, null);
      assert.deepEqual(failed.attempts[0]?.target, { engine, model: "original-model" });

      assert.equal(await session.send("recovery turn"), "recovered answer");
      assert.deepEqual(primary.dispatches, ["first turn", "unavailable turn", "recovery turn"].map((prompt) => ({
        model: "original-model", effort: "high", prompt
      })));
      assert.deepEqual(fallback.dispatches, []);
      const first = records.find((record) => record.session?.turn === 1 && record.status === "complete")!;
      const recovered = records.at(-1)!;
      assert.deepEqual(first.fallback, chain);
      assert.deepEqual(recovered.session, { id: first.session!.id, turn: 3 });
      assert.equal(recovered.status, "complete");
    } finally {
      await session.close();
      await runtime.close();
    }
  });
}
