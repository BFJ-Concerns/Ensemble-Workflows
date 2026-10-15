import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RunRecordWriter } from "../../src/run-record.js";

import type { RuntimeAgentRecord } from "../../src/run-record.js";

test("a cold archive consumer finds no artefact or files-table row for a suppressed empty transcript", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-empty-transcript-archive-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd: process.cwd(),
    runUuid: "empty-transcript-artefact",
    workflowPath: path.join(process.cwd(), "session-workflow.js"),
    workflowSource: "export const meta = { task: 'empty transcript artefact' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });

  try {
    await writer.recordAgent(agentWithSuppressedTranscript());
    await writer.finish({ status: "complete", exitCode: 0, result: null });

    const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
      transcripts: Array<{ path: string }>;
      transcripts_unavailable: string | null;
      transcript_capture: "retained" | "lost" | null;
    };
    const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
      files: Array<{ path: string }>;
    };
    const archivePaths = await readdir(writer.archiveDir, { recursive: true });

    // This is deliberately a cold consumer's own walk. It does not trust the
    // writer's filtering at the API boundary: the declared reference, the
    // archive tree, and the manifest's integrity table must agree that there
    // is no transcript artefact to consume.
    assert.deepEqual(agent.transcripts, []);
    assert.equal(agent.transcript_capture, "lost");
    assert.equal(agent.transcripts_unavailable, "session-client-capture-gap");
    assert.equal(archivePaths.some((entry) => entry.endsWith("empty-follow-up.jsonl")), false);
    assert.equal(manifest.files.some((entry) => entry.path.endsWith("empty-follow-up.jsonl")), false);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

function agentWithSuppressedTranscript(): RuntimeAgentRecord {
  return {
    id: 1,
    engine: "codex",
    headerIdentity: "original_request",
    prompt: "follow-up prompt",
    options: { timeoutMs: null, maxAttempts: 1 },
    model: null,
    effort: null,
    fallback: null,
    lean: null,
    answeredBy: null,
    resolvedModel: null,
    resolvedEffort: null,
    resolvedCwd: process.cwd(),
    isolation: null,
    worktree: null,
    label: null,
    phase: null,
    status: "complete",
    terminationCause: null,
    creationOrder: 1,
    concurrencyGroup: "codex",
    schema: null,
    strip: null,
    session: { id: 1, turn: 2 },
    transcriptCapture: "lost",
    parseRoute: null,
    decodeFailure: null,
    rawOutput: "",
    validatedOutput: null,
    queuedMs: 0,
    executionMs: 0,
    attempts: [
      {
        attempt: 1,
        status: "complete",
        target: { engine: "codex", model: null },
        failure: null,
        classification: null,
        chainDecision: null,
        observedFailure: null,
        workerExit: null,
      backgroundWaits: [],
        appServerDiagnostic: null,
        rawOutput: "",
        validatedOutput: null,
        resolvedModel: null,
        resolvedEffort: null,
        startedAt: "2026-09-01T00:00:00.000Z",
        endedAt: "2026-09-01T00:00:00.000Z",
        durationMs: 0,
        firstDeltaMs: null,
        tokenUsageEvents: [],
        transcripts: [
          {
            filename: "empty-follow-up.jsonl",
            format: "jsonl",
            source: "codex-app-server",
            threadId: "thread-1",
            content: ""
          }
        ],
        diagnostics: {}
      }
    ]
  };
}
