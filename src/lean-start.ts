import { LeanStartUnsupportedError } from "./errors.js";

import type { EngineName } from "./types.js";

/**
 * How one engine arranges a lean start — a worker that begins without the
 * operator's interactive context: the user-level rules and instructions,
 * the skill listing, and the MCP tool set an interactive session of that
 * engine would load. Reach and the engine's built-in tool surface are not
 * this axis's: the worker keeps both.
 *
 * - `config` — the engine withholds that context mechanically through its
 *   own launch surface; `detail` names the route and when it was measured.
 * - `unsupported` — the harness knows no route; a lean request fails loud
 *   before the worker spawns. A lean start asked for and not delivered is
 *   the silent no-op the options invariant forbids.
 */
export type LeanStartSupport = { route: "config"; detail: string } | { route: "unsupported"; detail: string };

/** A lean route that lets a worker dispatch, with its provenance, as the record carries it. */
export type DischargedLeanStart = { route: "config"; detail: string };

/** The effective lean request for one call: the run-wide flag or the call's own. Opt-in only — a call cannot lift a run-wide lean. */
export function effectiveLean(runWide: boolean | undefined, perCall: boolean | undefined): boolean {
  return runWide === true || perCall === true;
}

/**
 * Pre-spawn enforcement check: a lean request must resolve to a `config`
 * route on the target engine's declaration. An engine that declares
 * nothing cannot arrange a lean start — fail closed, like an `unsupported`
 * declaration. Returns the route and its detail for the durable record,
 * so the archive carries the measurement the route rests on.
 */
export function resolveLeanStart(engine: EngineName, support: LeanStartSupport | undefined): DischargedLeanStart {
  if (support === undefined || support.route === "unsupported") {
    throw new LeanStartUnsupportedError(engine, support?.detail ?? "the engine declares no lean-start route");
  }
  return { route: support.route, detail: support.detail };
}
