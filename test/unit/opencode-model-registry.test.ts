import assert from "node:assert/strict";
import test from "node:test";

import { defaultOpenCodeModelRegistry } from "../../src/opencode-model-registry.js";

test("registry resolves entries by curated key", () => {
  const expected = [
    ["glm-5.2", "openrouter/z-ai/glm-5.2", "glm", false, "pay-as-you-go"],
    ["gemma-4-31b-qat-standard", "local/Gemma-4-31B-QAT-Standard", "gemma", true, "self-hosted"],
    ["gemma-4-31b-qat-heretic", "local/Gemma-4-31B-QAT-Heretic", "gemma", true, "self-hosted"],
    ["qwen-3-6-27b-standard", "local/Qwen3.6-27B-Standard", "qwen", true, "self-hosted"],
    ["qwen-3-6-27b-heretic-neo-code", "local/Qwen3.6-27B-Heretic-NEO-CODE", "qwen", true, "self-hosted"]
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
    "gemma-4-31b-qat-standard",
    "gemma-4-31b-qat-heretic",
    "qwen-3-6-27b-standard",
    "qwen-3-6-27b-heretic-neo-code"
  ]);
});
