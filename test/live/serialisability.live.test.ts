import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { liveCodexModel } from "./live-models.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const archiveReaderPath = path.resolve("test/consumers/read-run-record.mjs");
const isLive = process.env.ENSEMBLE_LIVE === "1";

// Every run announces its completion sentinel on stderr at startup, so an
// exact-stderr assertion must account for that line. Removing exactly one
// well-formed announcement — and failing when it is absent, malformed, or
// duplicated — keeps the original assertion's protection over the remaining
// bytes while additionally pinning the announcement's own shape.
function withoutSentinelAnnouncement(stderr: string): string {
  const announcement = /^\[sentinel\] will write \S+\/completion-sentinel\.json when the run ends\n/gm;
  const matches = stderr.match(announcement) ?? [];
  assert.equal(matches.length, 1, `expected exactly one completion-sentinel announcement, got:\n${stderr}`);
  return stderr.replace(announcement, "");
}

// The CLI likewise announces the run's id and archive path on stderr at
// startup. Same discipline as the sentinel helper: remove exactly one
// well-formed announcement, failing when it is absent, malformed, or
// duplicated, so the exact-stderr assertion keeps its protection while this
// line's own shape stays pinned.
function withoutArchiveAnnouncement(stderr: string): string {
  const announcement = /^\[run-record-archive\] \{"run_id":"[^"\n]+","archive_path":"[^"\n]+"\}\n/gm;
  const matches = stderr.match(announcement) ?? [];
  assert.equal(matches.length, 1, `expected exactly one run-record-archive announcement, got:\n${stderr}`);
  return stderr.replace(announcement, "");
}

test(
  "live built CLI salvages completed Codex output and a consumer can recover it from the archive alone",
  { skip: !isLive || (liveCodexModel === undefined ? "ENSEMBLE_LIVE_CODEX_MODEL is unset" : false), timeout: 300_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-serialisability-"));
    const script = path.join(directory, "workflow.js");
    const dataHome = path.join(directory, "data");
    const token = `LIVE_SERIALISABILITY_${randomUUID()}`;

    try {
      await writeFile(
        script,
        `
          export const meta = {
            name: "live-serialisability-salvage",
            task: { id: "serialisability-salvage", family: "verification-estate" }
          };
          const completed = await agent("Return exactly one JSON object containing token ${token}.", {
            engine: "codex",
            model: ${JSON.stringify(liveCodexModel)},
            effort: "low",
            maxAttempts: 1,
            timeoutMs: 180000,
            label: "live-serialisability-worker",
            schema: {
              type: "object",
              required: ["token"],
              additionalProperties: false,
              properties: { token: { type: "string", enum: ["${token}"] } }
            }
          });
          return { completed, settlementFailure: 10n };
        `
      );

      const env: NodeJS.ProcessEnv = { ...process.env, XDG_DATA_HOME: dataHome, ENSEMBLE_STATUS: "0" };
      delete env.ENSEMBLE_RUN_RECORD;
      delete env.ENSEMBLE_RUN_RECORD_DIR;
      const result = await runNode([bundledCliPath, script], env);

      assert.equal(result.code, 1, result.stderr);
      assert.equal(
        withoutArchiveAnnouncement(withoutSentinelAnnouncement(result.stderr)),
        "WorkflowScriptError: workflow return value must be a JSON value: return value.settlementFailure is a BigInt\n"
      );
      const envelope = JSON.parse(result.stdout) as SalvageEnvelope;
      assert.deepEqual(envelope, {
        partial: true,
        reason: "failed",
        error: {
          kind: "WorkflowScriptError",
          message: "workflow return value must be a JSON value: return value.settlementFailure is a BigInt"
        },
        completed: [{ id: 1, engine: "codex", label: "live-serialisability-worker", phase: null, output: { token } }]
      });

      // A fresh process receives only the resolved data home. Its stdout is
      // therefore the archive consumer's reconstruction, not retained state
      // from the producer process or this test's in-memory envelope.
      const reader = await runNode([archiveReaderPath, dataHome], { ...process.env });
      assert.equal(reader.code, 0, reader.stderr);
      assert.deepEqual(JSON.parse(reader.stdout), {
        task: { id: "serialisability-salvage", family: "verification-estate" },
        status: "failed",
        exitCode: 1,
        completed: envelope.completed,
        recordedAgent: {
          label: "live-serialisability-worker",
          output: { token },
          attemptStatus: "complete"
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

interface SalvageEnvelope {
  partial: true;
  reason: "failed";
  error: { kind: string; message: string };
  completed: Array<{ id: number; engine: string; label: string | null; phase: string | null; output: unknown }>;
}

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
