import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { seedCodexHome } from "../fixtures/codex/provider-wire.js";
import { startCaptureProvider } from "../fixtures/provider-capture.js";
import { runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

test("real Codex provider request rejections retain a named rule and retry without advancing a chain", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-codex-provider-rejection-"));
  const provider = await startCaptureProvider();
  try {
    const seeded = await seedCodexHome(directory, provider.baseUrl);
    const workDirectory = path.join(directory, "work");
    const recordStore = path.join(directory, "records");
    const workflow = path.join(directory, "workflow.js");
    await mkdir(workDirectory);
    await writeFile(workflow, `export const meta = { name: "codex-provider-rejection" };
return await agent("hello", {
  engine: "codex",
  cwd: ${JSON.stringify(workDirectory)},
  maxAttempts: 2,
  fallback: [{ engine: "codex", model: "fallback-must-not-run" }]
});
`);
    const run = await runNode([bundledCliPath, workflow], {
      HOME: seeded.home,
      CODEX_HOME: seeded.codexHome,
      XDG_CONFIG_HOME: path.join(seeded.home, ".config"),
      XDG_DATA_HOME: path.join(seeded.home, ".local", "share"),
      ENSEMBLE_RUN_RECORD: "1",
      ENSEMBLE_RUN_RECORD_DIR: recordStore,
      ENSEMBLE_STATUS: "0"
    }, 60_000);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "null\n");
    assert.equal(provider.requests().length, 2, "each retry must reach the real Codex provider boundary");
    assert.match(run.stderr, /fallback chain not consulted/);
    assert.match(run.stderr, /rule codex.provider-request-rejected/);
    const entries = await readdir(recordStore, { recursive: true });
    const records = entries.filter((entry) => path.basename(entry) === "agent.json");
    assert.equal(records.length, 1);
    const agent = JSON.parse(await readFile(path.join(recordStore, records[0]!), "utf8")) as {
      attempts: Array<{
        classification: { class: string; rule: string | null };
        chain_decision: string;
        app_server_diagnostic: { code: string; payload: string };
        target: { model: string | null };
      }>;
    };
    assert.equal(agent.attempts.length, 2);
    for (const attempt of agent.attempts) {
      assert.equal(attempt.app_server_diagnostic.code, "other");
      assert.match(attempt.app_server_diagnostic.payload, /invalid_request_error/);
      assert.deepEqual(attempt.classification, { class: "unclassified", rule: "codex.provider-request-rejected" });
      assert.equal(attempt.chain_decision, "chain-not-consulted");
      assert.equal(attempt.target.model, null);
    }
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
