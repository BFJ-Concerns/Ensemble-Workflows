import { isConfiguredEngine } from "./ambient-settings.js";
import type { SelectedFallback } from "./fallback-source.js";
import type { EngineName } from "./types.js";

interface Target {
  engine: EngineName;
  model?: string | undefined;
}

type Key =
  | { kind: "label" | "phase"; glob: string[] }
  | ({ kind: "pair" | "engine" } & Target);

interface Rule {
  source: string;
  name: string;
  key: Key;
  target: Target;
}

export interface DispatchRemapEvidence {
  key: string;
  requested: { engine: EngineName; model: string | null };
}

export interface RemapMatch {
  target: Target;
  evidence: DispatchRemapEvidence;
  matched: readonly Rule[];
}

const ranks = { label: 0, phase: 1, pair: 2, engine: 3 };

function parseTarget(text: string): Target | undefined {
  const colon = text.indexOf(":");
  const engine = colon === -1 ? text : text.slice(0, colon);
  if (!isConfiguredEngine(engine)) return undefined;
  if (colon === -1) return { engine };
  const model = text.slice(colon + 1);
  return model.trim().length === 0 ? undefined : { engine, model };
}

function parseKey(text: string): Key | undefined {
  for (const kind of ["label", "phase"] as const) {
    const prefix = kind + ":";
    if (text.startsWith(prefix)) {
      const glob = text.slice(prefix.length);
      if (glob.length === 0) return undefined;
      return { kind, glob: Array.from(glob) };
    }
  }
  const target = parseTarget(text);
  if (target !== undefined) return { kind: target.model === undefined ? "engine" : "pair", ...target };
}

/** Match the whole value, letting the last star absorb more characters on a mismatch. */
function globMatches(glob: readonly string[], text: string): boolean {
  const value = Array.from(text);
  let pattern = 0;
  let char = 0;
  let star = -1;
  let consumedByStar = 0;
  while (char < value.length) {
    const token = glob[pattern];
    if (token === "*") {
      star = pattern++;
      consumedByStar = char;
    } else if (token === "?" || token === value[char]) {
      pattern++;
      char++;
    } else if (star !== -1) {
      pattern = star + 1;
      char = ++consumedByStar;
    } else {
      return false;
    }
  }
  while (glob[pattern] === "*") pattern++;
  return pattern === glob.length;
}

function parseRule(source: string): Rule {
  const equals = source.indexOf("=");
  if (equals !== -1) {
    const name = source.slice(0, equals).trim();
    const key = parseKey(name);
    const target = parseTarget(source.slice(equals + 1).trim());
    if (key !== undefined && target !== undefined) return { source, name, key, target };
  }
  throw new Error(
    `Invalid dispatch remap rule ${JSON.stringify(source)}. Use <key>=<engine>[:<model>] with a label:<glob>, phase:<glob>, engine:model or engine key.`
  );
}

/** Launch rules and the matches observed during one run. */
export class DispatchRemap {
  readonly #rules: readonly Rule[];
  readonly #matched = new Set<Rule>();

  constructor(sources: readonly string[]) {
    this.#rules = sources.map(parseRule);
  }

  /** Resolve a route without marking it as dispatched. */
  resolve(request: Target, label: string | null, phase: string | null, defaultModel: (engine: EngineName) => string | undefined): RemapMatch | undefined {
    let winner: Rule | undefined;
    const matched: Rule[] = [];
    for (const rule of this.#rules) {
      const key = rule.key;
      switch (key.kind) {
        case "label":
          if (label === null || !globMatches(key.glob, label)) continue;
          break;
        case "phase":
          if (phase === null || !globMatches(key.glob, phase)) continue;
          break;
        case "pair":
          if (key.engine !== request.engine || key.model !== request.model) continue;
          break;
        case "engine":
          if (key.engine !== request.engine) continue;
      }
      matched.push(rule);
      if (winner === undefined || ranks[key.kind] < ranks[winner.key.kind]) winner = rule;
    }
    if (winner === undefined) return undefined;
    return {
      target: { engine: winner.target.engine, model: winner.target.model ?? defaultModel(winner.target.engine) },
      evidence: { key: winner.name, requested: { engine: request.engine, model: request.model ?? null } },
      matched
    };
  }

  noteDispatch(match: RemapMatch): void {
    for (const rule of match.matched) this.#matched.add(rule);
  }

  unmatched(): string[] {
    return this.#rules.filter((rule) => !this.#matched.has(rule)).map((rule) => rule.source);
  }
}

const fallbackDefaults = new WeakMap<object, (engine: EngineName) => SelectedFallback>();

export function withRemapFallback<T extends object>(options: T, select: (engine: EngineName) => SelectedFallback): T {
  fallbackDefaults.set(options, select);
  return options;
}

export function remapFallbackFor(options: object, engine: EngineName): SelectedFallback | undefined {
  return fallbackDefaults.get(options)?.(engine);
}
