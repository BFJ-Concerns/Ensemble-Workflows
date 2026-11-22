import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runEnsembleCli } from "../../src/cli.js";
import { EngineRegistry } from "../../src/engines.js";
import { createWorkflowHooks } from "../../src/hooks.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { ChainEngine, claudeRefusal } from "./chain-engine-fakes.js";

import type { EngineAttemptResult, EngineTurnOptions, EngineWorkerSession } from "../../src/engines.js";

function answer(text: string, resolvedModel?: string): () => Promise<EngineAttemptResult> {
  return async () => ({
    text, deltaText: text, durationMs: 10, firstDeltaMs: 5, items: {}, tokenUsageEvents: [],
    ...(resolvedModel !== undefined ? { resolvedModel } : {})
  });
}

/** Held turns consume the same scripted results as one-shot calls. */
class SessionEngine extends ChainEngine {
  createSession(options: EngineTurnOptions): EngineWorkerSession {
    return {
      beginTurn: (prompt) => this.createInvocation(prompt, options),
      close: async () => {}
    };
  }
}

function runtimeOver(engines: ChainEngine[], modelFamilies?: Record<string, string>): EnsembleRuntime {
  return new EnsembleRuntime({
    engines: new EngineRegistry(engines),
    cwd: "/fake/repo",
    defaultMaxAttempts: 1,
    ...(modelFamilies !== undefined ? { modelFamilies } : {})
  });
}

function hooksFor(runtime: EnsembleRuntime): ReturnType<typeof createWorkflowHooks> {
  return createWorkflowHooks({ runtime, args: [], log: () => {}, workflow: async () => null });
}

test("workers on one model family across engines are judged single-family, by model and never by engine", async () => {
  const codex = new ChainEngine("codex", [answer("a")]);
  const claude = new ChainEngine("claude", [answer("b"), answer("c")]);
  const runtime = runtimeOver([codex, claude]);
  try {
    const hooks = hooksFor(runtime);
    await hooks.agent("doer", { engine: "codex", model: "claude-sonnet-5-5" });
    await hooks.agent("reviewer", { engine: "claude", model: "claude-opus-5-5" });
    await hooks.agent("checker", { engine: "claude", model: "opus" });
    assert.deepEqual(runtime.singleFamily(), { family: "claude", workers: 3 });
  } finally {
    await runtime.close();
  }
});

test("workers spanning families are not judged single-family, and a lone worker is its own family's", async () => {
  const spanning = runtimeOver([new ChainEngine("codex", [answer("a")]), new ChainEngine("claude", [answer("b")])]);
  const lone = runtimeOver([new ChainEngine("claude", [answer("a")])]);
  try {
    await hooksFor(spanning).agent("doer", { engine: "codex", model: "gpt-6.2-sol" });
    await hooksFor(spanning).agent("reviewer", { engine: "claude", model: "claude-opus-5-5" });
    assert.equal(spanning.singleFamily(), null);
    await hooksFor(lone).agent("doer", { engine: "claude", model: "claude-opus-5-5" });
    assert.deepEqual(lone.singleFamily(), { family: "claude", workers: 1 });
  } finally {
    await spanning.close();
    await lone.close();
  }
});

test("a machine assignment moves a model into a family for the judgement", async () => {
  const claude = new ChainEngine("claude", [answer("a"), answer("b")]);
  const runtime = runtimeOver([claude], { "gateway-glm": "glm", "gateway-glm-air": "glm" });
  try {
    const hooks = hooksFor(runtime);
    await hooks.agent("doer", { engine: "claude", model: "gateway-glm" });
    await hooks.agent("reviewer", { engine: "claude", model: "gateway-glm-air" });
    assert.deepEqual(runtime.singleFamily(), { family: "glm", workers: 2 });
  } finally {
    await runtime.close();
  }
});

test("a worker naming no model is judged by the model its engine's default served, and unknown where none was reported", async () => {
  const served = runtimeOver([
    new ChainEngine("codex", [answer("a", "gpt-6.2-sol")]),
    new ChainEngine("claude", [answer("b")])
  ]);
  const unreported = runtimeOver([new ChainEngine("codex", [answer("a"), answer("b")])]);
  try {
    await hooksFor(served).agent("doer", { engine: "codex" });
    await hooksFor(served).agent("reviewer", { engine: "claude", model: "gpt-6.1-sol" });
    assert.deepEqual(served.singleFamily(), { family: "gpt", workers: 2 });
    // The engine's name is never a family: an unpinned worker whose engine
    // reported no model leaves the fact unknown, and nothing is said.
    await hooksFor(unreported).agent("doer", { engine: "codex" });
    await hooksFor(unreported).agent("reviewer", { engine: "codex" });
    assert.equal(unreported.singleFamily(), null);
  } finally {
    await served.close();
    await unreported.close();
  }
});

test("a worker is judged on the target it resolved to at dispatch, not on the chain entry that answered", async () => {
  const claude = new ChainEngine("claude", [claudeRefusal(429, "rate_limit_error"), answer("b")]);
  const codex = new ChainEngine("codex", [answer("a")]);
  const runtime = runtimeOver([claude, codex]);
  try {
    const hooks = hooksFor(runtime);
    const first = await hooks.agent("reviewer", {
      engine: "claude", model: "claude-opus-5-5", fallback: [{ engine: "codex", model: "gpt-6.2-sol" }], identity: true
    });
    assert.deepEqual(first.answeredBy, { engine: "codex", model: "gpt-6.2-sol", family: "gpt" });
    await hooks.agent("checker", { engine: "claude", model: "claude-sonnet-5-5" });
    assert.deepEqual(runtime.singleFamily(), { family: "claude", workers: 2 });
  } finally {
    await runtime.close();
  }
});

test("a multi-turn session counts as one worker however many turns it takes", async () => {
  const claude = new SessionEngine("claude", [answer("a"), answer("b"), answer("c")]);
  const runtime = runtimeOver([claude]);
  try {
    const session = hooksFor(runtime).session({ engine: "claude", model: "claude-opus-5-5" });
    await session.send("one");
    await session.send("two");
    await session.close();
    assert.deepEqual(runtime.singleFamily(), { family: "claude", workers: 1 });
    await hooksFor(runtime).agent("reviewer", { engine: "claude", model: "claude-sonnet-5-5" });
    assert.deepEqual(runtime.singleFamily(), { family: "claude", workers: 2 });
  } finally {
    await runtime.close();
  }
});

class CaptureStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }
  text(): string {
    return this.chunks.join("");
  }
}

async function runTwoWorkerWorkflow(config: Record<string, unknown>): Promise<{
  exitCode: number;
  stderr: string;
  manifest: { single_family_notice: unknown; single_family: unknown };
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-single-family-"));
  const configFile = path.join(directory, "config", "ensemble", "config.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({ schema_version: 1, ...config }));
  const workflowPath = path.join(directory, "pair.workflow.js");
  await writeFile(workflowPath, [
    'export const meta = { name: "pair" };',
    'await agent("do it", { engine: "codex", model: "house-model" });',
    'return await agent("check it", { engine: "claude", model: "claude-opus-5-5" });'
  ].join("\n"));
  const engines = [new ChainEngine("codex", [answer("done")]), new ChainEngine("claude", [answer("checked")])];
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  try {
    const exitCode = await runEnsembleCli([workflowPath], {
      cwd: directory,
      env: { XDG_CONFIG_HOME: path.join(directory, "config"), ENSEMBLE_STATUS: "off" },
      stdout,
      stderr,
      runRecordDir: path.join(directory, "records"),
      createRuntime: async (options) => new EnsembleRuntime({ ...options, engines: new EngineRegistry(engines), defaultMaxAttempts: 1 })
    });
    const announcement = stderr.text().split("\n").find((line) => line.startsWith("[run-record-archive] "));
    assert.ok(announcement, stderr.text());
    const archivePath = (JSON.parse(announcement.slice("[run-record-archive] ".length)) as { archive_path: string }).archive_path;
    const manifest = JSON.parse(await readFile(path.join(archivePath, "manifest.json"), "utf8")) as {
      single_family_notice: unknown;
      single_family: unknown;
    };
    return { exitCode, stderr: stderr.text(), manifest };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a run whose workers all resolved onto one family says so on stderr at its end and in the manifest", async () => {
  // The machine file's assignment places the house model in Claude's family.
  const run = await runTwoWorkerWorkflow({ model_families: { "house-model": "claude" } });
  assert.equal(run.exitCode, 0, run.stderr);
  const notices = run.stderr.split("\n").filter((line) => line.startsWith("[single-family] "));
  assert.deepEqual(notices, ["[single-family] all 2 workers resolved onto one model family: claude"]);
  assert.equal(run.manifest.single_family_notice, true);
  assert.deepEqual(run.manifest.single_family, { family: "claude", workers: 2 });
});

test("a run across families, or one whose worker's family is unknown, says nothing", async () => {
  const assigned = await runTwoWorkerWorkflow({ model_families: { "house-model": "glm" } });
  const unknown = await runTwoWorkerWorkflow({});
  for (const run of [assigned, unknown]) {
    assert.equal(run.exitCode, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /\[single-family\]/);
    assert.equal(run.manifest.single_family, null);
  }
});

test("the machine file turns the single-family notice off", async () => {
  const run = await runTwoWorkerWorkflow({ model_families: { "house-model": "claude" }, single_family_notice: false });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /\[single-family\]/);
  assert.equal(run.manifest.single_family_notice, false);
  assert.equal(run.manifest.single_family, null);
});

test("a single-agent run whose worker's family is known says so too", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-single-family-agent-"));
  const codex = new ChainEngine("codex", [answer("OK", "gpt-6.1-sol")]);
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  try {
    const exitCode = await runEnsembleCli(["agent", "--engine=codex", "Reply with OK"], {
      cwd: directory,
      env: { XDG_CONFIG_HOME: path.join(directory, "missing-config"), ENSEMBLE_STATUS: "off" },
      stdout,
      stderr,
      runRecordDir: null,
      createRuntime: async (options) => new EnsembleRuntime({ ...options, engines: new EngineRegistry([codex]), defaultMaxAttempts: 1 })
    });
    assert.equal(exitCode, 0, stderr.text());
    const notices = stderr.text().split("\n").filter((line) => line.startsWith("[single-family] "));
    assert.deepEqual(notices, ["[single-family] 1 worker resolved onto one model family: gpt"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
