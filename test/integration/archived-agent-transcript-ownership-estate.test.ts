import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executablePath, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/scripts/ensemble.mjs");
const recordingAppServerPath = path.resolve("test/fixtures/codex/recording-app-server.mjs");
const archiveReaderPath = path.resolve("test/consumers/read-archived-agents.mjs");

interface AgentRecord {
  id: string;
  transcripts: Array<{ path: string }>;
}

test("cold archive consumer refuses transcript references outside each agent's own directory", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-archived-agent-ownership-estate-"));
  try {
    const recordStore = path.join(directory, "records");
    const binDirectory = path.join(directory, "bin");
    const workflow = path.join(directory, "workflow.mjs");
    await mkdir(binDirectory);
    await writeFile(path.join(binDirectory, "codex"), `#!/usr/bin/env node\nimport ${JSON.stringify(recordingAppServerPath)};\n`);
    await chmod(path.join(binDirectory, "codex"), 0o755);
    await writeFile(workflow, `
      export const meta = { name: "archived-agent-transcript-ownership" };
      return await parallel([
        () => agent("first transcript owner", { engine: "codex", label: "first", maxAttempts: 1 }),
        () => agent("second transcript owner", { engine: "codex", label: "second", maxAttempts: 1 })
      ]);
    `);
    const run = await runNode([bundledCliPath, workflow], {
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      ENSEMBLE_CODEX_SCHEMA_CLI: await executablePath("codex"),
      ENSEMBLE_RUN_RECORD: "1",
      ENSEMBLE_RUN_RECORD_DIR: recordStore,
      ENSEMBLE_STATUS: "0",
      XDG_DATA_HOME: path.join(directory, "data")
    }, 30_000);
    assert.equal(run.code, 0, run.stderr);

    const agentPaths = await findAgentPaths(recordStore);
    assert.equal(agentPaths.length, 2, "the built CLI must leave two independently-owned agent records");
    const originalRecords = await Promise.all(agentPaths.map(async (agentPath) => ({
      agentPath,
      record: JSON.parse(await readFile(agentPath, "utf8")) as AgentRecord
    })));
    assert.ok(originalRecords.every(({ record }) => record.transcripts.length === 1));
    await requireAccepted(recordStore);

    const [first, second] = originalRecords;
    assert.ok(first && second);
    await withMutatedRecord(first.agentPath, first.record, (record) => {
      record.transcripts[0]!.path = second.record.transcripts[0]!.path;
    }, async () => {
      await requireRejected(recordStore, "a cross-agent transcript reference");
    });

    await withMutatedRecord(second.agentPath, second.record, (record) => {
      record.transcripts[0]!.path = first.record.transcripts[0]!.path;
    }, async () => {
      await requireRejected(recordStore, "a shared transcript reference");
    });

    const archiveDirectory = path.dirname(path.dirname(path.dirname(first.agentPath)));
    await mkdir(path.join(archiveDirectory, "outside"));
    await writeFile(path.join(archiveDirectory, "outside", "transcript.jsonl"), "external transcript\n");
    await withMutatedRecord(first.agentPath, first.record, (record) => {
      record.transcripts[0]!.path = "outside/transcript.jsonl";
    }, async () => {
      await requireRejected(recordStore, "a transcript reference outside every agents/<id>/ directory");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function findAgentPaths(recordStore: string): Promise<string[]> {
  const entries = await readdir(recordStore, { recursive: true });
  return entries
    .filter((entry) => path.basename(entry) === "agent.json")
    .map((entry) => path.join(recordStore, entry));
}

async function requireAccepted(recordStore: string): Promise<void> {
  const result = await runNode([archiveReaderPath, recordStore]);
  assert.equal(result.code, 0, result.stderr);
}

async function requireRejected(recordStore: string, shape: string): Promise<void> {
  const result = await runNode([archiveReaderPath, recordStore]);
  assert.notEqual(result.code, 0, `cold consumer accepted ${shape}`);
}

async function withMutatedRecord(
  agentPath: string,
  original: AgentRecord,
  mutate: (record: AgentRecord) => void,
  body: () => Promise<void>
): Promise<void> {
  const altered = structuredClone(original);
  mutate(altered);
  await writeFile(agentPath, `${JSON.stringify(altered)}\n`);
  try {
    await body();
  } finally {
    await writeFile(agentPath, `${JSON.stringify(original)}\n`);
  }
}
