/* global process */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { readJson } from "./archive-helpers.mjs";

const [dataHome] = process.argv.slice(2);
assert.ok(dataHome, "usage: read-archived-agents.mjs <resolved-data-home>");

const entries = await readdir(dataHome, { recursive: true });
const agentPaths = entries
  .filter((entry) => path.basename(entry) === "agent.json")
  .map((entry) => path.join(dataHome, entry));
assert.ok(agentPaths.length > 0, `expected at least one agent.json below ${dataHome}`);

const agents = await Promise.all(agentPaths.map((agentPath) => readJson(agentPath)));
for (const agent of agents) {
  assert.equal(agent.schema_version, 3);
  assert.equal(agent.kind, "agent_record");
  assert.ok(agent.label === null || typeof agent.label === "string");
  assert.equal(typeof agent.status, "string");
  assert.ok(Array.isArray(agent.attempts));
}

process.stdout.write(`${JSON.stringify(agents)}\n`);
