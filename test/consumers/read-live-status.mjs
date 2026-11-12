/* global process */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

import { createAcknowledgementWriter } from "./archive-helpers.mjs";

const spec = JSON.parse(await readFile(process.argv[2], "utf8"));
const agentKeys = ["id", "attempt", "engine", "label", "phase", "state", "startedAtMs", "firstEvidenceAtMs", "lastEvidenceAtMs", "finishedAtMs", "waitingOn", "requestedModel", "requestedEffort", "resolvedModel", "resolvedEffort", "transcript", "worktree", "spent", "failure"].sort();
// Every finished worker carries one of four dispositions, each counted under its own total.
const finishedCounts = { done: "done", failed: "failed", "cut-short": "cutShort", unsettled: "unsettled" };
const finishedStates = Object.keys(finishedCounts);
const snapshotKeys = ["schema", "runId", "pid", "archiveDir", "workflow", "state", "startedAt", "updatedAt", "finishedAt", "currentPhase", "totals", "agentCeiling", "engines", "agents", "holds", "owner"].sort();
const child = spawn(process.execPath, [spec.bundle, spec.workflow], {
  cwd: spec.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"]
});
let stdout = "";
let stderr = "";
let ended = false;
child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => { ended = true; resolve({ code, signal }); });
});
// Keep failures handled even when an assertion interrupts the polling loop.
void completion.catch(() => undefined);
const { acknowledge, hasAcknowledged } = createAcknowledgementWriter(spec.acknowledgements);
const workers = new Map();
let announcement;
let snapshot;
let released = false;
const deadline = Date.now() + (spec.timeoutMs ?? 45_000);
async function exists(file) {
  try { await access(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
try {
  while (!ended) {
    assert.ok(Date.now() < deadline, `status journey exceeded its deadline\n${stderr}`);
    const line = stderr.split("\n").find((entry) => entry.startsWith("[status-file] "));
    if (line && !announcement) announcement = JSON.parse(line.slice("[status-file] ".length));
    if (!announcement) { await delay(10); continue; }
    let current;
    try { current = JSON.parse(await readFile(announcement.status_path, "utf8")); } catch (error) {
      if (error.code === "ENOENT") { await delay(10); continue; }
      throw error;
    }
    snapshot = current;
    assert.equal(current.schema, 5);
    assert.deepEqual(Object.keys(current).sort(), snapshotKeys);
    assert.match(announcement.run_id, /^cwd:[0-9a-f]{24}:[0-9a-f-]{36}$/);
    assert.equal(current.runId, announcement.run_id.split(":")[2]);
    const archiveLine = stderr.split("\n").find((entry) => entry.startsWith("[run-record-archive] "));
    if (archiveLine) {
      const archive = JSON.parse(archiveLine.slice("[run-record-archive] ".length));
      assert.equal(announcement.run_id, archive.run_id);
      const manifest = JSON.parse(await readFile(path.join(archive.archive_path, "manifest.json"), "utf8"));
      assert.equal(announcement.run_id, manifest.run_id);
    }
    assert.equal(current.pid, child.pid);
    assert.equal(current.owner.pid, child.pid);
    assert.equal(current.agents.length,
      current.totals.active + current.totals.queued + current.totals.done + current.totals.failed +
        current.totals.cutShort + current.totals.unsettled,
      "every registered worker must be listed");
    const listedIds = new Set(current.agents.map((agent) => agent.id));
    assert.equal(listedIds.size, current.agents.length, "worker IDs must be unique");
    for (const id of workers.keys()) assert.ok(listedIds.has(id), `worker ${id} disappeared during the run`);
    if (spec.recording !== false) assert.ok(path.isAbsolute(current.archiveDir));
    else assert.equal(current.archiveDir, null);
    if (spec.readyFile && !hasAcknowledged("ready")) {
      await writeFile(spec.readyFile, JSON.stringify(announcement));
      await acknowledge("ready");
    }
    for (const agent of current.agents) {
      assert.deepEqual(Object.keys(agent).sort(), agentKeys);
      assert.ok(["queued", "running", ...finishedStates].includes(agent.state));
      for (const field of ["requestedModel", "requestedEffort", "resolvedModel", "resolvedEffort", "transcript", "worktree"]) {
        assert.ok(agent[field] === null || typeof agent[field] === "string", field);
      }
      for (const field of ["startedAtMs", "firstEvidenceAtMs", "lastEvidenceAtMs", "finishedAtMs", "spent"]) {
        assert.ok(agent[field] === null || (Number.isFinite(agent[field]) && agent[field] >= 0), field);
      }
      const observed = workers.get(agent.id) ?? { states: [], attempts: [], evidenceTimes: [], attemptEvidence: {}, transcriptPaths: [], admissionWaits: [], latest: null };
      workers.set(agent.id, observed);
      observed.latest = agent;
      if (agent.waitingOn?.kind === "admission") {
        assert.equal(agent.state, "queued");
        assert.ok(["engine-cap", "agent-ceiling"].includes(agent.waitingOn.gate));
        assert.ok(Number.isFinite(agent.waitingOn.sinceMs));
        if (!observed.admissionWaits.some((wait) => wait.gate === agent.waitingOn.gate)) {
          observed.admissionWaits.push({ ...agent.waitingOn, ceiling: current.agentCeiling, engineCap: current.engines[agent.engine].cap });
        }
      }
      if (!observed.states.includes(agent.state)) observed.states.push(agent.state);
      if (!observed.attempts.includes(agent.attempt)) observed.attempts.push(agent.attempt);
      const attemptTimes = observed.attemptEvidence[agent.attempt] ??= [];
      if (agent.lastEvidenceAtMs !== null) {
        if (!observed.evidenceTimes.includes(agent.lastEvidenceAtMs)) observed.evidenceTimes.push(agent.lastEvidenceAtMs);
        if (!attemptTimes.includes(agent.lastEvidenceAtMs)) attemptTimes.push(agent.lastEvidenceAtMs);
      }
      await acknowledge(`${agent.id}:attempt:${agent.attempt}`);
      if (agent.transcript !== null) {
        const transcript = path.isAbsolute(agent.transcript) ? agent.transcript : path.join(current.archiveDir, agent.transcript);
        assert.ok((await readFile(transcript)).length > 0, "published transcript must be readable");
        if (!observed.transcriptPaths.includes(agent.transcript)) observed.transcriptPaths.push(agent.transcript);
        if (spec.recording !== false && agent.state === "running") {
          const record = JSON.parse(await readFile(path.join(current.archiveDir, "agents", String(agent.id).padStart(6, "0"), "agent.json"), "utf8"));
          // The two files publish independently; wait for a matching revision
          // rather than treating a publication in flight as a contradiction.
          if (record.current_attempt?.attempt === agent.attempt && record.current_attempt.transcript === agent.transcript) {
            observed.liveRecordMatched = true;
            await acknowledge(`${agent.id}:matched`);
          }
        }
        if (agent.firstEvidenceAtMs !== null) {
          await acknowledge(`${agent.id}:evidence`);
          await acknowledge(`${agent.id}:${agent.attempt}:evidence`);
        }
      }
      if (agent.worktree !== null && agent.state === "running" && !observed.worktreeReadable && await exists(agent.worktree)) {
        observed.worktreeReadable = true;
        await acknowledge(`${agent.id}:worktree`);
      }
      await acknowledge(`${agent.id}:${agent.state}`);
      if (observed.evidenceTimes.length > 1 && agent.transcript !== null) await acknowledge(`${agent.id}:growth`);
      if (attemptTimes.length > 1 && agent.transcript !== null) await acknowledge(`${agent.id}:${agent.attempt}:growth`);
      if (agent.spent > 0) await acknowledge(`${agent.id}:usage`);
      if (finishedStates.includes(agent.state)) {
        assert.ok(agent.finishedAtMs !== null);
        assert.equal(agent.waitingOn, null);
        if (agent.state !== "done") {
          assert.equal(typeof agent.failure?.kind, "string");
          assert.equal(typeof agent.failure?.message, "string");
          assert.ok(agent.failure.message.length > 0);
        } else assert.equal(agent.failure, null);
      }
    }
    const expected = spec.workers ?? [];
    const settled = expected.every((entry) => workers.get(entry.id)?.latest?.state === entry.state);
    const totalsMatch = spec.terminalTotals === undefined || finishedStates.reduce((sum, state) => sum + current.totals[finishedCounts[state]], 0) === spec.terminalTotals;
    const authorised = spec.finishWhen === undefined || await exists(spec.finishWhen);
    if (!released && settled && totalsMatch && authorised) {
      // The workflow waits here after workers settle, so outcomes are read
      // from a live file, never inferred from the final archive.
      await acknowledge("all-settled");
      await writeFile(spec.releaseFile, "");
      released = true;
    }
    await delay(10);
  }
  const result = await completion;
  assert.ok(announcement, `no status location announced\n${stderr}`);
  assert.equal(result.code, spec.exitCode ?? 0, stderr);
  assert.ok(snapshot, "status file was never read while the launcher lived");
  assert.ok(released, "workflow exited before the consumer observed its settlements");
  assert.equal(await exists(announcement.status_path), false, "status survived normal shutdown");
  for (const expected of spec.workers ?? []) {
    const observed = workers.get(expected.id);
    assert.ok(observed, `worker ${expected.id} was never visible`);
    const agent = observed.latest;
    for (const [key, value] of Object.entries(expected)) {
      if (["queued", "worktree", "growth", "live", "admissionGate"].includes(key)) continue;
      assert.deepEqual(agent[key], value, `worker ${expected.id}: ${key}`);
    }
    if (expected.queued) assert.ok(observed.states.includes("queued"));
    if (expected.admissionGate) assert.ok(observed.admissionWaits.some((wait) => wait.gate === expected.admissionGate),
      `worker ${expected.id} never published ${expected.admissionGate}`);
    if (expected.growth) assert.ok(observed.evidenceTimes.length > 1);
    if (expected.worktree) {
      assert.ok(path.isAbsolute(agent.worktree));
      assert.ok(observed.worktreeReadable, "worktree was never readable while running");
    }
    if (expected.live) {
      assert.ok(agent.resolvedModel && agent.resolvedEffort && agent.transcript);
      assert.ok(agent.spent > 0, "live worker's own usage never appeared");
      assert.ok(observed.liveRecordMatched, "transcript never matched its agent record while running");
    }
    if (spec.recording !== false) {
      const record = JSON.parse(await readFile(path.join(snapshot.archiveDir, "agents", String(agent.id).padStart(6, "0"), "agent.json"), "utf8"));
      assert.equal(agent.requestedModel, record.model);
      assert.equal(agent.requestedEffort, record.effort);
      assert.equal(agent.resolvedModel, record.resolved_model);
      assert.equal(agent.resolvedEffort, record.resolved_effort);
      if (agent.worktree !== null) assert.equal(agent.worktree, record.resolved_cwd);
      if (record.usage.summary) assert.equal(agent.spent, record.usage.summary.totalTokens);
      // Native Claude paths identify the running session; settlement archives
      // a copy. Archive-backed Codex references keep their path at settlement.
      if (agent.transcript !== null && !path.isAbsolute(agent.transcript)) {
        assert.ok(record.transcripts.some((entry) => entry.path === agent.transcript));
      }
      if (finishedStates.includes(agent.state) && agent.state !== "done") {
        const failure = record.termination_cause ?? record.attempts.findLast((entry) => entry.failure !== null)?.failure;
        assert.deepEqual(agent.failure, failure);
      }
    }
  }
  if (spec.retainedCount !== undefined) assert.equal(snapshot.agents.length, spec.retainedCount);
  process.stdout.write(JSON.stringify({ announcement, snapshot, workers: [...workers.entries()], stdout: JSON.parse(stdout), stderr }) + "\n");
} finally {
  if (!ended) {
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await completion;
    clearTimeout(killer);
  }
}
