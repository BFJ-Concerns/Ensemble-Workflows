import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const isLive = process.env.ENSEMBLE_LIVE === "1";

test(
  "live built CLI salvages completed Codex output and a consumer can recover it from the archive alone",
  { skip: !isLive, timeout: 300_000 },
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
            model: "gpt-5.6-terra",
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
        result.stderr,
        "WorkflowScriptError: workflow return value must be a JSON value: return value.settlementFailure is a BigInt\n"
      );
      const envelope = JSON.parse(result.stdout) as SalvageEnvelope;
      assert.deepEqual(envelope, {
        partial: true,
        reason: "failed",
        completed: [{ id: 1, engine: "codex", label: "live-serialisability-worker", phase: null, output: { token } }]
      });

      // The consumer boundary: forget the process objects and reconstruct
      // the claim solely from the versioned files beneath the resolved store.
      const manifestPath = await findOnlyFile(dataHome, "manifest.json");
      const archiveDir = path.dirname(manifestPath);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RunManifest;
      assert.equal(manifest.schema_version, 2);
      assert.equal(manifest.kind, "run_manifest");
      assert.equal(manifest.status, "failed");
      assert.deepEqual(manifest.meta.task, { id: "serialisability-salvage", family: "verification-estate" });
      assert.deepEqual(manifest.result, { archive_path: "result.json", exit_code: 1 });

      for (const file of manifest.files) {
        const bytes = await readFile(path.join(archiveDir, file.path));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
        assert.equal(bytes.byteLength, file.bytes, file.path);
      }

      const archivedResult = JSON.parse(await readFile(path.join(archiveDir, "result.json"), "utf8")) as RunResult;
      assert.equal(archivedResult.schema_version, 2);
      assert.equal(archivedResult.kind, "run_result");
      assert.equal(archivedResult.status, "failed");
      assert.equal(archivedResult.exit_code, 1);
      assert.deepEqual(archivedResult.value, envelope);

      const agentPath = await findOnlyFile(archiveDir, "agent.json");
      const agent = JSON.parse(await readFile(agentPath, "utf8")) as RecordedAgent;
      assert.equal(agent.schema_version, 2);
      assert.equal(agent.kind, "agent_record");
      assert.equal(agent.status, "complete");
      assert.equal(agent.label, "live-serialisability-worker");
      assert.deepEqual(agent.output, { token });
      assert.equal(agent.attempts.length, 1);
      assert.equal(agent.attempts[0]?.status, "complete");
      assert.deepEqual(agent.attempts[0]?.validated_output, { token });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

interface SalvageEnvelope {
  partial: true;
  reason: "failed";
  completed: Array<{ id: number; engine: string; label: string | null; phase: string | null; output: unknown }>;
}

interface RunManifest {
  schema_version: number;
  kind: string;
  status: string;
  meta: { task?: { id: string; family?: string } };
  result: { archive_path: string | null; exit_code: number | null };
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

interface RunResult {
  schema_version: number;
  kind: string;
  status: string;
  exit_code: number;
  value: unknown;
}

interface RecordedAgent {
  schema_version: number;
  kind: string;
  status: string;
  label: string | null;
  output: unknown;
  attempts: Array<{ status: string; validated_output: unknown }>;
}

async function findOnlyFile(root: string, basename: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const matches = entries.filter((entry) => path.basename(entry) === basename);
  assert.equal(matches.length, 1, `expected one ${basename}, found ${matches.length}`);
  return path.join(root, matches[0] ?? "");
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
