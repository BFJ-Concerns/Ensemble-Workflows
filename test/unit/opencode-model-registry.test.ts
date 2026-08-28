import assert from "node:assert/strict";
import test from "node:test";

import { defaultOpenCodeModelRegistry } from "../../src/opencode-model-registry.js";

test("registry resolves entries by curated key", () => {
  const expected = [
    ["glm-5.2", "openrouter/z-ai/glm-5.2", "glm", false, "pay-as-you-go"],
    ["qwen-3-8-27b", "local/Qwen3.8-27B", "qwen", false, "self-hosted"],
    ["qwen-3-8-27b-heretic-ara", "local/Qwen3.8-27B-heretic-ara", "qwen", true, "self-hosted"],
    ["muse-glimmer-30b", "local/Muse-Glimmer-30B", "muse-glimmer", true, "self-hosted"]
  ] as const;

  for (const [key, providerModel, family, vision, billingMode] of expected) {
    const entry = defaultOpenCodeModelRegistry.get(key);
    assert.equal(entry?.providerModel, providerModel);
    assert.equal(entry?.family, family);
    assert.equal(entry?.capabilities.vision, vision);
    assert.equal(entry?.billing.mode, billingMode);
  }
});

test("registry resolves entries by provider model id", () => {
  // Provenance-carrying callers know models by the
  // provider id the run record reports; both forms must resolve to one entry.
  const byKey = defaultOpenCodeModelRegistry.get("glm-5.2");
  const byProviderModel = defaultOpenCodeModelRegistry.get("openrouter/z-ai/glm-5.2");
  assert.equal(byProviderModel, byKey);
});

test("registry names list only curated keys", () => {
  assert.deepEqual(defaultOpenCodeModelRegistry.names(), [
    "glm-5.2",
    "qwen-3-8-27b",
    "qwen-3-8-27b-heretic-ara",
    "muse-glimmer-30b"
  ]);
});
