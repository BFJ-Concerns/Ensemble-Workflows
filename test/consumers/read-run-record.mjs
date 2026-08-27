/* global process */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const [dataHome] = process.argv.slice(2);
assert.ok(dataHome, "usage: read-run-record.mjs <resolved-data-home>");

const manifestPath = await findOnlyFile(dataHome, "manifest.json");
const archiveDir = path.dirname(manifestPath);
const manifest = await readJson(manifestPath);
assert.equal(manifest.schema_version, 3);
assert.equal(manifest.kind, "run_manifest");
assert.equal(manifest.status, "failed");
assert.equal(manifest.result?.archive_path, "result.json");
assert.equal(manifest.result?.exit_code, 1);

for (const file of manifest.files) {
  const bytes = await readFile(path.join(archiveDir, file.path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
  assert.equal(bytes.byteLength, file.size, file.path);
}

const result = await readJson(path.join(archiveDir, "result.json"));
assert.equal(result.schema_version, 3);
assert.equal(result.kind, "run_result");
assert.equal(result.status, "failed");
assert.equal(result.exit_code, 1);
assert.equal(result.value?.partial, true);
assert.equal(result.value?.reason, "failed");
assert.equal(result.value?.completed?.length, 1);

const agentPath = await findOnlyFile(archiveDir, "agent.json");
const agent = await readJson(agentPath);
assert.equal(agent.schema_version, 3);
assert.equal(agent.kind, "agent_record");
assert.equal(agent.status, "complete");
assert.equal(agent.attempts?.length, 1);
assert.equal(agent.attempts[0]?.status, "complete");
assert.deepEqual(agent.validated_output, result.value.completed[0].output);
assert.deepEqual(agent.attempts[0]?.validated_output, agent.validated_output);

process.stdout.write(`${JSON.stringify({
  task: manifest.meta?.task ?? null,
  status: result.status,
  exitCode: result.exit_code,
  completed: result.value.completed,
  recordedAgent: {
    label: agent.label,
    output: agent.validated_output,
    attemptStatus: agent.attempts[0].status
  }
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
