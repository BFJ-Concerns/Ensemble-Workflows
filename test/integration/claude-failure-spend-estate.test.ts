import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const fakeClaudePath = path.resolve("test/fixtures/claude/blocked-worker-cli.mjs");
const archiveReaderPath = path.resolve("test/consumers/read-claude-failure-spend.mjs");

/**
 * The built CLI, driven as a caller drives it, over a Claude worker that
 * generates real output and then fails operationally. The live engine's leg
 * of this journey is declined for a named reason — a mid-turn kill of a
 * `claude --bg` worker cannot be aimed at one session inside the shared
 * per-user daemon — so the fixture supplies that condition and only that
 * condition: dispatch, roster, transcript and teardown are the real control
 * plane's own surfaces, and the archive is read back cold afterwards.
 */
test("built CLI archives the spend and transcript a failed Claude worker already proved", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-claude-failure-spend-estate-"));
  const binDirectory = path.join(directory, "bin");
  const recordStore = path.join(directory, "records");
  const workerHome = path.join(directory, "home");
  try {
    await mkdir(binDirectory);
    await mkdir(workerHome);
    await writeFile(
      path.join(binDirectory, "claude"),
      `#!/usr/bin/env node\nimport ${JSON.stringify(fakeClaudePath)};\n`
    );
    await chmod(path.join(binDirectory, "claude"), 0o755);
    // No reply valve: the engine's blocked recovery needs tmux, so its bound
    // is spent at once and the worker's failure is immediate rather than
    // nudged. A `tmux` on the machine's PATH would otherwise be found.
    await writeFile(path.join(binDirectory, "tmux"), "#!/usr/bin/env node\nprocess.exit(1);\n");
    await chmod(path.join(binDirectory, "tmux"), 0o755);

    const run = await runNode(
      [bundledCliPath, "agent", "--engine", "claude", "--max-attempts", "1", "decide something"],
      {
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: workerHome,
        ENSEMBLE_FAKE_CLAUDE_STATE: path.join(directory, "roster.json"),
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore,
        ENSEMBLE_STATUS: "0",
        XDG_DATA_HOME: path.join(directory, "data")
      },
      60_000
    );

    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, /blocked awaiting input beyond the recovery bound/);

    const readBack = await runNode([archiveReaderPath, recordStore], {}, 15_000);
    assert.equal(readBack.code, 0, readBack.stderr);
    assert.deepEqual(JSON.parse(readBack.stdout), {
      status: "failed",
      failureKind: "claude-blocked",
      resolvedModel: "claude-fake-worker",
      provedFromTranscript: { inputTokens: 120, cachedInputTokens: 9, outputTokens: 30, totalTokens: 159 },
      summary: { freshInputTokens: 120, cachedInputTokens: 9, outputTokens: 30, totalTokens: 159 }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * The same journey with the one thing the archive must not invent: the
 * worker's transcript is readable but its usage block is zero-valued, so
 * there is no spend to prove. The transcript stays archived as attempt
 * evidence while the usage reads as the engine having reported none.
 */
test("built CLI archives a failed Claude worker's spend-free transcript as engine-reported-no-usage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-claude-no-spend-estate-"));
  const binDirectory = path.join(directory, "bin");
  const recordStore = path.join(directory, "records");
  const workerHome = path.join(directory, "home");
  try {
    await mkdir(binDirectory);
    await mkdir(workerHome);
    await writeFile(
      path.join(binDirectory, "claude"),
      `#!/usr/bin/env node\nimport ${JSON.stringify(fakeClaudePath)};\n`
    );
    await chmod(path.join(binDirectory, "claude"), 0o755);
    await writeFile(path.join(binDirectory, "tmux"), "#!/usr/bin/env node\nprocess.exit(1);\n");
    await chmod(path.join(binDirectory, "tmux"), 0o755);

    const run = await runNode(
      [bundledCliPath, "agent", "--engine", "claude", "--max-attempts", "1", "decide something"],
      {
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: workerHome,
        ENSEMBLE_FAKE_CLAUDE_STATE: path.join(directory, "roster.json"),
        ENSEMBLE_FAKE_CLAUDE_USAGE: '{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}',
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore,
        ENSEMBLE_STATUS: "0",
        XDG_DATA_HOME: path.join(directory, "data")
      },
      60_000
    );

    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, /blocked awaiting input beyond the recovery bound/);

    const entries = await readdir(recordStore, { recursive: true });
    const agentEntry = entries.find((entry) => entry.endsWith("agent.json"));
    assert.ok(agentEntry, `no agent.json under ${recordStore}`);
    const agent = JSON.parse(await readFile(path.join(recordStore, agentEntry), "utf8"));
    assert.equal(agent.status, "failed");
    assert.ok(Array.isArray(agent.transcripts), "the spend-free failure must still list its transcript");
    assert.equal(agent.transcripts.length, 1);
    assert.deepEqual(agent.usage, { unavailable: "engine-reported-no-usage" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
