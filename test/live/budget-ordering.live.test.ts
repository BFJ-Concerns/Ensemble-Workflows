import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isStatusFileName } from "../../src/status-file.js";
import { liveCodexScriptOptions } from "./live-models.js";

const isLive = process.env.ENSEMBLE_LIVE === "1";
const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

test(
  "live built Codex consumer rejects an exhausted next call without transport, progress, or durable dispatch evidence",
  { skip: !isLive, timeout: 240_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-budget-ordering-"));
    const workflow = path.join(directory, "workflow.js");
    const recordStore = path.join(directory, "records");
    const statusDirectory = path.join(directory, "status");
    const token = `LIVE_BUDGET_ADMISSION_${randomUUID()}`;
    await mkdir(statusDirectory);

    try {
      await writeFile(
        workflow,
        `
          export const meta = {
            name: "live-budget-dispatch-admission",
            task: { id: "budget-ordering-live-proof", family: "budget-ordering" }
          };
          const admitted = await agent(
            "Reply with exactly ${token} and nothing else.",
            { engine: "codex", ${liveCodexScriptOptions()} label: "admitted-live", maxAttempts: 1, timeoutMs: 180000 }
          );
          let blocked;
          try {
            await agent(
              "Reply with BLOCKED_CALL_RAN_${token}.",
              { engine: "codex", ${liveCodexScriptOptions()} label: "blocked-live", maxAttempts: 1, timeoutMs: 180000 }
            );
            blocked = null;
          } catch (error) {
            blocked = { name: error?.name ?? null, message: String(error?.message ?? error) };
          }
          return { admitted, blocked, spent: budget.spent("codex") };
        `
      );

      const snapshots: ProgressSnapshot[] = [];
      const result = await runNodeAndReadStatus(
        [bundledCliPath, "--budget=codex=1", workflow],
        {
          ...process.env,
          ENSEMBLE_RUN_RECORD: "1",
          ENSEMBLE_RUN_RECORD_DIR: recordStore,
          ENSEMBLE_STATUS: "1",
          ENSEMBLE_STATUS_DIR: statusDirectory,
          XDG_DATA_HOME: path.join(directory, "data")
        },
        statusDirectory,
        snapshots
      );

      assert.equal(result.code, 0, result.stderr);
      const output = JSON.parse(result.stdout) as {
        admitted: string;
        blocked: { name: string; message: string } | null;
        spent: number;
      };
      assert.equal(typeof output.admitted, "string", `the admitted call returned no text: ${result.stdout}`);
      assert.ok(output.spent >= 1);
      assert.equal(output.blocked?.name, "BudgetExceededError");
      assert.match(output.blocked?.message ?? "", /Token budget exhausted for codex/);
      assert.ok(snapshots.some((snapshot) => snapshot.agents.some((agent) => agent.label === "admitted-live")));
      assert.ok(snapshots.every((snapshot) => snapshot.agents.every((agent) => agent.label !== "blocked-live")));

      const archive = await readArchiveAsConsumer(recordStore);
      assert.equal(archive.manifest.schema_version, 4);
      assert.deepEqual(archive.manifest.meta.task, {
        id: "budget-ordering-live-proof",
        family: "budget-ordering"
      });
      assert.equal(archive.agents.length, 1);
      assert.equal(archive.agents[0]?.label, "admitted-live");
      assert.equal(archive.agents[0]?.status, "complete");
      assert.equal(archive.agents[0]?.attempts.length, 1);
      assert.ok((archive.agents[0]?.attempts[0]?.token_usage_events.length ?? 0) > 0);
      assert.ok((archive.agents[0]?.resolved_model?.length ?? 0) > 0);
      // Whatever the worker replied, the archive must hold the same reply the
      // script received, as the agent's output and in the run's result.
      assert.equal(archive.agents[0]?.raw_output, output.admitted);
      assert.equal(archive.result.value.admitted, output.admitted);
      assert.equal(archive.result.value.blocked?.name, "BudgetExceededError");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

interface ProgressSnapshot {
  agents: Array<{ label: string | null }>;
}

interface Manifest {
  schema_version: number;
  meta: { task: unknown };
  files: Array<{ path: string; size: number; sha256: string }>;
}

interface AgentRecord {
  label: string | null;
  status: string;
  resolved_model: string | null;
  raw_output: string | null;
  attempts: Array<{ token_usage_events: unknown[] }>;
}

async function runNodeAndReadStatus(
  args: string[],
  env: NodeJS.ProcessEnv,
  statusDirectory: string,
  snapshots: ProgressSnapshot[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env });
    let stdout = "";
    let stderr = "";
    // The run publishes under its own name, which the poller learns by
    // listing the directory — the consumer's own discovery step.
    const poll = setInterval(() => {
      void readdir(statusDirectory)
        .then(async (entries) => {
          for (const entry of entries.filter(isStatusFileName)) {
            snapshots.push(JSON.parse(await readFile(path.join(statusDirectory, entry), "utf8")) as ProgressSnapshot);
          }
        })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") reject(error);
        });
    }, 5);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => {
      clearInterval(poll);
      resolve({ code, stdout, stderr });
    });
  });
}

async function readArchiveAsConsumer(recordStore: string): Promise<{
  manifest: Manifest;
  agents: AgentRecord[];
  result: { exit_code: number; value: { admitted: string; blocked: { name: string } | null } };
}> {
  const entries = await readdir(recordStore, { recursive: true });
  const manifestEntry = entries.find((entry) => path.basename(entry) === "manifest.json");
  assert.ok(manifestEntry, "the live run did not write a manifest");
  const archiveDirectory = path.dirname(path.join(recordStore, manifestEntry));
  const manifest = JSON.parse(await readFile(path.join(recordStore, manifestEntry), "utf8")) as Manifest;

  for (const file of manifest.files) {
    const contents = await readFile(path.join(archiveDirectory, file.path));
    assert.equal(contents.byteLength, file.size, `${file.path} size did not match the manifest`);
    assert.equal(createHash("sha256").update(contents).digest("hex"), file.sha256, `${file.path} hash mismatch`);
  }

  const agents = await Promise.all(
    entries
      .filter((entry) => path.basename(entry) === "agent.json")
      .map(async (entry) => JSON.parse(await readFile(path.join(recordStore, entry), "utf8")) as AgentRecord)
  );
  const result = JSON.parse(await readFile(path.join(archiveDirectory, "result.json"), "utf8")) as {
    exit_code: number;
    value: { admitted: string; blocked: { name: string } | null };
  };
  return { manifest, agents, result };
}
