import assert from "node:assert/strict";
import test from "node:test";

import { EngineRegistry } from "../../src/engines.js";
import { UnreadableAgentOptionError } from "../../src/errors.js";
import { createWorkflowHooks, parallel } from "../../src/hooks.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { ChainEngine } from "./chain-engine-fakes.js";

import type { EngineAttemptResult } from "../../src/engines.js";
import type { RunRecordWriter, RuntimeAgentRecord } from "../../src/run-record.js";
import type { AgentOptions, FallbackTarget } from "../../src/types.js";

function answer(text: string): () => Promise<EngineAttemptResult> {
  return async () => ({ text, deltaText: text, durationMs: 10, firstDeltaMs: 5, items: {}, tokenUsageEvents: [] });
}

/** A runtime over one scripted Codex engine, keeping every record it writes. */
function recordingRuntime(steps: number): { runtime: EnsembleRuntime; records: RuntimeAgentRecord[] } {
  const engine = new ChainEngine("codex", Array.from({ length: steps }, (_, index) => answer(`answer ${index + 1}`)));
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry([engine]), cwd: "/fake/repo", defaultMaxAttempts: 1 });
  const recordAttemptStart: RunRecordWriter["recordAttemptStart"] = async () => {};
  const recordAttemptEnd: RunRecordWriter["recordAttemptEnd"] = async () => {};
  runtime.setRunRecorder({
    recordAttemptStart,
    recordAttemptEnd,
    recordAgent: async (record) => { records.push(structuredClone(record)); }
  } as RunRecordWriter);
  return { runtime, records };
}

function settledRecordLabelled(records: RuntimeAgentRecord[], label: string): RuntimeAgentRecord {
  const record = records.findLast((candidate) => candidate.label === label && candidate.status !== "in-progress");
  assert.ok(record, `no settled record labelled ${label}`);
  return record;
}

test("an agent record names the defaults block, the call or nothing as its chain's source", async () => {
  const defaultsChain: FallbackTarget[] = [{ engine: "codex", model: "defaults-fallback" }];
  const callChain: FallbackTarget[] = [{ engine: "codex", model: "call-fallback" }];
  const { runtime, records } = recordingRuntime(3);
  const hooks = createWorkflowHooks({
    runtime,
    args: [],
    log: () => {},
    workflow: async () => null,
    defaults: { codex: { fallback: defaultsChain } }
  });

  try {
    await hooks.agent("from defaults", { engine: "codex", label: "defaults" });
    await hooks.agent("from the call", { engine: "codex", label: "call", fallback: callChain });
    // A direct library call bypasses the hooks, so no defaults apply to it.
    await runtime.agent("direct", { engine: "codex", label: "direct" });

    const fromDefaults = settledRecordLabelled(records, "defaults");
    assert.deepEqual(fromDefaults.fallback, defaultsChain);
    assert.deepEqual(fromDefaults.fallbackSource, { kind: "defaults", engine: "codex" });

    const fromCall = settledRecordLabelled(records, "call");
    assert.deepEqual(fromCall.fallback, callChain);
    assert.deepEqual(fromCall.fallbackSource, { kind: "call" });

    const direct = settledRecordLabelled(records, "direct");
    assert.equal(direct.fallback, null);
    assert.deepEqual(direct.fallbackSource, { kind: "none" });
  } finally {
    await runtime.close();
  }
});

test("an unreadable fallback is refused as an author error, directly and through a combinator", async () => {
  // Enumerable and fresh on every call, as a script's object literal would be.
  const unreadableFallback = (label: string): Partial<AgentOptions> => {
    const options: Partial<AgentOptions> = { engine: "codex", label };
    Object.defineProperty(options, "fallback", {
      enumerable: true,
      get() {
        throw new Error("unreadable fallback");
      }
    });
    return options;
  };
  const { runtime, records } = recordingRuntime(0);

  try {
    await assert.rejects(runtime.agent("direct", unreadableFallback("direct")), UnreadableAgentOptionError);
    // A pre-spawn author error fails the run: the combinator rethrows it
    // rather than collapsing the slot to null.
    await assert.rejects(
      parallel([() => runtime.agent("in a combinator", unreadableFallback("combinator"))], () => {}),
      UnreadableAgentOptionError
    );
    assert.deepEqual(records, []);
  } finally {
    await runtime.close();
  }
});
