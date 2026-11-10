import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executablePath, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const recordingAppServerPath = path.resolve("test/fixtures/codex/recording-app-server.mjs");

// The turn-error notification Codex sent once it had spent its own retries
// on 429s, as archived during the 2026-10-26 rate-limit incident (the
// fixture supplies the thread and turn ids).
const retriesExhausted = {
  error: {
    message: "exceeded retry limit, last status: 429 Too Many Requests",
    codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
    additionalDetails: null,
    misalignment: null
  },
  willRetry: false
};

test("built CLI advances a fallback chain when Codex exhausts its own retries on a 429", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-codex-retry-exhausted-estate-"));
  const binDirectory = path.join(directory, "bin");
  const recordStore = path.join(directory, "records");
  const workflow = path.join(directory, "workflow.js");
  try {
    await mkdir(binDirectory);
    await writeFile(path.join(binDirectory, "codex"), `#!/usr/bin/env node\nimport ${JSON.stringify(recordingAppServerPath)};\n`);
    await chmod(path.join(binDirectory, "codex"), 0o755);
    await writeFile(
      workflow,
      `export const meta = { name: "codex-retry-exhausted-chain" };
return await agent("answer", {
  engine: "codex",
  model: "gpt-rate-limited",
  fallback: [{ engine: "codex", model: "gpt-fallback" }]
});
`
    );
    const run = await runNode([bundledCliPath, workflow], {
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      ENSEMBLE_CODEX_SCHEMA_CLI: await executablePath("codex"),
      ENSEMBLE_FAKE_CODEX_ERROR_SEQUENCE: JSON.stringify([retriesExhausted]),
      ENSEMBLE_RUN_RECORD: "1",
      ENSEMBLE_RUN_RECORD_DIR: recordStore,
      ENSEMBLE_STATUS: "0",
      XDG_DATA_HOME: path.join(directory, "data")
    }, 15_000);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, '"worker-ok"\n');
    assert.doesNotMatch(run.stderr, /not consulted/);

    const agent = await readOnlyAgentRecord(recordStore);
    assert.deepEqual(
      agent.attempts.map((attempt) => [attempt.status, attempt.target, attempt.classification, attempt.chain_decision]),
      [
        ["failed", { engine: "codex", model: "gpt-rate-limited" }, { class: "availability", rule: "codex.rate-limit" }, "advanced"],
        ["complete", { engine: "codex", model: "gpt-fallback" }, null, null]
      ]
    );
    assert.equal(agent.attempts[0]?.app_server_diagnostic?.code, "responseTooManyFailedAttempts");
    assert.equal(agent.attempts[0]?.app_server_diagnostic?.http_status_code, 429);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

interface ArchivedAttempt {
  status: string;
  target: { engine: string; model: string | null };
  classification: { class: string; rule: string | null } | null;
  chain_decision: string | null;
  app_server_diagnostic: { code: number | string | null; http_status_code: number | null } | null;
}

async function readOnlyAgentRecord(recordStore: string): Promise<{ attempts: ArchivedAttempt[] }> {
  const entries = await readdir(recordStore, { recursive: true });
  const agentRecords = entries.filter((entry) => path.basename(entry) === "agent.json");
  assert.equal(agentRecords.length, 1, `expected one archived agent record, found ${agentRecords.join(", ")}`);
  return JSON.parse(await readFile(path.join(recordStore, agentRecords[0]!), "utf8")) as { attempts: ArchivedAttempt[] };
}
