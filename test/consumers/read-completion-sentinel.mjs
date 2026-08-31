/* global process */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [sentinelPath] = process.argv.slice(2);
assert.ok(sentinelPath, "usage: read-completion-sentinel.mjs <completion-sentinel.json>");

const sentinel = JSON.parse(await readFile(sentinelPath, "utf8"));
assert.equal(sentinel.schema_version, 3);
assert.equal(sentinel.kind, "completion_sentinel");
assert.ok(["complete", "failed", "timed-out", "interrupted"].includes(sentinel.outcome));
assert.equal(typeof sentinel.exit_code, "number");
assert.ok(sentinel.error === null || (typeof sentinel.error.kind === "string" && typeof sentinel.error.message === "string"));
assert.ok(sentinel.workers === null || (Number.isInteger(sentinel.workers.done) && Number.isInteger(sentinel.workers.failed) && Number.isInteger(sentinel.workers.unsettled)));
assert.ok(sentinel.manifest?.sha256 !== undefined || sentinel.manifest?.unavailable !== undefined);
assert.equal(sentinel.integrity?.algorithm, "sha256");
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
