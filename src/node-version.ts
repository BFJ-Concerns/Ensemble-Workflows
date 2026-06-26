import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageMetadata {
  name?: string;
  engines?: { node?: string };
}

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * The Node floor, inlined at bundle time by `scripts/build-skill.mjs` via an
 * esbuild `define`. Genuinely undeclared in unbundled `dist/` and source runs,
 * where `requiredNodeRange` falls back to reading `engines.node` from
 * package.json instead.
 *
 * The skill ships as a standalone esbuild bundle with no package.json beside it,
 * so the bundle must carry its own floor rather than read one off disk at
 * startup — otherwise the version guard throws before the CLI does anything.
 */
declare const __ENSEMBLE_NODE_RANGE__: string | undefined;

/**
 * Resolves the package's declared Node floor (`engines.node`).
 *
 * The CLI guard should fail with the same requirement npm advertises. In the
 * bundle that requirement is the build-time-injected constant; everywhere else
 * (source, compiled `dist/`, an npm-installed `bin`) it's read from package.json,
 * walking upward so the lookup survives the differing directory depths.
 */
export function requiredNodeRange(fromUrl: string = import.meta.url): string {
  // `typeof` guard rather than a truthiness check: the identifier is genuinely
  // undeclared in unbundled builds, and a bare `typeof` is the one reference
  // that probes an undeclared name without a ReferenceError.
  if (typeof __ENSEMBLE_NODE_RANGE__ === "string" && __ENSEMBLE_NODE_RANGE__.trim().length > 0) {
    return __ENSEMBLE_NODE_RANGE__.trim();
  }
  const metadata = readPackageMetadata(fromUrl);
  const range = metadata.engines?.node;
  if (typeof range !== "string" || range.trim().length === 0) {
    throw new Error("package.json is missing engines.node");
  }
  return range.trim();
}

export function nodeVersionError(version: string = process.versions.node, range = requiredNodeRange()): string | null {
  return satisfiesNodeRange(version, range)
    ? null
    : `Ensemble requires Node ${range}; detected Node ${version}.`;
}

export function satisfiesNodeRange(version: string, range: string): boolean {
  const minimum = parseMinimumRange(range);
  const actual = parseVersion(version);
  if (minimum === null || actual === null) {
    throw new Error(`Unsupported Node version range: ${range}`);
  }
  if (actual.major !== minimum.major) {
    return actual.major > minimum.major;
  }
  if (actual.minor !== minimum.minor) {
    return actual.minor > minimum.minor;
  }
  return actual.patch >= minimum.patch;
}

function parseMinimumRange(range: string): SemanticVersion | null {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0)
  };
}

function parseVersion(version: string): SemanticVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function readPackageMetadata(fromUrl: string): PackageMetadata {
  let current = path.dirname(fileURLToPath(fromUrl));
  while (true) {
    const candidate = path.join(current, "package.json");
    try {
      const metadata = JSON.parse(readFileSync(candidate, "utf8")) as PackageMetadata;
      if (metadata.name === "ensemble-workflows") {
        return metadata;
      }
    } catch {
      // Keep walking: source, dist, and the bundled skill sit at different depths.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not locate ensemble-workflows package.json");
    }
    current = parent;
  }
}
