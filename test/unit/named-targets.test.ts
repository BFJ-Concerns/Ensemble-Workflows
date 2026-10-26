import assert from "node:assert/strict";
import test from "node:test";

import { FallbackTargetRejectedError, NamedTargetRejectedError } from "../../src/errors.js";
import { resolveNamedTargets } from "../../src/named-targets.js";

import type { NamedTargets } from "../../src/named-targets.js";
import type { FallbackTarget } from "../../src/types.js";

const targets: NamedTargets = {
  bindings: {
    doer: { engine: "codex", model: "gpt-6.1-sol" },
    grunt: { engine: "codex" },
    reviewer: { engine: "claude", model: "opus" },
    local: { engine: "opencode", model: "glm-5.2" }
  },
  source: "/home/op/.config/ensemble/config.json"
};

const declaredModel = (engine: string): string | undefined => ({ codex: "gpt-6-luna", claude: "sonnet" })[engine];

test("a call's own target and each named chain entry resolve to their bindings, the record evidence naming each", () => {
  const resolved = resolveNamedTargets(
    targets,
    { target: "doer", fallback: [{ target: "reviewer", effort: "high" }, { engine: "codex", model: "gpt-6-astra" }] },
    declaredModel
  );
  assert.deepEqual(resolved.own, { engine: "codex", model: "gpt-6.1-sol" });
  // Every entry is settled — the literal one as declared — so the chain's
  // consumers read one map rather than two shapes.
  assert.deepEqual(
    [...resolved.entries.entries()],
    [
      [0, { engine: "claude", model: "opus" }],
      [1, { engine: "codex", model: "gpt-6-astra" }]
    ]
  );
  assert.deepEqual(resolved.resolutions, [
    { name: "doer", entry: -1, resolved: { engine: "codex", model: "gpt-6.1-sol" } },
    { name: "reviewer", entry: 0, resolved: { engine: "claude", model: "opus" } }
  ]);
});

test("a model-less binding takes the resolved engine's declared model, else the engine's own default", () => {
  const withDefault = resolveNamedTargets(targets, { target: "grunt" }, declaredModel);
  assert.deepEqual(withDefault.own, { engine: "codex", model: "gpt-6-luna" });
  assert.deepEqual(withDefault.resolutions[0]?.resolved, { engine: "codex", model: "gpt-6-luna" });
  // No declared default: the model stays undefined for the dispatch and null
  // on the record — the engine's own default, as an unpinned call runs.
  const bare = resolveNamedTargets(targets, { target: "grunt" }, () => undefined);
  assert.deepEqual(bare.own, { engine: "codex", model: undefined });
  assert.deepEqual(bare.resolutions[0]?.resolved, { engine: "codex", model: null });
});

test("a call naming no target passes through as declared, its literal chain settled and no resolution recorded", () => {
  const resolved = resolveNamedTargets(targets, { engine: "claude", model: "opus", fallback: [{ engine: "codex", model: "gpt-6.1-sol" }] }, declaredModel);
  assert.deepEqual(resolved.own, { engine: "claude", model: "opus" });
  assert.deepEqual([...resolved.entries.entries()], [[0, { engine: "codex", model: "gpt-6.1-sol" }]]);
  assert.deepEqual(resolved.resolutions, []);
  // A run given no bindings at all resolves a literal call just the same.
  assert.deepEqual(resolveNamedTargets(null, { engine: "codex" }, declaredModel), { own: { engine: "codex", model: undefined }, entries: new Map(), resolutions: [] });
});

test("an unbound name is refused naming the name and the source, whatever the map holds", () => {
  assert.throws(
    () => resolveNamedTargets(targets, { target: "nobody" }, declaredModel),
    (error: unknown) =>
      error instanceof NamedTargetRejectedError &&
      error.message === 'Invalid named target: "nobody" is not bound: /home/op/.config/ensemble/config.json binds "doer", "grunt", "reviewer", "local"'
  );
  // A name that spells a prototype property is unbound, not Object's.
  assert.throws(() => resolveNamedTargets(targets, { target: "constructor" }, declaredModel), NamedTargetRejectedError);
  assert.throws(
    () => resolveNamedTargets({ bindings: {}, source: "/empty/config.json" }, { target: "doer" }, declaredModel),
    /"doer" is not bound: \/empty\/config\.json binds no targets/
  );
  assert.throws(() => resolveNamedTargets(null, { target: "doer" }, declaredModel), /"doer" is not bound: this run has no targets map/);
  // A chain entry's unbound name is the same refusal, before anything is paid for.
  assert.throws(() => resolveNamedTargets(targets, { engine: "codex", fallback: [{ target: "nobody" }] }, declaredModel), NamedTargetRejectedError);
});

test("a chain entry bound to opencode is refused as every opencode chain entry is", () => {
  assert.throws(
    () => resolveNamedTargets(targets, { engine: "codex", model: "gpt-6.1-sol", fallback: [{ target: "local" }] }, declaredModel),
    (error: unknown) => error instanceof FallbackTargetRejectedError && /entry 0 names target "local", bound to the opencode engine/.test(error.message)
  );
  // The call's own target may be the opencode binding: it is a one-shot dispatch like any other.
  assert.deepEqual(resolveNamedTargets(targets, { target: "local" }, declaredModel).own, { engine: "opencode", model: "glm-5.2" });
});

test("a target beside a literal engine or model is refused naming the name, the literal and the source, on the call and on a chain entry", () => {
  assert.throws(
    () => resolveNamedTargets(targets, { target: "doer", engine: "codex" }, declaredModel),
    (error: unknown) =>
      error instanceof NamedTargetRejectedError &&
      error.message ===
        'Invalid named target: "doer" is named beside engine "codex": a call names a target or a literal engine and model, never both — the binding in /home/op/.config/ensemble/config.json supplies the engine and model'
  );
  assert.throws(() => resolveNamedTargets(targets, { target: "doer", model: "gpt-6-luna" }, declaredModel), /"doer" is named beside model "gpt-6-luna"/);
  // The shape is judged before the name: an unbound name beside a literal is
  // refused for the shape, and the clause still names the file.
  assert.throws(() => resolveNamedTargets(targets, { target: "nobody", engine: "codex" }, declaredModel), /"nobody" is named beside engine "codex".*config\.json/);
  assert.throws(() => resolveNamedTargets(null, { target: "doer", engine: "codex" }, declaredModel), /never both — and this run has no targets map to bind the name/);
  assert.throws(
    () => resolveNamedTargets(targets, { engine: "codex", fallback: [{ target: "reviewer", engine: "claude" }] as unknown as FallbackTarget[] }, declaredModel),
    (error: unknown) =>
      error instanceof FallbackTargetRejectedError &&
      /entry 0 names target "reviewer" beside a literal engine or model; an entry names one or the other — the binding in \/home\/op\/.config\/ensemble\/config\.json supplies/.test(error.message)
  );
});
