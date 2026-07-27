import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  const manifestKeys = JSON.parse(await readFile("test/fixtures/run-record/v2-manifest-keys.json", "utf8"));
  const agentKeys = JSON.parse(await readFile("test/fixtures/run-record/v2-agent-keys.json", "utf8"));

  assert.deepEqual(Object.keys(manifest).sort(), manifestKeys);
  assert.deepEqual(Object.keys(agent).sort(), agentKeys);
  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.kind, "run_manifest");
  assert.equal(agent.schema_version, 2);
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

test("cost roll-up preserves raw usage and adds comparable fresh-input and cache-read fields", async () => {
  const cwd = await gitRepo("ensemble-record-derived-tokens-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-derived-tokens",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'tokens' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  await writer.recordAgent(agentRecordWithUsage(1, "codex", usage(20, 8, 5, 2, 27)));
  await writer.recordAgent(agentRecordWithUsage(2, "claude", usage(12, 8, 5, 0, 25)));
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    cost_rollup: Record<
      string,
      Record<string, { tokens: TokenUsageBreakdown & { freshInputTokens: number; cacheReadTokens: number } }>
    >;
  };
  const codex = manifest.cost_rollup.codex?.default?.tokens;
  const claude = manifest.cost_rollup.claude?.default?.tokens;
  assert.ok(codex);
  assert.ok(claude);
  assert.deepEqual(codex, {
    cachedInputTokens: 8,
    inputTokens: 20,
    outputTokens: 5,
    reasoningOutputTokens: 2,
    totalTokens: 27,
    freshInputTokens: 12,
    cacheReadTokens: 8
  });
  assert.deepEqual(claude, {
    cachedInputTokens: 8,
    inputTokens: 12,
    outputTokens: 5,
    reasoningOutputTokens: 0,
    totalTokens: 25,
    freshInputTokens: 12,
    cacheReadTokens: 8
  });
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

test("concurrent agent settles serialise cleanly and leave no temp litter", async () => {
  const cwd = await gitRepo("ensemble-record-concurrent-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-concurrent",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });

  const ids = Array.from({ length: 12 }, (_, index) => index + 1);
  // Same-tick settles previously collided on Date.now()-based temp names and
  // raced the shared manifest; all writes must land and none may reject.
  await Promise.all(ids.map((id) => writer.recordAgent(agentRecord(id, "codex", null, id))));
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    files: Array<{ path: string }>;
  };
  for (const id of ids) {
    assert.ok(
      manifest.files.some((entry) => entry.path === `agents/${String(id).padStart(6, "0")}/agent.json`),
      `agent ${id} missing from manifest files`
    );
  }
  const litter = (await readdir(writer.archiveDir, { recursive: true })).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(litter, []);
});

test("failed-run finalisation drains queued records and seals the archive against late writes", async () => {
  const cwd = await gitRepo("ensemble-record-failed-seal-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-failed-seal",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'failed' };\nthrow new Error('boom');\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });

  const inFlight = writer.recordAgent(agentRecord(1, "codex", null, 3));
  const finalising = writer.finish({ status: "failed", exitCode: 1, result: { partial: true } });
  await Promise.all([inFlight, finalising]);

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    status: string;
    files: Array<{ path: string }>;
  };
  assert.equal(manifest.status, "failed");
  assert.ok(manifest.files.some((entry) => entry.path === "agents/000001/agent.json"));

  await rm(writer.archiveDir, { recursive: true });
  await writer.recordAgent(agentRecord(2, "codex", null, 4));
});

test("agent record includes resolved placement and the complete worktree outcome", async () => {
  const cwd = await gitRepo("ensemble-record-worktree-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-worktree",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'worktree' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  await writer.recordAgent({
    ...agentRecord(1, "codex", null, 3),
    resolvedCwd: "/tmp/example-worktree",
    isolation: "worktree" as const,
    worktree: {
      branch: "ensemble-workflows/example",
      baseCommit: "0123456789abcdef",
      changed: true,
      removed: false
    }
  });

  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
    resolved_cwd: string;
    isolation: string | null;
    worktree: unknown;
  };
  assert.equal(agent.resolved_cwd, "/tmp/example-worktree");
  assert.equal(agent.isolation, "worktree");
  assert.deepEqual(agent.worktree, {
    branch: "ensemble-workflows/example",
    base_commit: "0123456789abcdef",
    changed: true,
    removed: false
  });
});

test("archived dirty diff captures staged changes", async () => {
  const cwd = await gitRepo("ensemble-record-staged-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "ensemble-workflows", version: "9.9.9" }));
  await execFileAsync("git", ["add", "package.json"], { cwd });

  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-staged",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'staged' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    git: { start: { dirty: boolean | null; diffPath: string | null } };
  };
  assert.equal(manifest.git.start.dirty, true);
  assert.equal(manifest.git.start.diffPath, "git/start.diff");
  assert.match(await readFile(path.join(writer.archiveDir, "git/start.diff"), "utf8"), /9\.9\.9/);
});

test("cost roll-up degrades to token-only accounting on unlike currencies", async () => {
  const cwd = await gitRepo("ensemble-record-currency-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-currency",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  await writer.recordAgent(agentRecord(1, "opencode" as EngineName, "glm-5.2", 3, 0.002, "USD"));
  await writer.recordAgent(agentRecord(2, "opencode" as EngineName, "glm-5.2", 4, 0.005, "EUR"));
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    cost_rollup: Record<string, Record<string, { tokens: TokenUsageBreakdown; cost: { amount: number | null; currency: string | null; source: string } }>>;
  };
  const bucket = manifest.cost_rollup.opencode?.["glm-5.2"];
  assert.ok(bucket);
  assert.equal(bucket.tokens.totalTokens, 7);
  assert.equal(bucket.cost.amount, null);
  assert.equal(bucket.cost.currency, null);
  assert.equal(bucket.cost.source, "estimated");
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

test("CLI records that --json-args supplied an array payload", async () => {
  const cwd = await gitRepo("ensemble-record-json-args-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const script = path.join(cwd, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "record-json-args" };
      return { args, codexBudget: budget.remaining("codex") };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runEnsembleCli(["--json-args", '["alpha", "beta"]', script], {
    cwd,
    stdout,
    stderr,
    runRecordDir: store,
    createRuntime: async () =>
      new EnsembleRuntime({
        engines: new EngineRegistry([]),
        defaultMaxAttempts: 1
      })
  });

  assert.equal(exitCode, 0, stderr.text());
  assert.equal(stdout.text(), '{"args":["alpha","beta"],"codexBudget":null}\n');
  const manifest = JSON.parse(await readFile(await findManifest(store), "utf8")) as {
    cli_flags: { jsonArgs: boolean };
  };
  assert.equal(manifest.cli_flags.jsonArgs, true);
});

test("ensemble agent records task identity when supplied and remains ungrouped when omitted", async () => {
  const cwd = await gitRepo("ensemble-record-agent-");
  const labelledStore = await mkdtemp(path.join(tmpdir(), "ensemble-record-labelled-"));
  const unlabelledStore = await mkdtemp(path.join(tmpdir(), "ensemble-record-unlabelled-"));

  const run = async (store: string, task?: string): Promise<string> => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const exitCode = await runEnsembleCli(
      [
        "agent",
        "--engine=codex",
        ...(task === undefined ? [] : [`--task=${task}`]),
        "record this worker"
      ],
      {
        cwd,
        stdout,
        stderr,
        runRecordDir: store,
        createRuntime: async () =>
          new EnsembleRuntime({
            engines: new EngineRegistry([new HangOnPromptEngine("codex", 1)]),
            defaultMaxAttempts: 1
          })
      }
    );
    assert.equal(exitCode, 0, stderr.text());
    assert.equal(stdout.text(), '"codex:record this worker"\n');
    return findManifest(store);
  };

  const labelledManifest = JSON.parse(await readFile(await run(labelledStore, "bench-single"), "utf8")) as {
    meta: { task: unknown };
    workflow: { path: string; archive_path: string };
    files: Array<{ path: string }>;
  };
  const unlabelledManifest = JSON.parse(await readFile(await run(unlabelledStore), "utf8")) as {
    meta: { task: unknown };
    files: Array<{ path: string }>;
  };

  assert.equal(labelledManifest.meta.task, "bench-single");
  assert.match(labelledManifest.workflow.path, /<ensemble-agent>$/);
  assert.equal(labelledManifest.workflow.archive_path, "workflow.js");
  assert.ok(labelledManifest.files.some((entry) => entry.path === "agents/000001/agent.json"));
  assert.equal(unlabelledManifest.meta.task, null);
  assert.ok(unlabelledManifest.files.some((entry) => entry.path === "agents/000001/agent.json"));
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

function agentRecord(id: number, engine: EngineName, model: string | null, tokens: number, cost?: number, currency?: string) {
  return {
    id,
    engine,
    model,
    effort: null,
    fallbackModel: null,
    resolvedModel: null,
    resolvedCwd: "/fixture/repo",
    isolation: null,
    worktree: null,
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
        tokenUsageEvents: [tokenUsageEvent(tokens, cost, currency)],
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

function agentRecordWithUsage(id: number, engine: EngineName, tokenUsage: TokenUsageBreakdown) {
  const record = agentRecord(id, engine, null, 0);
  record.attempts[0]!.tokenUsageEvents = [tokenUsageEventFromBreakdown(tokenUsage)];
  return record;
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

function tokenUsageEvent(totalTokens: number, cost?: number, currency?: string) {
  return tokenUsageEventFromBreakdown(usage(0, 0, totalTokens, 0, totalTokens), cost, currency);
}

function usage(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number,
  totalTokens: number
): TokenUsageBreakdown {
  return { cachedInputTokens, inputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function tokenUsageEventFromBreakdown(tokenUsage: TokenUsageBreakdown, cost?: number, currency?: string) {
  return {
    threadId: "thread",
    turnId: "turn",
    last: tokenUsage,
    total: tokenUsage,
    raw: {
      ...(cost === undefined ? {} : { cost }),
      ...(currency === undefined ? {} : { currency })
    }
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
