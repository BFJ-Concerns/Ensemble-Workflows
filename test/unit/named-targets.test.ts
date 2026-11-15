import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { appServerErrorFromPayload } from "../../src/app-server.js";
import { resolveAmbientSettings } from "../../src/ambient-settings.js";
import { runEnsembleCli } from "../../src/cli.js";
import { EngineRegistry } from "../../src/engines.js";
import { NamedTargetRejectedError } from "../../src/errors.js";
import { createWorkflowHooks } from "../../src/hooks.js";
import { createRuntime, EnsembleRuntime } from "../../src/runtime.js";
import { ChainEngine, claudeRefusal } from "./chain-engine-fakes.js";

import type { EngineAttemptResult, EngineTurnOptions, EngineWorkerSession } from "../../src/engines.js";
import type { WorkflowDefaults } from "../../src/hooks.js";
import type { NamedTargetBinding, NamedTargets } from "../../src/named-targets.js";
import type { RunRecordWriter, RuntimeAgentRecord } from "../../src/run-record.js";
import type { AgentOptions, WorkerSessionOptions } from "../../src/types.js";

const SOURCE = "/machine/ensemble/config.json";

function answer(text: string): () => Promise<EngineAttemptResult> {
  return async () => ({ text, deltaText: text, durationMs: 10, firstDeltaMs: 5, items: {}, tokenUsageEvents: [] });
}

/** A runtime over scripted Codex and Claude engines, keeping every record it writes. */
function recordingRuntime(
  bindings: NamedTargets["bindings"] | null,
  steps: { codex?: number; claude?: Array<() => Promise<EngineAttemptResult>> } = {}
): { runtime: EnsembleRuntime; codex: ChainEngine; claude: ChainEngine; records: RuntimeAgentRecord[] } {
  const codex = new ChainEngine("codex", Array.from({ length: steps.codex ?? 4 }, (_, index) => answer(`codex ${index + 1}`)));
  const claude = new ChainEngine("claude", steps.claude ?? Array.from({ length: 4 }, (_, index) => answer(`claude ${index + 1}`)));
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([codex, claude]),
    cwd: "/fake/repo",
    defaultMaxAttempts: 1,
    ...(bindings !== null ? { namedTargets: { bindings, source: SOURCE } } : {})
  });
  runtime.setRunRecorder({
    recordAttemptStart: async () => {},
    recordAttemptEnd: async () => {},
    recordAgent: async (record: RuntimeAgentRecord) => { records.push(structuredClone(record)); }
  } as unknown as RunRecordWriter);
  return { runtime, codex, claude, records };
}

function hooksFor(runtime: EnsembleRuntime, defaults?: WorkflowDefaults): ReturnType<typeof createWorkflowHooks> {
  return createWorkflowHooks({ runtime, args: [], log: () => {}, workflow: async () => null, ...(defaults !== undefined ? { defaults } : {}) });
}

function settled(records: RuntimeAgentRecord[], label: string): RuntimeAgentRecord {
  const record = records.findLast((candidate) => candidate.label === label && candidate.status !== "in-progress");
  assert.ok(record, `no settled record labelled ${label}`);
  return record;
}

test("a named target dispatches on its binding's engine and model, and the record keeps the name beside both", async () => {
  const { runtime, claude, codex, records } = recordingRuntime({ reviewer: { engine: "claude", model: "claude-opus-5-5" } });
  try {
    // Typed with no cast: a target-only call selects the identity overload.
    const identified = await hooksFor(runtime).agent("review", { target: "reviewer", label: "review", effort: "low", identity: true });
    const output: string | unknown = identified.output;
    assert.equal(output, "claude 1");
    assert.equal((await runtime.agent("direct", { target: "reviewer", identity: true })).output, "claude 2");
    assert.deepEqual(claude.dispatches.map((dispatch) => dispatch.model), ["claude-opus-5-5", "claude-opus-5-5"]);
    assert.equal(codex.dispatches.length, 0);
    const record = settled(records, "review");
    assert.equal(record.engine, "claude");
    assert.equal(record.model, "claude-opus-5-5");
    assert.equal(record.effort, "low");
    assert.deepEqual(record.namedTarget, { name: "reviewer", source: SOURCE, engine: "claude", model: "claude-opus-5-5" });
    assert.deepEqual(record.attempts.map((attempt) => [attempt.namedTarget, attempt.target]), [
      ["reviewer", { engine: "claude", model: "claude-opus-5-5" }]
    ]);
  } finally {
    await runtime.close();
  }
});

test("a script's defaults chain naming targets is judged against the bindings before the body runs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-defaults-chain-"));
  const configFile = path.join(directory, "config", "ensemble", "config.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({ schema_version: 1, targets: { back: { engine: "codex" } } }));
  try {
    for (const chain of ['[{ target: "typo" }]', '[{ target: "back", engine: "claude", model: "x" }]']) {
      const script = path.join(directory, "workflow.js");
      await writeFile(script, `export const meta = { name: "defaults-chain" };\nexport const defaults = { codex: { fallback: ${chain} } };\nreturn "BODY EXECUTED";\n`);
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const exitCode = await runEnsembleCli([script], {
        cwd: directory,
        env: { XDG_CONFIG_HOME: path.join(directory, "config"), ENSEMBLE_STATUS: "off" },
        stdout,
        stderr,
        runRecordDir: null,
        createRuntime: async (options) => new EnsembleRuntime({ ...options, engines: new EngineRegistry([new ChainEngine("codex", [])]), defaultMaxAttempts: 1 })
      });
      assert.notEqual(exitCode, 0, chain);
      assert.ok(!stdout.text().includes("BODY EXECUTED"), stdout.text());
      assert.match(stdout.text() + stderr.text(), /defaults\.codex\.fallback: Invalid named target: fallback entry 0/);
      assert.ok((stdout.text() + stderr.text()).includes(configFile), chain);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a model-less binding takes the resolved engine's defaults model, else leaves the engine to choose", async () => {
  const { runtime, codex, records } = recordingRuntime({ doer: { engine: "codex" } });
  try {
    await hooksFor(runtime, { codex: { model: "gpt-6.1-sol", effort: "medium" } }).agent("with defaults", { target: "doer", label: "defaults" });
    await hooksFor(runtime).agent("without defaults", { target: "doer", label: "bare" });
    assert.deepEqual(codex.dispatches.map((dispatch) => [dispatch.model, dispatch.effort]), [["gpt-6.1-sol", "medium"], [undefined, undefined]]);
    const withDefaults = settled(records, "defaults");
    assert.equal(withDefaults.model, "gpt-6.1-sol");
    assert.deepEqual(withDefaults.namedTarget, { name: "doer", source: SOURCE, engine: "codex", model: null });
    assert.equal(settled(records, "bare").model, null);
  } finally {
    await runtime.close();
  }
});

test("a pinned binding's model wins over the resolved engine's defaults model", async () => {
  const { runtime, codex } = recordingRuntime({ doer: { engine: "codex", model: "gpt-6-astra" } });
  try {
    await hooksFor(runtime, { codex: { model: "gpt-6.1-sol" } }).agent("work", { target: "doer" });
    assert.deepEqual(codex.dispatches.map((dispatch) => dispatch.model), ["gpt-6-astra"]);
  } finally {
    await runtime.close();
  }
});

test("a binding's chain applies only where neither the call nor the resolved engine's defaults declare one", async () => {
  const bindingChain = [{ engine: "codex" as const, model: "binding-fallback" }];
  const defaultsChain = [{ engine: "codex" as const, model: "defaults-fallback" }];
  const callChain = [{ engine: "codex" as const, model: "call-fallback" }];
  const { runtime, records } = recordingRuntime({ reviewer: { engine: "claude", model: "claude-opus-5-5", fallback: bindingChain } });
  try {
    await hooksFor(runtime).agent("binding", { target: "reviewer", label: "binding" });
    await hooksFor(runtime, { claude: { fallback: defaultsChain } }).agent("defaults", { target: "reviewer", label: "defaults" });
    // The codex block is not the resolved engine's, so the binding's chain applies.
    await hooksFor(runtime, { codex: { fallback: defaultsChain } }).agent("other block", { target: "reviewer", label: "other" });
    await hooksFor(runtime, { claude: { fallback: defaultsChain } }).agent("call", { target: "reviewer", label: "call", fallback: callChain });

    assert.deepEqual(settled(records, "binding").fallback, bindingChain);
    assert.deepEqual(settled(records, "binding").fallbackSource, { kind: "target", target: "reviewer" });
    assert.deepEqual(settled(records, "defaults").fallback, defaultsChain);
    assert.deepEqual(settled(records, "defaults").fallbackSource, { kind: "defaults", engine: "claude" });
    assert.deepEqual(settled(records, "other").fallbackSource, { kind: "target", target: "reviewer" });
    assert.deepEqual(settled(records, "call").fallback, callChain);
    assert.deepEqual(settled(records, "call").fallbackSource, { kind: "call" });
  } finally {
    await runtime.close();
  }
});

test("an attempt on a binding's chain entry names no target; the refused own target names it", async () => {
  const { runtime, codex, records } = recordingRuntime(
    { reviewer: { engine: "claude", model: "claude-opus-5-5", fallback: [{ engine: "codex", model: "gpt-6.1-sol" }] } },
    { codex: 1, claude: [claudeRefusal(429, "rate_limit")] }
  );
  try {
    assert.equal(await hooksFor(runtime).agent("review", { target: "reviewer", label: "review" }), "codex 1");
    assert.deepEqual(codex.dispatches.map((dispatch) => dispatch.model), ["gpt-6.1-sol"]);
    const record = settled(records, "review");
    assert.deepEqual(record.attempts.map((attempt) => [attempt.namedTarget, attempt.target.engine]), [
      ["reviewer", "claude"],
      [null, "codex"]
    ]);
  } finally {
    await runtime.close();
  }
});

test("a chain entry naming a target takes its binding, the defaults model where the binding names none, never its chain", async () => {
  const { runtime, codex, records } = recordingRuntime(
    {
      reviewer: { engine: "claude", model: "claude-opus-5-5" },
      bare: { engine: "codex", fallback: [{ engine: "claude", model: "never-dispatched" }] }
    },
    { codex: 1, claude: [claudeRefusal(429, "rate_limit")] }
  );
  try {
    const output = await hooksFor(runtime, { codex: { model: "gpt-6.1-sol" } }).agent(
      "review",
      { target: "reviewer", label: "review", fallback: [{ target: "bare", effort: "low" }] }
    );
    assert.equal(output, "codex 1");
    assert.deepEqual(codex.dispatches.map((dispatch) => [dispatch.model, dispatch.effort]), [["gpt-6.1-sol", "low"]]);
    const record = settled(records, "review");
    // The record keeps the chain as declared; each attempt names its target.
    assert.deepEqual(record.fallback, [{ target: "bare", effort: "low" }]);
    assert.deepEqual(record.attempts.map((attempt) => [attempt.namedTarget, attempt.target]), [
      ["reviewer", { engine: "claude", model: "claude-opus-5-5" }],
      ["bare", { engine: "codex", model: "gpt-6.1-sol" }]
    ]);
  } finally {
    await runtime.close();
  }
});

test("a binding's own chain may name another target", async () => {
  const { runtime, codex, records } = recordingRuntime(
    { reviewer: { engine: "claude", model: "claude-opus-5-5", fallback: [{ target: "doer" }] }, doer: { engine: "codex", model: "gpt-6-astra" } },
    { codex: 1, claude: [claudeRefusal(429, "rate_limit")] }
  );
  try {
    assert.equal(await hooksFor(runtime).agent("review", { target: "reviewer", label: "review" }), "codex 1");
    assert.deepEqual(codex.dispatches.map((dispatch) => dispatch.model), ["gpt-6-astra"]);
    assert.deepEqual(settled(records, "review").attempts.map((attempt) => attempt.namedTarget), ["reviewer", "doer"]);
  } finally {
    await runtime.close();
  }
});

test("named chain-entry mistakes are refused before any worker spawns", async () => {
  const bindings: Record<string, NamedTargetBinding> = { doer: { engine: "codex" }, local: { engine: "opencode", model: "glm" } };
  const cases: Array<{ fallback: unknown; pattern: RegExp }> = [
    { fallback: [{ target: "revewer" }], pattern: /fallback entry 0: target "revewer" is not bound: \/machine\/ensemble\/config\.json binds "doer", "local"/ },
    { fallback: [{ target: "doer", engine: "codex" }], pattern: /fallback entry 0 names target "doer" beside engine "codex".*\/machine\/ensemble\/config\.json/ },
    { fallback: [{ target: "doer", model: "x" }], pattern: /fallback entry 0 names target "doer" beside model "x"/ },
    { fallback: [{ target: "local" }], pattern: /entry 0 names target "local", bound to the opencode engine/ },
    { fallback: [{ target: "" }], pattern: /entry 0 target must be a non-empty string/ },
    { fallback: [{ target: "doer", effort: "extreme" }], pattern: /entry 0 effort must be one of/ }
  ];
  for (const entry of cases) {
    const { runtime, codex, claude, records } = recordingRuntime(bindings);
    try {
      await assert.rejects(
        async () => hooksFor(runtime).agent("prompt", { engine: "claude", fallback: entry.fallback } as unknown as AgentOptions),
        entry.pattern
      );
      assert.equal(codex.dispatches.length + claude.dispatches.length, 0);
      assert.deepEqual(records, []);
    } finally {
      await runtime.close();
    }
  }
});

test("a library caller's direct agent() call resolves its target and takes the binding's chain", async () => {
  const chain = [{ engine: "codex" as const, model: "binding-fallback" }];
  const { runtime, claude, records } = recordingRuntime({ reviewer: { engine: "claude", model: "claude-opus-5-5", fallback: chain } });
  try {
    await runtime.agent("direct", { target: "reviewer", label: "direct" });
    assert.deepEqual(claude.dispatches.map((dispatch) => dispatch.model), ["claude-opus-5-5"]);
    const record = settled(records, "direct");
    assert.deepEqual(record.namedTarget?.name, "reviewer");
    assert.deepEqual(record.fallbackSource, { kind: "target", target: "reviewer" });
  } finally {
    await runtime.close();
  }
});

test("resolving a target keeps options an accessor, prototype or Proxy trap supplies", async () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
  const codex = new ChainEngine("codex", [async () => ({ text: '{"ok":true}', deltaText: '{"ok":true}', durationMs: 10, firstDeltaMs: 5, items: {}, tokenUsageEvents: [] })]);
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([codex]),
    cwd: "/fake/repo",
    defaultMaxAttempts: 1,
    namedTargets: { bindings: { doer: { engine: "codex", model: "gpt-6.1-sol" } }, source: SOURCE }
  });
  runtime.setRunRecorder({
    recordAttemptStart: async () => {},
    recordAttemptEnd: async () => {},
    recordAgent: async (record: RuntimeAgentRecord) => { records.push(structuredClone(record)); }
  } as unknown as RunRecordWriter);
  // `schema` and `timeoutMs` come from a get trap alone, over an object
  // whose `identity` is inherited.
  const inherited = Object.create({ identity: false }) as Record<string, unknown>;
  inherited.target = "doer";
  const supplied: Record<string, unknown> = { schema, timeoutMs: 60_000 };
  const options = new Proxy(inherited, {
    get: (source, property, receiver) => (typeof property === "string" && property in supplied ? supplied[property] : Reflect.get(source, property, receiver))
  });
  try {
    // The validated object, not the raw text: the trap-supplied schema
    // reached the dispatch through the resolution.
    const output = await runtime.agent("structured", options as unknown as Partial<AgentOptions>);
    assert.deepEqual(output, { ok: true });
    assert.deepEqual(codex.dispatches.map((dispatch) => dispatch.model), ["gpt-6.1-sol"]);
    assert.equal(records.at(-1)?.namedTarget?.name, "doer");
  } finally {
    await runtime.close();
  }
});

test("a literal call carries no named target on its record or attempts", async () => {
  const { runtime, records } = recordingRuntime({ reviewer: { engine: "claude" } });
  try {
    await hooksFor(runtime).agent("literal", { engine: "codex", label: "literal" });
    const record = settled(records, "literal");
    assert.equal(record.namedTarget, null);
    assert.deepEqual(record.attempts.map((attempt) => attempt.namedTarget), [null]);
  } finally {
    await runtime.close();
  }
});

/** Held turns consume the same scripted results as one-shot calls. */
class TargetSessionEngine extends ChainEngine {
  createSession(options: EngineTurnOptions): EngineWorkerSession {
    return {
      beginTurn: (prompt) => this.createInvocation(prompt, options),
      close: async () => {}
    };
  }
}

for (const fallback of [false, true]) {
  test(`a target session keeps defaults and per-turn target records${fallback ? " after its binding's first-turn fallback" : " without fallback"}`, async () => {
    const claude = new TargetSessionEngine("claude", fallback
      ? [claudeRefusal(429, "rate_limit_error")]
      : [answer("first"), claudeRefusal(429, "rate_limit_error"), answer("third")]);
    const codex = new TargetSessionEngine("codex", [answer("first"), async () => {
      throw appServerErrorFromPayload("turn notification", { code: "usageLimitExceeded", message: "usage limit exceeded" });
    }, answer("third")]);
    const records: RuntimeAgentRecord[] = [];
    const chain = [{ target: "backup" }];
    const runtime = new EnsembleRuntime({
      engines: new EngineRegistry([claude, codex]),
      cwd: "/fake/repo",
      defaultMaxAttempts: 1,
      namedTargets: { bindings: { reviewer: { engine: "claude", fallback: chain }, backup: { engine: "codex" } }, source: SOURCE }
    });
    runtime.setRunRecorder({
      recordAttemptStart: async () => {},
      recordAttemptEnd: async () => {},
      recordAgent: async (record: RuntimeAgentRecord) => { records.push(structuredClone(record)); }
    } as unknown as RunRecordWriter);
    const declared: WorkerSessionOptions = { target: "reviewer", label: "held" };
    const session = hooksFor(runtime, {
      claude: { model: "primary-default", effort: "high" },
      codex: { model: "backup-default" }
    }).session(declared);
    try {
      assert.equal(await session.send("first turn"), "first");
      assert.equal(await session.send("second turn"), null);
      assert.equal(await session.send("third turn"), "third");
      const turns = [1, 2, 3].map((turn) => records.findLast((record) => record.session?.turn === turn && record.status !== "in-progress")!);
      assert.deepEqual(turns.map((record) => record.status), ["complete", "failed", "complete"]);
      assert.equal(turns[1]!.attempts.length, 1);
      assert.equal(turns[1]!.attempts[0]!.classification?.class, "availability");
      assert.equal(turns[1]!.attempts[0]!.chainDecision, null);
      assert.deepEqual(turns.map((record) => record.namedTarget), Array.from({ length: 3 }, () => ({ name: "reviewer", source: SOURCE, engine: "claude", model: null })));
      assert.deepEqual(turns.map((record) => record.model), fallback
        ? ["primary-default", "backup-default", "backup-default"]
        : ["primary-default", "primary-default", "primary-default"]);
      assert.deepEqual(turns.map((record) => record.fallback), [chain, null, null]);
      assert.deepEqual(turns[0]!.fallbackSource, { kind: "target", target: "reviewer" });
      assert.deepEqual(turns.map((record) => record.attempts.map((attempt) => attempt.namedTarget)), fallback
        ? [["reviewer", "backup"], ["backup"], ["backup"]]
        : [["reviewer"], ["reviewer"], ["reviewer"]]);
      assert.deepEqual(claude.dispatches.map(({ model, effort }) => ({ model, effort })), Array.from({ length: fallback ? 1 : 3 }, () => ({ model: "primary-default", effort: "high" })));
      assert.deepEqual(codex.dispatches.map(({ model }) => model), fallback ? ["backup-default", "backup-default", "backup-default"] : []);
    } finally {
      await session.close();
      await runtime.close();
    }
  });
}

test("named-target mistakes are refused before any worker spawns, naming the name and the file", async () => {
  const cases: Array<{ bindings: Record<string, NamedTargetBinding> | null; options: Record<string, unknown>; pattern: RegExp }> = [
    { bindings: { reviewer: { engine: "claude" } }, options: { target: "revewer" }, pattern: /target "revewer" is not bound: \/machine\/ensemble\/config\.json binds "reviewer"/ },
    { bindings: {}, options: { target: "reviewer" }, pattern: /target "reviewer" is not bound: \/machine\/ensemble\/config\.json binds no targets/ },
    { bindings: null, options: { target: "reviewer" }, pattern: /target "reviewer" is not bound: this run was given no machine configuration targets/ },
    // A name spelling a prototype property is unbound, not Object's.
    { bindings: { reviewer: { engine: "claude" } }, options: { target: "constructor" }, pattern: /target "constructor" is not bound/ },
    {
      bindings: { reviewer: { engine: "claude" } },
      options: { target: "reviewer", engine: "codex" },
      pattern: /target "reviewer" is named beside engine "codex".*\/machine\/ensemble\/config\.json/
    },
    {
      bindings: { reviewer: { engine: "claude" } },
      options: { target: "reviewer", model: "gpt-6.1-sol" },
      pattern: /target "reviewer" is named beside model "gpt-6.1-sol".*\/machine\/ensemble\/config\.json/
    }
  ];
  for (const entry of cases) {
    for (const route of ["hooks", "direct"] as const) {
      const { runtime, codex, claude, records } = recordingRuntime(entry.bindings);
      try {
        // The hooks judge a script's options synchronously, as the call is made.
        const call = async (): Promise<unknown> =>
          route === "hooks"
            ? hooksFor(runtime).agent("prompt", entry.options as unknown as AgentOptions)
            : runtime.agent("prompt", entry.options as Partial<AgentOptions>);
        await assert.rejects(call(), (error: Error) => {
          assert.ok(error instanceof NamedTargetRejectedError, `${route}: ${error.name}: ${error.message}`);
          assert.match(error.message, entry.pattern);
          return true;
        });
        assert.equal(codex.dispatches.length + claude.dispatches.length, 0);
        assert.deepEqual(records, []);
      } finally {
        await runtime.close();
      }
    }
  }
});

test("a malformed target option is refused by the option validation", async () => {
  const { runtime } = recordingRuntime({ reviewer: { engine: "claude" } });
  try {
    for (const target of ["", "  ", 7]) {
      await assert.rejects(async () => hooksFor(runtime).agent("prompt", { target } as unknown as AgentOptions), /"target"/);
    }
  } finally {
    await runtime.close();
  }
});

test("machine and library targets share validation before workers start", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-named-targets-"));
  const configHome = path.join(directory, "config");
  const configFile = path.join(configHome, "ensemble", "config.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  const resolve = async (config: unknown): Promise<ReturnType<typeof resolveAmbientSettings>> => {
    await writeFile(configFile, JSON.stringify(config));
    return resolveAmbientSettings({ env: { XDG_CONFIG_HOME: configHome }, cwd: directory });
  };
  try {
    const bindings = {
      doer: { engine: "codex" },
      reviewer: { engine: "claude", model: "claude-opus-5-5", fallback: [{ engine: "codex", model: "gpt-6.1-sol", effort: "low" }, { target: "doer" }] },
      codex: { engine: "claude" }
    };
    assert.deepEqual((await resolve({ schema_version: 1, targets: bindings })).namedTargets, { bindings, source: configFile });
    assert.deepEqual((await resolve({ schema_version: 1 })).namedTargets, { bindings: {}, source: configFile });

    const refusals: Array<{ targets: unknown; pattern: RegExp }> = [
      { targets: { doer: { engine: "gemini" } }, pattern: /targets\.doer\.engine in .*config\.json: target "doer" is bound to unknown engine "gemini"/ },
      { targets: { doer: {} }, pattern: /targets\.doer\.engine in .*config\.json: target "doer" is bound to unknown engine undefined/ },
      { targets: { doer: { engine: "codex", model: "" } }, pattern: /targets\.doer\.model in .*config\.json: must be a non-empty string/ },
      { targets: { doer: { engine: "codex", effort: "low" } }, pattern: /Unknown machine configuration key targets\.doer\.effort in .*config\.json/ },
      { targets: { doer: { engine: "codex", fallback: [{ engine: "codex" }] } }, pattern: /targets\.doer\.fallback in .*config\.json: Invalid fallback chain: entry 0 must name its model/ },
      { targets: { doer: { engine: "codex", fallback: [] } }, pattern: /targets\.doer\.fallback in .*config\.json: Invalid fallback chain: the chain must not be empty/ },
      { targets: { " ": { engine: "codex" } }, pattern: /targets in .*config\.json: target names must be non-empty/ },
      { targets: { doer: "codex" }, pattern: /targets\.doer in .*config\.json: must be a JSON object/ },
      { targets: ["doer"], pattern: /targets in .*config\.json: must be a JSON object/ },
      {
        targets: { doer: { engine: "codex", fallback: [{ target: "reviewer" }] } },
        pattern: /targets\.doer\.fallback in .*config\.json: entry 0 names target "reviewer", which this file does not bind/
      },
      {
        targets: { doer: { engine: "codex", fallback: [{ target: "back", engine: "claude", model: "x" }] }, back: { engine: "codex" } },
        pattern: /targets\.doer\.fallback in .*config\.json: entry 0 names target "back" beside a literal engine or model/
      },
      {
        targets: { doer: { engine: "codex", fallback: [{ target: "local" }] }, local: { engine: "opencode", model: "glm" } },
        pattern: /targets\.doer\.fallback in .*config\.json: entry 0 names target "local", bound to the opencode engine/
      }
    ];
    for (const entry of refusals) {
      await assert.rejects(resolve({ schema_version: 1, targets: entry.targets }), entry.pattern);
      const namedTargets = { bindings: entry.targets, source: configFile } as NamedTargets;
      const engine = new ChainEngine("codex", [answer("unexpected dispatch")]);
      assert.throws(() => new EnsembleRuntime({
        engines: new EngineRegistry([engine]), defaultMaxAttempts: 1, namedTargets
      }), entry.pattern);
      await assert.rejects(async () => {
        const runtime = await createRuntime({ namedTargets });
        await runtime.close();
      }, entry.pattern);
      assert.equal(engine.dispatches.length, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class CaptureStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }
  text(): string {
    return this.chunks.join("");
  }
}

test("ensemble agent --target dispatches on the binding and records the name in the agent record and the manifest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-agent-target-"));
  const configFile = path.join(directory, "config", "ensemble", "config.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({ schema_version: 1, targets: { reviewer: { engine: "claude", model: "claude-opus-5-5" } } }));
  const claude = new ChainEngine("claude", [answer("reviewed")]);
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  try {
    const exitCode = await runEnsembleCli(["agent", "--target", "reviewer", "review this"], {
      cwd: directory,
      env: { XDG_CONFIG_HOME: path.join(directory, "config"), ENSEMBLE_STATUS: "off" },
      stdout,
      stderr,
      runRecordDir: path.join(directory, "records"),
      createRuntime: async (options) => new EnsembleRuntime({ ...options, engines: new EngineRegistry([claude]), defaultMaxAttempts: 1 })
    });
    assert.equal(exitCode, 0, stderr.text());
    assert.equal(JSON.parse(stdout.text()), "reviewed");
    assert.deepEqual(claude.dispatches.map((dispatch) => dispatch.model), ["claude-opus-5-5"]);

    const announcement = stderr.text().split("\n").find((line) => line.startsWith("[run-record-archive] "));
    assert.ok(announcement, stderr.text());
    const archivePath = (JSON.parse(announcement.slice("[run-record-archive] ".length)) as { archive_path: string }).archive_path;
    const manifest = JSON.parse(await readFile(path.join(archivePath, "manifest.json"), "utf8")) as { named_targets: unknown };
    assert.deepEqual(manifest.named_targets, {
      source: configFile,
      bindings: { reviewer: { engine: "claude", model: "claude-opus-5-5", fallback: null } }
    });
    const agent = JSON.parse(await readFile(path.join(archivePath, "agents", "000001", "agent.json"), "utf8")) as {
      engine: string;
      named_target: unknown;
      attempts: Array<{ named_target: unknown }>;
    };
    assert.equal(agent.engine, "claude");
    assert.deepEqual(agent.named_target, { name: "reviewer", source: configFile, engine: "claude", model: "claude-opus-5-5" });
    assert.deepEqual(agent.attempts.map((attempt) => attempt.named_target), ["reviewer"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ensemble agent refuses a call with neither --engine nor --target, and --target beside --engine names the file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-agent-target-"));
  const configFile = path.join(directory, "config", "ensemble", "config.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({ schema_version: 1, targets: { reviewer: { engine: "claude" } } }));
  const run = async (argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string; dispatched: number }> => {
    const claude = new ChainEngine("claude", [answer("unused")]);
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = await runEnsembleCli(argv, {
      cwd: directory,
      env: { XDG_CONFIG_HOME: path.join(directory, "config"), ENSEMBLE_STATUS: "off" },
      stdout,
      stderr,
      runRecordDir: null,
      createRuntime: async (options) => new EnsembleRuntime({ ...options, engines: new EngineRegistry([claude]), defaultMaxAttempts: 1 })
    });
    return { exitCode, stdout: stdout.text(), stderr: stderr.text(), dispatched: claude.dispatches.length };
  };
  try {
    const neither = await run(["agent", "prompt"]);
    assert.notEqual(neither.exitCode, 0);
    assert.match(neither.stderr, /agent requires --engine or --target/);

    const both = await run(["agent", "--target", "reviewer", "--engine", "codex", "prompt"]);
    assert.equal(both.exitCode, 1, both.stderr);
    assert.equal(both.dispatched, 0);
    assert.match(both.stdout, /NamedTargetRejectedError/);
    assert.ok(both.stdout.includes(configFile), both.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
