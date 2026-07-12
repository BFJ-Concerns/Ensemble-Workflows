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
    key: "gemma-4-31b-qat-standard",
    providerModel: "local/Gemma-4-31B-QAT-Standard",
    displayName: "Gemma 4 31B QAT Standard",
    provider: "local",
    family: "gemma",
    capabilities: {
      vision: true
    },
    billing: {
      mode: "self-hosted"
    }
  },
  {
    key: "gemma-4-31b-qat-heretic",
    providerModel: "local/Gemma-4-31B-QAT-Heretic",
    displayName: "Gemma 4 31B QAT Heretic",
    provider: "local",
    family: "gemma",
    capabilities: {
      vision: true
    },
    billing: {
      mode: "self-hosted"
    }
  },
  {
    key: "qwen-3-6-27b-standard",
    providerModel: "local/Qwen3.6-27B-Standard",
    displayName: "Qwen 3.6 27B Standard",
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
    key: "qwen-3-6-27b-heretic-neo-code",
    providerModel: "local/Qwen3.6-27B-Heretic-NEO-CODE",
    displayName: "Qwen 3.6 27B Heretic NEO-CODE",
    provider: "local",
    family: "qwen",
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
