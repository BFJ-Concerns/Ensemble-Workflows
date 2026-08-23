import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const fixturePath = path.resolve("test/fixtures/codex/recording-app-server.mjs");

test("parallel built-CLI fixtures generate one shared schema and clean it after a signalled fixture", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-schema-generated-once-estate-"));
  const cacheDirectory = path.join(directory, "schema-cache");
  const binDirectory = path.join(directory, "bin");
  const workflow = path.join(directory, "workflow.js");
  await mkdir(cacheDirectory);
  await mkdir(binDirectory);
  await writeFile(workflow, 'export const meta = { name: "fixture-schema-generated-once" };\nreturn await agent("worker", { engine: "codex" });\n');
  const fakeCodex = path.join(binDirectory, "codex");
  await writeFile(fakeCodex, `#!/usr/bin/env node\nimport ${JSON.stringify(fixturePath)};\n`);
  await chmod(fakeCodex, 0o755);
  const codexCli = await executablePath("codex");

  try {
    const common = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      ENSEMBLE_CODEX_SCHEMA_CACHE_DIRECTORY: cacheDirectory,
      ENSEMBLE_CODEX_SCHEMA_CLI: codexCli,
      ENSEMBLE_RUN_RECORD: "0",
      ENSEMBLE_STATUS: "0"
    };
    const signalled = runCli(workflow, { ...common, ENSEMBLE_FAKE_CODEX_SIGNAL_AFTER_INITIALISE: "SIGTERM" });
    const peers = [runCli(workflow, common), runCli(workflow, common)];
    const [stopped, ...completed] = await Promise.all([signalled, ...peers]);

    t.diagnostic(JSON.stringify({ stopped, completed, generated: await schemaDirectories(cacheDirectory) }));
    assert.notEqual(stopped.code, 0, "the CLI must notice that its fixture was signalled");
    for (const peer of completed) {
      assert.equal(peer.code, 0, peer.stderr);
      assert.equal(peer.stdout, '"worker-ok"\n');
    }
    assert.equal((await schemaDirectories(cacheDirectory)).length, 1, "parallel fixture consumers must share one schema set");
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }

  await assert.rejects(access(cacheDirectory), "the suite-owner cleanup must leave no schema directory behind");
});

function runCli(workflow: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [bundledCliPath, workflow], { env, stdio: ["ignore", "pipe", "pipe"] });
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
  return (await readdir(cacheDirectory)).filter((entry) => !entry.startsWith("."));
}

async function executablePath(name: string): Promise<string> {
  const child = spawn("which", [name], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, `required executable ${name} is unavailable: ${stderr}`);
  return stdout.trim();
}
