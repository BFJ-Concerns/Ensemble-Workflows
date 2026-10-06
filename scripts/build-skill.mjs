// Bundles the CLI into the standalone skill launcher
// (skills/ensemble-workflow/Base/scripts/ensemble.mjs).
//
// The skill's guidance is maintained separately; this repo ships only the
// bundle, at the Base/scripts/ path skill installs expect — no package.json
// beside the bundle. The version guard needs the Node floor at
// startup, so we read `engines.node` here at build time and inline it via an
// esbuild `define`, leaving the bundle self-contained. package.json stays the
// single source of truth; only the moment of reading it moves from runtime to
// build time.
//
// The bundle travels as one file, so the licences of the third-party packages
// esbuild inlines travel inside it: THIRD_PARTY_NOTICES is appended as a
// closing comment. The build fails when the bundled packages and the notices'
// `Package:` entries disagree, so a dependency change cannot ship without its
// licence or keep a stale one.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const outfile = path.join(repoRoot, "skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const noticesPath = path.join(repoRoot, "THIRD_PARTY_NOTICES");

const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const nodeRange = pkg.engines?.node;
if (typeof nodeRange !== "string" || nodeRange.trim().length === 0) {
  throw new Error("package.json is missing engines.node; cannot inline the Node floor");
}
if (typeof pkg.version !== "string" || pkg.version.trim().length === 0) {
  throw new Error("package.json is missing version; cannot inline the harness version");
}

const notices = readFileSync(noticesPath, "utf8");
if (notices.includes("*/")) {
  throw new Error("THIRD_PARTY_NOTICES contains */, which would end the comment that carries it");
}

const result = await build({
  entryPoints: [path.join(repoRoot, "src/cli/ensemble.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile,
  write: false,
  metafile: true,
  define: {
    // JSON.stringify yields a quoted literal, e.g. `">=24.14.0"` — the source
    // text esbuild substitutes for every `__ENSEMBLE_NODE_RANGE__` reference.
    __ENSEMBLE_NODE_RANGE__: JSON.stringify(nodeRange.trim()),
    __ENSEMBLE_VERSION__: JSON.stringify(pkg.version.trim())
  }
});

const bundled = new Set(
  Object.keys(result.metafile.inputs)
    .map((input) => /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1])
    .filter((name) => name !== undefined)
);
const listed = new Set([...notices.matchAll(/^Package: (\S+)$/gm)].map((match) => match[1]));
const unlisted = [...bundled].filter((name) => !listed.has(name)).sort();
const stale = [...listed].filter((name) => !bundled.has(name)).sort();
if (unlisted.length > 0 || stale.length > 0) {
  const problems = [];
  if (unlisted.length > 0) problems.push(`bundled without a THIRD_PARTY_NOTICES entry: ${unlisted.join(", ")}`);
  if (stale.length > 0) problems.push(`listed in THIRD_PARTY_NOTICES but no longer bundled: ${stale.join(", ")}`);
  throw new Error(`third-party notices disagree with the bundle — ${problems.join("; ")}`);
}

const [output] = result.outputFiles;
writeFileSync(outfile, `${output.text}\n/*\n${notices.trimEnd()}\n*/\n`, { mode: 0o755 });
