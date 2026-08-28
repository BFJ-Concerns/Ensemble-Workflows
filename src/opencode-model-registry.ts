export interface OpenCodeModelRegistryEntry {
  key: string;
  providerModel: string;
  displayName: string;
  provider: string;
  family: string;
  capabilities: {
    vision: boolean;
  };
  billing: {
    mode: "pay-as-you-go" | "self-hosted";
  };
}

export interface OpenCodeModelRegistry {
  get(model: string): OpenCodeModelRegistryEntry | undefined;
  names(): string[];
}

// Every self-hosted (`local`) entry must name a model the self-hosted
// router actually serves: `providerModel` is `local/` plus a
// verbatim id from the router's `GET /v1/models` (source of truth: the
// router's own configuration). The router swaps models
// in and out over time, so re-survey before editing. Curate the standard
// serving entries only — the router also exposes per-experiment variants
// (`-Parallel8`, `-1GPU*`, quant-suffixed `*-GGUF` duplicates) that are not
// stable routes. `capabilities.vision` mirrors whether the served entry's
// modalities include image input.
const MODELS: readonly OpenCodeModelRegistryEntry[] = [
  {
    key: "glm-5.2",
    providerModel: "openrouter/z-ai/glm-5.2",
    displayName: "GLM 5.2",
    provider: "openrouter",
    family: "glm",
    capabilities: {
      vision: false
    },
    billing: {
      mode: "pay-as-you-go"
    }
  },
  {
    key: "qwen-3-8-27b",
    providerModel: "local/Qwen3.8-27B",
    displayName: "Qwen 3.8 27B",
    provider: "local",
    family: "qwen",
    capabilities: {
      vision: false
    },
    billing: {
      mode: "self-hosted"
    }
  },
  {
    key: "qwen-3-8-27b-heretic-ara",
    providerModel: "local/Qwen3.8-27B-heretic-ara",
    displayName: "Qwen 3.8 27B heretic-ara",
    provider: "local",
    family: "qwen",
    capabilities: {
      vision: true
    },
    billing: {
      mode: "self-hosted"
    }
  },
  {
    key: "muse-glimmer-30b",
    providerModel: "local/Muse-Glimmer-30B",
    displayName: "Muse Glimmer 30B",
    provider: "local",
    family: "muse-glimmer",
    capabilities: {
      vision: true
    },
    billing: {
      mode: "self-hosted"
    }
  }
];

class StaticOpenCodeModelRegistry implements OpenCodeModelRegistry {
  #models = new Map<string, OpenCodeModelRegistryEntry>();
  #names: string[];

  constructor(models: readonly OpenCodeModelRegistryEntry[]) {
    for (const model of models) {
      this.#models.set(model.key, model);
      // Callers that carry provenance know models
      // by the provider id the run record reports, so accept it as a key too.
      this.#models.set(model.providerModel, model);
    }
    this.#names = models.map((model) => model.key);
  }

  get(model: string): OpenCodeModelRegistryEntry | undefined {
    return this.#models.get(model);
  }

  names(): string[] {
    return [...this.#names];
  }
}

export const defaultOpenCodeModelRegistry: OpenCodeModelRegistry = new StaticOpenCodeModelRegistry(MODELS);
