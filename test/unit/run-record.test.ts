import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Writable } from "node:stream";

import { EngineRegistry } from "../../src/engines.js";
import { RunRecordWriter, reapAbandonedRuns, resolveRunDirectory } from "../../src/run-record.js";
import type { RuntimeAgentRecord } from "../../src/run-record.js";
import { runEnsembleCli } from "../../src/cli.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { Scheduler } from "../../src/scheduler.js";

import type { EngineAdapter, EngineInvocation } from "../../src/engines.js";
import type { EngineName, RuntimeOptions, TokenUsageBreakdown, TurnResult } from "../../src/types.js";

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
    cliFlags: { jsonArgs: true },
    callerIdentity: "session:run-record-test",
    concurrency: {
      agentCeiling: { value: null, layer: "default" },
      engines: {
        codex: { value: 3, layer: "config-file" },
        claude: { value: 8, layer: "default" },
        opencode: { value: 2, layer: "flag" }
      }
    }
  });
  await writer.noteMeta({ task: { id: "task-one", family: "demo" } });
  await writer.recordAgent(agentRecord(1, "codex", null, 3));
  await writer.recordAgent(agentRecord(2, "opencode" as EngineName, "glm-5.2", 7, 0.002));
  await writer.finish({ status: "complete", exitCode: 0, result: { ok: true } });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as Record<string, unknown>;
  const manifestKeys = JSON.parse(await readFile("test/fixtures/run-record/v3-manifest-keys.json", "utf8")) as {
    manifest: string[];
    args: string[];
  };
  const agentKeys = JSON.parse(await readFile("test/fixtures/run-record/v3-agent-keys.json", "utf8"));

  assert.deepEqual(Object.keys(manifest).sort(), manifestKeys.manifest);
  assert.deepEqual(Object.keys(manifest.args as Record<string, unknown>).sort(), manifestKeys.args);
  assert.deepEqual(Object.keys(agent).sort(), agentKeys);
  assert.equal(manifest.schema_version, 3);
  assert.equal(manifest.kind, "run_manifest");
  assert.equal(manifest.caller_identity, "session:run-record-test");
  assert.equal(agent.schema_version, 3);
  assert.equal(agent.kind, "agent_record");
  assert.deepEqual(manifest.concurrency, {
    agent_ceiling: { value: null, layer: "default" },
    engines: {
      claude: { value: 8, layer: "default" },
      codex: { value: 3, layer: "config-file" },
      opencode: { value: 2, layer: "flag" }
    }
  });
  assert.equal(agent.queued_ms, 0);
  assert.equal(agent.execution_ms, 0);
});

test("composed-workflow invocations are archived with hashes, ordering, and the parent link", async () => {
  const cwd = await gitRepo("ensemble-record-invocations-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const rootSource = "export const meta = { name: 'root' };\nreturn await workflow('child', []);\n";
  const rootArgs = ["root-arg"];
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-composed",
    workflowPath: path.join(cwd, "parent.js"),
    workflowSource: rootSource,
    args: rootArgs,
    cliFlags: { jsonArgs: false }
  });

  const childSource = "export const meta = { name: 'child' };\nreturn args;\n";
  const firstOrdinal = await writer.recordWorkflowInvocation({
    scriptPath: path.join(cwd, "child.js"),
    source: childSource,
    args: { id: 7 },
    parentOrdinal: 0
  });
  const secondOrdinal = await writer.recordWorkflowInvocation({
    scriptPath: path.join(cwd, "child.js"),
    source: childSource,
    args: { id: 8 },
    parentOrdinal: 0
  });
  await writer.finish({ status: "complete", exitCode: 0, result: null });

  assert.equal(firstOrdinal, 1);
  assert.equal(secondOrdinal, 2);
  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    workflow_invocations: Array<{
      ordinal: number;
      parent: number | null;
      path: string;
      source: { archive_path: string; sha256: string };
      args: { archive_path: string; canonical_archive_path: string; sha256: string };
    }>;
    files: Array<{ path: string; sha256: string }>;
  };

  // The root is entry 0 with no parent; children follow in call order, each
  // linked to the root. One run identity: this is the same manifest, not a
  // second archive.
  assert.equal(manifest.workflow_invocations.length, 3);
  const [root, first, second] = manifest.workflow_invocations;
  assert.deepEqual(
    manifest.workflow_invocations.map((entry) => [entry.ordinal, entry.parent]),
    [
      [0, null],
      [1, 0],
      [2, 0]
    ]
  );
  assert.equal(root!.source.archive_path, "workflow.js");
  assert.equal(first!.source.archive_path, "workflows/000001/workflow.js");
  assert.equal(second!.args.archive_path, "workflows/000002/args.json");
  assert.equal(root!.args.canonical_archive_path, "args.canonical.json");
  assert.equal(first!.args.canonical_archive_path, "workflows/000001/args.canonical.json");
  assert.deepEqual(Object.keys(root!.args).sort(), ["archive_path", "canonical_archive_path", "sha256"]);

  // The source hash covers the archived file's exact bytes. The args hash
  // covers the separately archived canonical text, not the envelope that
  // wraps the value, so an archive-only consumer can recompute it directly.
  const archivedChild = await readFile(path.join(writer.archiveDir, first!.source.archive_path), "utf8");
  assert.equal(archivedChild, childSource);
  assert.equal(first!.source.sha256, createHash("sha256").update(childSource).digest("hex"));
  assert.equal(first!.source.sha256, second!.source.sha256);
  const archivedArgs = JSON.parse(
    await readFile(path.join(writer.archiveDir, first!.args.archive_path), "utf8")
  ) as { value: unknown };
  assert.deepEqual(archivedArgs.value, { id: 7 });
  assert.equal(
    first!.args.sha256,
    createHash("sha256").update(JSON.stringify({ id: 7 }, null, 2)).digest("hex")
  );
  const archivedCanonicalArgs = await readFile(path.join(writer.archiveDir, first!.args.canonical_archive_path), "utf8");
  assert.equal(archivedCanonicalArgs, JSON.stringify({ id: 7 }, null, 2));
  assert.equal(first!.args.sha256, createHash("sha256").update(archivedCanonicalArgs).digest("hex"));
  assert.notEqual(first!.args.sha256, second!.args.sha256);

  // The archived files are integrity-tracked like every other artefact.
  const trackedPaths = manifest.files.map((entry) => entry.path);
  assert.ok(trackedPaths.includes("workflows/000001/workflow.js"));
  assert.ok(trackedPaths.includes("workflows/000002/args.json"));
  assert.ok(trackedPaths.includes("args.canonical.json"));
  assert.ok(trackedPaths.includes("workflows/000002/args.canonical.json"));
});

test("CLI records effective concurrency values with mixed-layer provenance", async () => {
  const cwd = await gitRepo("ensemble-record-concurrency-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const configHome = path.join(cwd, "config");
  const configFile = path.join(configHome, "ensemble", "config.json");
  const script = path.join(cwd, "workflow.js");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(
    configFile,
    JSON.stringify({
      schema_version: 1,
      agent_ceiling: 2,
      concurrency: { opencode: 5 },
      run_record: { enabled: true, dir: store },
      status: { enabled: false }
    })
  );
  await writeFile(script, `export const meta = { name: "mixed-concurrency" }; return await agent("ok", { engine: "codex" });`);

  const observed: RuntimeOptions[] = [];
  const exitCode = await runEnsembleCli(["--concurrency=codex=3", script], {
    cwd,
    env: {
      XDG_CONFIG_HOME: configHome,
      ENSEMBLE_AGENT_CEILING: "4"
    },
    stdout: new CaptureStream(),
    stderr: new CaptureStream(),
    createRuntime: async (options = {}) => {
      observed.push(options);
      return new EnsembleRuntime({
        engines: new EngineRegistry([
          new HangOnPromptEngine("codex", options.concurrencyCaps?.codex ?? 99),
          new HangOnPromptEngine("claude", 8),
          new HangOnPromptEngine("opencode", options.concurrencyCaps?.opencode ?? 99)
        ]),
        ...(options.agentCeiling !== undefined ? { agentCeiling: options.agentCeiling } : {}),
        defaultMaxAttempts: 1
      });
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(observed[0]?.agentCeiling, 4);
  assert.deepEqual(observed[0]?.concurrencyCaps, { codex: 3, opencode: 5 });

  const runDirectories = await readdir(path.join(store, "runs", "cwd"), { recursive: true });
  const manifestRelative = runDirectories.find((entry) => entry.endsWith("manifest.json"));
  assert.ok(manifestRelative);
  const manifest = JSON.parse(
    await readFile(path.join(store, "runs", "cwd", manifestRelative), "utf8")
  ) as { concurrency: unknown };
  assert.deepEqual(manifest.concurrency, {
    agent_ceiling: { value: 4, layer: "env" },
    engines: {
      claude: { value: 8, layer: "default" },
      codex: { value: 3, layer: "flag" },
      opencode: { value: 5, layer: "config-file" }
    }
  });
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
  const openCodeRecord = agentRecord(2, "opencode" as EngineName, "glm-5.2", 7, 0.002);
  // Spend is keyed under the *served* model, never the requested pin.
  openCodeRecord.resolvedModel = "zai/glm-5.2";
  await writer.recordAgent(openCodeRecord);
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    files: Array<{ path: string; size: number; sha256: string }>;
    cost_rollup: Record<
      string,
      Record<string, { tokens: { totalTokens: number }; cost: { amount: number | null; source: string } }>
    >;
  };
  const transcriptEntry = manifest.files.find((entry) => entry.path.startsWith("agents/000001/") && entry.path.endsWith(".jsonl"));
  assert.ok(transcriptEntry);
  const transcriptPath = path.join(writer.archiveDir, transcriptEntry.path);
  assert.equal(transcriptEntry.sha256, sha256(await readFile(transcriptPath)));
  // The codex agent never learned its served model: its spend lands under
  // the literal "unresolved", not under a requested pin it cannot vouch for.
  assert.equal(manifest.cost_rollup.codex?.unresolved?.tokens.totalTokens, 3);
  assert.equal(manifest.cost_rollup.opencode?.["zai/glm-5.2"]?.tokens.totalTokens, 7);
  assert.equal(manifest.cost_rollup.opencode?.["glm-5.2"], undefined);
  assert.equal(manifest.cost_rollup.opencode?.["zai/glm-5.2"]?.cost.amount, 0.002);
  assert.equal(manifest.cost_rollup.opencode?.["zai/glm-5.2"]?.cost.source, "provider-reported");
  // No engine reported money for the codex bucket, so the record says that
  // rather than an amount-less "estimate" a consumer cannot tell from zero.
  assert.deepEqual(manifest.cost_rollup.codex?.unresolved?.cost, { unavailable: "no-provider-cost-reported" });
  assert.equal("total" in manifest.cost_rollup, false);
});

test("the roll-up publishes the declared summary vocabulary under each engine's own inclusion rule", async () => {
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
  await writer.recordAgent(agentRecordWithUsage(1, "codex", usage(20, 8, 5, 2, 25)));
  await writer.recordAgent(agentRecordWithUsage(2, "claude", usage(12, 8, 5, 0, 25)));
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    cost_rollup: Record<string, Record<string, { tokens: Record<string, unknown> }>>;
  };
  const codex = manifest.cost_rollup.codex?.unresolved?.tokens;
  const claude = manifest.cost_rollup.claude?.unresolved?.tokens;
  assert.ok(codex);
  assert.ok(claude);
  // Codex reports cached within input and reasoning within output: both are
  // subtracted out, so the declared classes are disjoint and sum to the
  // total (12 + 8 + 3 + 2 = 25). The engine-native 20/5/27 figures stay in
  // the attempt events beneath, untouched.
  assert.deepEqual(codex, {
    freshInputTokens: 12,
    cachedInputTokens: 8,
    outputTokens: 3,
    reasoningOutputTokens: 2,
    unclassifiedTokens: 0,
    totalTokens: 25
  });
  // Claude separates neither reasoning nor (here) the cache split: reasoning
  // is null — not knowable, never zero — and output carries the whole
  // generation. 12 + 8 + 5 = 25.
  assert.deepEqual(claude, {
    freshInputTokens: 12,
    cachedInputTokens: 8,
    outputTokens: 5,
    reasoningOutputTokens: null,
    unclassifiedTokens: 0,
    totalTokens: 25
  });
});

test("cache creation is accounted apart from cache reads when the engine separates them", async () => {
  const cwd = await gitRepo("ensemble-record-cache-split-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-cache-split",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'cache' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  // A Claude-shaped breakdown: 10 cached in total, of which 3 were cache
  // writes — so only 7 were input actually served from cache.
  await writer.recordAgent(
    agentRecordWithUsage(1, "claude", { ...usage(220, 10, 40, 0, 270), cacheCreationInputTokens: 3 })
  );
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    cost_rollup: Record<
      string,
      Record<string, { tokens: { cachedInputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } }>
    >;
  };
  const tokens = manifest.cost_rollup.claude?.unresolved?.tokens;
  assert.ok(tokens);
  assert.equal(tokens.cachedInputTokens, 10);
  assert.equal(tokens.cacheReadTokens, 7);
  assert.equal(tokens.cacheCreationTokens, 3);
});

test("each agent record carries its usage in the declared vocabulary, or the reason it has none", async () => {
  const cwd = await gitRepo("ensemble-record-agent-usage-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-agent-usage",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'usage' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  await writer.recordAgent(agentRecordWithUsage(1, "codex", usage(20, 8, 5, 2, 25)));
  const noUsage = agentRecord(2, "claude", null, 0);
  noUsage.attempts[0]!.tokenUsageEvents = [];
  await writer.recordAgent(noUsage);
  const noAttempt = agentRecord(3, "claude", null, 0);
  noAttempt.attempts = [];
  noAttempt.status = "failed";
  await writer.recordAgent(noAttempt);
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const agentJson = async (id: string) =>
    JSON.parse(await readFile(path.join(writer.archiveDir, "agents", id, "agent.json"), "utf8")) as {
      usage: { summary?: Record<string, unknown>; unavailable?: string };
    };
  assert.deepEqual((await agentJson("000001")).usage, {
    summary: {
      freshInputTokens: 12,
      cachedInputTokens: 8,
      outputTokens: 3,
      reasoningOutputTokens: 2,
      unclassifiedTokens: 0,
      totalTokens: 25
    }
  });
  // No usage data is a stated reason, never a zero-spend figure the engine
  // did not report.
  assert.deepEqual((await agentJson("000002")).usage, { unavailable: "engine-reported-no-usage" });
  assert.deepEqual((await agentJson("000003")).usage, { unavailable: "no-attempt-ran" });
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
    parseRoute: "object-fallback",
    resolvedCwd: "/tmp/example-worktree",
    isolation: "worktree" as const,
    worktree: {
      branch: "ensemble-workflows/example",
      baseCommit: "0123456789abcdef",
      tipCommit: "fedcba9876543210",
      changed: true,
      removed: false
    }
  });

  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
    resolved_cwd: string;
    isolation: string | null;
    worktree: unknown;
    parse_route: string | null;
  };
  assert.equal(agent.resolved_cwd, "/tmp/example-worktree");
  assert.equal(agent.isolation, "worktree");
  assert.equal(agent.parse_route, "object-fallback");
  assert.deepEqual(agent.worktree, {
    branch: "ensemble-workflows/example",
    base_commit: "0123456789abcdef",
    tip_commit: "fedcba9876543210",
    changed: true,
    removed: false
  });
});

test("recordAgent snapshots new recoverability fields at its API boundary", async () => {
  const cwd = await gitRepo("ensemble-record-snapshot-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-snapshot",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "return true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  const record = agentRecord(1, "codex", null, 3);
  const writing = writer.recordAgent(record);
  record.parseRoute = "array-fallback";
  await writing;

  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
    parse_route: string | null;
  };
  assert.equal(agent.parse_route, null);
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
    cost_rollup: Record<string, Record<string, { tokens: TokenUsageBreakdown; cost: Record<string, unknown> }>>;
  };
  const bucket = manifest.cost_rollup.opencode?.unresolved;
  assert.ok(bucket);
  assert.equal(bucket.tokens.totalTokens, 7);
  // Token-only accounting, said out loud: the bucket saw money it could not
  // sum, which is a different statement from "no engine reported any".
  assert.deepEqual(bucket.cost, { unavailable: "unlike-currencies" });
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

function agentRecord(
  id: number,
  engine: EngineName,
  model: string | null,
  tokens: number,
  cost?: number,
  currency?: string
): RuntimeAgentRecord {
  return {
    id,
    engine,
    prompt: "fixture prompt",
    options: { timeoutMs: null, maxAttempts: 3 },
    model,
    effort: null,
    fallbackModel: null,
    resolvedModel: null,
    resolvedEffort: null,
    resolvedCwd: "/fixture/repo",
    isolation: null,
    worktree: null,
    label: null,
    phase: null,
    status: "complete" as const,
    terminationCause: null,
    creationOrder: id,
    concurrencyGroup: engine,
    schema: null,
    strip: null,
    parseRoute: null,
    decodeFailure: null,
    rawOutput: "ok",
    validatedOutput: "ok",
    queuedMs: 0,
    executionMs: 0,
    attempts: [
      {
        attempt: 1,
        status: "complete" as const,
        failure: null,
        observedFailure: null,
        workerExit: null,
        appServerDiagnostic: null,
        rawOutput: "ok",
        validatedOutput: "ok",
        resolvedModel: null,
        resolvedEffort: null,
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

test("the manifest attests itself, and an edited field breaks the attestation", async () => {
  const cwd = await gitRepo("ensemble-record-integrity-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-integrity",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: { item: "one" },
    cliFlags: { jsonArgs: true }
  });
  await writer.recordAgent(agentRecord(1, "codex", null, 3));
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const manifestPath = path.join(writer.archiveDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & {
    integrity: { algorithm: string; manifest_sha256: string; files_lost: unknown[] };
  };
  assert.equal(manifest.integrity.algorithm, "sha256");
  assert.deepEqual(manifest.integrity.files_lost, []);
  assert.equal(manifest.status, "complete");
  assert.equal(manifestSelfDigest(manifest), manifest.integrity.manifest_sha256);
  assert.equal(writer.manifestDigest(), manifest.integrity.manifest_sha256);

  // The tamper the archive-consumer session made and every hash check
  // passed: an edited manifest field, with the files table untouched.
  const tampered = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
  tampered.schema_version = 999;
  assert.notEqual(manifestSelfDigest(tampered), tampered.integrity.manifest_sha256);
  await rm(store, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

test("a run whose archive is deleted mid-flight cannot seal a complete manifest", async () => {
  const cwd = await gitRepo("ensemble-record-lost-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-lost",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: { item: "one" },
    cliFlags: { jsonArgs: true }
  });
  await writer.recordAgent(agentRecord(1, "codex", null, 3));
  // The two shapes the reconciliation must catch: a file the manifest
  // promises that is gone, and one replaced beneath the writer.
  await rm(path.join(writer.archiveDir, "workflow.js"));
  await writeFile(path.join(writer.archiveDir, "args.canonical.json"), "{}");
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    status: string;
    files: Array<{ path: string }>;
    integrity: { manifest_sha256: string; files_lost: Array<{ path: string; reason: string }> };
  };
  assert.equal(manifest.status, "incomplete");
  assert.deepEqual(manifest.integrity.files_lost, [
    { path: "args.canonical.json", reason: "size-mismatch" },
    { path: "workflow.js", reason: "missing" }
  ]);
  // The file table still declares them: the record loses nothing it knew,
  // it just stops claiming the archive is whole.
  assert.ok(manifest.files.some((entry) => entry.path === "workflow.js"));
  assert.equal(manifestSelfDigest(manifest), manifest.integrity.manifest_sha256);

  // The run itself ended cleanly and its own envelope still says so —
  // losing files is a recording failure, never a run failure.
  const result = JSON.parse(await readFile(path.join(writer.archiveDir, "result.json"), "utf8")) as {
    status: string;
    exit_code: number;
  };
  assert.equal(result.status, "complete");
  assert.equal(result.exit_code, 0);
  await rm(store, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/**
 * The reading belongs to the consumer, not the harness: the archive exports
 * no liveness API, so a cold reader applies the owner-block check itself.
 * This pins that copy against the same conservative terms the reaper holds
 * to, case for case, so the two cannot drift apart unnoticed.
 */
const { judgeArchivedRunLiveness } = (await import(
  pathToFileURL(path.resolve("test/consumers/archive-liveness.mjs")).href
)) as {
  judgeArchivedRunLiveness: (
    manifest: unknown,
    options: { procDir: string; host: string }
  ) => Promise<{ verdict: string; reason: string | null }>;
};

test("an archived run's liveness is judged from its own owner block", async () => {
  const proc = await mkdtemp(path.join(tmpdir(), "ensemble-liveness-proc-"));
  try {
    await writeProcStat(proc, process.pid, "1111");
    await writeProcStat(proc, 54321, "2222");
    const host = hostname();

    const dead = await judgeArchivedRunLiveness(
      { status: "in-progress", owner: { pid: 999999, start_ticks: "3333", host } },
      { procDir: proc, host }
    );
    assert.deepEqual(dead, { verdict: "dead", reason: "owner-process-gone" });

    const reusedPid = await judgeArchivedRunLiveness(
      { status: "in-progress", owner: { pid: 54321, start_ticks: "9999", host } },
      { procDir: proc, host }
    );
    assert.equal(reusedPid.verdict, "dead");

    const live = await judgeArchivedRunLiveness(
      { status: "in-progress", owner: { pid: 54321, start_ticks: "2222", host } },
      { procDir: proc, host }
    );
    assert.deepEqual(live, { verdict: "live", reason: null });

    // Everything the reaper refuses to judge, the consumer refuses too.
    const foreign = await judgeArchivedRunLiveness(
      { status: "in-progress", owner: { pid: 999998, start_ticks: "4", host: "elsewhere.invalid" } },
      { procDir: proc, host }
    );
    assert.deepEqual(foreign, { verdict: "undecidable", reason: null });

    const noEvidence = await judgeArchivedRunLiveness(
      { status: "in-progress", owner: { pid: 999997, start_ticks: null, host } },
      { procDir: proc, host }
    );
    assert.equal(noEvidence.verdict, "undecidable");

    const settled = await judgeArchivedRunLiveness(
      { status: "complete", owner: { pid: 999999, start_ticks: "3333", host } },
      { procDir: proc, host }
    );
    assert.deepEqual(settled, { verdict: "settled", reason: null });
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

test("the reaper flips provably-dead in-progress runs and leaves every judged-live one", async () => {
  const namespaceDir = await mkdtemp(path.join(tmpdir(), "ensemble-reap-ns-"));
  const proc = await mkdtemp(path.join(tmpdir(), "ensemble-reap-proc-"));
  try {
    // The judging side proves its own proc evidence readable before treating
    // an absent stat as death, so the fake proc carries this process too.
    // The fake comm contains a space to exercise the last-close-paren parse.
    await writeProcStat(proc, process.pid, "1111");
    await writeProcStat(proc, 54321, "2222");

    const host = hostname();
    await writeRunManifest(namespaceDir, "dead-run", {
      status: "in-progress",
      owner: { pid: 999999, start_ticks: "3333", host }
    });
    await writeRunManifest(namespaceDir, "reused-pid-run", {
      status: "in-progress",
      owner: { pid: 54321, start_ticks: "9999", host }
    });
    await writeRunManifest(namespaceDir, "live-run", {
      status: "in-progress",
      owner: { pid: 54321, start_ticks: "2222", host }
    });
    await writeRunManifest(namespaceDir, "foreign-host-run", {
      status: "in-progress",
      owner: { pid: 999998, start_ticks: "4", host: "elsewhere.invalid" }
    });
    await writeRunManifest(namespaceDir, "no-evidence-run", {
      status: "in-progress",
      owner: { pid: 999997, start_ticks: null, host }
    });
    await writeRunManifest(namespaceDir, "legacy-run", { status: "in-progress", run_uuid: "legacy" });
    await writeRunManifest(namespaceDir, "finished-run", {
      status: "complete",
      owner: { pid: 999999, start_ticks: "3333", host }
    });

    const reaped = await reapAbandonedRuns({
      namespaceDir,
      procDir: proc,
      observer: { pid: process.pid, runUuid: "sweeper-run" }
    });

    assert.deepEqual([...reaped].sort(), ["dead-run", "legacy-run", "reused-pid-run"]);
    const dead = await readRunManifest(namespaceDir, "dead-run");
    assert.equal(dead.status, "abandoned");
    const deadAbandonment = dead.abandonment as { reason: string; observed_by: { run_uuid: string } };
    assert.equal(deadAbandonment.reason, "owner-process-gone");
    assert.equal(deadAbandonment.observed_by.run_uuid, "sweeper-run");
    const legacy = await readRunManifest(namespaceDir, "legacy-run");
    assert.equal(legacy.status, "abandoned");
    assert.equal((legacy.abandonment as { reason: string }).reason, "manifest-predates-owner-recording");
    assert.equal(legacy.run_uuid, "legacy", "a reaped manifest keeps every field it already had");
    // The discriminating boundary: dead and live siblings no longer read
    // identically — and nothing judged possibly-live is touched.
    for (const untouched of ["live-run", "foreign-host-run", "no-evidence-run"]) {
      assert.equal((await readRunManifest(namespaceDir, untouched)).status, "in-progress", untouched);
    }
    assert.equal((await readRunManifest(namespaceDir, "finished-run")).status, "complete");
  } finally {
    await rm(namespaceDir, { recursive: true, force: true });
    await rm(proc, { recursive: true, force: true });
  }
});

test("a new writer records its own liveness evidence and reaps its dead siblings at start", async () => {
  const cwd = await gitRepo("ensemble-reap-start-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-reap-store-"));
  const proc = await mkdtemp(path.join(tmpdir(), "ensemble-reap-start-proc-"));
  try {
    await writeProcStat(proc, process.pid, "1111");
    const siblingDir = await resolveRunDirectory(store, cwd, "dead-sibling");
    await mkdir(siblingDir, { recursive: true });
    await writeFile(
      path.join(siblingDir, "manifest.json"),
      `${JSON.stringify({ status: "in-progress", owner: { pid: 999999, start_ticks: "3", host: hostname() } })}\n`
    );

    const writer = await RunRecordWriter.start({
      storeDir: store,
      cwd,
      runUuid: "run-reap",
      workflowPath: path.join(cwd, "workflow.js"),
      workflowSource: "export const meta = { name: 'reap' };\nreturn true;\n",
      args: [],
      cliFlags: { jsonArgs: false },
      procDir: proc
    });

    const sibling = JSON.parse(await readFile(path.join(siblingDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    assert.equal(sibling.status, "abandoned");
    const own = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    const owner = own.owner as { pid: number; start_ticks: string | null; host: string };
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.start_ticks, "1111");
    assert.equal(owner.host, hostname());
    assert.equal(own.status, "in-progress");
    await writer.finish({ status: "complete", exitCode: 0, result: null });
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(proc, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

async function writeProcStat(procDir: string, pid: number, startTicks: string): Promise<void> {
  const dir = path.join(procDir, String(pid));
  await mkdir(dir, { recursive: true });
  // Fields 3–21 precede starttime (field 22); the comm field carries a
  // space so the parser's last-close-paren split is what the fixture tests.
  const before = ["S", "1", "1", "1", "0", "-1", "4194560", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1"];
  await writeFile(path.join(dir, "stat"), `${pid} (fa ke) ${before.join(" ")} ${startTicks} 0 0\n`);
}

async function writeRunManifest(namespaceDir: string, runName: string, manifest: unknown): Promise<void> {
  const dir = path.join(namespaceDir, runName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
}

async function readRunManifest(namespaceDir: string, runName: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(namespaceDir, runName, "manifest.json"), "utf8")) as Record<string, unknown>;
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

test("an interrupted worker's archive names its termination cause and why no transcript is there", async () => {
  const cwd = await gitRepo("ensemble-record-termination-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-termination",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "return true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });

  const interrupted = agentRecord(1, "claude", null, 0);
  interrupted.status = "interrupted";
  interrupted.terminationCause = {
    kind: "run-interrupted",
    message: "the run ended (interrupted) while this worker's turn was in flight"
  };
  interrupted.attempts[0]!.status = "failed";
  interrupted.attempts[0]!.transcripts = [];
  interrupted.attempts[0]!.failure = {
    kind: "run-interrupted",
    message: "the run ended (interrupted) while this worker's turn was in flight"
  };
  interrupted.attempts[0]!.observedFailure = {
    kind: "AppServerExitedError",
    message: "codex app-server closed"
  };
  await writer.recordAgent(interrupted);

  const completed = agentRecord(2, "codex", null, 0);
  await writer.recordAgent(completed);

  const read = async (id: string) =>
    JSON.parse(await readFile(path.join(writer.archiveDir, "agents", id, "agent.json"), "utf8")) as {
      termination_cause: { kind: string; message: string } | null;
      transcripts: unknown;
      attempts: Array<{
        failure: { kind: string; message: string } | null;
        observed_failure: { kind: string; message: string } | null;
      }>;
    };

  const interruptedAgent = await read("000001");
  assert.deepEqual(interruptedAgent.termination_cause, {
    kind: "run-interrupted",
    message: "the run ended (interrupted) while this worker's turn was in flight"
  });
  // No transcript survives an interruption, so the archive says why rather
  // than showing an empty list a consumer would read as "the engine was silent".
  assert.deepEqual(interruptedAgent.transcripts, { unavailable: "worker-interrupted" });
  // The attempt reads the same cause as the agent above it, and the symptom
  // its transport reported survives beside it rather than as the reason.
  assert.deepEqual(interruptedAgent.attempts[0]?.failure, {
    kind: "run-interrupted",
    message: "the run ended (interrupted) while this worker's turn was in flight"
  });
  assert.deepEqual(interruptedAgent.attempts[0]?.observed_failure, {
    kind: "AppServerExitedError",
    message: "codex app-server closed"
  });

  // A worker that finished carries neither an invented cause nor an excuse.
  const completedAgent = await read("000002");
  assert.equal(completedAgent.termination_cause, null);
  assert.equal(completedAgent.attempts[0]?.observed_failure, null);
  assert.ok(Array.isArray(completedAgent.transcripts));
});

/**
 * The consumer's verification recipe for the manifest's self-attestation:
 * null the digest field, re-canonicalise in the writer's own form, hash.
 */
function manifestSelfDigest(manifest: Record<string, unknown>): string {
  const copy = JSON.parse(JSON.stringify(manifest)) as { integrity: { manifest_sha256: string | null } };
  copy.integrity.manifest_sha256 = null;
  return createHash("sha256").update(canonicalJson(copy)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortJson(entryValue)]));
  }
  return value;
}
