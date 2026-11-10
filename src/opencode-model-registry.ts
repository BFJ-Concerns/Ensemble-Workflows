export interface OpenCodeModelRegistryEntry {
  key: string;
  /** The `provider/model` route `opencode run --model` takes. */
  providerModel: string;
  displayName: string;
  /** The route's provider segment: everything before the first `/`. */
  provider: string;
  /** Model family, for choosing a different family to cross-check another. */
  family?: string;
  capabilities: {
    vision: boolean;
  };
  billing?: {
    mode: "pay-as-you-go" | "self-hosted";
  };
  /**
   * The served variants this entry accepts as `effort` — the registry is
   * the domain's owner, exactly as it owns the model list, because
   * `opencode run` forwards an unknown variant to the provider silently
   * (measured 2026-08-30: `--effort definitely-invalid` reached a healthy
   * worker at exit 0). Empty means the served model declares no variants,
   * so any `effort` request fails loud pre-spawn; a curator adds variants
   * from the provider's own listing, never by guess.
   */
  variants: readonly string[];
}

/**
 * Where a registry's models were declared — what a refusal points the
 * operator at when the model a call names is not there. It travels with
 * the registry because every refusal site (script-default validation, the
 * runtime's pre-admission check, the adapter's dispatch) already holds the
 * registry and nothing else: a site that resolved the location for itself
 * would read its own process environment, which is not the run's when a
 * caller hands `runEnsembleCli` a different one.
 *
 * - `machine-config`: the machine configuration's `opencode_models`
 *   section; `file` is the path as resolved for the run, whether or not
 *   it exists.
 * - `caller`: a library caller's own list, or none at all. No file was
 *   read, so there is no file to name.
 */
export type OpenCodeModelSource =
  | { kind: "machine-config"; file: string }
  | { kind: "caller" };

export interface OpenCodeModelRegistry {
  get(model: string): OpenCodeModelRegistryEntry | undefined;
  names(): string[];
  readonly source: OpenCodeModelSource;
}

class StaticOpenCodeModelRegistry implements OpenCodeModelRegistry {
  #models = new Map<string, OpenCodeModelRegistryEntry>();
  #names: string[];
  readonly source: OpenCodeModelSource;

  constructor(models: readonly OpenCodeModelRegistryEntry[], source: OpenCodeModelSource) {
    this.source = source;
    for (const model of models) {
      // Callers that carry provenance know models by the provider id the run
      // record reports, so it resolves as well as the key. Either name
      // resolving to two entries would make lookup order decide the model.
      for (const name of new Set([model.key, model.providerModel])) {
        const claimed = this.#models.get(name);
        if (claimed !== undefined) {
          throw new Error(
            `opencode model name ${JSON.stringify(name)} names both ${JSON.stringify(claimed.key)} and ${JSON.stringify(model.key)}`
          );
        }
        this.#models.set(name, model);
      }
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

/**
 * A registry over the given entries — the machine configuration's
 * `opencode_models` section, resolved by `resolveAmbientSettings`, or a
 * library caller's own list. Lookup accepts an entry's key or its
 * `providerModel`; a name that would resolve to two entries throws.
 * `source` defaults to `caller`: only a caller holding the resolved
 * machine configuration path can say the models came from that file.
 */
export function createOpenCodeModelRegistry(
  models: readonly OpenCodeModelRegistryEntry[],
  source: OpenCodeModelSource = { kind: "caller" }
): OpenCodeModelRegistry {
  return new StaticOpenCodeModelRegistry(models, source);
}

/**
 * The registry an adapter dispatches against when none is configured. It is
 * empty: the harness ships no model catalogue, so every opencode model is
 * one the operator declared. Its source is `caller`: an adapter built
 * without a registry was handed no models and read no file.
 */
export const defaultOpenCodeModelRegistry: OpenCodeModelRegistry = createOpenCodeModelRegistry([]);
