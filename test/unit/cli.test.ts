import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runEnsembleCli } from "../../src/cli.js";

import type { EnsembleRuntime } from "../../src/runtime.js";
import type { Budget } from "../../src/types.js";

class CaptureStream extends Writable {
  chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

test("CLI prints result JSON to stdout and logs to stderr", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli" };
      log("hello stderr");
      return { args };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script, "a", "b"], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.text(), "{\"args\":[\"a\",\"b\"]}\n");
  assert.equal(stderr.text(), "hello stderr\n");
});

test("CLI returns non-zero and writes errors to stderr when the script throws", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-error" };
      throw new Error("bad workflow");
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /Error: bad workflow/);
});

test("CLI entrypoint runs when invoked through a symlinked binary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-bin-"));
  const binPath = path.join(directory, "ensemble");
  const entrypointPath = fileURLToPath(new URL("../../src/cli/ensemble.js", import.meta.url));
  await symlink(entrypointPath, binPath);

  const result = spawnSync(process.execPath, [binPath], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Usage: ensemble <script.js> [args...]\n");
});

function fakeRuntime(): EnsembleRuntime {
  const budget: Budget = {
    spent: () => 0,
    remaining: () => Number.POSITIVE_INFINITY
  };

  return {
    budget,
    worktrees: [],
    onEvent: () => () => {},
    agent: async (prompt: string) => prompt,
    close: async () => {}
  } as unknown as EnsembleRuntime;
}
