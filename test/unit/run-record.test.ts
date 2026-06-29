import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Writable } from "node:stream";

import { EngineRegistry } from "../../src/engines.js";
import { RunRecordWriter } from "../../src/run-record.js";
import { runEnsembleCli } from "../../src/cli.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { Scheduler } from "../../src/scheduler.js";

import type { EngineAdapter, EngineInvocation } from "../../src/engines.js";
import type { EngineName, TokenUsageBreakdown, TurnResult } from "../../src/types.js";

const execFileAsync = promisify(execFile);

test("run record manifest and agent schemas are fixture-locked", async () => {
  const cwd = await gitRepo("ensemble-record-schema-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-a",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: { item: "one" },
    cliFlags: { jsonArgs: true }
  });
  await writer.noteMeta({ task: { id: "task-one", family: "demo" } });
  await writer.recordAgent(agentRecord(1, "codex", null, 3));
  await writer.recordAgent(agentRecord(2, "opencode" as EngineName, "glm-5.2", 7, 0.002));
  await writer.finish({ status: "complete", exitCode: 0, result: { ok: true } });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as Record<string, unknown>;
  const manifestKeys = JSON.parse(await readFile("test/fixtures/run-record/v1-manifest-keys.json", "utf8"));
  const agentKeys = JSON.parse(await readFile("test/fixtures/run-record/v1-agent-keys.json", "utf8"));

  assert.deepEqual(Object.keys(manifest).sort(), manifestKeys);
  assert.deepEqual(Object.keys(agent).sort(), agentKeys);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.kind, "run_manifest");
  assert.equal(agent.schema_version, 1);
  assert.equal(agent.kind, "agent_record");
});

test("files table hashes artefacts and cost roll-up stays per engine and per model", async () => {
  const cwd = await gitRepo("ensemble-record-integrity-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-b",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: ["a"],
    cliFlags: { jsonArgs: false }
  });
  await writer.recordAgent(agentRecord(1, "codex", null, 3));
  await writer.recordAgent(agentRecord(2, "opencode" as EngineName, "glm-5.2", 7, 0.002));
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    files: Array<{ path: string; size: number; sha256: string }>;
    cost_rollup: Record<
      string,
      Record<string, { tokens: TokenUsageBreakdown; cost: { amount: number | null; source: string } }>
    >;
  };
  const transcriptEntry = manifest.files.find((entry) => entry.path.startsWith("agents/000001/") && entry.path.endsWith(".jsonl"));
  assert.ok(transcriptEntry);
  const transcriptPath = path.join(writer.archiveDir, transcriptEntry.path);
  assert.equal(transcriptEntry.sha256, sha256(await readFile(transcriptPath)));
  assert.equal(manifest.cost_rollup.codex?.default?.tokens.totalTokens, 3);
  assert.equal(manifest.cost_rollup.opencode?.["glm-5.2"]?.tokens.totalTokens, 7);
  assert.equal(manifest.cost_rollup.opencode?.["glm-5.2"]?.cost.amount, 0.002);
  assert.equal(manifest.cost_rollup.opencode?.["glm-5.2"]?.cost.source, "provider-reported");
  assert.equal("total" in manifest.cost_rollup, false);
});

test("standalone git diff write stages beside its destination and succeeds", async () => {
  const source = await readFile("src/run-record.ts", "utf8");
  const standaloneWrite = source.match(/async function writeStandaloneText[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(standaloneWrite, /path\.join\(path\.dirname\(destination\),/);
  assert.doesNotMatch(standaloneWrite, /tmpdir\(\)/);

  const cwd = await gitRepo("ensemble-record-dirty-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "ensemble-workflows", version: "0.0.1" }));

  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-dirty",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'dirty' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    git: { start: { diffPath: string | null } };
    files: Array<{ path: string }>;
  };
  assert.equal(manifest.git.start.diffPath, "git/start.diff");
  assert.ok(manifest.files.some((entry) => entry.path === "git/start.diff"));
  assert.match(await readFile(path.join(writer.archiveDir, "git/start.diff"), "utf8"), /0\.0\.1/);
});

test("CLI timeout leaves a usable partial archive with meta.task", async () => {
  const cwd = await gitRepo("ensemble-record-cli-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const script = path.join(cwd, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "record-cli", task: { id: "bench-1", family: "smoke" } };
      await agent("done-fast", { engine: "codex", label: "alpha", model: "gpt-test" });
      await agent("hang", { engine: "codex", model: "gpt-test" });
      return "never";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli(["--timeout=80", script], {
    cwd,
    stdout,
    stderr,
    runRecordDir: store,
    createRuntime: async () =>
      new EnsembleRuntime({
        engines: new EngineRegistry([new HangOnPromptEngine("codex", 2)]),
        defaultTurnTimeoutMs: 1_000,
        defaultMaxAttempts: 1
      })
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text(), /Workflow timed out after 80ms/);
  const manifestPath = await findManifest(store);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    status: string;
    meta: { task: unknown };
    files: Array<{ path: string }>;
    result: { archive_path: string };
  };
  assert.equal(manifest.status, "timed-out");
  assert.deepEqual(manifest.meta.task, { id: "bench-1", family: "smoke" });
  assert.ok(manifest.files.some((entry) => entry.path === "agents/000001/agent.json"));
  assert.equal(manifest.result.archive_path, "result.json");
});

test("child workflow agents are recorded in the parent's single durable run record", async () => {
  const cwd = await gitRepo("ensemble-record-child-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  await writeFile(
    path.join(cwd, "child.js"),
    `
      export const meta = { name: "record-child" };
      return await agent("child-agent", { engine: "codex", label: "child" });
    `
  );
  const parent = path.join(cwd, "workflow.js");
  await writeFile(
    parent,
    `
      export const meta = { name: "record-parent" };
      const child = await workflow({ scriptPath: "./child.js" }, []);
      const parent = await agent("parent-agent", { engine: "codex", label: "parent" });
      return { child, parent };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli([parent], {
    cwd,
    stdout,
    stderr,
    runRecordDir: store,
    createRuntime: async () =>
      new EnsembleRuntime({
        engines: new EngineRegistry([new HangOnPromptEngine("codex", 2)]),
        defaultTurnTimeoutMs: 1_000,
        defaultMaxAttempts: 1
      })
  });

  assert.equal(exitCode, 0, stderr.text());
  assert.equal(stdout.text(), "{\"child\":\"codex:child-agent\",\"parent\":\"codex:parent-agent\"}\n");
  const manifests = await findManifests(store);
  assert.equal(manifests.length, 1);
  const manifest = JSON.parse(await readFile(manifests[0] ?? "", "utf8")) as {
    status: string;
    files: Array<{ path: string }>;
  };
  assert.equal(manifest.status, "complete");
  assert.ok(manifest.files.some((entry) => entry.path === "agents/000001/agent.json"));
  assert.ok(manifest.files.some((entry) => entry.path === "agents/000002/agent.json"));

  const archiveDir = path.dirname(manifests[0] ?? "");
  const childAgent = JSON.parse(await readFile(path.join(archiveDir, "agents/000001/agent.json"), "utf8")) as {
    label: string | null;
    validated_output: unknown;
  };
  const parentAgent = JSON.parse(await readFile(path.join(archiveDir, "agents/000002/agent.json"), "utf8")) as {
    label: string | null;
    validated_output: unknown;
  };
  assert.deepEqual(
    [childAgent, parentAgent].map((agent) => [agent.label, agent.validated_output]),
    [
      ["child", "codex:child-agent"],
      ["parent", "codex:parent-agent"]
    ]
  );
});

function agentRecord(id: number, engine: EngineName, model: string | null, tokens: number, cost?: number) {
  return {
    id,
    engine,
    model,
    effort: null,
    resolvedModel: null,
    label: null,
    phase: null,
    status: "complete" as const,
    creationOrder: id,
    concurrencyGroup: engine,
    schema: null,
    rawOutput: "ok",
    validatedOutput: "ok",
    attempts: [
      {
        attempt: 1,
        status: "complete" as const,
        failure: null,
        rawOutput: "ok",
        validatedOutput: "ok",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1,
        firstDeltaMs: 1,
        tokenUsageEvents: [tokenUsageEvent(tokens, cost)],
        transcripts: [
          {
            filename: `${engine}.jsonl`,
            format: "jsonl" as const,
            source: `${engine}-test`,
            content: `{"prompt":"x","engine":"${engine}"}\n`
          }
        ]
      }
    ]
  };
}

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

class HangOnPromptEngine implements EngineAdapter {
  readonly concurrency: number;
  readonly scheduler: Scheduler;

  constructor(
    readonly name: EngineName,
    concurrency: number
  ) {
    this.concurrency = concurrency;
    this.scheduler = new Scheduler(concurrency);
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule(task);
  }

  createInvocation(prompt: string): EngineInvocation {
    return {
      runAttempt: async () => {
        if (prompt === "hang") {
          await new Promise<never>(() => {});
        }
        return turn(`${this.name}:${prompt}`, 5);
      }
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

function turn(text: string, tokens: number): TurnResult {
  return {
    text,
    deltaText: text,
    durationMs: 1,
    firstDeltaMs: 1,
    items: {},
    tokenUsageEvents: [tokenUsageEvent(tokens)],
    transcripts: [
      {
        filename: "transcript.test.jsonl",
        format: "jsonl",
        source: "test-engine",
        content: `{"text":${JSON.stringify(text)}}\n`
      }
    ]
  };
}

function tokenUsageEvent(totalTokens: number, cost?: number) {
  const usage = {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: totalTokens,
    reasoningOutputTokens: 0,
    totalTokens
  };
  return {
    threadId: "thread",
    turnId: "turn",
    last: usage,
    total: usage,
    raw: cost === undefined ? {} : { cost }
  };
}

async function gitRepo(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "ensemble-workflows", version: "0.0.0" }));
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: directory });
  await execFileAsync("git", ["add", "package.json"], { cwd: directory });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: directory });
  return directory;
}

async function findManifest(store: string): Promise<string> {
  const manifests = await findManifests(store);
  const manifest = manifests[0];
  assert.ok(manifest);
  return manifest;
}

async function findManifests(store: string): Promise<string[]> {
  const entries = await readdir(store, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === "manifest.json")
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
