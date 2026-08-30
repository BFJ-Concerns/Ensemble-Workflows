/* global process */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { readJson } from "./archive-helpers.mjs";

const [dataHome, label] = process.argv.slice(2);
assert.ok(dataHome && label, "usage: read-agent-transcript-contract.mjs <resolved-data-home> <label>");

const entries = await readdir(dataHome, { recursive: true });
const agentPaths = entries
  .filter((entry) => path.basename(entry) === "agent.json")
  .map((entry) => path.join(dataHome, entry));
const agents = await Promise.all(agentPaths.map((agentPath) => readJson(agentPath)));
const agent = agents.find((candidate) => candidate.label === label);
assert.ok(agent, `expected archived agent with label ${label}`);
assert.equal(agent.schema_version, 3);
assert.equal(agent.kind, "agent_record");
assert.ok(Array.isArray(agent.transcripts));
assert.deepEqual(agent.transcripts, []);
assert.equal(agent.transcripts_unavailable, "no-attempt-ran");

process.stdout.write(`${JSON.stringify({ transcripts: agent.transcripts, transcriptsUnavailable: agent.transcripts_unavailable })}\n`);
