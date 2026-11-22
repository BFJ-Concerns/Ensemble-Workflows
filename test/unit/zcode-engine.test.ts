import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngineRegistry } from "../../src/engines.js";
import { ChainEngine } from "./chain-engine-fakes.js";
import {
  AgentPromptRejectedError,
  LeanStartUnsupportedError,
  ZCodeModelRequiredError,
  ZCodeSubstrateRefusedError
} from "../../src/errors.js";
import { classifyAttemptFailure, diagnoseAttemptFailure, settlesWithoutRetry } from "../../src/failure-classification.js";
import { validateEngineDefaults } from "../../src/engine-option-validation.js";
import { RunRecordWriter } from "../../src/run-record.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { summariseUsage } from "../../src/usage-summary.js";
import { WhitespaceStream } from "../../src/whitespace-stream.js";
import { laterTurnPrompt, openingPrompt, WORKER_STANDING_INSTRUCTIONS } from "../../src/worker-instructions.js";
import {
  ZCodeEngineAdapter,
  assertZCodePromptFits,
  defaultZCodeReasoningLevel,
  disallowedToolsFor,
  parseZCodeListing,
  supportedLevelsOfRefusal,
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
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  stderr?: string;
  deadlineExpired?: boolean;
  whitespaceLimitReached?: boolean;
  /** Awaited once the run's output has been delivered and before the run settles. */
  during?: () => Promise<void>;
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
    await scripted.during?.();
    return {
      exitCode: scripted.exitCode === undefined ? 0 : scripted.exitCode,
      signal: scripted.signal ?? null,
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
    // zcode's input includes its cached share and its output its reasoning.
    assert.deepEqual(summariseUsage("zcode", attempt.tokenUsageEvents), {
      freshInputTokens: 200, cachedInputTokens: 1000, cacheReadTokens: 1000, cacheCreationTokens: 0,
      outputTokens: 20, reasoningOutputTokens: 10, unclassifiedTokens: 0, totalTokens: 1230
    });
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

test("a zcode run killed before its closing result is a dead worker, and the chain takes the call", async () => {
  const killed = finishedRun("sess_a", "partial");
  const runner = new FakeZCodeRunner([
    { events: killed.events.slice(0, 3), exitCode: null, signal: "SIGKILL" },
    finishedRun("sess_b", "from the fallback", "claude-opus-5-5[1m]")
  ]);
  const { runtime, records } = runtimeWith(runner, { maxAttempts: 1 });
  try {
    const output = await runtime.agent("work", {
      engine: "zcode", model: "gateway/gpt-6.2-sol", fallback: [{ engine: "zcode", model: "gateway/claude-opus-5-5[1m]" }]
    });
    assert.equal(output, "from the fallback");
    const dead = records.at(-1)!.attempts[0]!;
    assert.equal(dead.failure?.kind, "zcode-worker-lost");
    assert.match(dead.failure?.message ?? "", /zcode was killed by SIGKILL before its closing result/);
    assert.deepEqual(dead.classification, { class: "availability", rule: "zcode.worker-dead" });
    assert.deepEqual(dead.workerExit, { exitCode: null, signal: "SIGKILL" });
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

/** zcode 0.17.1's listing when NanoGPT's timed out: the providers it read, and an exit of 1. */
const PARTIAL_LISTING = JSON.stringify({
  models: LISTING.models.filter((entry) => entry.provider === "gateway"),
  listings: [{ provider: "gateway", status: "read", models: 3 }, { provider: "nanogpt", status: "failed", reason: "Model listing timed out" }]
});

test("a listing that lacks one provider is read once and serves the whole run, retries included", async () => {
  const runner = new FakeZCodeRunner([
    finishedRun("sess_a", "one"),
    failedRun("sess_b", "The model stream ended early", { code: "model_request_failed", type: "model_error", message: "The model stream ended early" }),
    finishedRun("sess_c", "two")
  ], { models: PARTIAL_LISTING, modelsExit: 1 });
  const { runtime } = runtimeWith(runner);
  try {
    assert.equal(await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6.2-sol", effort: "high" }), "one");
    assert.equal(await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6.2-sol" }), "two");
    assert.deepEqual(runner.inspections, [["--help"], ["models"]]);
    assert.deepEqual(runner.runs.map((run) => run.reasoningLevel), ["high", "max", "max"]);
  } finally {
    await runtime.close();
  }
});

test("a call naming no effort for a model the listing lacks runs at the level zcode chooses among those the model serves", async () => {
  const refusal = 'Unsupported reasoning level "medium" for model "z-ai/glm-5.3-flash" from provider "nanogpt". Supported levels: disabled, enabled.';
  const runner = new FakeZCodeRunner([
    failedRun(null, refusal),
    finishedRun("sess_a", "answered", "z-ai/glm-5.3-flash"),
    finishedRun("sess_b", "again", "z-ai/glm-5.3-flash")
  ], { models: PARTIAL_LISTING, modelsExit: 1 });
  const { runtime, records } = runtimeWith(runner);
  try {
    assert.equal(await runtime.agent("go", { engine: "zcode", model: "nanogpt/z-ai/glm-5.3-flash" }), "answered");
    const record = records.at(-1)!;
    assert.equal(record.status, "complete");
    assert.equal(record.attempts.length, 1);
    // The levels zcode named serve the rest of the run.
    assert.equal(await runtime.agent("go", { engine: "zcode", model: "nanogpt/z-ai/glm-5.3-flash" }), "again");
    assert.deepEqual(runner.runs.map((run) => run.reasoningLevel), ["medium", "enabled", "enabled"]);
    assert.deepEqual(runner.inspections, [["--help"], ["models"]]);
  } finally {
    await runtime.close();
  }
  assert.deepEqual(supportedLevelsOfRefusal(`zcode run failed: ${refusal}`), ["disabled", "enabled"]);
  assert.equal(supportedLevelsOfRefusal('zcode run failed: Unknown model "x" for provider "nanogpt".'), null);
});

test("a requested effort zcode refuses for a model the listing lacks still settles as effort-rejected", async () => {
  const runner = new FakeZCodeRunner([
    failedRun(null, 'Unsupported reasoning level "max" for model "z-ai/glm-5.3-flash" from provider "nanogpt". Supported levels: disabled, enabled.')
  ], { models: PARTIAL_LISTING, modelsExit: 1 });
  const { runtime, records } = runtimeWith(runner);
  try {
    await runtime.agent("go", { engine: "zcode", model: "nanogpt/z-ai/glm-5.3-flash", effort: "max" }).catch(() => null);
    assert.equal(runner.runs.length, 1);
    assert.equal(records.at(-1)?.attempts[0]?.failure?.kind, "effort-rejected");
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
    assert.ok(runner.runs[0]!.prompt.startsWith(WORKER_STANDING_INSTRUCTIONS));
    assert.equal(runner.runs[1]!.prompt, laterTurnPrompt({ task: "second prompt", schema }));
    assert.match(runner.runs[2]!.prompt, /^Your last final message was not valid JSON for the required schema\./);
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
  const live = finishedRun("sess_live", "pong");
  let streamed: string[] = [];
  const held: { writer?: RunRecordWriter } = {};
  live.during = async () => {
    // The run has streamed every line and not yet settled.
    const liveFile = path.join(held.writer!.archiveDir, "agents/000001/attempt-001-1-transcript.zcode.jsonl");
    for (let tries = 0; tries < 200 && streamed.length < 7; tries += 1) {
      streamed = (await readFile(liveFile, "utf8").catch(() => "")).trim().split("\n").filter((line) => line.length > 0);
      if (streamed.length < 7) await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const runner = new FakeZCodeRunner([live]);
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new ZCodeEngineAdapter({ cwd: store, runner })]),
    cwd: store,
    defaultMaxAttempts: 1
  });
  const writer = held.writer = await RunRecordWriter.start({
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
    assert.equal(streamed.length, 7, "every streamed line was in the archive before the call settled");
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

test("an attempt whose guessed level zcode refused records both runs: the archived transcript holds the refused one, and the duration is the whole attempt's", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "ensemble-zcode-relaunch-"));
  const refusal = 'Unsupported reasoning level "medium" for model "z-ai/glm-5.3-flash" from provider "nanogpt". Supported levels: disabled, enabled.';
  const refused = failedRun("sess_refused", refusal);
  const answered = finishedRun("sess_a", "answered", "z-ai/glm-5.3-flash");
  const runner = new FakeZCodeRunner([refused, answered], { models: PARTIAL_LISTING, modelsExit: 1 });
  const records: RuntimeAgentRecord[] = [];
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new ZCodeEngineAdapter({ cwd: store, runner })]),
    cwd: store,
    defaultMaxAttempts: 1
  });
  const writer = await RunRecordWriter.start({
    storeDir: store,
    cwd: store,
    runUuid: "run-zcode-relaunch",
    workflowPath: path.join(store, "workflow.js"),
    workflowSource: "export const meta = { name: 'zcode-relaunch' };\n",
    args: [],
    cliFlags: { jsonArgs: false }
  });
  const recordAgent = writer.recordAgent.bind(writer);
  writer.recordAgent = async (record: RuntimeAgentRecord) => {
    records.push(structuredClone(record));
    await recordAgent(record);
  };
  runtime.setRunRecorder(writer);
  try {
    assert.equal(await runtime.agent("go", { engine: "zcode", model: "nanogpt/z-ai/glm-5.3-flash" }), "answered");
    assert.deepEqual(runner.runs.map((run) => run.reasoningLevel), ["medium", "enabled"]);
    const attempt = records.at(-1)!.attempts[0]!;
    // Each scripted run reports 7 ms.
    assert.equal(attempt.durationMs, 14);
    const agent = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000001/agent.json"), "utf8")) as {
      transcripts: Array<{ path: string; session_id: string | null }>;
    };
    assert.deepEqual(agent.transcripts.map((transcript) => [transcript.path, transcript.session_id]), [
      ["agents/000001/attempt-001-1-transcript.zcode.jsonl", "sess_a"]
    ]);
    const lines = (await readFile(path.join(writer.archiveDir, agent.transcripts[0]!.path), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; sessionId?: string });
    assert.deepEqual(lines.map((line) => [line.type, line.sessionId]), [
      ...refused.events.map((event) => [(event as { type: string }).type, "sess_refused"]),
      ...answered.events.map((event) => [(event as { type: string }).type, "sess_a"])
    ]);
  } finally {
    await runtime.close();
    await rm(store, { recursive: true, force: true });
  }
});

test("the effort a request's start reports stays on the record through its completion", async () => {
  const run = finishedRun("sess_e", "ok");
  const start = run.events[1] as { payload: { modelCall: { reasoning: { effectiveLevel: string } } } };
  start.payload.modelCall.reasoning.effectiveLevel = "high";
  // A second request of the same model reports its level as unknown.
  const second = { type: "session.updated", sessionId: "sess_e", payload: { requestId: "req-2", providerId: "gateway", modelId: "gpt-6.2-sol",
    modelCall: { reasoning: { requestedLevel: "high", effectiveLevel: "unknown" } } } };
  run.events.splice(5, 0, second);
  const runner = new FakeZCodeRunner([run]);
  const { runtime, records } = runtimeWith(runner);
  try {
    await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6.2-sol", effort: "high" });
    const record = records.at(-1)!;
    assert.equal(record.resolvedEffort, "high");
    assert.equal(record.attempts[0]?.resolvedEffort, "high");
  } finally {
    await runtime.close();
  }
});

test("a zcode target with no model, or one naming no provider, is refused by the lookup, by agent() and in a chain before any worker spawns", async () => {
  const runner = new FakeZCodeRunner([]);
  const { runtime } = runtimeWith(runner);
  try {
    assert.throws(() => runtime.lookupDispatch({ engine: "zcode" }), ZCodeModelRequiredError);
    assert.throws(() => runtime.lookupDispatch({ engine: "zcode", model: "gpt-6.2-sol" }), ZCodeModelRequiredError);
    assert.throws(() => runtime.lookupDispatch({ engine: "zcode", model: "gateway/gpt-6.2-sol", fallback: [{ engine: "zcode", model: "opus" }] }),
      ZCodeModelRequiredError);
    await assert.rejects(runtime.agent("work", {
      engine: "zcode", model: "gateway/gpt-6.2-sol", fallback: [{ engine: "zcode", model: "claude-opus-5-5" }]
    }), ZCodeModelRequiredError);
    assert.throws(() => runtime.createWorkerSession({ engine: "zcode", model: "gpt-6.2-sol" }), ZCodeModelRequiredError);
    assert.equal(runner.runs.length, 0);
    assert.deepEqual(runner.inspections, []);
  } finally {
    await runtime.close();
  }
});

test("a credential zcode reports missing or rejected is an authentication failure naming the step that mends it", () => {
  for (const turnError of [{ code: "model_request_failed", reason: "auth_failed" }, { code: "model_request_auth_missing", reason: null }]) {
    const evidence = {
      engine: "zcode" as const,
      failure: { kind: "zcode-run-error", message: "zcode run failed: Unauthorized" },
      appServerDiagnostic: null,
      diagnostics: { zcode: { turn_error: turnError } } as JsonObject
    };
    const failure = diagnoseAttemptFailure(evidence);
    assert.equal(failure.kind, "authentication-failure");
    assert.match(failure.message, /^zcode authentication failed\. Configure the provider's credentials in ZCode .* Engine diagnostic: zcode run failed: Unauthorized$/);
    assert.deepEqual(classifyAttemptFailure({ ...evidence, failure }), { class: "availability", rule: "zcode.authentication-failure" });
  }
});

test("a prompt longer than one command-line argument can carry is refused before a zcode worker spawns, naming the limit", async () => {
  const runner = new FakeZCodeRunner([]);
  const { runtime } = runtimeWith(runner);
  const prompt = "x".repeat(130 * 1024);
  try {
    await assert.rejects(runtime.agent(prompt, { engine: "zcode", model: "gateway/gpt-6.2-sol" }),
      (error: unknown) => error instanceof AgentPromptRejectedError && /131072 bytes \(128 KiB\)/.test(error.message));
    const session = runtime.createWorkerSession({ engine: "zcode", model: "gateway/gpt-6.2-sol" });
    await assert.rejects(session.send(prompt), AgentPromptRejectedError);
    await session.close();
    assert.equal(runner.runs.length, 0);
  } finally {
    await runtime.close();
  }
  assert.doesNotThrow(() => assertZCodePromptFits("x".repeat(100 * 1024), undefined));
});

test("a zcode prompt is judged with room for the longest correction a retry adds, to the byte", async () => {
  // A run takes `--prompt=<text>` as one argument of at most 131072 bytes,
  // its terminating NUL included. The room kept is the opening prompt's
  // growth when it carries the longest failure a retry repeats: 2000
  // characters of message, three bytes each, cut with an ellipsis.
  const argumentBytes = (text: string) => Buffer.byteLength(`--prompt=${text}`, "utf8") + 1;
  const alone = argumentBytes(openingPrompt({ task: "" }));
  const withRoom = argumentBytes(openingPrompt({
    task: "",
    previousFailure: { kind: "x".repeat(64), message: `${"\uFFFF".repeat(2_000)}…` }
  }));
  const largestTaken = 131_072 - withRoom;
  const refused = "x".repeat(largestTaken + 1);
  assert.ok(alone + refused.length <= 131_072, "the refused prompt fits one argument without the room");

  assert.doesNotThrow(() => assertZCodePromptFits("x".repeat(largestTaken), undefined));
  assert.throws(() => assertZCodePromptFits(refused, undefined), AgentPromptRejectedError);
  const runner = new FakeZCodeRunner([]);
  const { runtime } = runtimeWith(runner);
  try {
    await assert.rejects(runtime.agent(refused, { engine: "zcode", model: "gateway/gpt-6.2-sol" }), AgentPromptRejectedError);
    assert.equal(runner.runs.length, 0);
  } finally {
    await runtime.close();
  }
});

test("a zcode retry repeats at most 2000 characters of the failure's message, in the words every engine's worker is given", async () => {
  const runner = new FakeZCodeRunner([failedRun("sess_a", "y".repeat(5_000)), finishedRun("sess_b", "recovered")]);
  const { runtime, records } = runtimeWith(runner);
  try {
    assert.equal(await runtime.agent("work", { engine: "zcode", model: "gateway/gpt-6.2-sol" }), "recovered");
    const failure = records.at(-1)!.attempts[0]!.failure!;
    assert.ok(failure.message.length > 2_000);
    assert.equal(runner.runs[1]!.prompt, openingPrompt({
      task: "work",
      previousFailure: { kind: failure.kind, message: `${failure.message.slice(0, 2_000)}…` }
    }));
  } finally {
    await runtime.close();
  }
});

test("a zcode turn that streams only whitespace, or passes its deadline, spends an attempt and keeps its text", async () => {
  for (const ending of ["whitespace", "deadline"] as const) {
    const cut = finishedRun("sess_w", "   \n\n  ");
    const runner = new FakeZCodeRunner([
      { events: cut.events.slice(0, 3), exitCode: null, signal: "SIGTERM",
        ...(ending === "whitespace" ? { whitespaceLimitReached: true } : { deadlineExpired: true }) },
      finishedRun("sess_x", "recovered")
    ]);
    const { runtime, records } = runtimeWith(runner);
    try {
      assert.equal(await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6.2-sol", timeoutMs: 60_000 }), "recovered");
      const failed = records.at(-1)!.attempts[0]!;
      assert.equal(failed.failure?.kind, ending === "whitespace" ? "WhitespaceStreamError" : "TurnTimeoutError", ending);
      assert.equal(failed.rawOutput, "   ", ending);
      assert.equal(records.at(-1)!.attempts.length, 2);
    } finally {
      await runtime.close();
    }
  }
});

test("a killed zcode attempt keeps the text it had streamed", async () => {
  const killed = finishedRun("sess_k", "partial answer");
  const runner = new FakeZCodeRunner([{ events: killed.events.slice(0, 3), exitCode: null, signal: "SIGKILL" }]);
  const { runtime, records } = runtimeWith(runner, { maxAttempts: 1 });
  try {
    await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6.2-sol" }).catch(() => null);
    const attempt = records.at(-1)!.attempts[0]!;
    assert.equal(attempt.failure?.kind, "zcode-worker-lost");
    assert.equal(attempt.rawOutput, "par");
  } finally {
    await runtime.close();
  }
});

test("a zcode strip of agents is recorded as enforced, as one of skills is", async () => {
  const runner = new FakeZCodeRunner([finishedRun("sess_s", "ok")]);
  const { runtime, records } = runtimeWith(runner);
  try {
    await runtime.agent("go", { engine: "zcode", model: "gateway/gpt-6.2-sol", strip: ["agents"] });
    assert.deepEqual(runner.runs[0]?.disallowedTools, ["Agent", "CreateWorkflow"]);
    assert.equal(records.at(-1)?.strip?.enforcement.agents?.route, "config");
  } finally {
    await runtime.close();
  }
});

test("a held session's creating turn is refused before it starts when a zcode fallback could not be given its prompt", async () => {
  /** A Codex stand-in that holds sessions and records whether one was ever created. */
  class SessionEngine extends ChainEngine {
    sessions = 0;
    createSession(): never {
      this.sessions += 1;
      throw new Error("the creating turn started");
    }
  }
  const codex = new SessionEngine("codex", []);
  const runner = new FakeZCodeRunner([]);
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([codex, new ZCodeEngineAdapter({ cwd: "/fake/repo", runner })]),
    cwd: "/fake/repo",
    defaultMaxAttempts: 1
  });
  try {
    const session = runtime.createWorkerSession({
      engine: "codex", model: "gpt-6.2-sol", fallback: [{ engine: "zcode", model: "gateway/claude-haiku-5-5" }]
    });
    await assert.rejects(session.send("x".repeat(140_000)), AgentPromptRejectedError);
    assert.equal(codex.sessions, 0);
    assert.equal(runner.runs.length, 0);
    await session.close();
  } finally {
    await runtime.close();
  }
});
