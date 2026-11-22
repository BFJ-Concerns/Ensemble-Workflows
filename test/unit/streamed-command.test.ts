import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CommandContainment } from "../../src/contained-command.js";
import { AgentPromptRejectedError, SubstrateRefusedError } from "../../src/errors.js";
import { OpenCodeCliRunner } from "../../src/opencode-engine.js";
import { MAX_ARGUMENT_BYTES, runStreamedCommand, type StreamedCommandOptions } from "../../src/streamed-command.js";
import { NoWorkerScopes } from "../../src/worker-scopes.js";

function options(commands: CommandContainment, overrides: Partial<StreamedCommandOptions>): StreamedCommandOptions {
  return {
    label: "fixture run", file: "/bin/true", args: [], cwd: process.cwd(), env: process.env,
    commands, timeoutMs: 10_000, killGraceMs: 100, signal: undefined, ...overrides
  };
}

test("a command that cannot be started is its substrate refusing, not a raw process error", async () => {
  const commands = new CommandContainment(new NoWorkerScopes());
  try {
    await assert.rejects(
      runStreamedCommand(options(commands, { file: "/nonexistent/zcode" })),
      (error: unknown) => error instanceof SubstrateRefusedError && /^fixture run could not be started \(ENOENT\)/.test(error.message)
    );
  } finally {
    await commands.close();
  }
});

test("Node rejecting a NUL in a command argument is not a substrate refusal", async () => {
  const commands = new CommandContainment(new NoWorkerScopes());
  try {
    await assert.rejects(
      runStreamedCommand(options(commands, { args: ["invalid\0prompt"] })),
      { code: "ERR_INVALID_ARG_VALUE" }
    );
  } finally {
    await commands.close();
  }
});

test("an argument longer than Linux passes is refused before anything spawns, naming the limit", async (t) => {
  const commands = new CommandContainment(new NoWorkerScopes());
  const contain = t.mock.method(commands, "contain");
  try {
    await assert.rejects(
      runStreamedCommand(options(commands, { args: ["x".repeat(MAX_ARGUMENT_BYTES)] })),
      (error: unknown) => error instanceof AgentPromptRejectedError && /at most 131072 bytes \(128 KiB\)/.test(error.message)
    );
    assert.equal(contain.mock.callCount(), 0);
  } finally {
    await commands.close();
  }
});

test("a command is given its stdin and reads it to the end", async () => {
  const commands = new CommandContainment(new NoWorkerScopes());
  try {
    const result = await runStreamedCommand(options(commands, { file: "/bin/cat", stdin: "carried on stdin" }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "carried on stdin");
  } finally {
    await commands.close();
  }
});

test("an opencode prompt too long for one argument reaches opencode on its stdin", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-stdin-"));
  const bin = path.join(dir, "opencode");
  // Prints its last argument, then how many bytes arrived on stdin.
  await writeFile(bin, '#!/bin/sh\nfor last; do :; done\nprintf "%s\\n" "$last"\nwc -c\n');
  await chmod(bin, 0o755);
  const commands = new CommandContainment(new NoWorkerScopes());
  try {
    const runner = new OpenCodeCliRunner(bin, { commands });
    const prompt = "p".repeat(200 * 1024);
    const long = await runner.run({ prompt, cwd: dir, providerModel: "fixture/model" });
    assert.deepEqual(long.stdout.trim().split("\n").map((line) => line.trim()), ["ensemble-worker", String(prompt.length)]);
    const short = await runner.run({ prompt: "short prompt", cwd: dir, providerModel: "fixture/model" });
    assert.deepEqual(short.stdout.trim().split("\n").map((line) => line.trim()), ["short prompt", "0"]);
  } finally {
    await commands.close();
    await rm(dir, { recursive: true, force: true });
  }
});
