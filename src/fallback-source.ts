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
 *
 * Today's dispatch surfaces declare chains at the call and in `defaults`
 * only, so `target`, `map` and `switched-off` are not written yet. They are
 * the kinds the resolution of named targets, the machine map and
 * `fallback: false` records when it decides the chain.
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
 * merge today. Returns `options` for chaining.
 */
export function handOffFallbackSource<T extends object>(options: T, source: FallbackSource): T {
  handedOff.set(options, source);
  return options;
}

/**
 * The source of `validated.fallback`, as the runtime records it at a
 * dispatch's entry. A source handed off on `passed` wins. Without one — a
 * direct library call, which bypasses the hooks — the options are the
 * call's own, so a declared chain came from the call and an undeclared one
 * from nowhere.
 *
 * The two arguments split identity from value. `passed` is the options
 * object exactly as the caller handed it over, consulted only by identity:
 * no property of it is read here, so capture it before any copy or
 * snapshot replaces it (neither carries the hand-off). `validated` is the
 * object the option validation has already passed, and the only one whose
 * `fallback` is read: call this after validation, so an unreadable or
 * malformed chain is refused there as an author error before it can escape
 * from here as anything else. The two may be the same object where nothing
 * replaces the caller's options before validation.
 */
export function fallbackSourceOf(passed: object, validated: { fallback?: FallbackTarget[] }): FallbackSource {
  return handedOff.get(passed) ?? (validated.fallback === undefined ? { kind: "none" } : { kind: "call" });
}

/**
 * Attribute the chain a `defaults` merge produced, under the merge's own
 * precedence: the call's declaration wins, then the `defaults` block for
 * `engine`, then none. `merged` is the options object the merge returned;
 * the source is attached to it and it is returned.
 */
export function attributeMergedChain<T extends { fallback?: FallbackTarget[] }>(
  merged: T,
  callFallback: FallbackTarget[] | undefined,
  engine: EngineName
): T {
  if (callFallback !== undefined) {
    return handOffFallbackSource(merged, { kind: "call" });
  }
  if (merged.fallback !== undefined) {
    return handOffFallbackSource(merged, { kind: "defaults", engine });
  }
  return handOffFallbackSource(merged, { kind: "none" });
}
