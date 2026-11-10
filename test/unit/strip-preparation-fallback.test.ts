import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeEngineAdapter, EngineRegistry } from "../../src/engines.js";
import { CapabilityStripUnsupportedError, ClaudeDispatchError, ClaudeRegistrationTimeoutError } from "../../src/errors.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { ChainEngine } from "./chain-engine-fakes.js";

import type { ClaudeControlPlane } from "../../src/claude-control-plane.js";
import type { EngineTurnOptions, EngineWorkerSession } from "../../src/engines.js";
import type { RunRecordWriter, RuntimeAgentRecord } from "../../src/run-record.js";

class FallbackEngine extends ChainEngine {
  readonly capabilities = {
    agents: { route: "absent" as const, detail: "test engine has no agents" },
    skills: { route: "absent" as const, detail: "test engine has no skills" }
  };

  createSession(options: EngineTurnOptions): EngineWorkerSession {
    return { beginTurn: prompt => this.createInvocation(prompt, options), close: async () => {} };
  }
}

for (const held of [false, true]) {
  for (const schema of [false, true]) {
    for (const mode of ["dispatch", "registration", "unreadable", "unenforced", "missing"] as const) {
      test(`${held ? "held" : "one-shot"} ${schema ? "schema" : "text"} preparation ${mode} preserves the capability/availability boundary`, async () => {
        let requestedWorkers = 0;
        const plane: ClaudeControlPlane = {
          dispatch: async () => { requestedWorkers++; throw new Error("requested worker must not dispatch"); },
          poll: async () => { throw new Error("not dispatched"); },
          transcriptPath: async () => null,
          steer: async () => ({ submitted: false, reason: "not dispatched" }),
          stop: async () => {}, close: async () => {}, tmuxAvailable: async () => true,
          ...(mode === "missing" ? {} : { probeToolSurface: async () => {
            if (mode === "dispatch") throw new ClaudeDispatchError("probe substrate refused");
            if (mode === "registration") throw new ClaudeRegistrationTimeoutError("probe did not register");
            if (mode === "unreadable") throw new Error("unreadable capture");
            return { cliVersion: "test", source: "test capture", tools: [{ name: "Agent", exposure: "loaded" as const }] };
          } })
        };
        const fallback = new FallbackEngine("codex", Array.from({ length: 2 }, () => async () => ({
          text: schema ? '{"answer":"fallback"}' : "fallback", deltaText: "", durationMs: 1, firstDeltaMs: 1,
          items: {}, tokenUsageEvents: []
        })));
        const runtime = new EnsembleRuntime({ engines: new EngineRegistry([new ClaudeEngineAdapter({ controlPlane: plane }), fallback]), defaultMaxAttempts: 1 });
        const records: RuntimeAgentRecord[] = [];
        const recordAttemptStart: RunRecordWriter["recordAttemptStart"] = async () => {};
        const recordAttemptEnd: RunRecordWriter["recordAttemptEnd"] = async () => {};
        runtime.setRunRecorder({
          recordAttemptStart, recordAttemptEnd,
          recordAgent: async record => { records.push(structuredClone(record)); }
        } as RunRecordWriter);
        const options = { engine: "claude" as const, strip: ["agents" as const], fallback: [{ engine: "codex" as const, model: "fallback" }] };
        const shape = schema ? { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } : {};
        const session = held ? runtime.createWorkerSession(options) : null;
        try {
          const pending = session ? session.send("restricted", shape) : runtime.agent("restricted", { ...options, ...shape });
          if (mode === "dispatch" || mode === "registration") {
            assert.deepEqual(await pending, schema ? { answer: "fallback" } : "fallback");
            const record = runtime.lastAgentRecord()!;
            assert.equal(record.attempts.length, 2);
            assert.equal(record.attempts[0]?.classification?.class, "availability");
            assert.equal(record.attempts[0]?.classification?.rule, "claude.dispatch-refused");
            assert.equal(record.attempts[1]?.status, "complete");
            assert.equal(record.answeredBy?.engine, "codex");
            assert.ok(records.filter(r => r.concurrencyGroup === "claude").every(r => Object.keys(r.strip!.enforcement).length === 0));
            assert.equal(record.strip?.enforcement.agents?.route, "absent");
            assert.equal(fallback.dispatches.length, 1, "availability refusal must not spend the one-answer bound");
            if (session) {
              assert.deepEqual(await session.send("next", shape), schema ? { answer: "fallback" } : "fallback");
              assert.equal(runtime.lastAgentRecord()?.strip?.enforcement.agents?.route, "absent");
            }
          } else {
            await assert.rejects(pending, CapabilityStripUnsupportedError);
            assert.deepEqual(runtime.lastAgentRecord()?.strip, { requested: ["agents"], enforcement: {} });
            assert.equal(runtime.lastAgentRecord()?.attempts.length, 0);
            assert.equal(fallback.dispatches.length, 0, "a capability refusal must not advance the chain");
          }
          assert.equal(requestedWorkers, 0);
        } finally { await session?.close(); await runtime.close(); }
      });
    }
  }

  test(`${held ? "held" : "one-shot"} probe substrate refusal without a remaining target is recorded and throws pre-spawn`, async () => {
    const error = new ClaudeDispatchError("probe substrate down");
    const plane = { probeToolSurface: async () => { throw error; }, close: async () => {} } as unknown as ClaudeControlPlane;
    const runtime = new EnsembleRuntime({ engines: new EngineRegistry([new ClaudeEngineAdapter({ controlPlane: plane })]), defaultMaxAttempts: 1 });
    const options = { engine: "claude" as const, strip: ["agents" as const] };
    const session = held ? runtime.createWorkerSession(options) : null;
    try {
      await assert.rejects(session ? session.send("restricted") : runtime.agent("restricted", options), e => e === error);
      const record = runtime.lastAgentRecord()!;
      assert.equal(record.attempts.length, 1);
      assert.equal(record.attempts[0]?.classification?.rule, "claude.dispatch-refused");
      assert.equal(record.status, "failed");
      assert.deepEqual(record.strip, { requested: ["agents"], enforcement: {} });
    } finally { await session?.close(); await runtime.close(); }
  });
}
