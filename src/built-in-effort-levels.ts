import type { ServedEffortLevels } from "./effort-resolution.js";

/**
 * The served effort levels Ensemble ships for well-known models, so a
 * common setup needs no `effort` configuration. Rows are keyed by model
 * identity — the model's own name, whichever engine or route reaches it —
 * and a row is the model's whole served set: a canonical level the row
 * omits is one the model is taken not to serve.
 *
 * The table outranks an engine's own listing for a model it knows, because
 * a listing can omit a level the provider serves and can advertise a name
 * that is not a reasoning level; the machine's `effort` section outranks
 * the table, so an operator can correct a row before a release does.
 *
 * Every row is a dated measurement, and its comment says what was measured
 * and against which engine version: a level is listed because the provider
 * was seen to serve it, and left out because it was seen to refuse it or
 * was never seen at all. A row is re-measured, never extrapolated from a
 * neighbouring model's.
 */
const BUILT_IN_SERVED_LEVELS: Readonly<Record<string, ServedEffortLevels>> = {};

/** The served levels the built-in table holds for a model identity, or undefined where the table does not know the model. */
export function builtInServedLevels(identity: string): ServedEffortLevels | undefined {
  // `hasOwn`, not a lookup: an identity spelling a prototype property
  // (`constructor`) is unknown, not Object's.
  return Object.hasOwn(BUILT_IN_SERVED_LEVELS, identity) ? BUILT_IN_SERVED_LEVELS[identity] : undefined;
}
