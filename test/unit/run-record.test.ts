import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Writable } from "node:stream";

import { readArchiveIntegrity } from "../archive-integrity-reader.js";
import { EngineRegistry } from "../../src/engines.js";
import { DIGEST_RECIPE } from "../../src/canonical-document.js";
import { EngineShutdownError } from "../../src/errors.js";
import { RunRecordWriter, reapAbandonedRuns, resolveRunDirectory } from "../../src/run-record.js";
import { writeProcStat } from "../fixtures/proc-stat.js";
import type { RuntimeAgentRecord } from "../../src/run-record.js";
import { runEnsembleCli } from "../../src/cli.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { Scheduler } from "../../src/scheduler.js";

import type { EngineAdapter, EngineInvocation } from "../../src/engines.js";
import type { EngineName, RuntimeOptions, TokenUsageBreakdown, TurnResult } from "../../src/types.js";

const execFileAsync = promisify(execFile);


test("the run id and the archive directory carry one identifier, verbatim", async () => {
  const cwd = await gitRepo("ensemble-record-identifier-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-identifier-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-ident",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  await writer.finish({ status: "complete", exitCode: 0, result: null });

  // A user carries the startup line's run id straight to the filesystem:
  // `cwd:<hash24>:<uuid>` names `runs/cwd/<hash24>/<uuid>` with no
  // transformation (the pre-fix tree used the full hash in the path and
  // the truncated one in the id).
  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    run_id: string;
  };
  const match = /^cwd:([0-9a-f]{24}):run-ident$/.exec(manifest.run_id);
  assert.ok(match, `unexpected run_id shape: ${manifest.run_id}`);
  assert.ok(
    writer.archiveDir.endsWith(path.join("runs", "cwd", match![1]!, "run-ident")),
    `archive dir ${writer.archiveDir} does not carry the run id's namespace component`
  );
});

test("a rejected hold event preserves its submitted verdict, or explicitly says why it is unavailable", async () => {
  const cwd = await gitRepo("ensemble-record-hold-rejection-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-hold-rejection-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-hold-rejection",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });

  await writer.recordHoldEvent({
    method: "hold/answerRejected",
    params: { holdId: "hold-1", reason: "invalid-verdict", attemptedVerdict: "later", attemptedVerdictState: "submitted" },
    receivedAt: 0
  });
  await writer.recordHoldEvent({
    method: "hold/answerRejected",
    params: { holdId: "hold-1", reason: "malformed", attemptedVerdict: null, attemptedVerdictState: "unparseable" },
    receivedAt: 1
  });
  await writer.finish({ status: "complete", exitCode: 0, result: null });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    hold_events: Array<Record<string, unknown>>;
  };
  assert.deepEqual(manifest.hold_events, [
    {
      hold_id: "hold-1",
      event: "answer-rejected",
      verdict: null,
      reason: "invalid-verdict",
      attempted_verdict: "later",
      attempted_verdict_state: "submitted",
      answered_by: null,
      note: null,
      at: new Date(0).toISOString()
    },
    {
      hold_id: "hold-1",
      event: "answer-rejected",
      verdict: null,
      reason: "malformed",
      attempted_verdict: null,
      attempted_verdict_state: "unparseable",
      answered_by: null,
      note: null,
      at: new Date(1).toISOString()
    }
  ]);
});

test("the manifest attributes budget ceilings and the run timeout to their winning layers", async () => {
  const cwd = await gitRepo("ensemble-record-effective-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-effective-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-effective",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false, budget: { codex: 50_000 }, timeoutMs: 90_000 },
    effectiveSettings: {
      budgetCeilings: {
        codex: { value: 50_000, layer: "flag" },
        claude: { value: null, layer: "default" },
        opencode: { value: null, layer: "default" }
      },
      runTimeoutMs: { value: 90_000, layer: "flag" }
    }
  });
  await writer.finish({ status: "complete", exitCode: 0, result: null });

  // The auditor's read: which layer won each run-shaping number, without
  // product knowledge — the shape the concurrency block established.
  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    budget_ceilings: Record<string, { value: number | null; layer: string }>;
    run_timeout_ms: { value: number | null; layer: string };
  };
  assert.deepEqual(manifest.budget_ceilings.codex, { value: 50_000, layer: "flag" });
  assert.deepEqual(manifest.budget_ceilings.claude, { value: null, layer: "default" });
  assert.deepEqual(manifest.run_timeout_ms, { value: 90_000, layer: "flag" });

  // A writer given no effective settings still publishes the honest default
  // shape rather than omitting the keys.
  const bare = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-effective-bare",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  await bare.finish({ status: "complete", exitCode: 0, result: null });
  const bareManifest = JSON.parse(await readFile(path.join(bare.archiveDir, "manifest.json"), "utf8")) as {
    budget_ceilings: Record<string, unknown>;
    run_timeout_ms: { value: number | null; layer: string };
  };
  assert.deepEqual(bareManifest.budget_ceilings, {});
  assert.deepEqual(bareManifest.run_timeout_ms, { value: null, layer: "default" });
});

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
  const manifestKeys = JSON.parse(await readFile("test/fixtures/run-record/v4-manifest-keys.json", "utf8")) as {
    manifest: string[];
    args: string[];
  };
  const agentKeys = JSON.parse(await readFile("test/fixtures/run-record/v4-agent-keys.json", "utf8"));
  const attemptKeys = JSON.parse(await readFile("test/fixtures/run-record/v4-attempt-keys.json", "utf8"));

  assert.deepEqual(Object.keys(manifest).sort(), manifestKeys.manifest);
  assert.deepEqual(Object.keys(manifest.args as Record<string, unknown>).sort(), manifestKeys.args);
  assert.deepEqual(Object.keys(agent).sort(), agentKeys);
  assert.deepEqual(Object.keys((agent.attempts as Array<Record<string, unknown>>)[0]!).sort(), attemptKeys);
  assert.equal(manifest.schema_version, 4);
  assert.equal(manifest.kind, "run_manifest");
  assert.equal(manifest.caller_identity, "session:run-record-test");
  assert.equal(agent.schema_version, 4);
  assert.equal(agent.kind, "agent_record");
  assert.equal(agent.header_identity, "original_request");
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
  ) as { concurrency: unknown; agent_ceiling?: unknown };
  assert.equal(Object.hasOwn(manifest, "agent_ceiling"), false);
  assert.deepEqual(manifest.concurrency, {
    agent_ceiling: { value: 4, layer: "env" },
    engines: {
      claude: { value: 8, layer: "default" },
      codex: { value: 3, layer: "flag" },
      opencode: { value: 5, layer: "config-file" }
    }
  });
});

test("a dispatched worker with no usage has an unresolved roll-up reason", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "ensemble-empty-rollup-"));
  try {
    const start = (runUuid: string) => RunRecordWriter.start({
      storeDir: scratch,
      cwd: process.cwd(),
      runUuid,
      workflowPath: path.join(scratch, "workflow.js"),
      workflowSource: "export const meta = { name: 'empty-rollup' };\nreturn true;\n",
      args: [],
      cliFlags: { jsonArgs: false }
    });
    const empty = await start("no-worker");
    await empty.finish({ status: "complete", exitCode: 0, result: true });
    const emptyManifest = JSON.parse(await readFile(path.join(empty.archiveDir, "manifest.json"), "utf8")) as {
      cost_rollup: unknown;
    };
    assert.deepEqual(emptyManifest.cost_rollup, {});

    const writer = await start("cut-short-worker");
    const worker = agentRecord(1, "codex", null, 0);
    worker.status = "timed-out";
    worker.attempts = [];
    worker.terminationCause = { kind: "WorkflowTimeoutError", message: "run deadline elapsed" };
    await writer.recordAgent(worker);
    await writer.finish({ status: "timed-out", exitCode: 1, result: null });
    const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
      cost_rollup: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(manifest.cost_rollup.codex?.unresolved, { unavailable: "no-usage-reported" });

    const attempted = await start("attempt-without-usage");
    const attempt = agentRecord(1, "codex", null, 0);
    attempt.attempts[0]!.status = "failed";
    attempt.attempts[0]!.tokenUsageEvents = [];
    await attempted.recordAgent(attempt);
    await attempted.finish({ status: "failed", exitCode: 1, result: null });
    const attemptedManifest = JSON.parse(
      await readFile(path.join(attempted.archiveDir, "manifest.json"), "utf8")
    ) as { cost_rollup: Record<string, Record<string, unknown>> };
    assert.deepEqual(attemptedManifest.cost_rollup.codex?.unresolved, { unavailable: "no-usage-reported" });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a standalone bundle does not attribute the workflow checkout to its own build", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "ensemble-build-identity-"));
  try {
    const bundle = path.join(scratch, "ensemble.mjs");
    await writeFile(bundle, await readFile("skills/ensemble-workflow/Base/scripts/ensemble.mjs"));
    const workflow = path.join(scratch, "workflow.js");
    await writeFile(workflow, "export const meta = { name: 'build-identity' };\nreturn true;\n");
    await execFileAsync(process.execPath, [bundle, workflow], {
      cwd: process.cwd(),
      env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: path.join(scratch, "records"), XDG_CONFIG_HOME: scratch }
    });
    const manifest = JSON.parse(await readFile(await findManifest(path.join(scratch, "records")), "utf8")) as {
      harness: { commit: string | null; commit_unavailable: string | null };
    };
    assert.deepEqual(
      { commit: manifest.harness.commit, commit_unavailable: manifest.harness.commit_unavailable },
      { commit: null, commit_unavailable: "bundle-has-no-embedded-commit" }
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("an empty tallies object explains that the script recorded no counts", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "ensemble-tallies-state-"));
  try {
    const writer = await RunRecordWriter.start({
      storeDir: scratch,
      cwd: process.cwd(),
      runUuid: "tallies-state",
      workflowPath: path.join(scratch, "workflow.js"),
      workflowSource: "export const meta = { name: 'tallies-state' };\nreturn true;\n",
      args: [],
      cliFlags: { jsonArgs: false }
    });
    const read = async () => JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
      tallies: Record<string, number>;
      tallies_unavailable: string | null;
    };
    assert.deepEqual([(await read()).tallies, (await read()).tallies_unavailable], [{}, "none-recorded"]);
    await writer.recordTally("accepted", 0);
    assert.deepEqual([(await read()).tallies, (await read()).tallies_unavailable], [{ accepted: 0 }, null]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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
  await writer.recordAgent(agentRecordWithUsage(1, "codex", usage(20, 8, 5, 0, 25)));
  await writer.recordAgent(agentRecordWithUsage(2, "claude", usage(12, 8, 5, undefined, 25)));
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
  // total (12 + 8 + 5 + 0 = 25). Its reported zero survives as zero. The
  // engine-native 20/5/25 figures stay in
  // the attempt events beneath, untouched.
  assert.deepEqual(codex, {
    freshInputTokens: 12,
    cachedInputTokens: 8,
    outputTokens: 5,
    reasoningOutputTokens: 0,
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

  const agentJson = async (id: string) => JSON.parse(
    await readFile(path.join(writer.archiveDir, "agents", id, "agent.json"), "utf8")
  ) as {
    usage: { summary?: Record<string, unknown> };
  };
  // Each agent and its manifest roll-up are cold-read consumers of the same
  // summary boundary: Codex's reported zero stays zero at both levels, while
  // Claude's absent measurement stays null at both levels.
  assert.deepEqual((await agentJson("000001")).usage.summary, codex);
  assert.deepEqual((await agentJson("000002")).usage.summary, claude);
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
    agentRecordWithUsage(1, "claude", { ...usage(220, 10, 40, undefined, 270), cacheCreationInputTokens: 3 })
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

  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents", "000001", "agent.json"), "utf8")) as {
    usage: { summary?: Record<string, unknown> };
  };
  assert.deepEqual(agent.usage.summary, tokens);
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

test("a dispatch-time record says unsettled, not no-attempt-ran, before and after an unclean death", async () => {
  // The killed-run journey as the archive sees it: the dispatch-time write
  // lands while the attempt is running, the launcher dies by SIGKILL, and
  // the next writer's sweep reaps the record. At every step a cold reader
  // must find no denial of the attempt the live status snapshot showed
  // running, and no zero-cost claim — only "unsettled".
  const cwd = await gitRepo("ensemble-record-unsettled-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const proc = await mkdtemp(path.join(tmpdir(), "ensemble-record-unsettled-proc-"));
  try {
    await writeProcStat(proc, process.pid, "1111");
    const writer = await RunRecordWriter.start({
      storeDir: store,
      cwd,
      runUuid: "run-unsettled",
      workflowPath: path.join(cwd, "workflow.js"),
      workflowSource: "export const meta = { name: 'unsettled' };\nreturn true;\n",
      args: [],
      cliFlags: { jsonArgs: false },
      procDir: proc
    });
    const inFlight = agentRecord(1, "claude", null, 0);
    inFlight.status = "in-progress";
    inFlight.attempts = [];
    inFlight.rawOutput = null;
    inFlight.validatedOutput = null;
    await writer.recordAgent(inFlight);

    const agentJsonPath = path.join(writer.archiveDir, "agents", "000001", "agent.json");
    const readAgent = async () =>
      JSON.parse(await readFile(agentJsonPath, "utf8")) as {
        status: string;
        attempts: unknown[];
        usage: { unavailable?: string; summary?: unknown };
        transcripts_unavailable: string | null;
      };
    const dispatched = await readAgent();
    assert.equal(dispatched.status, "in-progress");
    assert.deepEqual(dispatched.attempts, [], "the attempt in flight has not settled, so it is not listed");
    assert.deepEqual(dispatched.usage, { unavailable: "record-unsettled" });
    assert.equal(dispatched.transcripts_unavailable, "record-unsettled");

    // The launcher dies without sealing: the manifest's owner is rewritten
    // to a pid that is provably gone, as the next writer will find it.
    const manifestPath = path.join(writer.archiveDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeAttestedRunManifest(
      path.dirname(writer.archiveDir),
      path.basename(writer.archiveDir),
      { ...manifest, owner: { pid: 999999, start_ticks: "3333", host: hostname() } },
      (manifest.files as Array<{ path: string; size: number; sha256: string }>)
    );
    const reaped = await reapAbandonedRuns({
      namespaceDir: path.dirname(writer.archiveDir),
      procDir: proc,
      observer: { pid: process.pid, runUuid: "sweeper-run" }
    });
    assert.deepEqual(reaped, [path.basename(writer.archiveDir)]);

    const abandoned = await readAgent();
    assert.equal(abandoned.status, "abandoned");
    assert.deepEqual(abandoned.attempts, [], "the reap invents no attempt");
    assert.deepEqual(abandoned.usage, { unavailable: "record-unsettled" }, "the reap never turns unsettled into no-attempt-ran");
    assert.equal(abandoned.transcripts_unavailable, "record-unsettled");
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(proc, { recursive: true, force: true });
  }
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
    headerIdentity: "original_request",
    prompt: "fixture prompt",
    options: { timeoutMs: null, maxAttempts: 3 },
    session: null,
    model,
    effort: null,
    fallback: null,
    lean: null,
    answeredBy: null,
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
    transcriptCapture: null,
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
        target: { engine, model: null },
        failure: null,
        classification: null,
        chainDecision: null,
        observedFailure: null,
        workerExit: null,
      backgroundWaits: [],
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
  #activeInvocations = new Set<EngineInvocation>();

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
    let rejectHang: ((error: Error) => void) | undefined;
    const invocation: EngineInvocation = {
      runAttempt: async () => {
        if (prompt === "hang") {
          await new Promise<never>((_resolve, reject) => {
            rejectHang = reject;
          });
        }
        return turn(`${this.name}:${prompt}`, 5);
      },
      // The adapter contract: close settles active invocations — the
      // runtime's shutdown accounting waits on those settlements.
      close: async () => {
        this.#activeInvocations.delete(invocation);
        rejectHang?.(new EngineShutdownError(this.name));
        rejectHang = undefined;
      }
    };
    this.#activeInvocations.add(invocation);
    return invocation;
  }

  async close(): Promise<void> {
    this.scheduler.close(new EngineShutdownError(this.name));
    await Promise.allSettled([...this.#activeInvocations].map((invocation) => invocation.close?.()));
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
  reasoningOutputTokens: number | undefined,
  totalTokens: number
): TokenUsageBreakdown {
  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    totalTokens
  };
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
  assert.equal(writer.sealedManifestDigest(), manifest.integrity.manifest_sha256);
  // The archive states its own verification rule beside the digest.
  assert.equal((manifest.integrity as { recipe?: string }).recipe, DIGEST_RECIPE);

  // The tamper the archive-consumer session made and every hash check
  // passed: an edited manifest field, with the files table untouched.
  const tampered = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
  tampered.schema_version = 999;
  assert.notEqual(manifestSelfDigest(tampered), tampered.integrity.manifest_sha256);
  await rm(store, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

test("the sealed digest is published only after the seal", async () => {
  // The sentinel's attestation reads this accessor. A mid-run manifest
  // carries a real self-digest, but finish() rewrites the file — so until
  // the seal lands, publishing that digest outside the archive would vouch
  // for bytes the seal then replaces. `manifest-unsealed` must mean what it
  // says: no digest until the archive is final.
  const cwd = await gitRepo("ensemble-record-seal-gate-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-seal-gate",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: null,
    cliFlags: { jsonArgs: false }
  });
  // The start() write has already produced a manifest with a self-digest…
  const manifestPath = path.join(writer.archiveDir, "manifest.json");
  const midRun = JSON.parse(await readFile(manifestPath, "utf8")) as {
    integrity: { manifest_sha256: string | null };
  };
  assert.equal(typeof midRun.integrity.manifest_sha256, "string");
  // …but the accessor publishes nothing until the seal.
  assert.equal(writer.sealedManifestDigest(), null);

  await writer.finish({ status: "complete", exitCode: 0, result: true });
  const sealed = JSON.parse(await readFile(manifestPath, "utf8")) as {
    integrity: { manifest_sha256: string | null };
  };
  assert.equal(writer.sealedManifestDigest(), sealed.integrity.manifest_sha256);
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
    await writeAttestedRunManifest(namespaceDir, "dead-run", {
      status: "in-progress",
      owner: { pid: 999999, start_ticks: "3333", host }
    });
    await writeAttestedRunManifest(namespaceDir, "reused-pid-run", {
      status: "in-progress",
      owner: { pid: 54321, start_ticks: "9999", host }
    });
    await writeAttestedRunManifest(namespaceDir, "live-run", {
      status: "in-progress",
      owner: { pid: 54321, start_ticks: "2222", host }
    });
    await writeAttestedRunManifest(namespaceDir, "foreign-host-run", {
      status: "in-progress",
      owner: { pid: 999998, start_ticks: "4", host: "elsewhere.invalid" }
    });
    await writeAttestedRunManifest(namespaceDir, "no-evidence-run", {
      status: "in-progress",
      owner: { pid: 999997, start_ticks: null, host }
    });
    await writeRunManifest(namespaceDir, "legacy-run", { status: "in-progress", run_uuid: "legacy" });
    await writeAttestedRunManifest(namespaceDir, "finished-run", {
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

test("the reaper resolves a reaped run's in-progress agent records and leaves settled ones", async () => {
  const namespaceDir = await mkdtemp(path.join(tmpdir(), "ensemble-reap-agents-ns-"));
  const proc = await mkdtemp(path.join(tmpdir(), "ensemble-reap-agents-proc-"));
  try {
    await writeProcStat(proc, process.pid, "1111");
    const host = hostname();
    // The discriminating pair: a dispatch-time record the death stranded,
    // and a sibling whose settlement landed before the death. Both are
    // tracked in the manifest's files table with their digests, as the
    // real writer tracks every write — a reaped archive must still verify.
    const strandedBytes = `${JSON.stringify({ kind: "agent_record", id: 1, status: "in-progress", attempts: [] })}\n`;
    const settledBytes = `${JSON.stringify({
      kind: "agent_record",
      id: 2,
      status: "complete",
      attempts: [{ attempt: 1, status: "complete" }]
    })}\n`;
    await writeAgentRecordBytes(namespaceDir, "dead-run", "000001", strandedBytes);
    await writeAgentRecordBytes(namespaceDir, "dead-run", "000002", settledBytes);
    await writeAttestedRunManifest(
      namespaceDir,
      "dead-run",
      { status: "in-progress", owner: { pid: 999999, start_ticks: "3333", host } },
      [fileEntry("agents/000001/agent.json", strandedBytes), fileEntry("agents/000002/agent.json", settledBytes)]
    );

    const reaped = await reapAbandonedRuns({
      namespaceDir,
      procDir: proc,
      observer: { pid: process.pid, runUuid: "sweeper-run" }
    });

    assert.deepEqual(reaped, ["dead-run"]);
    const stranded = await readAgentRecord(namespaceDir, "dead-run", "000001");
    assert.equal(stranded.status, "abandoned", "a stranded dispatch-time record stops asserting in-progress");
    const abandonment = stranded.abandonment as { reason: string; observed_by: { run_uuid: string } };
    assert.equal(abandonment.reason, "owner-process-gone");
    assert.equal(abandonment.observed_by.run_uuid, "sweeper-run");
    assert.deepEqual(stranded.attempts, [], "resolution never invents attempts or usage");
    const settled = await readAgentRecord(namespaceDir, "dead-run", "000002");
    assert.equal(settled.status, "complete", "a landed settlement is evidence, never rewritten");
    assert.equal(settled.abandonment, undefined);
    // The one manifest write carried the rewritten record's refreshed
    // table entry, so every declared digest still matches its bytes and
    // the manifest's own self-attestation holds.
    const reapedManifest = await readRunManifest(namespaceDir, "dead-run");
    for (const declared of reapedManifest.files as Array<{ path: string; size: number; sha256: string }>) {
      const bytes = await readFile(path.join(namespaceDir, "dead-run", declared.path), "utf8");
      assert.equal(declared.sha256, createHash("sha256").update(bytes).digest("hex"), declared.path);
      assert.equal(declared.size, Buffer.byteLength(bytes), declared.path);
    }
    assert.equal(manifestSelfDigest(reapedManifest), (reapedManifest.integrity as { manifest_sha256: string }).manifest_sha256);
  } finally {
    await rm(namespaceDir, { recursive: true, force: true });
    await rm(proc, { recursive: true, force: true });
  }
});

test("the reaper abandons a provably-dead manifest with a null integrity block", async () => {
  const namespaceDir = await mkdtemp(path.join(tmpdir(), "ensemble-reap-null-integrity-ns-"));
  const proc = await mkdtemp(path.join(tmpdir(), "ensemble-reap-null-integrity-proc-"));
  try {
    await writeProcStat(proc, process.pid, "1111");
    const host = hostname();
    await writeRunManifest(namespaceDir, "null-integrity-run", {
      status: "in-progress",
      owner: { pid: 999999, start_ticks: "3333", host },
      integrity: null
    });

    const reaped = await reapAbandonedRuns({
      namespaceDir,
      procDir: proc,
      observer: { pid: process.pid, runUuid: "sweeper-run" }
    });

    assert.deepEqual(reaped, ["null-integrity-run"]);
    const manifest = await readRunManifest(namespaceDir, "null-integrity-run");
    assert.equal(manifest.status, "abandoned");
    assert.equal((manifest.abandonment as { reason: string }).reason, "owner-process-gone");
    assert.equal(manifest.integrity, null);
  } finally {
    await rm(namespaceDir, { recursive: true, force: true });
    await rm(proc, { recursive: true, force: true });
  }
});

test("a cold archive reader rejects the old reap shape and verifies every reaper rewrite route", async () => {
  const namespaceDir = await mkdtemp(path.join(tmpdir(), "ensemble-reap-integrity-ns-"));
  const proc = await mkdtemp(path.join(tmpdir(), "ensemble-reap-integrity-proc-"));
  try {
    await writeProcStat(proc, process.pid, "1111");
    await writeProcStat(proc, 54321, "2222");
    const host = hostname();
    const owner = { pid: 999999, start_ticks: "3333", host };

    // The old standalone rewrite changed these fields but retained the
    // previous self-digest. A cold reader must observe that breakage.
    await writeAttestedRunManifest(namespaceDir, "pre-fix", { status: "in-progress", owner });
    const preFix = await readRunManifest(namespaceDir, "pre-fix");
    preFix.status = "abandoned";
    preFix.abandonment = {
      observed_at: "2026-08-30T00:00:00.000Z",
      reason: "owner-process-gone",
      observed_by: { pid: process.pid, run_uuid: "sweeper-run" }
    };
    await writeFile(path.join(namespaceDir, "pre-fix", "manifest.json"), `${canonicalJson(preFix)}\n`);
    assert.equal((await readArchiveIntegrity(path.join(namespaceDir, "pre-fix"))).manifestVerified, false);

    await writeAttestedRunManifest(namespaceDir, "dead-run", { status: "in-progress", owner });
    await writeAttestedRunManifest(namespaceDir, "live-run", {
      status: "in-progress",
      owner: { pid: 54321, start_ticks: "2222", host }
    });
    const liveBefore = await readFile(path.join(namespaceDir, "live-run", "manifest.json"), "utf8");
    const reaped = await reapAbandonedRuns({
      namespaceDir,
      procDir: proc,
      observer: { pid: process.pid, runUuid: "sweeper-run" }
    });

    assert.deepEqual(reaped, ["dead-run"]);
    const direct = await readArchiveIntegrity(path.join(namespaceDir, "dead-run"));
    assert.equal(direct.status, "abandoned");
    assert.equal(direct.manifestVerified, true);
    assert.equal(await readFile(path.join(namespaceDir, "live-run", "manifest.json"), "utf8"), liveBefore);
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
    await writeAttestedRunManifest(path.dirname(siblingDir), path.basename(siblingDir), {
      status: "in-progress",
      owner: { pid: 999999, start_ticks: "3", host: hostname() }
    });

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
    assert.equal((await readArchiveIntegrity(siblingDir)).manifestVerified, true);
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


async function writeRunManifest(namespaceDir: string, runName: string, manifest: unknown): Promise<void> {
  const dir = path.join(namespaceDir, runName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
}

async function writeAttestedRunManifest(
  namespaceDir: string,
  runName: string,
  manifest: Record<string, unknown>,
  files: Array<{ path: string; size: number; sha256: string }> = []
): Promise<void> {
  const attested = {
    ...manifest,
    files,
    integrity: { algorithm: "sha256", files_lost: [], manifest_sha256: null as string | null }
  };
  attested.integrity.manifest_sha256 = manifestSelfDigest(attested);
  await writeRunManifest(namespaceDir, runName, attested);
}

function fileEntry(relativePath: string, bytes: string): { path: string; size: number; sha256: string } {
  return {
    path: relativePath,
    size: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

async function writeAgentRecordBytes(
  namespaceDir: string,
  runName: string,
  agentDir: string,
  bytes: string
): Promise<void> {
  const dir = path.join(namespaceDir, runName, "agents", agentDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "agent.json"), bytes);
}

async function readRunManifest(namespaceDir: string, runName: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(namespaceDir, runName, "manifest.json"), "utf8")) as Record<string, unknown>;
}

async function readAgentRecord(
  namespaceDir: string,
  runName: string,
  agentDir: string
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(namespaceDir, runName, "agents", agentDir, "agent.json"), "utf8")
  ) as Record<string, unknown>;
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
      schema_version: number;
      termination_cause: { kind: string; message: string } | null;
      transcripts: unknown[];
      transcripts_unavailable: string | null;
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
  // This is a cold read of the real writer's v3 record. No transcript
  // survives an interruption, but the array's type remains stable and its
  // sibling carries the reason a consumer needs to interpret the empty list.
  assert.equal(interruptedAgent.schema_version, 4);
  assert.ok(Array.isArray(interruptedAgent.transcripts));
  assert.deepEqual(interruptedAgent.transcripts, []);
  assert.equal(interruptedAgent.transcripts_unavailable, "worker-interrupted");
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
  assert.equal((completedAgent.transcripts[0] as { partial?: boolean } | undefined)?.partial, false);
  assert.equal(completedAgent.transcripts_unavailable, null);
});

test("cold archive reads distinguish retained Codex capture from a genuine capture loss", async () => {
  const cwd = await gitRepo("ensemble-record-session-transcript-reason-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-session-transcript-reason",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "return true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });

  const codexFirstTurn = agentRecord(1, "codex", null, 0);
  codexFirstTurn.session = { id: 1, turn: 1 };
  codexFirstTurn.attempts[0]!.transcripts = [];
  const claudeFollowUp = agentRecord(2, "claude", null, 0);
  claudeFollowUp.session = { id: 2, turn: 2 };
  claudeFollowUp.attempts[0]!.transcripts = [];
  const retainedCodexFollowUp = agentRecord(3, "codex", null, 0);
  retainedCodexFollowUp.session = { id: 3, turn: 2 };
  retainedCodexFollowUp.transcriptCapture = "retained";
  retainedCodexFollowUp.attempts[0]!.transcripts = [];
  const lostCodexFollowUp = agentRecord(4, "codex", null, 0);
  lostCodexFollowUp.session = { id: 4, turn: 2 };
  lostCodexFollowUp.transcriptCapture = "lost";
  lostCodexFollowUp.attempts[0]!.transcripts = [];
  const interruptedCodexFollowUp = agentRecord(5, "codex", null, 0);
  interruptedCodexFollowUp.session = { id: 5, turn: 2 };
  interruptedCodexFollowUp.transcriptCapture = "lost";
  interruptedCodexFollowUp.status = "interrupted";
  interruptedCodexFollowUp.attempts[0]!.transcripts = [];
  const timedOutCodexFollowUp = agentRecord(6, "codex", null, 0);
  timedOutCodexFollowUp.session = { id: 6, turn: 2 };
  timedOutCodexFollowUp.transcriptCapture = "lost";
  timedOutCodexFollowUp.status = "timed-out";
  timedOutCodexFollowUp.attempts[0]!.transcripts = [];
  await Promise.all([
    writer.recordAgent(codexFirstTurn),
    writer.recordAgent(claudeFollowUp),
    writer.recordAgent(retainedCodexFollowUp),
    writer.recordAgent(lostCodexFollowUp),
    writer.recordAgent(interruptedCodexFollowUp),
    writer.recordAgent(timedOutCodexFollowUp)
  ]);

  const reasonOf = async (id: string) =>
    (
      JSON.parse(await readFile(path.join(writer.archiveDir, "agents", id, "agent.json"), "utf8")) as {
        transcripts_unavailable: string | null;
      }
    ).transcripts_unavailable;
  assert.equal(await reasonOf("000001"), "engine-produced-no-transcript");
  assert.equal(await reasonOf("000002"), "engine-produced-no-transcript");
  // Both records are Codex follow-ups with no persisted transcript. The old
  // turn-number proxy calls both a capture gap; the archived capture state
  // distinguishes the retained capture from one the client actually lost.
  assert.equal(await reasonOf("000003"), "engine-produced-no-transcript");
  assert.equal(await reasonOf("000004"), "session-client-capture-gap");
  assert.equal(await reasonOf("000005"), "worker-interrupted");
  assert.equal(await reasonOf("000006"), "worker-timed-out");
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
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entryValue]) => [key, sortJson(entryValue)]));
  }
  return value;
}

/**
 * The consumer surface for a failed agent's account, read cold from disk.
 *
 * The runtime tests pin the settled in-memory record through a recorder
 * stub; this drives the same settlements through a real `RunRecordWriter`
 * and reads `agents/<id>/agent.json` back, because the archive is where the
 * consumer actually looks. Two of the three ways a failure's account reaches
 * the record are read from the same run: an engine account carried, an
 * unreadable account named as unavailable. The third — an attempt-diagnosed
 * failure leaving `termination_cause` null — is pinned in `runtime.test.ts`,
 * where no attempt reaches disk.
 */
test("a failed agent's account is readable cold from its archived record", async () => {
  const cwd = await gitRepo("ensemble-record-failure-account-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-failure-account-store-"));

  const rejections = new Map<string, unknown>();
  const refusal = new Error("model 'gpt-5.6-nonesuch' is not available");
  refusal.name = "ModelNotFoundError";
  rejections.set("refused", refusal);
  const silent = new Error("");
  silent.name = "SilentEngineError";
  rejections.set("silent", silent);

  const engine: EngineAdapter = {
    name: "codex",
    concurrency: 1,
    schedule: async (task) => task(),
    createInvocation: (prompt) => {
      const rejection = rejections.get(prompt);
      if (rejection !== undefined) {
        // Refused as the invocation is created: no attempt is ever pushed,
        // so the attempts array cannot carry the account.
        throw rejection;
      }
      throw new Error(`unexpected dispatch: ${prompt}`);
    },
    close: async () => undefined
  };

  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-failure-account",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "return true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  const runtime = new EnsembleRuntime({ engines: new EngineRegistry([engine]), defaultMaxAttempts: 1 });
  runtime.setRunRecorder(writer);

  await assert.rejects(() => runtime.agent("refused", { engine: "codex" }));
  await assert.rejects(() => runtime.agent("silent", { engine: "codex" }));
  await runtime.close();

  const read = async (id: string) =>
    JSON.parse(await readFile(path.join(writer.archiveDir, "agents", id, "agent.json"), "utf8")) as {
      status: string;
      termination_cause: { kind: string; message: string } | null;
      attempts: Array<{ failure: { kind: string; message: string } | null }>;
    };

  // The engine's own words survive to the archive, in the field a cold
  // consumer reads when the attempts array is empty.
  const refused = await read("000001");
  assert.equal(refused.status, "failed");
  assert.deepEqual(refused.attempts, []);
  assert.deepEqual(refused.termination_cause, {
    kind: "ModelNotFoundError",
    message: "model 'gpt-5.6-nonesuch' is not available"
  });

  // The other direction of the honesty rule: no account was readable, so the
  // record says so and why, rather than publishing a bare `failed`.
  const unreadable = await read("000002");
  assert.equal(unreadable.status, "failed");
  assert.deepEqual(unreadable.attempts, []);
  assert.deepEqual(unreadable.termination_cause, {
    kind: "unavailable",
    message:
      "the agent failed with no attempt recorded and the rejection the runtime holds (SilentEngineError) carried no message"
  });
});

test("archived agent and attempt output distinguish a silent failed turn from an empty answer", async () => {
  const cwd = await gitRepo("ensemble-record-no-output-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-no-output-store-"));
  try {
    const writer = await RunRecordWriter.start({
      storeDir: store,
      cwd,
      runUuid: "run-no-output",
      workflowPath: path.join(cwd, "workflow.js"),
      workflowSource: "return true;\n",
      args: [],
      cliFlags: { jsonArgs: false }
    });
    const engines: EngineAdapter[] = (["claude", "opencode", "codex"] as const).map((name) => ({
      name,
      concurrency: 1,
      schedule: async (task) => task(),
      createInvocation: () => ({
        runAttempt: async () =>
          name === "codex"
            ? turn("", 0)
            : {
                ...turn("", 0),
                tokenUsageEvents: [],
                transcripts: [],
                attemptFailure: {
                  kind: name === "claude" ? "claude-worker-error" : "opencode-run-error",
                  message: "worker stopped before producing text"
                }
              }
      }),
      close: async () => undefined
    }));
    const runtime = new EnsembleRuntime({ engines: new EngineRegistry(engines), defaultMaxAttempts: 1 });
    runtime.setRunRecorder(writer);

    await runtime.agent("silent Claude failure", { engine: "claude" });
    await runtime.agent("silent opencode failure", { engine: "opencode" });
    await runtime.agent("answered empty", { engine: "codex" });
    await runtime.close();
    await writer.finish({ status: "complete", exitCode: 0, result: null });

    const observed = [];
    for (const id of ["000001", "000002", "000003"]) {
      const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents", id, "agent.json"), "utf8")) as {
        engine: EngineName;
        raw_output: string | null;
        attempts: Array<{ raw_output: string | null; failure: { kind: string } | null }>;
      };
      assert.equal(agent.attempts.length, 1);
      observed.push({
        engine: agent.engine,
        agent: agent.raw_output,
        attempt: agent.attempts[0]!.raw_output,
        failure: agent.attempts[0]!.failure?.kind ?? null
      });
    }
    assert.deepEqual(observed, [
      { engine: "claude", agent: null, attempt: null, failure: "claude-worker-error" },
      { engine: "opencode", agent: null, attempt: null, failure: "opencode-run-error" },
      { engine: "codex", agent: "", attempt: "", failure: "empty-output" }
    ]);
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("script-recorded tallies land in the manifest beside the usage rollup, last write per name winning", async () => {
  // The count is in the archive before finish() and survives it; a consumer
  // reads it from the manifest without a transcript.
  const cwd = await gitRepo("ensemble-record-tallies-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-tallies",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  await writer.recordTally("fix rounds", 2);
  await writer.recordTally("rejected", 3);
  await writer.recordTally("fix rounds", 4);

  const midRun = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    tallies: Record<string, number>;
  };
  assert.deepEqual(midRun.tallies, { "fix rounds": 4, rejected: 3 });

  await writer.finish({ status: "complete", exitCode: 0, result: true });
  const sealed = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    tallies: Record<string, number>;
  };
  assert.deepEqual(sealed.tallies, { "fix rounds": 4, rejected: 3 });
  // A tally after the seal is dropped, like every other late write.
  await writer.recordTally("late", 1);
  const afterSeal = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    tallies: Record<string, number>;
  };
  assert.deepEqual(afterSeal.tallies, { "fix rounds": 4, rejected: 3 });
  await rm(store, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

test("a chained agent's usage is keyed under each attempt's own engine and served model", async () => {
  // One agent, two engines: the rollup must not book the Claude
  // attempt's spend under the agent's declared Codex engine, and the
  // agent's own summary must fold both engines' events under their own
  // inclusion rules.
  const cwd = await gitRepo("ensemble-record-chain-usage-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-chain-usage",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  // The Codex attempt spent tokens (a worker lost mid-flight) but reported
  // no served model; the agent-level resolved model is the Claude answer's.
  // The Codex spend must land under codex/unresolved, never under the
  // Claude model the agent-level field now carries.
  const record = agentRecord(1, "codex", "gpt-5.6-sol", 3);
  const refused = record.attempts[0]!;
  refused.status = "failed";
  refused.failure = { kind: "AppServerExitedError", message: "died mid-flight" };
  refused.classification = { class: "availability", rule: "codex.substrate-dead" };
  refused.target = { engine: "codex", model: "gpt-5.6-sol" };
  refused.resolvedModel = null;
  record.resolvedModel = "claude-opus-5";
  record.attempts.push({
    ...structuredClone(refused),
    attempt: 2,
    status: "complete",
    failure: null,
    classification: null,
    target: { engine: "claude", model: "opus" },
    resolvedModel: "claude-opus-5",
    tokenUsageEvents: agentRecord(2, "claude", "claude-opus-5", 7).attempts[0]!.tokenUsageEvents
  });
  record.fallback = [{ engine: "claude", model: "opus" }];
  record.answeredBy = { entry: 0, engine: "claude", model: "opus" };
  await writer.recordAgent(record);
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    cost_rollup: Record<string, Record<string, { tokens: { totalTokens: number } }>>;
  };
  assert.deepEqual(Object.keys(manifest.cost_rollup).sort(), ["claude", "codex"]);
  assert.equal(manifest.cost_rollup.claude?.["claude-opus-5"]?.tokens.totalTokens, 7);
  assert.deepEqual(Object.keys(manifest.cost_rollup.codex ?? {}), ["unresolved"]);
  assert.equal(manifest.cost_rollup.codex?.unresolved?.tokens.totalTokens, 3);
  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
    engine: string;
    answered_by: unknown;
    usage: { summary: { totalTokens: number } };
    attempts: Array<{ target: { engine: string; model: string | null }; classification: unknown }>;
  };
  assert.equal(agent.engine, "codex");
  assert.deepEqual(agent.answered_by, { entry: 0, engine: "claude", model: "opus" });
  assert.equal(agent.usage.summary.totalTokens, 10);
  assert.deepEqual(
    agent.attempts.map((attempt) => [attempt.target, attempt.classification]),
    [
      [{ engine: "codex", model: "gpt-5.6-sol" }, { class: "availability", rule: "codex.substrate-dead" }],
      [{ engine: "claude", model: "opus" }, null]
    ]
  );
  await rm(store, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

test("each attempt's chain decision is archived as chain_decision, null where the harness decided nothing", async () => {
  const cwd = await gitRepo("ensemble-record-chain-decision-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-chain-decision",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  const record = agentRecord(1, "codex", "gpt-6-sol", 3);
  const [first] = record.attempts;
  Object.assign(first!, {
    status: "failed",
    failure: { kind: "AppServerSystemError", message: "turn notification failed (threadFailed): the thread failed" },
    classification: { class: "unclassified", rule: null },
    chainDecision: "chain-not-consulted"
  });
  const onClaude = { engine: "claude" as EngineName, model: "opus" };
  const outputFailure = { class: "output" as const, rule: "output" };
  record.attempts.push(
    {
      ...structuredClone(first!),
      attempt: 2,
      classification: { class: "availability", rule: "codex.usage-limit" },
      chainDecision: "advanced"
    },
    { ...structuredClone(first!), attempt: 3, target: onClaude, classification: outputFailure, chainDecision: "retried-in-place" },
    { ...structuredClone(first!), attempt: 4, target: onClaude, classification: outputFailure, chainDecision: "exhausted" }
  );
  record.fallback = [{ engine: "claude", model: "opus" }];
  record.status = "failed";
  await writer.recordAgent(record);
  // The other side: a call with no chain carries null on its attempt.
  await writer.recordAgent(agentRecord(2, "codex", null, 1));
  await writer.finish({ status: "complete", exitCode: 0, result: true });

  const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
    attempts: Array<{ attempt: number; chain_decision: unknown }>;
  };
  // Every one of the four decisions reaches disk under the documented key,
  // spelled as the record's type spells it.
  assert.deepEqual(
    agent.attempts.map((attempt) => [attempt.attempt, attempt.chain_decision]),
    [
      [1, "chain-not-consulted"],
      [2, "advanced"],
      [3, "retried-in-place"],
      [4, "exhausted"]
    ]
  );

  const plain = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000002/agent.json"), "utf8")) as {
    attempts: Array<Record<string, unknown>>;
  };
  assert.ok(Object.hasOwn(plain.attempts[0]!, "chain_decision"));
  assert.equal(plain.attempts[0]!.chain_decision, null);
  await rm(store, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

test("a tally named __proto__ is recorded as an own property, not swallowed by the inherited setter", async () => {
  const cwd = await gitRepo("ensemble-record-tally-proto-");
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-record-store-"));
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd,
    runUuid: "run-tally-proto",
    workflowPath: path.join(cwd, "workflow.js"),
    workflowSource: "export const meta = { name: 'x' };\nreturn true;\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  await writer.recordTally("__proto__", 1);
  await writer.recordTally("constructor", 2);
  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    tallies: Record<string, number>;
  };
  assert.equal(Object.hasOwn(manifest.tallies, "__proto__"), true);
  assert.equal(manifest.tallies["__proto__"], 1);
  assert.equal(manifest.tallies.constructor, 2);
  await rm(store, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});
