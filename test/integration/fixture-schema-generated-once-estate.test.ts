import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { executablePath, hermeticEstateEnvironment } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const fixturePath = path.resolve("test/fixtures/codex/recording-app-server.mjs");

test("parallel built-CLI fixtures generate one shared schema without signal-kill residue", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-schema-generated-once-estate-"));
  const cacheDirectory = path.join(directory, "schema-cache");
  const binDirectory = path.join(directory, "bin");
  const workflow = path.join(directory, "workflow.js");
  try {
    await mkdir(cacheDirectory);
    await mkdir(binDirectory);
    // maxAttempts 1: the journey kills the fixture's app-server mid-turn and
    // reads the residue; under the one retry rule a wider bound would
    // re-dispatch against the dead substrate before the call settled.
    await writeFile(
      workflow,
      'export const meta = { name: "fixture-schema-generated-once" };\nreturn await agent("worker", { engine: "codex", maxAttempts: 1 });\n'
    );
    const fakeCodex = path.join(binDirectory, "codex");
    await writeFile(fakeCodex, `#!/usr/bin/env node\nimport ${JSON.stringify(fixturePath)};\n`);
    await chmod(fakeCodex, 0o755);
    const codexCli = await executablePath("codex");
    const common = {
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: directory,
      ENSEMBLE_CODEX_SCHEMA_CACHE_DIRECTORY: cacheDirectory,
      ENSEMBLE_CODEX_SCHEMA_CLI: codexCli,
      ENSEMBLE_RUN_RECORD: "0",
      ENSEMBLE_STATUS: "0"
    };
    const signalled = runCli(workflow, { ...common, ENSEMBLE_FAKE_CODEX_SIGNAL_AFTER_INITIALISE: "SIGKILL" });
    const peers = [runCli(workflow, common), runCli(workflow, common)];
    const [stopped, ...completed] = await Promise.all([signalled, ...peers]);

    t.diagnostic(JSON.stringify({ stopped, completed, generated: await schemaDirectories(cacheDirectory) }));
    // The signalled fixture dies straight after its handshake, before it
    // served a thread: no worker existed, so the run fails on the substrate
    // refusal, which precedes any worker, and the kill is legible on it.
    assert.equal(stopped.code, 1, stopped.stderr);
    const envelope = JSON.parse(stopped.stdout) as { reason: string; error: { kind: string } };
    assert.equal(envelope.reason, "failed");
    assert.equal(envelope.error.kind, "CodexSubstrateRefusedError");
    assert.match(stopped.stderr, /CodexSubstrateRefusedError: Codex app-server could not serve a thread in .*: Codex app-server exited/);
    assert.match(stopped.stderr, /signal SIGKILL/);
    for (const peer of completed) {
      assert.equal(peer.code, 0, peer.stderr);
      assert.equal(peer.stdout, '"worker-ok"\n');
    }
    assert.deepEqual(
      await uncachedSchemaEntries(directory),
      [],
      "a SIGKILLed fixture must not leave a per-process schema directory in its system temporary directory"
    );
    assert.equal((await schemaDirectories(cacheDirectory)).length, 1, "parallel fixture consumers must share one schema set");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runCli(workflow: string, envOverrides: NodeJS.ProcessEnv): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  // Local spawn (the shared helper does not surface the exit signal this
  // suite asserts on), but the environment is the shared hermetic one.
  const child = spawn(process.execPath, [bundledCliPath, workflow], {
    env: hermeticEstateEnvironment(envOverrides),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function schemaDirectories(cacheDirectory: string): Promise<string[]> {
  return readdir(cacheDirectory);
}

async function uncachedSchemaEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) =>
    entry.startsWith("ensemble-codex-schema-") || entry.startsWith(".ensemble-codex-schema-building-")
  );
}

