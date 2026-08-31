/* global process */

/**
 * Reads a sealed (or abandoned) run archive the way a supervisor would:
 * cold, in its own process, with no access to the run that wrote it. It
 * answers three questions the archive is supposed to answer by itself —
 * is this archive unedited, is it whole, and is the run that owns it still
 * alive — and prints the answers as JSON for the caller to pin. Every check
 * is the consumer's own: nothing here imports the harness.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { readJson } from "./archive-helpers.mjs";
import { judgeArchivedRunLiveness } from "./archive-liveness.mjs";

const [archiveDir] = process.argv.slice(2);
assert.ok(archiveDir, "usage: read-archive-integrity.mjs <archive-dir>");

const manifest = await readJson(path.join(archiveDir, "manifest.json"));
assert.equal(manifest.integrity?.algorithm, "sha256");

// One recipe covers manifest and sentinel: the digest of the document with
// its own digest field null, canonicalised (sorted keys, two-space indent).
const manifestVerified = manifest.integrity.manifest_sha256 === selfDigest(manifest, "integrity", "manifest_sha256");

// The manifest is untrusted input: a crafted `files` entry must not walk
// this consumer out of the archive (`../`, an absolute path) or through a
// symlink to bytes the archive does not contain. Containment is judged on
// the resolved real path so a link anywhere in the chain is caught, and
// the entry itself may not be a link at all — an archive attests its own
// bytes, never whatever a link currently points at.
const archiveRoot = await realpath(archiveDir);
async function containedArchivePath(relativePath) {
  assert.ok(!path.isAbsolute(relativePath), `${relativePath} escapes the archive: absolute path`);
  const joined = path.join(archiveRoot, relativePath);
  assert.ok(
    joined === archiveRoot || joined.startsWith(archiveRoot + path.sep),
    `${relativePath} escapes the archive directory`
  );
  const entryStat = await lstat(joined).catch(() => null);
  if (entryStat !== null) {
    assert.ok(!entryStat.isSymbolicLink(), `${relativePath} is a symlink; the archive attests only its own bytes`);
    const real = await realpath(joined);
    assert.ok(
      real === archiveRoot || real.startsWith(archiveRoot + path.sep),
      `${relativePath} resolves outside the archive directory`
    );
  }
  return joined;
}

const lost = new Set((manifest.integrity.files_lost ?? []).map((entry) => entry.path));
for (const file of manifest.files) {
  if (lost.has(file.path)) {
    continue;
  }
  const bytes = await readFile(await containedArchivePath(file.path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
  assert.equal(bytes.byteLength, file.size, file.path);
}

// Every recorded loss must still be a loss on disk: the archive may not
// call a file lost that a reader can read back whole.
for (const entry of manifest.integrity.files_lost ?? []) {
  const declared = manifest.files.find((file) => file.path === entry.path);
  assert.ok(declared, `lost file ${entry.path} must still be declared in the files table`);
  const actual = await stat(await containedArchivePath(entry.path)).catch(() => null);
  if (entry.reason === "missing") {
    assert.equal(actual, null, `${entry.path} is recorded missing but is present`);
  } else {
    assert.notEqual(actual?.size, declared.size, `${entry.path} is recorded mismatched but matches`);
  }
}

let sentinel = null;
try {
  sentinel = await readJson(path.join(archiveDir, "completion-sentinel.json"));
} catch {
  // An uncatchable kill leaves no sentinel; that absence is itself a reading.
}
const sentinelVerified =
  sentinel === null ? null : sentinel.integrity.sentinel_sha256 === selfDigest(sentinel, "integrity", "sentinel_sha256");
const sentinelAttestsManifest =
  sentinel === null ? null : sentinel.manifest?.sha256 === manifest.integrity.manifest_sha256;

const liveness = await judgeArchivedRunLiveness(manifest);

process.stdout.write(`${JSON.stringify({
  status: manifest.status,
  manifestVerified,
  filesLost: manifest.integrity.files_lost ?? [],
  sentinelPresent: sentinel !== null,
  sentinelVerified,
  sentinelAttestsManifest,
  liveness
})}\n`);

function selfDigest(document, block, field) {
  const copy = JSON.parse(JSON.stringify(document));
  copy[block][field] = null;
  return createHash("sha256").update(canonicalJson(copy)).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortJson(entryValue)]));
  }
  return value;
}
