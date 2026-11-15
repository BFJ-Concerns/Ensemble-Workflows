import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolveAmbientSettings } from "../../src/ambient-settings.js";
import { appServerErrorFromPayload } from "../../src/app-server.js";
import { CodexEngineAdapter, EngineRegistry, OpenCodeEngineAdapter } from "../../src/engines.js";
import { attachFailedTurnResult, EffortBoundsUnservedError, InvalidAgentOptionValueError } from "../../src/errors.js";
import { createOpenCodeModelRegistry } from "../../src/opencode-model-registry.js";
import { RunRecordWriter } from "../../src/run-record.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import type { RuntimeAgentRecord } from "../../src/run-record.js";
import type { EngineAdapter, EngineAttemptResult, EngineTurnOptions } from "../../src/engines.js";
import type { OpenCodeModelRegistryEntry } from "../../src/opencode-model-registry.js";
import type { EffortPolicy } from "../../src/effort-resolution.js";

const answer = (): EngineAttemptResult => ({ text: "done", deltaText: "done", durationMs: 1, firstDeltaMs: 1, items: {}, tokenUsageEvents: [] });

function fixture(policy?: EffortPolicy, refuse?: "returned" | "thrown" | "availability" | "worker-output") {
  const dispatched: EngineTurnOptions[] = [];
  const records = new Map<number, RuntimeAgentRecord>();
  let attempts = 0;
  const engineName: EngineAdapter["name"] = refuse === "returned" ? "claude" : "codex";
  const engine: EngineAdapter = {
    name: engineName, concurrency: 1, schedule: (body) => body(), close: async () => undefined,
    effortReport: async () => ({ identity: "unknown", levels: { low: "low", high: "high" } }),
    createInvocation: (_prompt, options) => {
      dispatched.push(options);
      return { runAttempt: async () => {
        attempts++;
        if (refuse === "availability" && options.model === "unknown") throw appServerErrorFromPayload("turn", { code: "serverOverloaded", message: "overloaded" });
        if (refuse === "thrown") {
          const error = appServerErrorFromPayload("turn", { code: "badRequest",
            message: "Unsupported value: reasoning.effort minimal is not supported for this model",
            data: { param: "reasoning.effort", supported_values: ["low", "high"] } });
          attachFailedTurnResult(error, { ...answer(), text: "", resolvedEffort: "minimal" });
          throw error;
        }
        if (refuse === "returned") return { ...answer(), text: "", resolvedEffort: "minimal",
          attemptFailure: { kind: "claude-worker-diagnostic", message: "Invalid reasoning_effort: supported values are low and high" },
          diagnostics: { apiError: { status: 400, code: "invalid_request_error" } } };
        if (refuse === "worker-output") return { ...answer(), text: "invalid effort level", deltaText: "invalid effort level" };
        return answer();
      } };
    },
    createSession: (options) => {
      const invocation = engine.createInvocation("", options);
      return { beginTurn: () => invocation, close: async () => undefined };
    }
  };
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry([engine]), defaultMaxAttempts: 3,
    ...(policy === undefined ? {} : { effortPolicy: policy }) });
  runtime.setRunRecorder({ recordAgent: async (record: RuntimeAgentRecord) => { records.set(record.id, structuredClone(record)); },
    recordAttemptStart: async () => undefined, recordAttemptEnd: async () => undefined } as unknown as RunRecordWriter);
  return { runtime, dispatched, records, engineName, attempts: () => attempts };
}

test("impossible machine bounds refuse before an invocation is created", async () => {
  const f = fixture({ source: "machine.json", section: { "*": { ceiling: "minimal" } } });
  try {
    await assert.rejects(f.runtime.agent("work", { engine: "codex", model: "unknown", effort: "high" }), EffortBoundsUnservedError);
    assert.equal(f.dispatched.length, 0);
  } finally { await f.runtime.close(); }
});

test("a held session resolves once and every turn records the clamp", async () => {
  const f = fixture();
  try {
    const session = f.runtime.createWorkerSession({ engine: "codex", model: "gpt-6-luna", effort: "minimal" });
    await session.send("one");
    await session.send("two");
    await session.close();
    assert.deepEqual(f.dispatched.map((options) => options.effort), ["none"]);
    for (const record of f.records.values()) {
      assert.equal(record.effort, "minimal");
      assert.equal(record.effortResolution?.dispatched, "none");
      assert.equal(record.attempts[0]?.effortResolution?.served?.source, "built-in-table");
      assert.equal(record.resolvedEffort, null, "dispatch is not served evidence");
    }
  } finally { await f.runtime.close(); }
});

for (const kind of ["returned", "thrown"] as const) {
  test(`a ${kind} provider effort refusal settles once and names no served effort`, async () => {
    const f = fixture(undefined, kind);
    try {
      assert.equal(await f.runtime.agent("work", { engine: f.engineName, model: "unknown", effort: "low", fallback: [{ engine: f.engineName, model: "gpt-6-luna" }] }), null);
      assert.equal(f.attempts(), 1);
      const record = [...f.records.values()][0]!;
      assert.equal(record.resolvedEffort, null);
      assert.equal(record.attempts[0]?.resolvedEffort, null);
      assert.equal(record.attempts[0]?.failure?.kind, "effort-rejected");
    } finally { await f.runtime.close(); }
  });
}

test("worker output about invalid effort retries as output rather than settling as effort-rejected", async () => {
  const f = fixture(undefined, "worker-output");
  try {
    assert.equal(await f.runtime.agent("work", { engine: "codex", model: "unknown", effort: "low",
      schema: { type: "object", required: ["answer"] } }), null);
    assert.equal(f.attempts(), 3);
    assert.deepEqual([...f.records.values()][0]!.attempts.map((attempt) => attempt.failure?.kind),
      ["invalid-json", "invalid-json", "invalid-json"]);
  } finally { await f.runtime.close(); }
});

test("a fallback target takes its own clamp and preserves each attempt's resolution", async () => {
  const f = fixture(undefined, "availability");
  try {
    assert.equal(await f.runtime.agent("work", { engine: "codex", model: "unknown", effort: "minimal", fallback: [{ engine: "codex", model: "gpt-6-luna" }] }), "done");
    assert.deepEqual(f.dispatched.map((options) => options.effort), ["low", "none"]);
    const record = [...f.records.values()][0]!;
    assert.deepEqual(record.attempts.map((attempt) => attempt.effortResolution?.dispatched), ["low", "none"]);
  } finally { await f.runtime.close(); }
});

test("machine bounds cannot be bypassed by omitting effort", async () => {
  const f = fixture({ source: "machine.json", section: { "*": { ceiling: "high" } } });
  try {
    await assert.rejects(f.runtime.agent("work", { engine: "codex", model: "unknown" }), /explicit canonical level.*machine.json/);
    assert.equal(f.dispatched.length, 0);
  } finally { await f.runtime.close(); }
});

test("Codex model reports filter ultra and select the default model", async () => {
  const adapter = new CodexEngineAdapter({ concurrency: 1, transport: {
    cwd: process.cwd(), listModels: async () => [{ model: "unknown", isDefault: true, supportedReasoningEfforts: ["low", "ultra", "high"] }],
    openThread: async () => "thread", runTurn: async () => answer(), close: async () => undefined
  } });
  try {
    assert.deepEqual(await adapter.effortReport(undefined), { identity: "unknown", levels: { low: "low", high: "high" } });
    assert.equal(await adapter.effortReport("missing"), null);
  } finally { await adapter.close(); }
});

test("the machine effort section reaches the ambient policy and manifest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-effort-record-"));
  try {
    await mkdir(path.join(directory, "ensemble"));
    const config = path.join(directory, "ensemble", "config.json");
    const section = { "*": { ceiling: "max" }, "codex:gpt-6-luna": { floor: "none" } };
    await writeFile(config, JSON.stringify({ schema_version: 1, effort: section }));
    const settings = resolveAmbientSettings({ env: { XDG_CONFIG_HOME: directory }, cwd: process.cwd() });
    assert.deepEqual(settings.effortPolicy, { source: config, section });
    const writer = await RunRecordWriter.start({ storeDir: directory, cwd: process.cwd(), runUuid: "effort", workflowPath: "workflow.js", workflowSource: "", args: [], cliFlags: { jsonArgs: false }, effortPolicy: settings.effortPolicy });
    await writer.finish({ status: "complete", exitCode: 0, result: null });
    const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as { effort: EffortPolicy };
    assert.deepEqual(manifest.effort, settings.effortPolicy);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("the archive keeps requested, dispatched and served effort separate", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-effort-agent-record-"));
  const policy: EffortPolicy = { source: "machine.json", section: { "codex:unknown": { levels: { low: "quiet", high: "think" } } } };
  const f = fixture(policy);
  try {
    const writer = await RunRecordWriter.start({ storeDir: directory, cwd: process.cwd(), runUuid: "effort-agent",
      workflowPath: "workflow.js", workflowSource: "", args: [], cliFlags: { jsonArgs: false }, effortPolicy: policy });
    f.runtime.setRunRecorder(writer);
    await f.runtime.agent("work", { engine: "codex", model: "unknown", effort: "minimal" });
    await f.runtime.close();
    await writer.finish({ status: "complete", exitCode: 0, result: null });
    const record = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
      effort: string; resolved_effort: string | null; effort_resolution: { dispatched: string; served: { source: string; level: string } };
      attempts: Array<{ effort_resolution: unknown; resolved_effort: string | null }>;
    };
    assert.equal(record.effort, "minimal");
    assert.equal(record.effort_resolution.dispatched, "quiet");
    assert.deepEqual(record.effort_resolution.served, { source: "machine-map", level: "low" });
    assert.deepEqual(record.attempts[0]?.effort_resolution, record.effort_resolution);
    assert.equal(record.resolved_effort, null);
    assert.equal(record.attempts[0]?.resolved_effort, null);
  } finally { await f.runtime.close(); await rm(directory, { recursive: true, force: true }); }
});


function routedRuntime(binding: Pick<OpenCodeModelRegistryEntry, "key" | "providerModel" | "variants">, effortPolicy?: EffortPolicy) {
  const variants: Array<string | undefined> = [];
  const adapter = new OpenCodeEngineAdapter({
    modelRegistry: createOpenCodeModelRegistry([{ ...binding, provider: "provider",
      displayName: "Routed model", capabilities: { vision: false } }]),
    runner: {
      run: async (options) => {
        variants.push(options.variant);
        return { exitCode: 0, signal: null, durationMs: 1, stderr: "",
          stdout: JSON.stringify({ type: "text", part: { type: "text", text: "done" } }) + "\n" };
      },
      exportSession: async () => ({ status: "command-failed", exitCode: 1, signal: null, stderr: "no session" })
    }
  });
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry([adapter]), defaultMaxAttempts: 1,
    ...(effortPolicy === undefined ? {} : { effortPolicy }) });
  return { runtime, variants };
}

test("a routed model's built-in levels outrank its opencode variant listing", async () => {
  const { runtime, variants } = routedRuntime({ key: "routed-luna", providerModel: "provider/gpt-6-luna", variants: ["high"] });
  try {
    assert.equal(await runtime.agent("work", { engine: "opencode", model: "routed-luna", effort: "none" }), "done");
    assert.deepEqual(variants, ["none"]);
    await assert.rejects(runtime.agent("work", { engine: "opencode", model: "routed-luna", effort: "ultra" }), /ultra/);
    assert.deepEqual(variants, ["none"]);
  } finally { await runtime.close(); }
});


for (const model of ["local-coder", "provider/local-coder"]) {
  const binding = { key: "local-coder", providerModel: "provider/local-coder", variants: ["low", "high", "thorough"] };
  test(`opencode model bounds use the registry key through ${model}`, async () => {
    const { runtime, variants } = routedRuntime(binding, { source: "machine.json", section: {
      "opencode:local-coder": { ceiling: "low" }
    } });
    try {
      assert.equal(await runtime.agent("work", { engine: "opencode", model, effort: "high" }), "done");
      assert.deepEqual(variants, ["low"]);
    } finally { await runtime.close(); }
  });

  test(`opencode native-level maps use the registry key through ${model}`, async () => {
    const { runtime, variants } = routedRuntime(binding, { source: "machine.json", section: {
      "opencode:local-coder": { levels: { low: "quiet", high: "think" } }
    } });
    try {
      assert.equal(await runtime.agent("work", { engine: "opencode", model, effort: "high" }), "done");
      assert.deepEqual(variants, ["think"]);
    } finally { await runtime.close(); }
  });

  test(`opencode omitted and raw effort cannot bypass bounds through ${model}`, async () => {
    const { runtime, variants } = routedRuntime(binding, { source: "machine.json", section: {
      "opencode:local-coder": { ceiling: "low" }
    } });
    try {
      for (const effort of [undefined, "thorough"]) {
        await assert.rejects(runtime.agent("work", { engine: "opencode", model,
          ...(effort === undefined ? {} : { effort }) }), /explicit canonical level.*opencode:local-coder/);
      }
      assert.deepEqual(variants, []);
    } finally { await runtime.close(); }
  });
}


for (const declared of [[], ["think"]]) {
  test(`opencode rejects unresolved canonical effort with variants ${JSON.stringify(declared)}`, async () => {
    const { runtime, variants } = routedRuntime({ key: "variant-only", providerModel: "provider/variant-only", variants: declared });
    try {
      await assert.rejects(runtime.agent("work", { engine: "opencode", model: "variant-only", effort: "high" }), InvalidAgentOptionValueError);
      assert.deepEqual(variants, [], "the provider must not receive an undeclared variant");
      if (declared.includes("think")) {
        assert.equal(await runtime.agent("work", { engine: "opencode", model: "variant-only", effort: "think" }), "done");
        assert.deepEqual(variants, ["think"]);
      }
    } finally { await runtime.close(); }
  });
}
