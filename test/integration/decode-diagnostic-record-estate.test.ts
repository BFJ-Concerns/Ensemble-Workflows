import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executablePath, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const recordingAppServerPath = path.resolve("test/fixtures/codex/recording-app-server.mjs");
const archiveReaderPath = path.resolve("test/consumers/read-decode-diagnostic-record.mjs");

test("built bundle archives a decode diagnostic while a clean control remains null", async () => {
  const fixture = await createFixture();
  try {
    const clean = await fixture.run(false);
    const decoded = await fixture.run(true);

    assert.equal(clean.code, 0, clean.stderr);
    assert.equal(decoded.code, 0, decoded.stderr);
    assert.equal(clean.stdout, `"worker-ok"\n`);
    assert.equal(decoded.stdout, `"worker-ok"\n`);

    const cleanRead = await runNode([archiveReaderPath, fixture.cleanDataHome, "clean"], {}, 15_000);
    const decodedRead = await runNode([archiveReaderPath, fixture.decodeDataHome, "decode"], {}, 15_000);
    assert.equal(cleanRead.code, 0, cleanRead.stderr);
    assert.equal(decodedRead.code, 0, decodedRead.stderr);
    assert.deepEqual(JSON.parse(cleanRead.stdout), { decodeFailure: null });
    assert.deepEqual(JSON.parse(decodedRead.stdout), {
      decodeFailure: {
        byte_length: Buffer.byteLength("this is not JSON at all", "utf8"),
        line_prefix: "this is not JSON at all"
      }
    });
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-decode-record-estate-"));
  const binDirectory = path.join(directory, "bin");
  const workflow = path.join(directory, "workflow.js");
  const cleanDataHome = path.join(directory, "clean-data");
  const decodeDataHome = path.join(directory, "decode-data");
  await mkdir(binDirectory);
  await writeFile(path.join(binDirectory, "codex"), `#!/usr/bin/env node\nimport ${JSON.stringify(recordingAppServerPath)};\n`);
  await chmod(path.join(binDirectory, "codex"), 0o755);
  await writeFile(
    workflow,
    `
      export const meta = { name: "decode-diagnostic-record" };
      return await agent("continue after a malformed frame", { engine: "codex", maxAttempts: 1 });
    `
  );
  const realCodex = await executablePath("codex");

  return {
    cleanDataHome,
    decodeDataHome,
    run: (decode: boolean) =>
      runNode(
        [bundledCliPath, workflow],
        {
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          ENSEMBLE_CODEX_SCHEMA_CLI: realCodex,
          ENSEMBLE_FAKE_CODEX_DECODE_FAILURE: decode ? "1" : "0",
          ENSEMBLE_RUN_RECORD: "1",
          // Explicit store: an inherited ENSEMBLE_RUN_RECORD_DIR (the suite
          // runner's own per-run temp store) would win over the data home.
          ENSEMBLE_RUN_RECORD_DIR: path.join(decode ? decodeDataHome : cleanDataHome, "ensemble"),
          ENSEMBLE_STATUS: "0",
          XDG_DATA_HOME: decode ? decodeDataHome : cleanDataHome
        },
        15_000
      ),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}
