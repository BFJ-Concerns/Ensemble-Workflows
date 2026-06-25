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

  constructor(models: readonly OpenCodeModelRegistryEntry[]) {
    for (const model of models) {
      this.#models.set(model.key, model);
    }
  }

  get(model: string): OpenCodeModelRegistryEntry | undefined {
    return this.#models.get(model);
  }

  names(): string[] {
    return [...this.#models.keys()];
  }
}

export const defaultOpenCodeModelRegistry: OpenCodeModelRegistry = new StaticOpenCodeModelRegistry(MODELS);
