import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngineRegistry } from "../../src/engines.js";
import {
  LeanStartUnsupportedError,
  ZCodeModelRequiredError,
  ZCodeSubstrateRefusedError
} from "../../src/errors.js";
import { classifyAttemptFailure, diagnoseAttemptFailure, settlesWithoutRetry } from "../../src/failure-classification.js";
import { validateEngineDefaults } from "../../src/engine-option-validation.js";
import { RunRecordWriter } from "../../src/run-record.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { WhitespaceStream } from "../../src/whitespace-stream.js";
import {
  ZCodeEngineAdapter,
  defaultZCodeReasoningLevel,
  disallowedToolsFor,
  parseZCodeListing,
  watchZCodeLine,
  zcodeRunArguments
} from "../../src/zcode-engine.js";
import { parseZCodeModel } from "../../src/zcode-model.js";

import type { RuntimeAgentRecord } from "../../src/run-record.js";
import type { StreamedCommandResult } from "../../src/streamed-command.js";
import type { JsonObject } from "../../src/types.js";
import type { ZCodeRunOptions, ZCodeRunner } from "../../src/zcode-engine.js";

/** The fork's help text, cut to the lines the adapter reads. */
const FORK_HELP = [
  "Commands:",
  "  app-server Run the ZCode Protocol stdio app server",
  "  models     Print the available models and their limits and reasoning levels as JSON",
  "Options:",
  "  -p, --prompt <text>  Run a single prompt without opening the TUI",
  "  --provider <id> --model <id> --reasoning-level <level>  Select the model for this interactive or headless run"
].join("\n");

/** Upstream ZCode's help: no per-run model flags and no listing. */
const UPSTREAM_HELP = [
  "Commands:",
  "  app-server Run the ZCode Protocol stdio app server",
  "Options:",
  "  -p, --prompt <text>  Run a single prompt without opening the TUI"
].join("\n");

const LISTING = {
  models: [
    { provider: "gateway", model: "gpt-6.2-sol", reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    { provider: "gateway", model: "gpt-6-luna", reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
    { provider: "gateway", model: "claude-opus-5-5[1m]", reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
    { provider: "nanogpt", model: "z-ai/glm-5.3-flash", reasoningLevels: ["disabled", "enabled"] }
  ],
  listings: [{ provider: "gateway", status: "read", models: 2 }]
};

interface ScriptedRun {
  events: unknown[];
  exitCode?: number;
  stderr?: string;
  deadlineExpired?: boolean;
  whitespaceLimitReached?: boolean;
}

class FakeZCodeRunner implements ZCodeRunner {
  readonly bin = "/fake/zcode";
  readonly runs: ZCodeRunOptions[] = [];
  readonly inspections: string[][] = [];
  #script: ScriptedRun[];
  #help: string;
  #models: string;
  #modelsExit: number;

  constructor(script: ScriptedRun[], options: { help?: string; models?: string; modelsExit?: number } = {}) {
    this.#script = script;
    this.#help = options.help ?? FORK_HELP;
    this.#models = options.models ?? JSON.stringify(LISTING);
    this.#modelsExit = options.modelsExit ?? 0;
  }

  async inspect(args: readonly string[]): Promise<StreamedCommandResult> {
    this.inspections.push([...args]);
    return args[0] === "models"
      ? { exitCode: this.#modelsExit, signal: null, stdout: this.#models, stderr: this.#modelsExit === 0 ? "" : "Error: no models", durationMs: 1 }
      : { exitCode: 0, signal: null, stdout: this.#help, stderr: "", durationMs: 1 };
  }

  async run(options: ZCodeRunOptions): Promise<StreamedCommandResult> {
    this.runs.push(options);
    const scripted = this.#script.shift();
    assert.ok(scripted !== undefined, "an unscripted zcode run");
    const stdout = scripted.events.map((event) => `${JSON.stringify(event)}\n`).join("");
    options.onFirstData?.();
    // Two chunks split mid-line: the stream must reassemble lines itself.
    const middle = Math.floor(stdout.length / 2);
    options.onData?.(stdout.slice(0, middle));
    options.onData?.(stdout.slice(middle));
    return {
      exitCode: scripted.exitCode ?? 0,
      signal: null,
      stdout,
      stderr: scripted.stderr ?? "",
      durationMs: 7,
      ...(scripted.deadlineExpired === true ? { deadlineExpired: true } : {}),
      ...(scripted.whitespaceLimitReached === true ? { whitespaceLimitReached: true } : {})
    };
  }
}

const USAGE = { inputTokens: 1200, outputTokens: 30, totalTokens: 1230, cacheReadTokens: 1000, cacheWriteTokens: 0, reasoningTokens: 10 };

/** A run's events in the shape zcode 0.17.1 streams them, ending in its `result` line. */
function finishedRun(sessionId: string, response: string, model = "gpt-6.2-sol"): ScriptedRun {
  return {
    events: [
      { type: "turn.started", sessionId, payload: { turnNumber: 0 } },
      { type: "session.updated", sessionId, payload: { requestId: "req-1", providerId: "gateway", modelId: model,
        modelCall: { reasoning: { requestedLevel: "low", effectiveLevel: "unknown" } } } },
      { type: "model.streaming", sessionId, payload: { assistantMessageId: "msg-1", kind: "text_delta", delta: response.slice(0, 3) } },
      { type: "model.streaming", sessionId, payload: { assistantMessageId: "msg-1", kind: "text_delta", delta: response.slice(3) } },
      { type: "session.updated", sessionId, payload: { requestId: "req-1", providerId: "gateway", modelId: model, durationMs: 400, usage: USAGE } },
      { type: "turn.completed", sessionId, payload: { response, usage: USAGE, resultType: "success" } },
      { type: "result", sessionId, response, usage: USAGE, outcome: "finished" }
    ]
  };
}

function failedRun(sessionId: string | null, error: string, turnError?: JsonObject): ScriptedRun {
  return {
    exitCode: 1,
    stderr: `Error: ${error}\n`,
    events: [
      ...(turnError !== undefined ? [{ type: "turn.failed", sessionId, payload: { error: turnError, turnPhase: "model" } }] : []),
      { type: "result", ...(sessionId !== null ? { sessionId } : {}), outcome: "failed", error }
    ]
  };
}

function runtimeWith(runner: FakeZCodeRunner, options: { maxAttempts?: number; stale?: Record<string, number> } = {}): {
  runtime: EnsembleRuntime;
  records: RuntimeAgentRecord[];
} {
  const records: RuntimeAgentRecord[] = [];
  // The default registry routes each engine's usage events into the run's
  // budget; a hand-built one is wired the same way.
  let routed: EnsembleRuntime | null = null;
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new ZCodeEngineAdapter({
      cwd: "/fake/repo", runner, onEvent: (event) => routed?.handleEngineEvent("zcode", event)
    })]),
    cwd: "/fake/repo",
    defaultMaxAttempts: options.maxAttempts ?? 3,
    ...(options.stale !== undefined ? { zcodeSessionStaleAfterMs: options.stale } : {})
  });
  routed = runtime;
  runtime.setRunRecorder({
    recordAttemptStart: async () => undefined,
    recordAttemptEnd: async () => undefined,
    recordAgent: async (record: RuntimeAgentRecord) => {
      records.push(structuredClone(record));
    }
  } as unknown as RunRecordWriter);
  return { runtime, records };
}

test("a zcode model is spelt provider/model, split at the first slash", () => {
  assert.deepEqual(parseZCodeModel("gateway/claude-opus-5-5[1m]"), { provider: "gateway", model: "claude-opus-5-5[1m]" });
  assert.deepEqual(parseZCodeModel("nanogpt/kitani/clover-2:thinking"), { provider: "nanogpt", model: "kitani/clover-2:thinking" });
  for (const spelling of [undefined, "claude-opus-5-5", "/claude-opus-5-5", "gateway/", " /x"]) {
    assert.throws(() => parseZCodeModel(spelling), ZCodeModelRequiredError, String(spelling));
  }
});

test("a run names its provider, model and level, and rides the prompt so it is never read as a flag", () => {
  assert.deepEqual(
    zcodeRunArguments({
      prompt: "-x do it", cwd: "/w", provider: "nanogpt", model: "z-ai/glm-5.3-flash", reasoningLevel: "enabled",
      resume: "sess_1", disallowedTools: ["Skill", "Agent"]
    }),
    ["--prompt=-x do it", "--output-format", "stream-json", "--provider", "nanogpt", "--model", "z-ai/glm-5.3-flash",
      "--reasoning-level", "enabled", "--cwd", "/w", "--resume", "sess_1", "--disallowed-tools", "Skill", "Agent"]
  );
  assert.deepEqual(disallowedToolsFor(["skills", "agents", "skills"]), ["Skill", "Agent", "CreateWorkflow"]);
  assert.deepEqual(disallowedToolsFor(undefined), []);
});

test("an unrequested level is zcode's highest listed level within the canonical vocabulary", () => {
  assert.equal(defaultZCodeReasoningLevel(["low", "medium", "high", "xhigh", "max", "ultra"]), "max");
  assert.equal(defaultZCodeReasoningLevel(["none", "high"]), "high");
  assert.equal(defaultZCodeReasoningLevel(["disabled", "enabled"]), "enabled");
  assert.equal(defaultZCodeReasoningLevel(undefined), undefined);
  assert.equal(parseZCodeListing("not json"), null);
  assert.deepEqual(parseZCodeListing(JSON.stringify(LISTING))?.levels({ provider: "gateway", model: "claude-opus-5-5[1m]" }),
    ["low", "medium", "high", "xhigh", "max"]);
});

test("a zcode worker answers through one run, recording the served model, its spend and its transcript", async () => {
  const runner = new FakeZCodeRunner([finishedRun("sess_a", "pong")]);
  const { runtime, records } = runtimeWith(runner);
  try {
    assert.equal(await runtime.agent("Reply pong", { engine: "zcode", model: "gateway/gpt-6.2-sol", effort: "low" }), "pong");
    assert.equal(runner.runs.length, 1);
    const run = runner.runs[0]!;
    assert.deepEqual([run.provider, run.model, run.reasoningLevel, run.cwd, run.resume], ["gateway", "gpt-6.2-sol", "low", "/fake/repo", undefined]);
    assert.match(run.prompt, /Task:\nReply pong$/);
    assert.deepEqual(runner.inspections, [["--help"], ["models"]]);
    const record = records.at(-1)!;
    assert.equal(record.status, "complete");
    assert.equal(record.resolvedModel, "gateway/gpt-6.2-sol");
    const attempt = record.attempts[0]!;
    assert.deepEqual(attempt.tokenUsageEvents.map((event) => event.total), [{
      cachedInputTokens: 1000, cacheCreationInputTokens: 0, inputTokens: 1200, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 1230
    }]);
    assert.equal(attempt.transcripts[0]?.filename, "transcript.zcode.jsonl");
    assert.equal(attempt.transcripts[0]?.sessionId, "sess_a");
    assert.equal(attempt.transcripts[0]?.content.trim().split("\n").length, 7);
    assert.equal(runtime.budget.spent("zcode"), 1230);
  } finally {
    await runtime.close();
  }
});

test("a zcode call with no effort runs at zcode's own highest canonical level for the model", async () => {
  const runner = new FakeZCodeRunner([finishedRun("sess_a", "ok"), finishedRun("sess_b", "ok", "z-ai/glm-5.3-flash")]);
  const { runtime } = runtimeWith(runner);
  try {
    await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6.2-sol" });
    await runtime.agent("go", { engine: "zcode", model: "nanogpt/z-ai/glm-5.3-flash" });
    assert.deepEqual(runner.runs.map((run) => run.reasoningLevel), ["max", "enabled"]);
  } finally {
    await runtime.close();
  }
});

test("a requested effort clamps to the levels zcode lists for the model", async () => {
  const runner = new FakeZCodeRunner([finishedRun("sess_a", "ok")]);
  const { runtime, records } = runtimeWith(runner);
  try {
    // claude-opus-5-5 lists low..max: `minimal` clamps to the nearest served level.
    await runtime.agent("go", { engine: "zcode", model: "gateway/claude-opus-5-5[1m]", effort: "minimal" });
    assert.equal(runner.runs[0]?.reasoningLevel, "low");
    assert.equal(records.at(-1)?.effortResolution?.served?.source, "engine-report");
  } finally {
    await runtime.close();
  }
});

test("zcode's listing, not the built-in table, decides the levels a zcode model serves", async () => {
  // The built-in table gives gpt-6-luna `none` (its Codex route); the
  // gateway lists low..max for it, and zcode refuses `none`.
  const runner = new FakeZCodeRunner([finishedRun("sess_a", "ok", "gpt-6-luna"), finishedRun("sess_b", "ok", "gpt-6-luna")]);
  const { runtime, records } = runtimeWith(runner);
  try {
    await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6-luna", effort: "minimal" });
    await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6-luna", effort: "none" });
    assert.deepEqual(runner.runs.map((run) => run.reasoningLevel), ["low", "low"]);
    assert.deepEqual(records.filter((record) => record.status === "complete").map((record) => record.effortResolution?.served), [
      { source: "engine-report", level: "low" }, { source: "engine-report", level: "low" }
    ]);
  } finally {
    await runtime.close();
  }
});

test("a schema answer rides the prompt and is read from the worker's final message", async () => {
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  const runner = new FakeZCodeRunner([finishedRun("sess_a", "Done.\n```json\n{\"ok\": true}\n```")]);
  const { runtime } = runtimeWith(runner);
  try {
    assert.deepEqual(await runtime.agent("flag it", { engine: "zcode", model: "gateway/gpt-6.2-sol", schema }), { ok: true });
    assert.match(runner.runs[0]!.prompt, /JSON Schema/);
    assert.ok(runner.runs[0]!.prompt.includes(JSON.stringify(schema)));
  } finally {
    await runtime.close();
  }
});

test("a failed zcode run spends an attempt and the retry carries the failure into a fresh run", async () => {
  const runner = new FakeZCodeRunner([
    failedRun("sess_a", "The model stream ended early", { code: "model_request_failed", type: "model_error", message: "The model stream ended early" }),
    finishedRun("sess_b", "recovered")
  ]);
  const { runtime, records } = runtimeWith(runner);
  try {
    assert.equal(await runtime.agent("work", { engine: "zcode", model: "gateway/gpt-6.2-sol" }), "recovered");
    assert.equal(runner.runs.length, 2);
    assert.equal(runner.runs[1]?.resume, undefined);
    assert.match(runner.runs[1]!.prompt, /A previous attempt failed \(zcode-run-error\): zcode run failed: The model stream ended early/);
    const failed = records.at(-1)!.attempts[0]!;
    assert.equal(failed.failure?.kind, "zcode-run-error");
    assert.deepEqual(failed.classification, { class: "unclassified", rule: "zcode.run-error" });
    assert.deepEqual(failed.workerExit, { exitCode: 1, signal: null });
  } finally {
    await runtime.close();
  }
});

test("a provider refusal zcode could not outlast is an availability failure that advances the chain", async () => {
  const runner = new FakeZCodeRunner([
    failedRun("sess_a", "Rate limited", { code: "model_rate_limited", type: "model_error", message: "Rate limited",
      attribution: { source: "provider", reason: "rate_limited" } }),
    finishedRun("sess_b", "from the fallback", "claude-opus-5-5[1m]")
  ]);
  const { runtime, records } = runtimeWith(runner, { maxAttempts: 1 });
  try {
    const output = await runtime.agent("work", {
      engine: "zcode", model: "gateway/gpt-6.2-sol", fallback: [{ engine: "zcode", model: "gateway/claude-opus-5-5[1m]" }]
    });
    assert.equal(output, "from the fallback");
    assert.deepEqual(runner.runs.map((run) => run.model), ["gpt-6.2-sol", "claude-opus-5-5[1m]"]);
    assert.deepEqual(records.at(-1)!.attempts[0]?.classification, { class: "availability", rule: "zcode.rate-limit" });
  } finally {
    await runtime.close();
  }
});

test("zcode's refusals of an unlisted model and of a level it does not hold are recognised", () => {
  const evidence = (message: string) => ({
    engine: "zcode" as const, failure: { kind: "zcode-run-error", message }, appServerDiagnostic: null, diagnostics: undefined
  });
  const unknown = diagnoseAttemptFailure(evidence('zcode run failed: Unknown model "nope" for provider "gateway". Run zcode models to list usable models.'));
  assert.equal(unknown.kind, "model-not-found");
  assert.deepEqual(classifyAttemptFailure({ ...evidence(unknown.message), failure: unknown }), { class: "unclassified", rule: "zcode.model-not-found" });
  const level = diagnoseAttemptFailure(evidence('zcode run failed: Unsupported reasoning level "ultra" for model "gpt-6-luna" from provider "gateway". Supported levels: low, medium.'));
  assert.equal(level.kind, "effort-rejected");
  assert.equal(settlesWithoutRetry(level), true);
  assert.deepEqual(
    classifyAttemptFailure({ ...evidence("zcode run failed: denied"), diagnostics: { zcode: { turn_error: { code: "model_request_failed", reason: "auth_failed" } } } }),
    { class: "availability", rule: "zcode.authentication-failure" }
  );
  assert.deepEqual(classifyAttemptFailure({ ...evidence("x"), failure: { kind: "ZCodeSubstrateRefusedError", message: "x" } }),
    { class: "availability", rule: "zcode.substrate-refused" });
});

test("a ZCode without per-run model selection or a listing is refused before any worker spawns, naming what it lacks", async () => {
  const runner = new FakeZCodeRunner([], { help: UPSTREAM_HELP });
  const { runtime } = runtimeWith(runner);
  try {
    await assert.rejects(
      runtime.agent("work", { engine: "zcode", model: "gateway/gpt-6.2-sol" }),
      (error: unknown) => error instanceof ZCodeSubstrateRefusedError &&
        /lacks per-run model selection \(--provider, --model and --reasoning-level\) and a model listing \(zcode models\)/.test(error.message)
    );
    assert.equal(runner.runs.length, 0);
  } finally {
    await runtime.close();
  }
  const broken = new FakeZCodeRunner([], { models: "", modelsExit: 1 });
  const second = runtimeWith(broken);
  try {
    await assert.rejects(second.runtime.agent("work", { engine: "zcode", model: "gateway/gpt-6.2-sol" }),
      /model listing \(zcode models\) did not print the expected JSON: Error: no models/);
    assert.equal(broken.runs.length, 0);
  } finally {
    await second.runtime.close();
  }
});

test("a listing that lacks one provider still serves, and is read again by the next dispatch", async () => {
  // zcode 0.17.1 prints the providers it read and exits 1 when another
  // provider's listing times out.
  const partial = JSON.stringify({
    models: LISTING.models.filter((entry) => entry.provider === "gateway"),
    listings: [{ provider: "gateway", status: "read", models: 2 }, { provider: "nanogpt", status: "failed", reason: "Model listing timed out" }]
  });
  const runner = new FakeZCodeRunner([finishedRun("sess_a", "one"), finishedRun("sess_b", "two")], { models: partial, modelsExit: 1 });
  const { runtime } = runtimeWith(runner);
  try {
    assert.equal(await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6.2-sol" }), "one");
    assert.equal(await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6.2-sol" }), "two");
    assert.deepEqual(runner.inspections, [["--help"], ["models"], ["--help"], ["models"]]);
    assert.deepEqual(runner.runs.map((run) => run.reasoningLevel), ["max", "max"]);
  } finally {
    await runtime.close();
  }
});

test("a zcode call without a provider-qualified model is refused before it spawns", async () => {
  const runner = new FakeZCodeRunner([]);
  const { runtime } = runtimeWith(runner);
  try {
    await assert.rejects(runtime.agent("work", { engine: "zcode" }), ZCodeModelRequiredError);
    await assert.rejects(runtime.agent("work", { engine: "zcode", model: "claude-opus-5-5" }), ZCodeModelRequiredError);
    assert.throws(() => validateEngineDefaults("zcode", { model: "claude-opus-5-5" }), ZCodeModelRequiredError);
    assert.equal(runner.runs.length, 0);
  } finally {
    await runtime.close();
  }
});

test("a zcode strip withholds the tools by name, and a lean start is refused", async () => {
  const runner = new FakeZCodeRunner([finishedRun("sess_a", "ok")]);
  const { runtime, records } = runtimeWith(runner);
  try {
    await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6.2-sol", strip: ["skills", "agents"] });
    assert.deepEqual(runner.runs[0]?.disallowedTools, ["Skill", "Agent", "CreateWorkflow"]);
    assert.equal(records.at(-1)?.strip?.enforcement.skills?.route, "config");
    await assert.rejects(runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6.2-sol", lean: true }), LeanStartUnsupportedError);
    assert.equal(runner.runs.length, 1);
  } finally {
    await runtime.close();
  }
});

test("a held zcode worker resumes its session on every later turn, and a retry corrects in-session", async () => {
  const runner = new FakeZCodeRunner([
    finishedRun("sess_held", "first answer"),
    finishedRun("sess_held", "not json"),
    finishedRun("sess_held", "{\"ok\": true}")
  ]);
  const { runtime } = runtimeWith(runner);
  try {
    const session = runtime.createWorkerSession({ engine: "zcode", model: "gateway/gpt-6.2-sol", effort: "low" });
    assert.equal(await session.send("first prompt"), "first answer");
    const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    assert.deepEqual(await session.send("second prompt", { schema }), { ok: true });
    assert.deepEqual(runner.runs.map((run) => run.resume), [undefined, "sess_held", "sess_held"]);
    assert.match(runner.runs[1]!.prompt, /second prompt$/);
    assert.match(runner.runs[2]!.prompt, /^A previous attempt failed \(invalid-json\)/);
    await session.close();
  } finally {
    await runtime.close();
  }
});

test("a held zcode session zcode no longer finds is lost, and later turns submit nothing", async () => {
  const runner = new FakeZCodeRunner([
    finishedRun("sess_gone", "first answer"),
    failedRun("sess_gone", "Session not found: sess_gone")
  ]);
  const { runtime, records } = runtimeWith(runner);
  try {
    const session = runtime.createWorkerSession({ engine: "zcode", model: "gateway/gpt-6.2-sol" });
    assert.equal(await session.send("first"), "first answer");
    assert.equal(await session.send("second"), null);
    assert.equal(session.lost, true);
    assert.equal(records.at(-1)?.attempts.length, 1);
    assert.equal(records.at(-1)?.attempts[0]?.failure?.kind, "session-lost");
    assert.equal(await session.send("third"), null);
    assert.equal(runner.runs.length, 2);
    await session.close();
  } finally {
    await runtime.close();
  }
});

test("a held zcode worker is marked stale at its provider's threshold, and unmarked where its provider has none", async () => {
  const runner = new FakeZCodeRunner([]);
  const { runtime } = runtimeWith(runner, { stale: { gateway: 90_000 } });
  try {
    const gateway = runtime.createWorkerSession({ engine: "zcode", model: "gateway/gpt-6.2-sol" });
    const nanogpt = runtime.createWorkerSession({ engine: "zcode", model: "nanogpt/z-ai/glm-5.3-flash" });
    assert.equal(gateway.staleAfterMs, 90_000);
    assert.equal(nanogpt.staleAfterMs, null);
    assert.equal(nanogpt.stale, false);
    await gateway.close();
    await nanogpt.close();
  } finally {
    await runtime.close();
  }
});

test("zcode's streamed text arms the whitespace bound and its tool and reasoning events reset it", () => {
  const observed: string[] = [];
  const whitespace = {
    observeText: (text: string) => observed.push(`text:${JSON.stringify(text)}`),
    observeActivity: () => observed.push("activity")
  } as unknown as WhitespaceStream;
  const line = (event: unknown) => watchZCodeLine(JSON.stringify(event), whitespace);
  line({ type: "model.streaming", payload: { kind: "text_delta", delta: "\n\n" } });
  line({ type: "model.streaming", payload: { kind: "reasoning_delta", delta: "thinking" } });
  line({ type: "model.streaming", payload: { kind: "tool_input_delta", delta: "{" } });
  line({ type: "tool.updated", payload: { kind: "started" } });
  line({ type: "session.updated", payload: {} });
  watchZCodeLine("not json", whitespace);
  assert.deepEqual(observed, ['text:"\\n\\n"', "activity", "activity", "activity"]);
  assert.ok(new WhitespaceStream(Date.now()) instanceof WhitespaceStream);
});

test("a zcode attempt's events reach the archive as they stream, and the settled transcript is that file", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-zcode-archive-"));
  const runner = new FakeZCodeRunner([finishedRun("sess_live", "pong")]);
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new ZCodeEngineAdapter({ cwd: store, runner })]),
    cwd: store,
    defaultMaxAttempts: 1
  });
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd: store,
    runUuid: "run-zcode-transcript",
    workflowPath: path.join(store, "workflow.js"),
    workflowSource: "export const meta = { name: 'zcode-transcript' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  runtime.setRunRecorder(writer);
  try {
    assert.equal(await runtime.agent("Reply pong", { engine: "zcode", model: "gateway/gpt-6.2-sol" }), "pong");
    const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
      transcripts: Array<{ path: string; source: string; session_id: string | null }>;
    };
    assert.deepEqual(agent.transcripts.map((transcript) => [transcript.path, transcript.source, transcript.session_id]), [
      ["agents/000001/attempt-001-1-transcript.zcode.jsonl", "zcode --output-format stream-json", "sess_live"]
    ]);
    const lines = (await readFile(path.join(writer.archiveDir, agent.transcripts[0]!.path), "utf8")).trim().split("\n");
    assert.equal(lines.length, 7);
    assert.equal((JSON.parse(lines.at(-1)!) as { type: string }).type, "result");
  } finally {
    await runtime.close();
    await rm(store, { recursive: true, force: true });
  }
});
