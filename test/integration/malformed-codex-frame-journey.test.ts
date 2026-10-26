import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { executablePath, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/scripts/ensemble.mjs");
const recordingFixturePath = path.resolve("test/fixtures/codex/recording-app-server.mjs");

test("built CLI exposes rejection of a malformed partial assistant delta from its recording instrument", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-malformed-codex-frame-"));
  const binDirectory = path.join(directory, "bin");
  const workflow = path.join(directory, "workflow.js");
  try {
    await mkdir(binDirectory);
    await writeFile(
      path.join(binDirectory, "codex"),
      `#!/usr/bin/env node\nimport ${JSON.stringify(recordingFixturePath)};\n`
    );
    await chmod(path.join(binDirectory, "codex"), 0o755);
    await writeFile(
      workflow,
      'export const meta = { name: "malformed-codex-frame" };\nreturn await agent("exercise inbound frame validation", { engine: "codex", maxAttempts: 1 });\n'
    );

    const result = await runNode([bundledCliPath, workflow], {
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      ENSEMBLE_CODEX_SCHEMA_CLI: await executablePath("codex"),
      ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify([[
        {
          method: "item/agentMessage/delta",
          params: { delta: "malformed partial" },
          allowMalformed: "a partial assistant delta may never opt out of itemId validation"
        }
      ]]),
      ENSEMBLE_RUN_RECORD: "0",
      ENSEMBLE_STATUS: "0",
      XDG_DATA_HOME: path.join(directory, "data")
    });

    // The fixture's validation rejection kills the app-server mid-turn: a
    // dispatched worker's failure, so the script's null completes the run
    // and the rejection is legible on the failure notice.
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "null\n");
    assert.match(result.stderr, /\[codex\] agent 1 failed after 1 attempt — Codex app-server exited/);
    assert.match(result.stderr, /ServerNotification\.json validation for item\/agentMessage\/delta/);
    assert.match(result.stderr, /must have required property 'itemId'/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
