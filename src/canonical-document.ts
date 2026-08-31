import { createHash } from "node:crypto";

/**
 * The one canonical form every self-attesting archive document is written
 * and digested in: keys sorted recursively, two-space indent. The manifest
 * and the completion sentinel each carry a digest of their own canonical
 * form, so a consumer that verifies either file uses a single recipe —
 * which only holds while both writers compute it the same way, hence one
 * implementation rather than a copy per writer.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

/**
 * The digest recipe, stated in the archive itself (`integrity.recipe`) so a
 * cold consumer needs no access to this codebase to verify: parse the
 * document, set the named digest field to null, re-serialise in the
 * canonical form, and hash. The wording is contract — consumers may pin it —
 * so changes to it are schema changes, not copy-edits.
 */
export const DIGEST_RECIPE =
  "sha256 hex of the document with this digest field set to null, " +
  "serialised as ECMA-262 JSON.stringify with two-space indent and no " +
  "trailing newline, object keys sorted by UTF-16 code unit at every level " +
  "(integer-index keys first in ascending numeric order, as ECMA-262 " +
  "property enumeration places them)";

/**
 * Key order is by UTF-16 code unit, never `localeCompare`: the digest
 * recipe requires the writer and any later consumer — on any machine, under
 * any locale — to sort identically, and ICU collation varies with the
 * environment's locale tailoring (punctuation such as `_` especially).
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareCodeUnits(a, b));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortJson(entryValue)]));
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
