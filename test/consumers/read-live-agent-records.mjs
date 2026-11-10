/* global process */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

import { createAcknowledgementWriter } from "./archive-helpers.mjs";

const [store, expectedCount, timeout = "45000", acknowledgements] = process.argv.slice(2);
assert.ok(store && Number(expectedCount) > 0, "usage: read-live-agent-records.mjs <store> <agent-count> [timeout-ms] [acknowledgements-file]");
const expectedKeys = JSON.parse(await readFile(new URL("../fixtures/run-record/v4-agent-keys.json", import.meta.url), "utf8"));
const observed = new Map();
const deadline = Date.now() + Number(timeout);
const { acknowledge } = createAcknowledgementWriter(acknowledgements);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

for (;;) {
  assert.ok(Date.now() < deadline, "archive did not settle before the consumer deadline");
  const controls = acknowledgements === undefined ? [] : (await readFile(acknowledgements, "utf8")).split("\n");
  // The observer can fail before every expected agent exists. Its cleanup
  // stops this reader without waiting for an archive that cannot complete.
  if (controls.includes("stop")) process.exit(0);
  const entries = await readdir(store, { recursive: true });
  const manifests = entries.filter((entry) => path.basename(entry) === "manifest.json");
  for (const relative of manifests) {
    const archive = path.dirname(path.join(store, relative));
    const manifest = await readJson(path.join(archive, "manifest.json"));
    if (manifest === null) continue;
    const agents = entries.filter((entry) => path.basename(entry) === "agent.json" && path.join(store, entry).startsWith(archive + path.sep));
    for (const entry of agents) {
      const file = path.join(store, entry);
      const agent = await readJson(file);
      if (agent === null) continue;
      const observation = observed.get(file) ?? { id: agent.id, label: agent.label, queued: false, attempts: new Map() };
      observed.set(file, observation);
      observation.session = agent.session;
      const current = agent.current_attempt;
      if (agent.status === "in-progress" && current === undefined) {
        observation.queued = true;
        await acknowledge(`queued:${agent.label}`);
      }
      if (current === undefined) continue;
      assert.equal(agent.status, "in-progress");
      assert.ok(Number.isInteger(current.attempt) && current.attempt > 0);
      assert.ok(Number.isFinite(Date.parse(current.started_at)));
      const attempt = observation.attempts.get(current.attempt) ?? {
        attempt: current.attempt, started_at: current.started_at, transcript: null, sizes: [], lastContent: null
      };
      observation.attempts.set(current.attempt, attempt);
      assert.equal(attempt.started_at, current.started_at, "start time changed during an attempt");
      if (controls.includes(`seal:${agent.id}:${current.attempt}`)) {
        await acknowledge(`sealed:${agent.id}:${current.attempt}`);
        continue;
      }
      if (current.transcript !== null) {
        const transcript = path.isAbsolute(current.transcript) ? current.transcript : path.join(archive, current.transcript);
        if (!path.isAbsolute(current.transcript)) {
          assert.ok(current.transcript.startsWith(`agents/${path.basename(path.dirname(file))}/`));
        } else {
          assert.ok(path.isAbsolute(current.transcript), "engine-owned transcript must have an absolute path");
        }
        const bytes = await readFile(transcript);
        if (attempt.transcript !== null) assert.equal(attempt.transcript, current.transcript);
        attempt.transcript = current.transcript;
        if (attempt.sizes.at(-1) !== bytes.length) attempt.sizes.push(bytes.length);
        if (attempt.lastContent !== null) {
          assert.ok(bytes.subarray(0, attempt.lastContent.length).equals(attempt.lastContent), "live transcript lost previously read bytes");
        }
        attempt.lastContent = bytes;
        await acknowledge(`readable:${agent.label}`);
        if (attempt.sizes.length > 1) {
          await acknowledge(`growth:${agent.label}`);
          await acknowledge(`growth:${agent.id}:${current.attempt}`);
        }
        const marker = `observed:${agent.id}:${current.attempt}`;
        await acknowledge(`${marker}:started`);
        const deltas = bytes.toString("utf8").split("\n").filter((line) => line.includes('"method":"item/agentMessage/delta"')).length;
        if (deltas >= 1) await acknowledge(`${marker}:output`);
        if (deltas >= 2) await acknowledge(`${marker}:grown`);
      }
    }
    if (manifest.status === "in-progress" || agents.length !== Number(expectedCount)) continue;
    assert.equal(manifest.status, "complete", "expected the workflow to finish normally");
    for (const entry of agents) {
      const file = path.join(store, entry);
      const agent = await readJson(file);
      assert.ok(agent !== null);
      assert.equal(agent.current_attempt, undefined);
      assert.deepEqual(Object.keys(agent).sort(), expectedKeys);
      const observation = observed.get(file);
      for (const attempt of observation.attempts.values()) {
        const settled = agent.attempts.find((candidate) => candidate.attempt === attempt.attempt);
        assert.ok(settled, "observed attempt is absent from the settled record");
        assert.equal(settled.started_at, attempt.started_at);
        if (attempt.transcript !== null && path.isAbsolute(attempt.transcript)) {
          const reference = agent.transcripts.find((candidate) => candidate.attempt === attempt.attempt);
          assert.ok(reference, "engine-owned live transcript was not archived");
          const bytes = await readFile(path.join(archive, reference.path));
          assert.ok(bytes.subarray(0, attempt.lastContent.length).equals(attempt.lastContent),
            `archive lost engine-owned transcript bytes: agent=${agent.id} attempt=${attempt.attempt} captured=${bytes.length} observed=${attempt.lastContent.length} commonPrefix=${bytes.subarray(0, Math.min(bytes.length, attempt.lastContent.length)).equals(attempt.lastContent.subarray(0, Math.min(bytes.length, attempt.lastContent.length)))}`);
        }
        if (attempt.transcript !== null && !path.isAbsolute(attempt.transcript)) {
          assert.ok(agent.transcripts.some((reference) => reference.path === attempt.transcript && reference.attempt === attempt.attempt));
          const bytes = await readFile(path.join(archive, attempt.transcript));
          assert.ok(bytes.subarray(0, attempt.lastContent.length).equals(attempt.lastContent), "settlement replaced streamed bytes");
          for (const line of bytes.toString("utf8").trim().split("\n")) JSON.parse(line);
        }
      }
    }
    for (const file of manifest.files) {
      const bytes = await readFile(path.join(archive, file.path));
      assert.equal(bytes.length, file.size, file.path);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
    }
    process.stdout.write(`${JSON.stringify([...observed.values()].map((observation) => ({
      ...observation,
      attempts: [...observation.attempts.values()].map(({ lastContent, ...attempt }) => ({ ...attempt, readable: lastContent !== null }))
    })))}\n`);
    process.exit(0);
  }
  await delay(10);
}
