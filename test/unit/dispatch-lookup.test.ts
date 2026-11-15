import assert from "node:assert/strict";
import test from "node:test";

import { EngineRegistry, OpenCodeEngineAdapter } from "../../src/engines.js";
import { MissingEngineError, NamedTargetRejectedError, OpenCodeModelRequiredError } from "../../src/errors.js";
import { createWorkflowHooks } from "../../src/hooks.js";
import { modelFamilyOf } from "../../src/model-family.js";
import { createOpenCodeModelRegistry } from "../../src/opencode-model-registry.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { runWorkflowScript } from "../../src/script-runner.js";
import { ChainEngine, claudeRefusal } from "./chain-engine-fakes.js";

import type { EngineAttemptResult } from "../../src/engines.js";
import type { WorkflowDefaults } from "../../src/hooks.js";
import type { NamedTargets } from "../../src/named-targets.js";
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
      run: async () => ({ exitCode: 0, signal: null, durationMs: 1, stderr: "", stdout: "" }),
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
      target: "doer", bound: true, engine: "codex", model: "gpt-6.1-sol", family: "codex"
    });
    // With no `defaults` model either, the engine's own default decides, which the harness does not know.
    assert.deepEqual(hooksFor(runtime).lookupDispatch({ target: "doer" }), {
      target: "doer", bound: true, engine: "codex", model: null, family: "codex"
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
      target: null, bound: true, engine: "codex", model: "gpt-6-luna", family: "codex"
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

test("model families: Codex and Claude by engine, opencode by declaration, null where nothing declares one", () => {
  const registry = createOpenCodeModelRegistry(OPENCODE_MODELS);
  assert.equal(modelFamilyOf("codex", null, undefined), "codex");
  assert.equal(modelFamilyOf("claude", "claude-opus-5-5", registry), "claude");
  assert.equal(modelFamilyOf("opencode", "glm", registry), "glm");
  assert.equal(modelFamilyOf("opencode", "provider/glm-5", registry), "glm");
  assert.equal(modelFamilyOf("opencode", "unlabelled", registry), null);
  assert.equal(modelFamilyOf("opencode", "unregistered", registry), null);
  assert.equal(modelFamilyOf("opencode", undefined, registry), null);
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
    assert.deepEqual(fellBack.answeredBy, { engine: "codex", model: "gpt-6.1-sol-2026-09-29", family: "codex" });
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
