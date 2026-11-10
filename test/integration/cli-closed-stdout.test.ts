import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { hermeticEstateEnvironment, runNode } from "./estate-process.js";

const launcher = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

async function withClosedStdout(args: string[], cwd?: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd,
    env: hermeticEstateEnvironment({
      ENSEMBLE_RUN_RECORD: "off",
      ENSEMBLE_STATUS: "off",
      ...(cwd === undefined ? {} : { ENSEMBLE_RUN_RECORD_DIR: path.join(cwd, "records") })
    }),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000
  });
  // Close the reader before the child starts writing: unlike `head`, this
  // guarantees EPIPE even when the complete help text fits in the pipe.
  child.stdout.destroy();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null) reject(new Error(`launcher ended with ${signal}: ${stderr}`));
      else resolve({ code, stderr });
    });
  });
}

test("launcher help exits quietly when its stdout reader closes", async () => {
  const result = await withClosedStdout(["--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
});

for (const fails of [false, true]) {
  test(`closed stdout preserves ${fails ? "failed" : "successful"} workflow settlement`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-closed-stdout-"));
    try {
      const script = path.join(directory, "workflow.mjs");
      await writeFile(script, fails
        ? 'export const meta = { name: "closed-stdout" }; throw new Error("deliberate workflow failure");\n'
        : 'export const meta = { name: "closed-stdout" }; return { answer: "x".repeat(1_000_000) };\n');
      const result = await withClosedStdout([script], directory);
      assert.equal(result.code, fails ? 1 : 0, result.stderr);
      assert.doesNotMatch(result.stderr, /EPIPE|Unhandled 'error'/);
      if (fails) assert.match(result.stderr, /deliberate workflow failure/);
      const sentinelPath = /\[sentinel\] will write (.+) when the run ends/.exec(result.stderr)?.[1];
      assert.ok(sentinelPath, result.stderr);
      const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as { exit_code: number };
      assert.equal(sentinel.exit_code, fails ? 1 : 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("launcher does not suppress stdout errors other than EPIPE", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-stdout-error-"));
  try {
    const preload = path.join(directory, "stdout-error.mjs");
    await writeFile(preload, `
      process.stdout.write = function () {
        process.nextTick(() => this.emit("error", Object.assign(new Error("stdout I/O failure"), { code: "EIO" })));
        return true;
      };
    `);
    const result = await runNode(["--import", preload, launcher, "--help"]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /stdout I\/O failure/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
