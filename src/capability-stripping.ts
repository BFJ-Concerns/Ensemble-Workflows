import { CapabilityStripUnsupportedError, InvalidAgentOptionValueError } from "./errors.js";

import type { EngineName } from "./types.js";

/**
 * The named tool-surface capabilities a caller may strip from a dispatched
 * worker. The vocabulary is deliberately closed: stripping is enforced
 * through each engine's own configuration surface, so a capability only
 * joins this list together with an enforcement judgement on every shipped
 * engine — an open string would reintroduce the silent no-op the options
 * invariant forbids.
 */
export type StrippableCapability = "skills" | "agents";
export const STRIPPABLE_CAPABILITIES: readonly StrippableCapability[] = ["skills", "agents"];

/**
 * How one engine discharges a strip request for one capability.
 *
 * - `config` — the engine strips it mechanically through its own
 *   configuration surface; `detail` names the route.
 * - `absent` — the capability does not exist on the engine's tool surface,
 *   so the request is satisfied by construction; `detail` states why. This
 *   is a stated judgement, never a silent skip: it is recorded on the
 *   agent's durable record like any other route.
 * - `unsupported` — the engine has (or may have) the capability but the
 *   harness cannot strip it; the request fails loud before the worker
 *   spawns. A restriction asked for and not delivered is exactly the
 *   silent no-op the options invariant exists to prevent.
 */
export type CapabilityEnforcement =
  | { route: "config"; detail: string }
  | { route: "absent"; detail: string }
  | { route: "unsupported"; detail: string };

export type EngineCapabilityTable = Record<StrippableCapability, CapabilityEnforcement>;

const CAPABILITY_SET = new Set<string>(STRIPPABLE_CAPABILITIES);

/**
 * Validate a `strip` option value: an array of known capability names.
 * Duplicates are tolerated (stripping is idempotent); unknown names fail
 * before anything is paid for.
 */
export function assertValidStripOption(value: unknown): asserts value is StrippableCapability[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !CAPABILITY_SET.has(entry))) {
    throw new InvalidAgentOptionValueError(
      "strip",
      value,
      `an array of capability names from: ${STRIPPABLE_CAPABILITIES.join(", ")}`
    );
  }
}

/**
 * The effective strip set for one call: the run-wide list united with the
 * per-call list. Union only — a call can add strips but never lift a
 * run-wide one, so no worker regains a capability someone asked stripped.
 */
export function effectiveStrip(
  runWide: readonly StrippableCapability[] | undefined,
  perCall: readonly StrippableCapability[] | undefined
): StrippableCapability[] {
  return [...new Set([...(runWide ?? []), ...(perCall ?? [])])];
}

/**
 * Pre-spawn enforcement check: every requested capability must resolve to a
 * `config` or `absent` route on the target engine's declared table. An
 * engine with no table cannot enforce anything — fail closed, same as an
 * `unsupported` entry. Returns the per-capability routes for the durable
 * record, so the archive shows how each strip was discharged.
 */
export function resolveStripEnforcement(
  engine: EngineName,
  table: EngineCapabilityTable | undefined,
  strip: readonly StrippableCapability[]
): Partial<Record<StrippableCapability, "config" | "absent">> {
  const routes: Partial<Record<StrippableCapability, "config" | "absent">> = {};
  for (const capability of strip) {
    const enforcement = table?.[capability];
    if (enforcement === undefined || enforcement.route === "unsupported") {
      throw new CapabilityStripUnsupportedError(
        engine,
        capability,
        enforcement?.detail ?? "the engine declares no capability-stripping surface"
      );
    }
    routes[capability] = enforcement.route;
  }
  return routes;
}
