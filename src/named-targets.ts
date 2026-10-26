import { FallbackTargetRejectedError, NamedTargetRejectedError } from "./errors.js";

import type { EngineName, FallbackTarget } from "./types.js";

/**
 * Named targets: the machine configuration's `targets` map binds the
 * operator's own names — `doer`, `reviewer`, whatever their routing
 * vocabulary is — to an engine with or without a model, and a script names
 * the target where it would have named an engine and model: in `agent()`
 * and `session()`, and in a fallback-chain entry.
 * One edit to the file moves every workflow on the machine that uses the
 * name; when a family misbehaves, rebinding the names that point at it
 * moves every role off it with no script edited. Ensemble ships no names,
 * so a script meant to run where the bindings cannot be assumed keeps
 * literal engines and models. Resolution is the harness's, before any
 * worker spawns, and the record keeps the name beside what it resolved to.
 */
export interface NamedTargetBinding {
  engine: EngineName;
  /** The model to dispatch, or undefined: the engine's declared `defaults` model, else its own default — as an unpinned call runs. */
  model?: string;
}

export type NamedTargetBindings = Readonly<Record<string, NamedTargetBinding>>;

/** The bindings in force and where they were read from — the file every refusal names. */
export interface NamedTargets {
  bindings: NamedTargetBindings;
  source: string;
}

/**
 * One name resolved: which target of the call (`-1` the call's own, else
 * the fallback-chain index), the name, and the engine and model it resolved
 * to — the model after the resolved engine's declared default, null where
 * the engine's own default decides.
 */
export interface NamedTargetEvidence {
  name: string;
  entry: number;
  resolved: { engine: EngineName; model: string | null };
}

/** A settled engine-and-model pair: what a dispatch is made on (undefined model: the engine's own default). */
export interface SettledTarget {
  engine: EngineName;
  model: string | undefined;
}

/** The dispatch targets a call declares: its own, and its chain. */
export interface DeclaredDispatch {
  engine?: EngineName | undefined;
  model?: string | undefined;
  target?: string | undefined;
  fallback?: FallbackTarget[] | undefined;
}

/** A call's targets after resolution. */
export interface ResolvedDispatch {
  /** The call's own engine and model: the binding's where the call named a target, else the literal ones as declared. */
  own: { engine: EngineName | undefined; model: string | undefined };
  /** Every chain entry's settled pair, by index — literal entries as declared, named ones as bound. */
  entries: Map<number, SettledTarget>;
  /** The names resolved — the call's own first, then each entry in chain order; empty when the call named none. */
  resolutions: NamedTargetEvidence[];
}

/**
 * Resolve a call's named targets against the bindings in force. The call's
 * own target and each chain entry naming one take the binding's engine and
 * the binding's model, else `declaredModel(engine)` — the resolved engine's
 * script default — else undefined, the engine's own default, exactly as an
 * unpinned call on that engine runs. A target beside a literal engine or
 * model — on the call or on a chain entry — is refused naming the name, the
 * literal and the source whose binding would have supplied them; an unbound
 * name is refused naming the name and the source; a chain entry bound to
 * opencode is refused as every opencode chain entry is. Literal targets pass
 * through as declared.
 */
export function resolveNamedTargets(
  targets: NamedTargets | null,
  declared: DeclaredDispatch,
  declaredModel: (engine: EngineName) => string | undefined
): ResolvedDispatch {
  const resolutions: NamedTargetEvidence[] = [];
  const resolve = (name: string, entry: number): SettledTarget => {
    const binding = bindingFor(targets, name);
    const model = binding.model ?? declaredModel(binding.engine);
    resolutions.push({ name, entry, resolved: { engine: binding.engine, model: model ?? null } });
    return { engine: binding.engine, model };
  };
  if (declared.target !== undefined && (declared.engine !== undefined || declared.model !== undefined)) {
    const literal = declared.engine !== undefined ? `engine ${JSON.stringify(declared.engine)}` : `model ${JSON.stringify(declared.model)}`;
    throw new NamedTargetRejectedError(
      `${JSON.stringify(declared.target)} is named beside ${literal}: a call names a target or a literal engine and model, never both — ${bindingClause(targets)}`
    );
  }
  const own = declared.target === undefined ? { engine: declared.engine, model: declared.model } : resolve(declared.target, -1);
  const entries = new Map<number, SettledTarget>();
  (declared.fallback ?? []).forEach((entry, index) => {
    if (entry.target === undefined) {
      entries.set(index, { engine: entry.engine, model: entry.model });
      return;
    }
    // The union types forbid the pair; a script's object literal does not.
    const written = entry as { target: string; engine?: unknown; model?: unknown };
    if (written.engine !== undefined || written.model !== undefined) {
      throw new FallbackTargetRejectedError(
        `entry ${index} names target ${JSON.stringify(written.target)} beside a literal engine or model; an entry names one or the other — ${bindingClause(targets)}`
      );
    }
    const settled = resolve(entry.target, index);
    if (settled.engine === "opencode") {
      throw new FallbackTargetRejectedError(
        `entry ${index} names target ${JSON.stringify(entry.target)}, bound to the opencode engine, which is held at its one-shot surface and takes no chain entries`
      );
    }
    entries.set(index, settled);
  });
  return { own, entries, resolutions };
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
      ? 'this run has no targets map (the machine configuration\'s "targets" section binds names to an engine and model)'
      : bound.length === 0
        ? `${targets.source} binds no targets`
        : `${targets.source} binds ${bound.map((other) => JSON.stringify(other)).join(", ")}`;
  throw new NamedTargetRejectedError(`${JSON.stringify(name)} is not bound: ${where}`);
}
