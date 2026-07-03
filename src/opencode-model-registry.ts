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
    mode: "pay-as-you-go";
  };
}

export interface OpenCodeModelRegistry {
  get(model: string): OpenCodeModelRegistryEntry | undefined;
  names(): string[];
}

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
