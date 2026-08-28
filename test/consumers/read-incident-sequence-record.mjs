/* global process */

import assert from "node:assert/strict";
import path from "node:path";
import { findOnlyFile, readJson } from "./archive-helpers.mjs";

const [dataHome, identifier] = process.argv.slice(2);
assert.ok(dataHome, "usage: read-incident-sequence-record.mjs <resolved-data-home> <identifier>");
assert.ok(identifier, "an incident identifier is required");

const manifestPath = await findOnlyFile(dataHome, "manifest.json");
const archiveDir = path.dirname(manifestPath);
const manifest = await readJson(manifestPath);
assert.equal(manifest.status, "failed");
assert.equal(manifest.meta.task.id, identifier);

const agent = await readJson(await findOnlyFile(archiveDir, "agent.json"));
assert.equal(agent.prompt, `dispatch ${identifier}`);
assert.equal(agent.status, "failed");
assert.equal(agent.attempts.length, 1);

const [attempt] = agent.attempts;
assert.equal(attempt.attempt, 1);
assert.equal(attempt.raw_output, `partial ${identifier}`);
assert.equal(attempt.failure.kind, "AppServerOverloadedError");
assert.match(attempt.failure.message, new RegExp(`overload ${identifier}`));

process.stdout.write(`${JSON.stringify({
  task: manifest.meta.task.id,
  prompt: agent.prompt,
  partial: attempt.raw_output,
  failure: attempt.failure.message
})}\n`);
