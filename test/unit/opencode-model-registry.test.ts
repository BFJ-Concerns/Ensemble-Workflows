import assert from "node:assert/strict";
import test from "node:test";

import { createOpenCodeModelRegistry, defaultOpenCodeModelRegistry } from "../../src/opencode-model-registry.js";
import { testOpenCodeModels } from "../fixtures/opencode/models.js";

import type { OpenCodeModelRegistryEntry } from "../../src/opencode-model-registry.js";

test("the default registry ships no models", () => {
  assert.deepEqual(defaultOpenCodeModelRegistry.names(), []);
  assert.equal(defaultOpenCodeModelRegistry.get("glm-5.2"), undefined);
});

test("registry resolves entries by key", () => {
  const registry = createOpenCodeModelRegistry(testOpenCodeModels);
  for (const entry of testOpenCodeModels) {
    assert.equal(registry.get(entry.key), entry);
  }
});

test("registry resolves entries by provider model id", () => {
  // Provenance-carrying callers know models by the provider id the run
  // record reports; both forms must resolve to one entry.
  const registry = createOpenCodeModelRegistry(testOpenCodeModels);
  assert.equal(registry.get("openrouter/z-ai/glm-5.2"), registry.get("glm-5.2"));
});

test("registry names list only keys, in declaration order", () => {
  assert.deepEqual(createOpenCodeModelRegistry(testOpenCodeModels).names(), ["glm-5.2", "local-model"]);
});

test("registry refuses a name that would resolve to two entries", () => {
  const entry = (key: string, providerModel: string): OpenCodeModelRegistryEntry => ({
    key,
    providerModel,
    displayName: key,
    provider: providerModel.slice(0, providerModel.indexOf("/")),
    capabilities: { vision: false },
    variants: []
  });

  assert.throws(
    () => createOpenCodeModelRegistry([entry("first", "prov/shared"), entry("second", "prov/shared")]),
    /"prov\/shared" names both "first" and "second"/
  );
  assert.throws(
    () => createOpenCodeModelRegistry([entry("first", "prov/first"), entry("prov/first", "prov/other")]),
    /"prov\/first" names both "first" and "prov\/first"/
  );
  // An entry whose key is its own provider id claims one name, not two.
  assert.deepEqual(createOpenCodeModelRegistry([entry("prov/model", "prov/model")]).names(), ["prov/model"]);
});
