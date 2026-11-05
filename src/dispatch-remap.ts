import { DispatchRemapRejectedError } from "./errors.js";
import type { EngineName } from "./types.js";

/**
 * The launch-time dispatch remap: an operator re-routes an unedited script's
 * workers by rules the launcher takes from `--remap` or
 * `ENSEMBLE_DISPATCH_REMAP` — never the configuration file, since a standing
 * remap would silently make every cross-family workflow on a machine
 * single-family.
 *
 * A rule is `<key>=<target>`. The key names what to move: a label glob
 * (`label:propose:*`), a phase glob (`phase:critique`), an `engine:model`
 * pair (`claude:opus`), or an engine (`claude`). The target names where to:
 * an engine with or without a model (`codex:gpt-6-astra`, `codex`). Globs
 * take `*` and `?` anywhere; a script's labels and phases are its stable
 * roles, so they are the primary form, and a glob's matched set is readable
 * off the script before launch. Every dispatch the runtime makes — a call's
 * own target, each fallback-chain entry, a session's creation — resolves
 * through {@link DispatchRemapLedger.resolve}, so a chain cannot carry a
 * call back onto an engine the operator moved it off.
 */
export type DispatchRemapKey =
  | { kind: "label"; glob: string }
  | { kind: "phase"; glob: string }
  | { kind: "model"; engine: EngineName; model: string }
  | { kind: "engine"; engine: EngineName };

export interface DispatchRemapTarget {
  engine: EngineName;
  /** The model to dispatch, or undefined: the target engine's script default, else its own default. */
  model?: string;
}

export interface DispatchRemapRule {
  key: DispatchRemapKey;
  target: DispatchRemapTarget;
  /** The rule exactly as the operator wrote it — the key the record and the notices name. */
  source: string;
}

/** The dispatch a rule is matched against: the engine and model the script asked for, and the call's roles. */
export interface DispatchRequest {
  engine: EngineName;
  model: string | undefined;
  label: string | null;
  phase: string | null;
}

/** Where a request moved, and the rule that moved it. */
export interface DispatchRemapMove {
  rule: DispatchRemapRule;
  engine: EngineName;
  /** The model the target names, or undefined where the target engine's defaults decide. */
  model: string | undefined;
}

const ENGINE_NAMES: ReadonlySet<string> = new Set<EngineName>(["codex", "claude", "opencode"]);

/** Specificity order: a label key beats a phase key beats a model key beats an engine key; within a kind, declaration order. */
const KEY_RANK: Record<DispatchRemapKey["kind"], number> = { label: 0, phase: 1, model: 2, engine: 3 };

function isEngineName(value: string): value is EngineName {
  return ENGINE_NAMES.has(value);
}

function rejected(rule: string, detail: string): DispatchRemapRejectedError {
  return new DispatchRemapRejectedError(
    `dispatch remap rule ${JSON.stringify(rule)} is invalid: ${detail}. ` +
      "A rule is <key>=<engine>[:<model>], where the key is label:<glob>, phase:<glob>, <engine>:<model>, or <engine>."
  );
}

/**
 * Parse one rule as the operator wrote it. The split at the first `=` keeps
 * `=` out of keys and targets alike; a glob may hold any other character,
 * since labels and phases are free text.
 */
export function parseDispatchRemapRule(rule: string): DispatchRemapRule {
  const equals = rule.indexOf("=");
  if (equals === -1) {
    throw rejected(rule, "no `=` separates the key from the target");
  }
  const keyText = rule.slice(0, equals).trim();
  const targetText = rule.slice(equals + 1).trim();
  if (keyText.length === 0) {
    throw rejected(rule, "the key is empty");
  }
  if (targetText.length === 0) {
    throw rejected(rule, "the target is empty");
  }
  return { key: parseKey(rule, keyText), target: parseTarget(rule, targetText), source: rule.trim() };
}

function parseKey(rule: string, keyText: string): DispatchRemapKey {
  const colon = keyText.indexOf(":");
  if (colon === -1) {
    if (!isEngineName(keyText)) {
      throw rejected(rule, `${JSON.stringify(keyText)} is neither an engine nor a label:, phase:, or engine:model key`);
    }
    return { kind: "engine", engine: keyText };
  }
  const head = keyText.slice(0, colon);
  const rest = keyText.slice(colon + 1);
  if (head === "label" || head === "phase") {
    if (rest.length === 0) {
      throw rejected(rule, `the ${head} glob is empty`);
    }
    return { kind: head, glob: rest };
  }
  if (isEngineName(head)) {
    if (rest.length === 0) {
      throw rejected(rule, `the model after ${JSON.stringify(head)}: is empty`);
    }
    return { kind: "model", engine: head, model: rest };
  }
  throw rejected(rule, `${JSON.stringify(head)} is neither an engine nor label or phase`);
}

function parseTarget(rule: string, targetText: string): DispatchRemapTarget {
  const colon = targetText.indexOf(":");
  const engine = colon === -1 ? targetText : targetText.slice(0, colon);
  if (!isEngineName(engine)) {
    throw rejected(rule, `the target engine ${JSON.stringify(engine)} is not an engine`);
  }
  if (colon === -1) {
    return { engine };
  }
  const model = targetText.slice(colon + 1);
  if (model.length === 0) {
    throw rejected(rule, `the target model after ${JSON.stringify(engine)}: is empty`);
  }
  return { engine, model };
}

/** Parse a list of rules; a flag's repeated values, or the variable's comma-separated ones. Blank entries are skipped. */
export function parseDispatchRemap(rules: readonly string[]): DispatchRemapRule[] {
  return rules
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0)
    .map((rule) => parseDispatchRemapRule(rule));
}

/** Split the environment variable's value into rules: comma-separated, whitespace around each ignored. */
export function splitDispatchRemapVariable(value: string): string[] {
  return value.split(",");
}

/**
 * Whether a glob matches a value whole: `*` is any run of characters, `?`
 * exactly one, everything else literal. Anchored at both ends, so
 * `propose:*` matches `propose:1` and not `re-propose:1`.
 */
export function globMatches(glob: string, value: string): boolean {
  let pattern = "";
  for (const character of glob) {
    if (character === "*") {
      pattern += ".*";
    } else if (character === "?") {
      pattern += ".";
    } else {
      pattern += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`, "su").test(value);
}

function keyMatches(key: DispatchRemapKey, request: DispatchRequest): boolean {
  switch (key.kind) {
    case "label":
      return request.label !== null && globMatches(key.glob, request.label);
    case "phase":
      return request.phase !== null && globMatches(key.glob, request.phase);
    case "model":
      return request.engine === key.engine && request.model === key.model;
    case "engine":
      return request.engine === key.engine;
  }
}

/**
 * The run's remap and its ledger of which rules caught a dispatch, so the
 * run's end can name the keys that caught nothing — a mistyped key must
 * never silently leave everything where it was.
 */
export class DispatchRemapLedger {
  readonly rules: readonly DispatchRemapRule[];
  #matched = new Set<DispatchRemapRule>();

  constructor(rules: readonly DispatchRemapRule[]) {
    this.rules = rules;
  }

  /**
   * The move a request takes, or null where no key matches. Among matching
   * rules the most specific key wins — label, then phase, then
   * `engine:model`, then engine — and among keys of one kind the first
   * declared. A match is recorded as caught even when the target equals the
   * request: the operator's rule took, and it was not mistyped.
   */
  resolve(request: DispatchRequest): DispatchRemapMove | null {
    let best: DispatchRemapRule | undefined;
    for (const rule of this.rules) {
      if (keyMatches(rule.key, request) && (best === undefined || KEY_RANK[rule.key.kind] < KEY_RANK[best.key.kind])) {
        best = rule;
      }
    }
    if (best === undefined) {
      return null;
    }
    this.#matched.add(best);
    return { rule: best, engine: best.target.engine, model: best.target.model };
  }

  /** The rules that caught no dispatch so far, as written, in declaration order. */
  unmatched(): string[] {
    return this.rules.filter((rule) => !this.#matched.has(rule)).map((rule) => rule.source);
  }
}
