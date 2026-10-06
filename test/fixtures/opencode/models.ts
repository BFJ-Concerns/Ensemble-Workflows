import { createOpenCodeModelRegistry } from "../../../src/opencode-model-registry.js";

import type { OpenCodeModelRegistryEntry } from "../../../src/opencode-model-registry.js";

/**
 * A declared catalogue standing in for a machine's `opencode_models`: one
 * hosted route and one self-hosted route, neither declaring served variants.
 */
export const testOpenCodeModels: readonly OpenCodeModelRegistryEntry[] = [
  {
    key: "glm-5.2",
    providerModel: "openrouter/z-ai/glm-5.2",
    displayName: "GLM 5.2",
    provider: "openrouter",
    family: "glm",
    capabilities: { vision: false },
    billing: { mode: "pay-as-you-go" },
    variants: []
  },
  {
    key: "local-model",
    providerModel: "local/Served-Model",
    displayName: "Served Model",
    provider: "local",
    family: "local",
    capabilities: { vision: true },
    billing: { mode: "self-hosted" },
    variants: []
  }
];

export const testOpenCodeModelRegistry = createOpenCodeModelRegistry(testOpenCodeModels);
