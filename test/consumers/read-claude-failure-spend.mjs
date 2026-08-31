/* global process */

/**
 * A cold consumer of a *failed* Claude turn: read the durable record back
 * with the run gone, and reconcile what it claims about spend against the
 * transcript it archived beside it. The reconciliation arithmetic is
 * reimplemented here rather than imported — a consumer parsing the archive
 * later has only the artefacts, so agreeing with the writer's own helper
 * would prove nothing.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { findOnlyFile, readJson } from "./archive-helpers.mjs";

const [recordStore] = process.argv.slice(2);
assert.ok(recordStore, "usage: read-claude-failure-spend.mjs <record-store>");

const agentPath = await findOnlyFile(recordStore, "agent.json");
const agent = await readJson(agentPath);
assert.equal(agent.schema_version, 3);
assert.equal(agent.kind, "agent_record");
assert.equal(agent.status, "failed");
assert.ok(Array.isArray(agent.transcripts), "a failed turn that left a transcript must list it");
assert.equal(agent.transcripts.length, 1);
assert.equal(agent.usage.unavailable, undefined, "a turn that spent tokens must not read as no-usage");

const archiveDir = path.dirname(path.dirname(path.dirname(agentPath)));
const transcriptText = await readFile(path.join(archiveDir, agent.transcripts[0].path), "utf8");

let outputTokens = 0;
let inputTokens = 0;
let cacheReadTokens = 0;
let cacheCreationTokens = 0;
for (const line of transcriptText.split("\n")) {
  if (line.trim().length === 0) {
    continue;
  }
  const entry = JSON.parse(line);
  const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
  if (usage === undefined || usage === null) {
    continue;
  }
  // Output accumulates across messages; the input side is the last message's
  // snapshot of the running context, charged once.
  outputTokens += usage.output_tokens ?? 0;
  inputTokens = usage.input_tokens ?? 0;
  cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
}
const cachedInputTokens = cacheReadTokens + cacheCreationTokens;
const provedTotal = inputTokens + cachedInputTokens + outputTokens;
assert.ok(provedTotal > 0, "the archived transcript itself must prove non-zero spend");

// Claude reports cache reads beside `input_tokens`, not within it, so the
// transcript's input snapshot is the summary's fresh-input class outright.
const summary = agent.usage.summary;
assert.equal(summary.outputTokens, outputTokens);
assert.equal(summary.freshInputTokens, inputTokens);
assert.equal(summary.cachedInputTokens, cachedInputTokens);
assert.equal(summary.cacheReadTokens, cacheReadTokens);
assert.equal(summary.cacheCreationTokens, cacheCreationTokens);
assert.equal(summary.unclassifiedTokens, 0);
assert.equal(summary.totalTokens, provedTotal);

const attempt = agent.attempts.at(-1);
assert.equal(attempt.status, "failed");
assert.ok(attempt.token_usage_events.length > 0, "the failed attempt must carry the spend it proved");

process.stdout.write(
  `${JSON.stringify({
    status: agent.status,
    failureKind: attempt.failure.kind,
    resolvedModel: attempt.resolved_model,
    provedFromTranscript: { inputTokens, cachedInputTokens, outputTokens, totalTokens: provedTotal },
    summary: {
      freshInputTokens: summary.freshInputTokens,
      cachedInputTokens: summary.cachedInputTokens,
      outputTokens: summary.outputTokens,
      totalTokens: summary.totalTokens
    }
  })}\n`
);
