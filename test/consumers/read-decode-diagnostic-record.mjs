/* global process */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { findOnlyFile, readJson } from "./archive-helpers.mjs";

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
