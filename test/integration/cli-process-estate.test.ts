import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("built CLI salvages a top-level failure with its recorder enabled by default", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-process-estate-"));
  const script = path.join(directory, "workflow.js");
  const dataHome = path.join(directory, "data");
  const expectedEnvelope = {
    partial: true,
    reason: "failed",
    completed: []
  };

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "top-level-failure-salvage",
          description: "Built CLI failure-envelope proof"
        };
        throw new Error("ESTATE_TOP_LEVEL_FAILURE");
      `
    );

    const env: NodeJS.ProcessEnv = { ...process.env, XDG_DATA_HOME: dataHome };
    delete env.ENSEMBLE_RUN_RECORD;
    delete env.ENSEMBLE_RUN_RECORD_DIR;

    const cliPath = path.resolve("dist/src/cli/ensemble.js");
    const result = await runNode([cliPath, script], env);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `${JSON.stringify(expectedEnvelope)}\n`, result.stderr);
    assert.match(result.stderr, /Error: ESTATE_TOP_LEVEL_FAILURE/);

    const manifestPath = await findOnlyFile(dataHome, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      status: string;
      result: { archive_path: string | null; exit_code: number | null };
    };
    assert.equal(manifest.status, "failed");
    assert.deepEqual(manifest.result, {
      archive_path: "result.json",
      exit_code: 1
    });

    const recordedResult = JSON.parse(await readFile(path.join(path.dirname(manifestPath), "result.json"), "utf8")) as {
      status: string;
      exit_code: number;
      value: unknown;
    };
    assert.equal(recordedResult.status, "failed");
    assert.equal(recordedResult.exit_code, 1);
    assert.deepEqual(recordedResult.value, expectedEnvelope);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function findOnlyFile(root: string, basename: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const matches = entries.filter((entry) => path.basename(entry) === basename);
  assert.equal(matches.length, 1, `expected one ${basename}, found ${matches.length}`);
  return path.join(root, matches[0] ?? "");
}

async function runNode(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
