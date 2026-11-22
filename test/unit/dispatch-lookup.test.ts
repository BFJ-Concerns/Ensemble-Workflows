import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { EngineRegistry, OpenCodeEngineAdapter } from "../../src/engines.js";
import { AgentCwdRejectedError, CapabilityStripUnsupportedError, InvalidAgentSchemaError, LeanStartUnsupportedError, MissingEngineError, NamedTargetRejectedError, OpenCodeModelRequiredError } from "../../src/errors.js";
import { createWorkflowHooks } from "../../src/hooks.js";
import { groupModelName, modelFamilyOf, singleFamilyOf } from "../../src/model-family.js";
import { createOpenCodeModelRegistry } from "../../src/opencode-model-registry.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { runWorkflowScript } from "../../src/script-runner.js";
import { ChainEngine, claudeRefusal } from "./chain-engine-fakes.js";

import type { EngineAttemptResult } from "../../src/engines.js";
import type { WorkflowDefaults } from "../../src/hooks.js";
import type { NamedTargets } from "../../src/named-targets.js";
import type { AgentOptions } from "../../src/types.js";
import type { OpenCodeModelRegistryEntry } from "../../src/opencode-model-registry.js";

const SOURCE = "/machine/ensemble/config.json";

function answer(text: string, resolvedModel?: string): () => Promise<EngineAttemptResult> {
  return async () => ({
    text, deltaText: text, durationMs: 10, firstDeltaMs: 5, items: {}, tokenUsageEvents: [],
    ...(resolvedModel !== undefined ? { resolvedModel } : {})
  });
}

function scriptedRuntime(
  bindings: NamedTargets["bindings"] | null,
  steps: { codex?: Array<() => Promise<EngineAttemptResult>>; claude?: Array<() => Promise<EngineAttemptResult>> } = {}
): { runtime: EnsembleRuntime; codex: ChainEngine; claude: ChainEngine } {
  const codex = new ChainEngine("codex", steps.codex ?? [answer("codex 1"), answer("codex 2")]);
  const claude = new ChainEngine("claude", steps.claude ?? [answer("claude 1"), answer("claude 2")]);
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([codex, claude]),
    cwd: "/fake/repo",
    defaultMaxAttempts: 1,
    ...(bindings !== null ? { namedTargets: { bindings, source: SOURCE } } : {})
  });
  return { runtime, codex, claude };
}

function hooksFor(runtime: EnsembleRuntime, defaults?: WorkflowDefaults): ReturnType<typeof createWorkflowHooks> {
  return createWorkflowHooks({ runtime, args: [], log: () => {}, workflow: async () => null, ...(defaults !== undefined ? { defaults } : {}) });
}

const OPENCODE_MODELS: OpenCodeModelRegistryEntry[] = [
  { key: "glm", provider: "provider", providerModel: "provider/glm-5", displayName: "GLM", family: "glm", capabilities: { vision: false }, variants: [] },
  { key: "unlabelled", provider: "provider", providerModel: "provider/mystery", displayName: "Mystery", capabilities: { vision: false }, variants: [] }
];

function openCodeRuntime(): EnsembleRuntime {
  const adapter = new OpenCodeEngineAdapter({
    modelRegistry: createOpenCodeModelRegistry(OPENCODE_MODELS),
    runner: {
      run: async () => ({ exitCode: 0, signal: null, durationMs: 1, stderr: "", stdout: JSON.stringify({ type: "text", sessionID: "ses_lookup", part: { type: "text", text: "answer" } }) }),
      exportSession: async () => ({ status: "command-failed", exitCode: 1, signal: null, stderr: "no session" })
    }
  });
  return new EnsembleRuntime({ engines: new EngineRegistry([adapter]), cwd: "/fake/repo", defaultMaxAttempts: 1 });
}

test("the dispatch lookup answers a named target's engine, model and family with nothing dispatched", async () => {
  const { runtime, codex, claude } = scriptedRuntime({
    reviewer: { engine: "claude", model: "claude-opus-5-5" },
    doer: { engine: "codex" }
  });
  try {
    const hooks = hooksFor(runtime, { codex: { model: "gpt-6.1-sol" } });
    assert.deepEqual(hooks.lookupDispatch({ target: "reviewer" }), {
      target: "reviewer", bound: true, engine: "claude", model: "claude-opus-5-5", family: "claude"
    });
    // A model-less binding takes the resolved engine's `defaults` model, as the call would.
    assert.deepEqual(hooks.lookupDispatch({ target: "doer", label: "build" }), {
      target: "doer", bound: true, engine: "codex", model: "gpt-6.1-sol", family: "gpt"
    });
    // With no `defaults` model either, the engine's own default decides,
    // which the harness does not know until a worker serves it: its family
    // is unknown, never the engine's name.
    assert.deepEqual(hooksFor(runtime).lookupDispatch({ target: "doer" }), {
      target: "doer", bound: true, engine: "codex", model: null, family: null
    });
    assert.equal(codex.dispatches.length, 0);
    assert.equal(claude.dispatches.length, 0);
  } finally {
    await runtime.close();
  }
});

test("the dispatch lookup answers a literal-engine call as the call would dispatch it", async () => {
  const { runtime } = scriptedRuntime(null);
  try {
    const hooks = hooksFor(runtime, { claude: { model: "claude-sonnet-5-5" } });
    assert.deepEqual(hooks.lookupDispatch({ engine: "claude" }), {
      target: null, bound: true, engine: "claude", model: "claude-sonnet-5-5", family: "claude"
    });
    assert.deepEqual(hooks.lookupDispatch({ engine: "claude", model: "claude-opus-5-5" }), {
      target: null, bound: true, engine: "claude", model: "claude-opus-5-5", family: "claude"
    });
    // A library caller's options stand as given.
    assert.deepEqual(runtime.lookupDispatch({ engine: "codex", model: "gpt-6-luna" }), {
      target: null, bound: true, engine: "codex", model: "gpt-6-luna", family: "gpt"
    });
  } finally {
    await runtime.close();
  }
});

test("the dispatch lookup answers an unbound target as unbound and refuses what the call would refuse", async () => {
  const { runtime } = scriptedRuntime({ reviewer: { engine: "claude" } });
  const unboundRun = scriptedRuntime(null);
  try {
    const unbound = { target: "nobody", bound: false, engine: null, model: null, family: null };
    assert.deepEqual(hooksFor(runtime).lookupDispatch({ target: "nobody" }), unbound);
    // A prototype property's name is unbound too, as the call judges it.
    assert.deepEqual(hooksFor(runtime).lookupDispatch({ target: "constructor" }), { ...unbound, target: "constructor" });
    // A run given no targets binds no name.
    assert.deepEqual(hooksFor(unboundRun.runtime).lookupDispatch({ target: "nobody" }), unbound);
    assert.throws(() => hooksFor(runtime).agent("go", { target: "nobody" }), NamedTargetRejectedError);

    assert.throws(
      () => hooksFor(runtime).lookupDispatch({ target: "reviewer", engine: "codex" } as never),
      (error: unknown) => error instanceof NamedTargetRejectedError && /beside engine "codex"/.test(error.message)
    );
    assert.throws(() => hooksFor(runtime).lookupDispatch({}), MissingEngineError);
    // A chain entry the call could not settle is refused too, from the call
    // and from the script's defaults. (A binding's own chain is judged when
    // the bindings are read.)
    const unboundEntry = [{ target: "missing" }];
    assert.throws(() => hooksFor(runtime).lookupDispatch({ engine: "claude", fallback: unboundEntry }), NamedTargetRejectedError);
    assert.throws(
      () => hooksFor(runtime, { claude: { fallback: unboundEntry } }).lookupDispatch({ engine: "claude" }),
      NamedTargetRejectedError
    );
    assert.throws(() => runtime.lookupDispatch({ engine: "claude", fallback: unboundEntry }), NamedTargetRejectedError);
  } finally {
    await runtime.close();
    await unboundRun.runtime.close();
  }
});

test("the dispatch lookup judges an opencode route's family from its registry entry, unknown where it declares none", async () => {
  const runtime = openCodeRuntime();
  try {
    const hooks = hooksFor(runtime);
    assert.deepEqual(hooks.lookupDispatch({ engine: "opencode", model: "glm" }), {
      target: null, bound: true, engine: "opencode", model: "glm", family: "glm"
    });
    assert.deepEqual(hooks.lookupDispatch({ engine: "opencode", model: "unlabelled" }), {
      target: null, bound: true, engine: "opencode", model: "unlabelled", family: null
    });
    assert.deepEqual(hooksFor(runtime, { opencode: { model: "provider/glm-5" } }).lookupDispatch({ engine: "opencode" }), {
      target: null, bound: true, engine: "opencode", model: "provider/glm-5", family: "glm"
    });
    assert.throws(() => hooks.lookupDispatch({ engine: "opencode" }), OpenCodeModelRequiredError);
  } finally {
    await runtime.close();
  }
});

test("the dispatch lookup judges a family from the model, under the machine's assignments", async () => {
  const codex = new ChainEngine("codex", []);
  const claude = new ChainEngine("claude", []);
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([codex, claude]),
    cwd: "/fake/repo",
    defaultMaxAttempts: 1,
    modelFamilies: { "house-model": "glm", "claude-opus-5-5": "house" }
  });
  try {
    // A Claude model's family is Claude's on the Codex engine too.
    assert.equal(runtime.lookupDispatch({ engine: "codex", model: "claude-sonnet-5-5" }).family, "claude");
    assert.equal(runtime.lookupDispatch({ engine: "claude", model: "house-model" }).family, "glm");
    // An assignment outranks the grouping.
    assert.equal(runtime.lookupDispatch({ engine: "claude", model: "claude-opus-5-5" }).family, "house");
    assert.equal(runtime.lookupDispatch({ engine: "claude", model: "mystery-1" }).family, null);
  } finally {
    await runtime.close();
  }
});

test("model families: grouped by model name on every engine, assignments first, null where nothing places it", () => {
  const registry = createOpenCodeModelRegistry(OPENCODE_MODELS);
  const judge = (engine: "codex" | "claude" | "opencode", requested: string | null, served: string | null = null, assignments = {}) =>
    modelFamilyOf({ engine, requested, served }, assignments, registry);
  for (const [model, family] of [
    ["claude-opus-5-5", "claude"], ["opus", "claude"], ["sonnet[1m]", "claude"], ["openrouter/anthropic/claude-sonnet-5-5", "claude"],
    ["gpt-6.2-sol", "gpt"], ["o4-mini", "gpt"], ["codex-mini-latest", "gpt"], ["gpt-oss-120b", "gpt"],
    ["gemini-4-neon", "gemini"], ["z-ai/GLM-4.6", "glm"], ["moonshotai/kimi-k2", "kimi"], ["Qwen/Qwen3-Coder", "qwen"],
    ["deepseek-v3.2", "deepseek"], ["mystery-1", null], ["opusculum", null], ["o", null]
  ] as const) {
    assert.equal(groupModelName(model), family, model);
  }
  // The engine never decides: one model is one family on every engine.
  assert.equal(judge("codex", "claude-opus-5-5"), "claude");
  assert.equal(judge("claude", "gpt-6.2-sol"), "gpt");
  // No model named and none served: unknown, never the engine's name.
  assert.equal(judge("codex", null), null);
  // A call naming no model is judged by the model its engine's default served.
  assert.equal(judge("codex", null, "gpt-6.2-sol"), "gpt");
  assert.equal(judge("claude", "fast", "claude-haiku-5-5"), "claude");
  // An assignment outranks the grouping, on the requested name or the served one.
  assert.equal(judge("claude", "claude-opus-5-5", null, { "claude-opus-5-5": "house" }), "house");
  assert.equal(judge("claude", "claude-opus-5-5", "gateway-model", { "gateway-model": "glm" }), "glm");
  // opencode: the entry's declared family first, then its key and route by name.
  assert.equal(judge("opencode", "glm"), "glm");
  assert.equal(judge("opencode", "provider/glm-5"), "glm");
  assert.equal(judge("opencode", "unlabelled"), null);
  assert.equal(judge("opencode", "unlabelled", null, { unlabelled: "mystery" }), "mystery");
  assert.equal(judge("opencode", "glm", null, { glm: "other" }), "glm");
  assert.equal(judge("opencode", "unregistered"), null);
  assert.equal(judge("opencode", "kimi-k2.5"), "kimi");
});

test("the single-family judgement names one family only where every worker is placed on it", () => {
  assert.deepEqual(singleFamilyOf(["claude", "claude", "claude"]), { family: "claude", workers: 3 });
  assert.deepEqual(singleFamilyOf(["claude"]), { family: "claude", workers: 1 });
  assert.equal(singleFamilyOf([]), null);
  assert.equal(singleFamilyOf(["claude", "gpt"]), null);
  // A worker whose family is unknown leaves the fact unknown.
  assert.equal(singleFamilyOf(["claude", "claude", null]), null);
  assert.equal(singleFamilyOf([null, null]), null);
});

test("an identified call's envelope names the engine, model and family that answered it", async () => {
  const { runtime } = scriptedRuntime(
    { reviewer: { engine: "claude", model: "claude-opus-5-5", fallback: [{ engine: "codex", model: "gpt-6.1-sol" }] } },
    {
      codex: [answer("codex 1", "gpt-6.1-sol-2026-09-29")],
      claude: [answer("claude 1"), claudeRefusal(429, "rate_limit")]
    }
  );
  try {
    const hooks = hooksFor(runtime);
    const own = await hooks.agent("review", { target: "reviewer", identity: true });
    // The engine reported no served model, so the requested one stands.
    assert.deepEqual(own.answeredBy, { engine: "claude", model: "claude-opus-5-5", family: "claude" });

    const fellBack = await hooks.agent("review again", { target: "reviewer", identity: true });
    assert.equal(fellBack.output, "codex 1");
    // The chain entry that answered, under the model it served.
    assert.deepEqual(fellBack.answeredBy, { engine: "codex", model: "gpt-6.1-sol-2026-09-29", family: "gpt" });
  } finally {
    await runtime.close();
  }
});

test("a failed identified call's envelope names no answering target", async () => {
  const { runtime } = scriptedRuntime(null, { claude: [claudeRefusal(429, "rate_limit")] });
  try {
    const failed = await hooksFor(runtime).agent("review", { engine: "claude", identity: true });
    assert.notEqual(failed.failure, null);
    assert.equal(failed.answeredBy, null);
  } finally {
    await runtime.close();
  }
});

test("a workflow script reaches the dispatch lookup as a bound hook", async () => {
  const { runtime } = scriptedRuntime({ reviewer: { engine: "claude", model: "claude-opus-5-5" } });
  try {
    const result = await runWorkflowScript({
      filename: "lookup.js",
      runtime,
      log: () => {},
      source: [
        'export const meta = { name: "lookup" };',
        "return [lookupDispatch({ target: \"reviewer\" }).family, lookupDispatch({ target: \"absent\" }).bound];"
      ].join("\n")
    });
    assert.deepEqual(result.result, ["claude", false]);
  } finally {
    await runtime.close();
  }
});

test("lookup and call refuse omitted options with the same missing-engine error", async () => {
  const { runtime } = scriptedRuntime(null);
  try {
    const hooks = hooksFor(runtime);
    let refusal: unknown;
    assert.throws(() => runtime.lookupDispatch(), (error) => {
      refusal = error;
      return error instanceof MissingEngineError;
    });
    assert.throws(() => hooks.lookupDispatch(), (error) => {
      assert.deepEqual(error, refusal);
      return true;
    });
    await assert.rejects(Reflect.apply(runtime.agent, runtime, ["go"]), (error) => {
      assert.deepEqual(error, refusal);
      return true;
    });
    await assert.rejects(Reflect.apply(hooks.agent, undefined, ["go"]), (error) => {
      assert.deepEqual(error, refusal);
      return true;
    });
  } finally {
    await runtime.close();
  }
});

test("lookup refuses malformed schemas and unusable cwd with the call's error and precedence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dispatch-lookup-test-"));
  const codex = new ChainEngine("codex", [answer("unused")]);
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry([codex]), cwd: root, defaultMaxAttempts: 1 });
  try {
    await mkdir(path.join(root, "directory"));
    await writeFile(path.join(root, "file"), "a file is not a directory");
    const hooks = hooksFor(runtime);
    const invalidSchema = { type: "not-a-json-schema-type" };
    const cases: Array<[Partial<AgentOptions>, typeof InvalidAgentSchemaError | typeof AgentCwdRejectedError]> = [
      [{ engine: "codex", schema: invalidSchema }, InvalidAgentSchemaError],
      [{ engine: "codex", schema: { $ref: "#/missing" } }, InvalidAgentSchemaError],
      [{ engine: "codex", cwd: "missing" }, AgentCwdRejectedError],
      [{ engine: "codex", cwd: "file" }, AgentCwdRejectedError],
      // Schema and cwd rejection precede engine and capability selection.
      [{ engine: "opencode", cwd: "missing", schema: invalidSchema }, InvalidAgentSchemaError],
      [{ engine: "opencode", cwd: "missing", lean: true }, AgentCwdRejectedError]
    ];
    for (const [options, errorType] of cases) {
      let refusal: unknown;
      assert.throws(() => hooks.lookupDispatch(options), (error) => {
        refusal = error;
        return error instanceof errorType;
      });
      assert.throws(() => runtime.lookupDispatch(options), (error) => {
        assert.ok(error instanceof errorType);
        assert.equal(error.message, (refusal as Error).message);
        return true;
      });
      await assert.rejects(hooks.agent("go", options), (error) => {
        assert.ok(error instanceof errorType);
        assert.equal(error.message, (refusal as Error).message);
        return true;
      });
    }
    let cwdReads = 0;
    assert.equal(hooks.lookupDispatch({ engine: "codex", get cwd() {
      cwdReads++;
      return cwdReads === 1 ? "directory" : "missing";
    } }).engine, "codex");
    assert.equal(cwdReads, 1);
    assert.equal(hooks.lookupDispatch({ engine: "codex", schema: { type: "string" }, cwd: "directory" }).bound, true);
    assert.equal(codex.dispatches.length, 0);
    assert.equal(runtime.progress.snapshot().agents.length, 0);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("lookup refuses strip and lean on the first target and every effective fallback", async () => {
  const restrictions: Array<Pick<Partial<AgentOptions>, "strip" | "lean">> = [{ strip: ["skills"] }, { lean: true }];
  for (const restriction of restrictions) {
    const { runtime, codex, claude } = scriptedRuntime({
      first: { engine: "claude" },
      chained: { engine: "codex", fallback: [{ target: "first" }] }
    });
    Object.assign(codex, {
      capabilities: { skills: { route: "absent", detail: "test engine has no skills" } },
      leanStart: { route: "config", detail: "test engine starts empty" }
    });
    try {
      const errorType = "strip" in restriction ? CapabilityStripUnsupportedError : LeanStartUnsupportedError;
      const hooks = hooksFor(runtime);
      const cases: Array<Partial<AgentOptions>> = [
        { target: "first", ...restriction },
        { engine: "codex", fallback: [{ engine: "claude", model: "claude-opus-5-5" }], ...restriction },
        { target: "chained", ...restriction }
      ];
      for (const options of cases) {
        let refusal: unknown;
        assert.throws(() => hooks.lookupDispatch(options), (error) => {
          refusal = error;
          return error instanceof errorType;
        });
        await assert.rejects(hooks.agent("go", options), (error) => {
          assert.ok(error instanceof errorType);
          assert.equal(error.message, (refusal as Error).message);
          return true;
        });
      }
      assert.throws(() => hooksFor(runtime, { codex: { fallback: [{ engine: "claude", model: "claude-opus-5-5" }] } })
        .lookupDispatch({ engine: "codex", ...restriction }), errorType);
      assert.equal(codex.dispatches.length, 0);
      assert.equal(claude.dispatches.length, 0);
    } finally {
      await runtime.close();
    }
  }
});

test("an identified opencode answer names its registry family, unknown when undeclared", async () => {
  const runtime = openCodeRuntime();
  try {
    const hooks = hooksFor(runtime);
    for (const [model, servedModel, family] of [
      ["glm", "provider/glm-5", "glm"],
      ["provider/glm-5", "provider/glm-5", "glm"],
      ["unlabelled", "provider/mystery", null]
    ] as const) {
      const result = await hooks.agent("go", { engine: "opencode", model, identity: true });
      assert.equal(result.output, "answer");
      assert.deepEqual(result.answeredBy, { engine: "opencode", model: servedModel, family });
    }
  } finally {
    await runtime.close();
  }
});
