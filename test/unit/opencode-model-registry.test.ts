import assert from "node:assert/strict";
import test from "node:test";

import { defaultOpenCodeModelRegistry } from "../../src/opencode-model-registry.js";

test("registry resolves entries by curated key", () => {
  const entry = defaultOpenCodeModelRegistry.get("glm-5.2");
  assert.equal(entry?.providerModel, "openrouter/z-ai/glm-5.2");
});

test("registry resolves entries by provider model id", () => {
  // Provenance-carrying callers know models by the
  // provider id the run record reports; both forms must resolve to one entry.
  const byKey = defaultOpenCodeModelRegistry.get("glm-5.2");
  const byProviderModel = defaultOpenCodeModelRegistry.get("openrouter/z-ai/glm-5.2");
  assert.equal(byProviderModel, byKey);
});

test("registry names list only curated keys", () => {
  assert.deepEqual(defaultOpenCodeModelRegistry.names(), ["glm-5.2"]);
});
