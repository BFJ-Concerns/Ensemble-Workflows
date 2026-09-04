/* global process */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { findOnlyFile, readJson } from "./archive-helpers.mjs";

const [recordStore] = process.argv.slice(2);
assert.ok(recordStore, "usage: read-claude-interruption-evidence.mjs <record-store>");

const agentPath = await findOnlyFile(recordStore, "agent.json");
const agent = await readJson(agentPath);
assert.equal(agent.schema_version, 4);
assert.equal(agent.status, "interrupted");
assert.ok(Array.isArray(agent.transcripts), "an interrupted turn that left a transcript must list it");
assert.equal(agent.transcripts.length, 1);

const archiveDir = path.dirname(path.dirname(path.dirname(agentPath)));
const transcript = await readFile(path.join(archiveDir, agent.transcripts[0].path), "utf8");
assert.match(transcript, /started work, calling a tool/);

const attempt = agent.attempts.at(-1);
assert.equal(attempt.raw_output, "started work, calling a tool");
assert.equal(attempt.resolved_model, "claude-fake-worker");
assert.ok(attempt.token_usage_events.length > 0, "the interrupted attempt must retain its usage event");
assert.deepEqual(attempt.token_usage_events.at(-1).total, {
  inputTokens: 120,
  outputTokens: 30,
  cachedInputTokens: 9,
  cacheCreationInputTokens: 0,
  totalTokens: 159
});
assert.equal(agent.usage.summary.totalTokens, 159);

process.stdout.write(`${JSON.stringify({
  status: agent.status,
  resolvedModel: attempt.resolved_model,
  transcripts: agent.transcripts.length,
  totalTokens: agent.usage.summary.totalTokens
})}\n`);
