import type { EngineName, FallbackTarget } from "./types.js";

/**
 * Where an agent record's fallback chain came from. One value per record,
 * written as the record's `fallback_source`; every key is a single word, so
 * the in-memory shape and the archived shape are the same object.
 *
 * - `call` — the call's own `fallback` option.
 * - `defaults` — the script's `defaults` block for `engine`, the engine
 *   actually dispatched.
 * - `target` — the binding of the named target `target`.
 * - `map` — the machine `fallback` map entry under `key` (`engine:model` or
 *   `engine`).
 * - `switched-off` — `fallback: false` at the call or in the `defaults` block
 *   for `engine`, which ends the search with no chain.
 * - `none` — the search found no chain anywhere it looked.
 * - `later-turn` — a held session's second or later turn: the session's chain
 *   applied to its creating turn alone, so none applies here. The creating
 *   turn's record (same `session.id`, `turn` 1) carries the chain and its
 *   source.
 *
 * `none`, `switched-off` and `later-turn` all pair with a null `fallback` and
 * stay distinct, so a reader never mistakes an author's explicit opt-out for
 * an absent declaration or for a chain that no longer applies.
 */
export type FallbackSource =
  | { kind: "call" }
  | { kind: "defaults"; engine: EngineName }
  | { kind: "target"; target: string }
  | { kind: "map"; key: string }
  | { kind: "switched-off"; by: "call" }
  | { kind: "switched-off"; by: "defaults"; engine: EngineName }
  | { kind: "none" }
  | { kind: "later-turn" };

export type FallbackMap = Readonly<Record<string, FallbackTarget[]>>;

export interface MachineFallback {
  chains: FallbackMap;
  source: string;
}

export interface SelectedFallback {
  chain: FallbackTarget[] | undefined;
  source: FallbackSource;
}

/**
 * Finish selection after validation and after defaults and target policy.
 * `passed` carries the hand-off by identity and `options` carries the
 * validated values. A placement snapshot can make these separate objects.
 */
export function selectFallback(
  passed: object,
  options: { fallback?: FallbackTarget[] | false; model?: string; engine?: EngineName },
  map: FallbackMap | undefined
): SelectedFallback {
  const { fallback, engine, model } = options;
  if (fallback === false) {
    return { chain: undefined, source: handedOff.get(passed) ?? { kind: "switched-off", by: "call" } };
  }
  if (fallback !== undefined) {
    return { chain: fallback, source: handedOff.get(passed) ?? { kind: "call" } };
  }
  if (map !== undefined && engine !== undefined) {
    const modelKey = model === undefined ? undefined : `${engine}:${model}`;
    const key = modelKey !== undefined && Object.hasOwn(map, modelKey) ? modelKey : engine;
    if (Object.hasOwn(map, key)) {
      return { chain: map[key], source: { kind: "map", key } };
    }
  }
  return { chain: undefined, source: { kind: "none" } };
}

/**
 * The provenance one options object carries from the layer that decided its
 * chain to the runtime that records it. Keyed by object identity and held
 * here alone, so no script can write it: a script reaches the runtime only
 * with plain options, which carry no provenance and are judged by the
 * unknown-option validation like any other.
 */
const handedOff = new WeakMap<object, FallbackSource>();

/**
 * Attach the source of `options.fallback` to this options object, for the
 * runtime to read when it builds the record. For a layer that resolves the
 * chain from somewhere other than the call itself — the hooks' `defaults`
 * merge, and a named target's binding. Returns `options` for chaining.
 */
export function handOffFallbackSource<T extends object>(options: T, source: FallbackSource): T {
  handedOff.set(options, source);
  return options;
}

/**
 * Apply the call's explicit fallback to the defaults merge, including
 * values supplied outside the call's enumerable keys, and record its source.
 */
export function attributeMergedChain<T extends { fallback?: FallbackTarget[] | false }>(
  merged: T,
  callFallback: FallbackTarget[] | false | undefined,
  engine: EngineName
): T {
  if (callFallback !== undefined) {
    merged.fallback = callFallback;
    return handOffFallbackSource(merged, callFallback === false ? { kind: "switched-off", by: "call" } : { kind: "call" });
  }
  if (merged.fallback !== undefined) {
    return handOffFallbackSource(merged, merged.fallback === false
      ? { kind: "switched-off", by: "defaults", engine }
      : { kind: "defaults", engine });
  }
  return merged;
}
