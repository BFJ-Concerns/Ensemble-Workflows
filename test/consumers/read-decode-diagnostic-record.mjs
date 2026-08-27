/* global process */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

const [dataHome, expected] = process.argv.slice(2);
assert.ok(dataHome, "usage: read-decode-diagnostic-record.mjs <resolved-data-home> <clean|decode>");
assert.ok(expected === "clean" || expected === "decode", "expected clean or decode");

const agentPath = await findOnlyFile(dataHome, "agent.json");
const agent = await readJson(agentPath);
const fixtureKeys = await readJson(new URL("../fixtures/run-record/v3-agent-keys.json", import.meta.url));

assert.equal(agent.schema_version, 3);
assert.equal(agent.kind, "agent_record");
assert.deepEqual(Object.keys(agent).sort(), fixtureKeys);

if (expected === "decode") {
  assert.deepEqual(agent.decode_failure, {
    byte_length: Buffer.byteLength("this is not JSON at all", "utf8"),
    line_prefix: "this is not JSON at all"
  });
} else {
  assert.equal(agent.decode_failure, null);
}

process.stdout.write(`${JSON.stringify({ decodeFailure: agent.decode_failure })}\n`);

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function findOnlyFile(root, basename) {
  const entries = await readdir(root, { recursive: true });
  const matches = entries.filter((entry) => path.basename(entry) === basename);
  assert.equal(matches.length, 1, `expected one ${basename}, found ${matches.length}`);
  return path.join(root, matches[0]);
}
