import { assertValidFallbackEffort } from "./engine-option-validation.js";
import { NamedTargetRejectedError } from "./errors.js";
import { handOffFallbackSource } from "./fallback-source.js";
import { withOptionOverrides } from "./option-overrides.js";

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
 * options are returned unchanged. With one, a view over them is returned in
 * which the binding's engine (and its model, where it names one) stands in
 * for the name, and `target` reads as unset; the resolution rides on it by
 * identity for {@link withTargetChain} and
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
  // A view, not a copy, so options an accessor, prototype or Proxy trap
  // supplies survive resolution; `target` reads as unset from here on.
  const resolved = withOptionOverrides(options, {
    target: undefined,
    engine: binding.engine,
    ...(binding.model !== undefined ? { model: binding.model } : {})
  });
  resolutions.set(resolved, {
    resolution: { name, source: (targets as NamedTargets).source, engine: binding.engine, model: binding.model ?? null },
    fallback: binding.fallback
  });
  return resolved;
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
export function withTargetChain<T extends { fallback?: FallbackTarget[] | false }>(from: object, to: T): T {
  const carried = resolutions.get(from);
  if (carried === undefined) {
    return to;
  }
  let settled = to;
  if (to.fallback === undefined && carried.fallback !== undefined) {
    settled = handOffFallbackSource(
      withOptionOverrides(to, { fallback: carried.fallback.map((entry) => ({ ...entry })) }),
      { kind: "target", target: carried.resolution.name }
    );
  }
  resolutions.set(settled, carried);
  return settled;
}

/**
 * A fallback-chain entry settled for dispatch: a literal entry as declared,
 * or a named one as its binding resolves it. `namedTarget` is the name the
 * entry was declared through, or null for a literal entry.
 */
export interface SettledChainEntry {
  engine: EngineName;
  /** Undefined only for a named entry whose binding, and the script's `defaults` for its engine, name no model: the engine's own default. */
  model: string | undefined;
  effort: string | undefined;
  namedTarget: string | null;
}

/** The script's `defaults` model per engine, handed from the hooks to the runtime by identity, for named chain entries. */
const declaredModels = new WeakMap<object, (engine: EngineName) => string | undefined>();

/**
 * Attach the script's per-engine `defaults` model lookup to `options`, so a
 * named chain entry whose binding names no model takes the model the
 * script declares for that engine, as a call naming that engine would.
 * Returns `options`.
 */
export function withDeclaredModels<T extends object>(options: T, lookup: (engine: EngineName) => string | undefined): T {
  declaredModels.set(options, lookup);
  return options;
}

export function declaredModelFor(options: object, engine: EngineName): string | undefined {
  return declaredModels.get(options)?.(engine);
}

/**
 * Settle a call's chain for dispatch. A named entry takes its binding's
 * engine and model — never the binding's own chain, since chains do not
 * nest — the model falling back to the script's `defaults` model for that
 * engine (as handed off on `passed`), else the engine's own default.
 *
 * Refused before anything spawns: a named entry beside a literal engine or
 * model, or naming a name the bindings do not hold (both naming the file).
 */
export function settleChain(targets: NamedTargets | null, chain: readonly FallbackTarget[] | undefined, passed: object): SettledChainEntry[] {
  return (chain ?? []).map((entry, index) => {
    if (entry.target === undefined) {
      return { engine: entry.engine, model: entry.model, effort: entry.effort, namedTarget: null };
    }
    // The union types forbid the pair; a script's object literal does not.
    const written = entry as { target: string; engine?: unknown; model?: unknown };
    if (written.engine !== undefined || written.model !== undefined) {
      const literal = written.engine !== undefined ? `engine ${JSON.stringify(written.engine)}` : `model ${JSON.stringify(written.model)}`;
      throw new NamedTargetRejectedError(
        `fallback entry ${index} names target ${JSON.stringify(entry.target)} beside ${literal}; an entry names a target or a literal engine and model, never both — ${bindingClause(targets)}`
      );
    }
    const binding = bindingFor(targets, entry.target, `fallback entry ${index}: `);
    assertValidFallbackEffort(entry.effort, binding.engine, index);
    return {
      engine: binding.engine,
      model: binding.model ?? declaredModelFor(passed, binding.engine),
      effort: entry.effort,
      namedTarget: entry.target
    };
  });
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

/** Whether `name` is bound, where a call naming it would resolve rather than be refused. */
export function isNamedTargetBound(targets: NamedTargets | null, name: string): boolean {
  // `hasOwn`, not a lookup: a name spelling a prototype property
  // (`constructor`) is unbound, not Object's.
  return targets !== null && Object.hasOwn(targets.bindings, name);
}

/** The binding for `name`; refused naming the file when unbound. `context` prefixes the refusal (a chain entry's index). */
function bindingFor(targets: NamedTargets | null, name: string, context = ""): NamedTargetBinding {
  const binding = isNamedTargetBound(targets, name) ? (targets as NamedTargets).bindings[name] : undefined;
  if (binding !== undefined) {
    return binding;
  }
  const bound = targets === null ? [] : Object.keys(targets.bindings);
  const held =
    targets === null
      ? "this run was given no machine configuration targets"
      : bound.length === 0
        ? `${targets.source} binds no targets`
        : `${targets.source} binds ${bound.map((other) => JSON.stringify(other)).join(", ")}`;
  throw new NamedTargetRejectedError(`${context}target ${JSON.stringify(name)} is not bound: ${held}`);
}
