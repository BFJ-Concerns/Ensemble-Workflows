/* global process */

import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { readJson } from "./archive-helpers.mjs";

const [dataHome] = process.argv.slice(2);
assert.ok(dataHome, "usage: read-archived-agents.mjs <resolved-data-home>");

const entries = await readdir(dataHome, { recursive: true });
const agentPaths = entries
  .filter((entry) => path.basename(entry) === "agent.json")
  .map((entry) => path.join(dataHome, entry));
assert.ok(agentPaths.length > 0, `expected at least one agent.json below ${dataHome}`);

// The walk above finds the records that are there; only the manifest says
// which ones the run wrote. Without this comparison an archive whose records
// were removed reads as an archive that simply ran fewer agents, and every
// shape assertion below passes over the survivors while saying nothing about
// the ones that are gone. A loss declared in `integrity.files_lost` is not an
// excuse here either: it legitimately spares an ordinary file from a byte
// check, but a run whose own agent records are missing is not a run this
// archive can still describe. Implemented against the manifest directly
// rather than shared with the integrity consumer — each consumer model
// carries its own copy of the discipline it depends on.
const manifestPaths = entries
  .filter((entry) => path.basename(entry) === "manifest.json")
  .map((entry) => path.join(dataHome, entry));
for (const manifestPath of manifestPaths) {
  const manifest = await readJson(manifestPath);
  const archiveRoot = path.dirname(manifestPath);
  const lost = new Set((manifest.integrity?.files_lost ?? []).map((entry) => entry.path));
  const namedRecords = (manifest.files ?? [])
    .map((file) => file.path)
    .filter((filePath) => /^agents\/[^/]+\/agent\.json$/.test(filePath));
  for (const recordPath of namedRecords) {
    assert.ok(
      !lost.has(recordPath),
      `agent record ${recordPath} is named by ${manifestPath} but recorded lost; an archive cannot describe a run whose agent records are missing`
    );
    const record = await lstat(path.join(archiveRoot, recordPath)).catch(() => null);
    assert.ok(
      record !== null && record.isFile(),
      `agent record ${recordPath} is named by ${manifestPath} but is not a file in the archive`
    );
  }
}

const agents = await Promise.all(agentPaths.map((agentPath) => readJson(agentPath)));
const v3AgentKeys = [
  "attempts", "concurrency_group", "creation_order", "decode_failure", "effort", "engine", "execution_ms",
  "fallback_model", "id", "isolation", "kind", "label", "model", "options", "parse_route", "phase", "prompt",
  "queued_ms", "raw_output", "resolved_cwd", "resolved_effort", "resolved_model", "schema", "schema_version",
  "session", "status", "strip", "termination_cause", "transcripts", "transcripts_unavailable", "usage",
  "validated_output", "worktree"
];

for (const [index, agent] of agents.entries()) {
  assert.equal(agent.schema_version, 3);
  assert.equal(agent.kind, "agent_record");
  const hasAbandonment = agent.abandonment !== undefined;
  assert.deepEqual(Object.keys(agent).sort(), hasAbandonment ? [...v3AgentKeys, "abandonment"].sort() : v3AgentKeys);
  assert.ok(agent.label === null || typeof agent.label === "string");
  assert.equal(typeof agent.status, "string");
  assert.ok(Array.isArray(agent.attempts));
  assert.ok(Array.isArray(agent.transcripts));
  assert.ok(agent.transcripts_unavailable === null || typeof agent.transcripts_unavailable === "string");
  if (hasAbandonment) {
    const archiveDirectory = path.dirname(path.dirname(path.dirname(agentPaths[index])));
    const manifest = await readJson(path.join(archiveDirectory, "manifest.json"));
    assert.equal(manifest.status, "abandoned");
    assert.deepEqual(agent.abandonment, manifest.abandonment);
    assert.equal(agent.abandonment?.reason, "owner-process-gone");
  }
  if (agent.transcripts.length > 0) assert.equal(agent.transcripts_unavailable, null);

  const archiveDirectory = path.dirname(path.dirname(path.dirname(agentPaths[index])));
  for (const transcript of agent.transcripts) {
    assert.equal(typeof transcript.attempt, "number");
    assert.equal(typeof transcript.path, "string");
    assert.ok(["jsonl", "text"].includes(transcript.format));
    assert.equal(typeof transcript.source, "string");
    assert.ok(transcript.thread_id === null || typeof transcript.thread_id === "string");
    assert.ok(transcript.session_id === null || typeof transcript.session_id === "string");
    const transcriptPath = path.posix.normalize(transcript.path);
    const ownTranscriptPrefix = `${path.relative(archiveDirectory, path.dirname(agentPaths[index])).split(path.sep).join("/")}/`;
    assert.ok(
      transcriptPath.startsWith(ownTranscriptPrefix),
      `agent ${agent.id} transcript must remain below ${ownTranscriptPrefix}: ${transcript.path}`
    );
    const contents = await readFile(path.join(archiveDirectory, transcriptPath), "utf8");
    assert.notEqual(contents, "", `expected transcript ${transcript.path} to retain its contents`);
  }
}

process.stdout.write(`${JSON.stringify(agents)}\n`);
