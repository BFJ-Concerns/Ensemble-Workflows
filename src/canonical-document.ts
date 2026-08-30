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

export function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortJson(entryValue)]));
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
