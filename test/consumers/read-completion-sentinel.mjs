/* global process */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [sentinelPath] = process.argv.slice(2);
assert.ok(sentinelPath, "usage: read-completion-sentinel.mjs <completion-sentinel.json>");

const sentinel = JSON.parse(await readFile(sentinelPath, "utf8"));
assert.deepEqual(Object.keys(sentinel).sort(), [
  "ended_at", "error", "exit_code", "integrity", "kind", "manifest", "outcome", "schema_version", "workers"
]);
assert.equal(sentinel.schema_version, 3);
assert.equal(sentinel.kind, "completion_sentinel");
assert.ok(["complete", "failed", "timed-out", "interrupted"].includes(sentinel.outcome));
assert.equal(typeof sentinel.exit_code, "number");
assert.ok(sentinel.error === null || (typeof sentinel.error.kind === "string" && typeof sentinel.error.message === "string"));
assert.ok(sentinel.workers === null || (
  Number.isInteger(sentinel.workers.done) &&
  Number.isInteger(sentinel.workers.failed) &&
  Number.isInteger(sentinel.workers.cut_short) &&
  Number.isInteger(sentinel.workers.unsettled)
));
assert.ok(
  (typeof sentinel.manifest?.sha256 === "string" && Object.keys(sentinel.manifest).length === 1) ||
  (["recording-disabled", "manifest-unsealed"].includes(sentinel.manifest?.unavailable) && Object.keys(sentinel.manifest).length === 1)
);
assert.equal(typeof sentinel.ended_at, "string");
assert.ok(Number.isFinite(Date.parse(sentinel.ended_at)));
assert.equal(sentinel.integrity?.algorithm, "sha256");
assert.equal(
  sentinel.integrity?.recipe,
  "sha256 hex of the document with this digest field set to null, " +
    "serialised as ECMA-262 JSON.stringify with two-space indent and no " +
    "trailing newline, object keys sorted by UTF-16 code unit at every level " +
    "(integer-index keys first in ascending numeric order, as ECMA-262 " +
    "property enumeration places them)"
);
assert.equal(sentinel.integrity?.sentinel_sha256, selfDigest(sentinel));

process.stdout.write(`${JSON.stringify(sentinel)}\n`);

function selfDigest(document) {
  const copy = JSON.parse(JSON.stringify(document));
  copy.integrity.sentinel_sha256 = null;
  return createHash("sha256").update(JSON.stringify(sortJson(copy), null, 2)).digest("hex");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, sortJson(entry)]));
  }
  return value;
}
