import { readHarnessPackageMetadata } from "./node-version.js";

/**
 * The harness version, inlined at bundle time by `scripts/build-skill.mjs`
 * via an esbuild `define` — the same shape as the Node floor: the bundle
 * ships with no package.json beside it, so it must carry its own version
 * rather than read one off disk at startup. Genuinely undeclared in
 * unbundled `dist/` and source runs, where the fallback walks to
 * package.json instead. package.json stays the single source of truth;
 * only the moment of reading it moves from runtime to build time.
 */
declare const __ENSEMBLE_VERSION__: string | undefined;

export function harnessVersion(fromUrl: string = import.meta.url): string {
  // `typeof` guard rather than a truthiness check: the identifier is
  // genuinely undeclared in unbundled builds, and a bare `typeof` is the
  // one reference that probes an undeclared name without a ReferenceError.
  if (typeof __ENSEMBLE_VERSION__ === "string" && __ENSEMBLE_VERSION__.trim().length > 0) {
    return __ENSEMBLE_VERSION__.trim();
  }
  const version = readHarnessPackageMetadata(fromUrl).version;
  return typeof version === "string" && version.trim().length > 0 ? version.trim() : "0.0.0";
}
