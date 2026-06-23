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
 * Reads the package's declared Node floor from `engines.node`.
 *
 * The CLI guard should fail with the same requirement npm advertises; walking
 * upward keeps the lookup working from source, compiled `dist/`, and the
 * bundled skill launcher.
 */
export function requiredNodeRange(fromUrl: string = import.meta.url): string {
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
