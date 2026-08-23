/* global process */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const archiveDir = process.argv[2];
if (typeof archiveDir !== "string") {
  throw new Error("usage: node verify-args.mjs <archive-directory>");
}

const manifest = JSON.parse(await readFile(path.join(archiveDir, "manifest.json"), "utf8"));
const invocationEntries = Array.isArray(manifest.workflow_invocations) ? manifest.workflow_invocations : [];
const entries = [
  { label: "manifest args", args: manifest.args },
  ...invocationEntries.map((entry) => ({ label: `workflow invocation ${entry.ordinal} args`, args: entry.args }))
];

for (const entry of entries) {
  await verifyArgs(archiveDir, entry.label, entry.args);
}

process.stdout.write(`verified ${entries.length} args digests\n`);

async function verifyArgs(archiveDirectory, label, args) {
  if (
    args === null ||
    typeof args !== "object" ||
    typeof args.canonical_archive_path !== "string" ||
    typeof args.sha256 !== "string"
  ) {
    throw new Error(`${label} does not name a canonical args artefact and digest`);
  }

  const canonicalPath = path.resolve(archiveDirectory, args.canonical_archive_path);
  const archiveRoot = `${path.resolve(archiveDirectory)}${path.sep}`;
  if (!canonicalPath.startsWith(archiveRoot)) {
    throw new Error(`${label} canonical artefact escapes the archive`);
  }

  const canonicalText = await readFile(canonicalPath, "utf8");
  const actual = createHash("sha256").update(canonicalText).digest("hex");
  if (actual !== args.sha256) {
    throw new Error(`${label} sha256 mismatch`);
  }
}
