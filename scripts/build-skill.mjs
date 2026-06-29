// Bundles the CLI into the standalone skill launcher
// (skills/ensemble-workflow/Base/scripts/ensemble.mjs).
//
// The bundle lives at Base/scripts/ where skill installs expect it — no
// package.json beside the bundle. The version guard needs the Node floor at
// startup, so we read `engines.node` here at build time and inline it via an
// esbuild `define`, leaving the bundle self-contained. package.json stays the
// single source of truth; only the moment of reading it moves from runtime to
// build time.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const nodeRange = pkg.engines?.node;
if (typeof nodeRange !== "string" || nodeRange.trim().length === 0) {
  throw new Error("package.json is missing engines.node; cannot inline the Node floor");
}

await build({
  entryPoints: [path.join(repoRoot, "src/cli/ensemble.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: path.join(repoRoot, "skills/ensemble-workflow/Base/scripts/ensemble.mjs"),
  define: {
    // JSON.stringify yields a quoted literal, e.g. `">=24.14.0"` — the source
    // text esbuild substitutes for every `__ENSEMBLE_NODE_RANGE__` reference.
    __ENSEMBLE_NODE_RANGE__: JSON.stringify(nodeRange.trim())
  }
});
