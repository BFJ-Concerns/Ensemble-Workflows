/* global process */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

import { readJson } from "./archive-helpers.mjs";

const [dataHome] = process.argv.slice(2);
assert.ok(dataHome, "usage: read-archived-agents.mjs <resolved-data-home>");

const entries = await readdir(dataHome, { recursive: true });
const agentPaths = entries
  .filter((entry) => path.basename(entry) === "agent.json")
  .map((entry) => path.join(dataHome, entry));
assert.ok(agentPaths.length > 0, `expected at least one agent.json below ${dataHome}`);

const agents = await Promise.all(agentPaths.map((agentPath) => readJson(agentPath)));
const v3AgentKeys = await readJson(new URL("../fixtures/run-record/v3-agent-keys.json", import.meta.url));

for (const [index, agent] of agents.entries()) {
  assert.equal(agent.schema_version, 3);
  assert.equal(agent.kind, "agent_record");
  assert.deepEqual(Object.keys(agent).sort(), v3AgentKeys);
  assert.ok(agent.label === null || typeof agent.label === "string");
  assert.equal(typeof agent.status, "string");
  assert.ok(Array.isArray(agent.attempts));
  assert.ok(Array.isArray(agent.transcripts));
  assert.ok(agent.transcript_capture === null || agent.transcript_capture === "retained" || agent.transcript_capture === "lost");
  assert.ok(agent.transcripts_unavailable === null || typeof agent.transcripts_unavailable === "string");
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
