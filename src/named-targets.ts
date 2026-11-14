import { NamedTargetRejectedError } from "./errors.js";
import { handOffFallbackSource } from "./fallback-source.js";

import type { EngineName, FallbackTarget } from "./types.js";

/**
 * Named targets: the machine configuration's `targets` map binds the
 * operator's own names — `doer`, `reviewer`, whatever their routing
 * vocabulary is — to an engine with or without a model, optionally with a
 * fallback chain. A call names one through its own `target` option in place
 * of a literal `engine` and `model`, so one edit to the file moves every
 * workflow on the machine that uses the name, with no script edited.
 * Ensemble ships no names. Resolution is the harness's, before any worker
 * spawns, and the record keeps the name beside what it resolved to.
 */
export interface NamedTargetBinding {
  engine: EngineName;
  /** The model to dispatch, or undefined: the resolved engine's policy decides, as for a call that pins none. */
  model?: string;
  /** The chain a call naming this target takes when neither the call nor the script's `defaults` for the resolved engine declares one. */
  fallback?: FallbackTarget[];
}

export type NamedTargetBindings = Readonly<Record<string, NamedTargetBinding>>;

/** The bindings in force and the file they were read from, which every refusal names. */
export interface NamedTargets {
  bindings: NamedTargetBindings;
  source: string;
}

/**
 * What a call's named target resolved to, as the agent record keeps it:
 * the name asked for, the file whose binding answered, and the binding's
 * engine and model (`null` where the binding names none).
 */
export interface NamedTargetResolution {
  name: string;
  source: string;
  engine: EngineName;
  model: string | null;
}

/**
 * The resolution a resolved options object carries to the runtime that
 * records it. Keyed by object identity and held here alone, so no script
 * can write it — the same discipline as the fallback-source hand-off.
 */
const resolutions = new WeakMap<object, { resolution: NamedTargetResolution; fallback: FallbackTarget[] | undefined }>();

interface DeclaredTarget {
  target?: unknown;
  engine?: unknown;
  model?: unknown;
}

/**
 * Resolve the named target `options` declares, if any. Without one, the
 * options are returned unchanged. With one, a new options object is
 * returned in which the binding's engine (and its model, where it names
 * one) stands in for the name, and `target` is gone; the resolution rides
 * on it by identity for {@link withTargetChain} and
 * {@link namedTargetResolutionOf}.
 *
 * Refused before anything spawns, naming the name and the file: a target
 * written beside a literal `engine` or `model`, and a name the bindings do
 * not hold. The option's type (a non-empty string) is the option
 * validation's to judge.
 */
export function resolveNamedTarget<T extends object>(targets: NamedTargets | null, options: T): T {
  const declared = options as DeclaredTarget;
  // A target that is not a non-empty string is the option validation's to
  // refuse, by its own rule; left unresolved for it.
  if (typeof declared.target !== "string" || declared.target.trim().length === 0) {
    return options;
  }
  const name = declared.target;
  if (declared.engine !== undefined || declared.model !== undefined) {
    const literal = declared.engine !== undefined ? `engine ${JSON.stringify(declared.engine)}` : `model ${JSON.stringify(declared.model)}`;
    throw new NamedTargetRejectedError(
      `target ${JSON.stringify(name)} is named beside ${literal}; a call names a target or a literal engine and model, never both — ${bindingClause(targets)}`
    );
  }
  const binding = bindingFor(targets, name);
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key !== "target") {
      resolved[key] = value;
    }
  }
  resolved.engine = binding.engine;
  if (binding.model !== undefined) {
    resolved.model = binding.model;
  }
  resolutions.set(resolved, {
    resolution: { name, source: (targets as NamedTargets).source, engine: binding.engine, model: binding.model ?? null },
    fallback: binding.fallback
  });
  return resolved as T;
}

/**
 * Settle the chain of a call resolved through a named target, once every
 * earlier source has had its say: where the options declare no chain — not
 * the call, not the script's `defaults` for the resolved engine — the
 * binding's chain applies, attributed to the target. `from` is the object
 * {@link resolveNamedTarget} returned and `to` the options as they now
 * stand (the same object, or a merge built from it); the resolution moves
 * to the returned object. Options that named no target return unchanged.
 */
export function withTargetChain<T extends { fallback?: FallbackTarget[] }>(from: object, to: T): T {
  const carried = resolutions.get(from);
  if (carried === undefined) {
    return to;
  }
  let settled = to;
  if (to.fallback === undefined && carried.fallback !== undefined) {
    settled = handOffFallbackSource(
      { ...to, fallback: carried.fallback.map((entry) => ({ ...entry })) },
      { kind: "target", target: carried.resolution.name }
    );
  }
  resolutions.set(settled, carried);
  return settled;
}

/** The named-target resolution `options` carries, or null where the call named its engine literally. */
export function namedTargetResolutionOf(options: object): NamedTargetResolution | null {
  return resolutions.get(options)?.resolution ?? null;
}

/** Where a name's engine and model come from, for a refusal that names the file. */
function bindingClause(targets: NamedTargets | null): string {
  return targets === null
    ? "and this run has no targets map to bind the name"
    : `the binding in ${targets.source} supplies the engine and model`;
}

function bindingFor(targets: NamedTargets | null, name: string): NamedTargetBinding {
  // `hasOwn`, not a lookup: a name spelling a prototype property
  // (`constructor`) is unbound, not Object's.
  const binding = targets !== null && Object.hasOwn(targets.bindings, name) ? targets.bindings[name] : undefined;
  if (binding !== undefined) {
    return binding;
  }
  const bound = targets === null ? [] : Object.keys(targets.bindings);
  const where =
    targets === null
      ? "this run was given no machine configuration targets"
      : bound.length === 0
        ? `${targets.source} binds no targets`
        : `${targets.source} binds ${bound.map((other) => JSON.stringify(other)).join(", ")}`;
  throw new NamedTargetRejectedError(`target ${JSON.stringify(name)} is not bound: ${where}`);
}
