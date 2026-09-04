import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executablePath, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const recordingAppServerPath = path.resolve("test/fixtures/codex/recording-app-server.mjs");
const archiveReaderPath = path.resolve("test/consumers/read-codex-served-model-record.mjs");

test("built archive keeps a requested Codex pin distinct from the server-served model", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-codex-served-model-estate-"));
  const binDirectory = path.join(directory, "bin");
  const recordStore = path.join(directory, "records");
  const workflow = path.join(directory, "workflow.js");
  try {
    await mkdir(binDirectory);
    await writeFile(path.join(binDirectory, "codex"), `#!/usr/bin/env node\nimport ${JSON.stringify(recordingAppServerPath)};\n`);
    await chmod(path.join(binDirectory, "codex"), 0o755);
    await writeFile(
      workflow,
      `export const meta = { name: "codex-served-model-record" };\nreturn await agent("report served model", { engine: "codex", model: "gpt-requested", maxAttempts: 1 });\n`
    );
    const schemaCli = await executablePath("codex");
    const run = await runNode([bundledCliPath, workflow], {
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      ENSEMBLE_CODEX_SCHEMA_CLI: schemaCli,
      ENSEMBLE_FAKE_CODEX_SERVED_MODEL: "gpt-served",
      ENSEMBLE_FAKE_CODEX_REQUIRE_THREAD_MODEL: "gpt-requested",
      ENSEMBLE_RUN_RECORD: "1",
      ENSEMBLE_RUN_RECORD_DIR: recordStore,
      ENSEMBLE_STATUS: "0",
      XDG_DATA_HOME: path.join(directory, "data")
    }, 15_000);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, '"worker-ok"\n');

    const readBack = await runNode([archiveReaderPath, recordStore], {}, 15_000);
    assert.equal(readBack.code, 0, readBack.stderr);
    assert.deepEqual(JSON.parse(readBack.stdout), {
      manifestSchemaVersion: 4,
      requestedModel: "gpt-requested",
      servedModel: "gpt-served",
      attemptServedModel: "gpt-served"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


