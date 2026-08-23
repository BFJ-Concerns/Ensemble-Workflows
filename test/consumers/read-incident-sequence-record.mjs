/* global process */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

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

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function findOnlyFile(root, basename) {
  const entries = await readdir(root, { recursive: true });
  const matches = entries.filter((entry) => path.basename(entry) === basename);
  assert.equal(matches.length, 1, `expected one ${basename}, found ${matches.length}`);
  return path.join(root, matches[0]);
}
