import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { AgyEngineAdapter } from "../../src/agy-engine.js";
import { CommandContainment } from "../../src/contained-command.js";
import { DispatchRemap } from "../../src/dispatch-remap.js";
import { EngineRegistry, type EngineAttemptResult } from "../../src/engines.js";
import { AgySubstrateRefusedError, InvalidAgentOptionValueError, TurnTimeoutError, failedTurnResultOf } from "../../src/errors.js";
import { assertValidFallbackOption } from "../../src/engine-option-validation.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { summariseUsage } from "../../src/usage-summary.js";
import { inSessionCorrection, openingPrompt, previousFailureNotice, laterTurnPrompt } from "../../src/worker-instructions.js";
import { NoWorkerScopes } from "../../src/worker-scopes.js";

import type { TokenUsageEvent } from "../../src/types.js";

const scriptedAgent = path.resolve("test/fixtures/acp/scripted-agent.mjs");

/** What the scripted agent is told to do (`test/fixtures/acp/scripted-agent.mjs` lists the steps). */
interface AgentScript {
  signedOut?: boolean;
  turns?: Record<string, unknown>[][];
  counter?: string;
}

const say = (text: string): Record<string, unknown> => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const tool = (toolCallId: string): Record<string, unknown> => ({ update: { sessionUpdate: "tool_call", toolCallId, title: "run", kind: "execute", status: "pending" } });
const ECHO = { echo: true };

/** A directory holding an `agy` that runs the scripted agent, removed when the test ends. */
async function scriptedAgy(t: TestContext): Promise<{ bin: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-agy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "agy");
  await writeFile(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptedAgent)} "$@"\n`);
  await chmod(bin, 0o755);
  return { bin, dir };
}

async function scriptedAdapter(t: TestContext, script: AgentScript, events: unknown[] = []): Promise<{ adapter: AgyEngineAdapter; dir: string }> {
  const { bin, dir } = await scriptedAgy(t);
  const commands = new CommandContainment(new NoWorkerScopes());
  const adapter = new AgyEngineAdapter({
    bin, cwd: dir, commands,
    workerEnv: { SCRIPTED_ACP_AGENT: JSON.stringify(script) },
    onEvent: (event) => events.push(event)
  });
  t.after(async () => {
    await adapter.close();
    await commands.close();
  });
  return { adapter, dir };
}

async function scriptedRuntime(t: TestContext, script: AgentScript, maxAttempts = 3): Promise<{ runtime: EnsembleRuntime; dir: string }> {
  const { adapter, dir } = await scriptedAdapter(t, script);
  const runtime = new EnsembleRuntime({ defaultMaxAttempts: maxAttempts, cwd: dir, engines: new EngineRegistry([adapter]) });
  t.after(() => runtime.close());
  return { runtime, dir };
}

test("a one-shot agy worker answers with the message after its last tool call, and its record carries the session's model, level, usage and transcript", async (t) => {
  const events: unknown[] = [];
  const { adapter, dir } = await scriptedAdapter(t, {
    turns: [[say("Let me look."), tool("t1"), { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } } }, say("The answer"), say(" is 42.")]]
  }, events);
  const invocation = adapter.createInvocation("What is the answer?", { cwd: dir });
  const identities: unknown[] = [];
  const usage: TokenUsageEvent[] = [];
  let evidence = 0;
  const result = await invocation.runAttempt({
    attempt: 1,
    onIdentity: (identity) => identities.push(identity),
    onUsage: (event) => usage.push(event),
    onLiveEvidence: () => { evidence += 1; }
  });
  await invocation.close?.();

  assert.equal(result.text, "The answer is 42.");
  assert.equal(result.deltaText, "Let me look.The answer is 42.");
  assert.equal(result.attemptFailure, undefined);
  assert.equal(result.resolvedModel, "tiered-model", "the agent's default model is reported when the call names none");
  assert.equal(result.resolvedEffort, "high");
  assert.deepEqual(identities, [{ resolvedModel: "tiered-model", resolvedEffort: "high" }]);
  assert.ok(evidence >= 1);
  assert.equal(result.tokenUsageEvents.length, 1);
  assert.deepEqual(result.tokenUsageEvents[0]?.last, {
    inputTokens: 100, cachedInputTokens: 40, cacheCreationInputTokens: 0, outputTokens: 7, reasoningOutputTokens: 3, totalTokens: 110
  });
  assert.deepEqual(usage, result.tokenUsageEvents, "the live view sees the usage the record keeps");
  assert.ok(events.some((event) => (event as { method: string }).method === "thread/tokenUsage/updated"), "the budget is told the spend");
  const transcript = result.transcripts?.[0];
  assert.equal(transcript?.filename, "transcript.agy.jsonl");
  assert.equal(transcript?.sessionId, "session-1");
  const lines = transcript!.content.trim().split("\n").map((line) => JSON.parse(line) as { type: string; text?: string });
  assert.equal(lines[0]?.type, "prompt");
  assert.equal(lines[0]?.text, openingPrompt({ task: "What is the answer?" }));
  assert.equal(lines.at(-1)?.type, "reply");
  assert.deepEqual((result.diagnostics?.agy as { stop_reason: string }).stop_reason, "end_turn");
});

test("an agy worker runs on the model and level the call names", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[say("done")]] });
  assert.equal(await runtime.agent("go", { engine: "agy", model: "tiered-model", effort: "low" }), "done");
  const record = runtime.lastAgentRecord();
  assert.equal(record?.resolvedModel, "tiered-model");
  assert.equal(record?.resolvedEffort, "low");
});

test("a level the model does not serve is clamped from agy's own listing before dispatch", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[say("done")]] });
  assert.equal(await runtime.agent("go", { engine: "agy", model: "tiered-model", effort: "max" }), "done");
  const record = runtime.lastAgentRecord();
  assert.deepEqual(record?.effortResolution?.served, { source: "engine-report", level: "high" });
  assert.equal(record?.resolvedEffort, "high");
});

test("a model agy does not list is refused before any prompt, naming the models it lists", async (t) => {
  const { runtime } = await scriptedRuntime(t, {});
  await assert.rejects(
    runtime.agent("go", { engine: "agy", model: "gemini-4-hydrogen-low" }),
    (error: unknown) => error instanceof InvalidAgentOptionValueError &&
      /tiered-model \| single-level-model/.test(error.message) && /a name carries no level/.test(error.message)
  );
});

test("a level asked of a model that offers none is refused before any prompt", async (t) => {
  const { runtime } = await scriptedRuntime(t, {});
  await assert.rejects(
    runtime.agent("go", { engine: "agy", model: "single-level-model", effort: "low" }),
    (error: unknown) => error instanceof InvalidAgentOptionValueError && /offers no thought level for single-level-model/.test(error.message)
  );
});

test("a model with no level setting runs, and reports no level", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[say("done")]] });
  assert.equal(await runtime.agent("go", { engine: "agy", model: "single-level-model" }), "done");
  assert.equal(runtime.lastAgentRecord()?.resolvedEffort, null);
});

test("agy with no sign-in is a substrate refusal, classed as availability", async (t) => {
  const { runtime } = await scriptedRuntime(t, { signedOut: true });
  await assert.rejects(
    runtime.agent("go", { engine: "agy" }),
    (error: unknown) => error instanceof AgySubstrateRefusedError && /agy is not signed in/.test(error.message) && /Authentication required/.test(error.message)
  );
  const attempt = runtime.lastAgentRecord()?.attempts[0];
  assert.equal(attempt?.failure?.kind, "AgySubstrateRefusedError");
  assert.deepEqual(attempt?.classification, { class: "availability", rule: "agy.substrate-refused" });
});

test("a schema answer that fails the check is corrected in the same session", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[say("not json")], [ECHO, say('\n{"ok": true}')]] });
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  assert.deepEqual(await runtime.agent("check it", { engine: "agy", schema }), { ok: true });
  const record = runtime.lastAgentRecord();
  assert.equal(record?.attempts.length, 2);
  assert.equal(record?.attempts[0]?.failure?.kind, "invalid-json");
  const second = String(record?.attempts[1]?.rawOutput);
  assert.ok(second.startsWith(inSessionCorrection({ kind: "invalid-json", message: String(record?.attempts[0]?.failure?.message) })),
    "the correction alone is sent: the session already holds the task and the schema");
});

test("the opening prompt carries the standing instructions, the schema contract and the task", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[ECHO, say('\n{"ok": true}')]] });
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  assert.deepEqual(await runtime.agent("check it", { engine: "agy", schema }), { ok: true });
  assert.ok(String(runtime.lastAgentRecord()?.attempts[0]?.rawOutput).startsWith(openingPrompt({ task: "check it", schema })));
});

test("a worker whose process ends mid-turn is replaced, and the new session is told of the failure it never saw", async (t) => {
  const { bin, dir } = await scriptedAgy(t);
  const counter = path.join(dir, "turns");
  const commands = new CommandContainment(new NoWorkerScopes());
  const adapter = new AgyEngineAdapter({
    bin, cwd: dir, commands,
    workerEnv: { SCRIPTED_ACP_AGENT: JSON.stringify({ counter, turns: [[say("partial"), { stderr: "agy crashed" }, { exit: 3 }], [ECHO]] }) }
  });
  const runtime = new EnsembleRuntime({ defaultMaxAttempts: 2, cwd: dir, engines: new EngineRegistry([adapter]) });
  t.after(async () => {
    await runtime.close();
    await commands.close();
  });
  const answer = await runtime.agent("do it", { engine: "agy" });
  const record = runtime.lastAgentRecord();
  const first = record?.attempts[0];
  assert.equal(first?.failure?.kind, "agy-worker-lost");
  assert.match(String(first?.failure?.message), /agy acp exited with code 3; its last stderr: agy crashed/);
  assert.deepEqual(first?.classification, { class: "availability", rule: "agy.worker-lost" });
  assert.deepEqual(first?.workerExit, { exitCode: 3, signal: null });
  assert.equal(answer, openingPrompt({ task: "do it", previousFailure: { kind: "agy-worker-lost", message: String(first?.failure?.message) } }));
  assert.ok(String(answer).includes(previousFailureNotice({ kind: "agy-worker-lost", message: String(first?.failure?.message) })));
});

test("a turn past its deadline is cancelled, classed as agy's deadline, and corrected in the session it ran in", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[say("working"), { untilCancelled: true }], [ECHO]] }, 2);
  const answer = await runtime.agent("slow task", { engine: "agy", timeoutMs: 300 });
  const record = runtime.lastAgentRecord();
  const first = record?.attempts[0];
  assert.equal(first?.failure?.kind, "TurnTimeoutError");
  assert.deepEqual(first?.classification, { class: "unclassified", rule: "agy.deadline" });
  assert.equal(answer, inSessionCorrection({ kind: "TurnTimeoutError", message: String(first?.failure?.message) }));
});

test("the turn deadline throws with the turn's evidence attached", async (t) => {
  const { adapter, dir } = await scriptedAdapter(t, { turns: [[say("half"), { untilCancelled: true }]] });
  const invocation = adapter.createInvocation("slow", { cwd: dir, timeoutMs: 200 });
  const failure = await invocation.runAttempt({ attempt: 1 }).catch((error: unknown) => error);
  await invocation.close?.();
  assert.ok(failure instanceof TurnTimeoutError);
  const result = failedTurnResultOf(failure) as EngineAttemptResult;
  assert.equal(result.text, "half");
  assert.equal(result.tokenUsageEvents.length, 1, "a cancelled turn's usage is kept");
  assert.equal(result.transcripts?.[0]?.partial, true);
});

test("agy ending a turn as a refusal is a returned failure under its own kind", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[{ stop: "refusal" }]] }, 1);
  assert.equal(await runtime.agent("go", { engine: "agy" }), null);
  const first = runtime.lastAgentRecord()?.attempts[0];
  assert.equal(first?.failure?.kind, "agy-stop-reason");
  assert.deepEqual(first?.classification, { class: "unclassified", rule: "agy.stop-reason" });
});

test("a prompt agy refuses for want of a sign-in is an availability failure", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[{ error: { code: -32000, message: "Authentication required" } }]] }, 1);
  assert.equal(await runtime.agent("go", { engine: "agy" }), null);
  const first = runtime.lastAgentRecord()?.attempts[0];
  assert.equal(first?.failure?.kind, "agy-sign-in-required");
  assert.deepEqual(first?.classification, { class: "availability", rule: "agy.sign-in-required" });
});

test("every tool approval agy asks for is granted", async (t) => {
  const { adapter, dir } = await scriptedAdapter(t, { turns: [[{ permission: "t1" }, say("ran it")]] });
  const invocation = adapter.createInvocation("run something", { cwd: dir });
  const result = await invocation.runAttempt({ attempt: 1 });
  await invocation.close?.();
  assert.equal(result.text, "ran it");
  assert.match(result.transcripts![0]!.content, /"status":"completed"/);
});

test("a held agy worker keeps one session across turns, and later turns carry only their own contract and task", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[ECHO], [ECHO, say('\n"ok"')]] });
  const session = runtime.createWorkerSession({ engine: "agy" });
  t.after(() => session.close());
  assert.equal(await session.send("first"), openingPrompt({ task: "first" }));
  const schema = { type: "string" };
  assert.equal(await session.send("second", { schema }), "ok");
  const record = runtime.lastAgentRecord();
  assert.ok(String(record?.attempts[0]?.rawOutput).startsWith(laterTurnPrompt({ task: "second", schema })));
});

test("a held agy worker whose process ends is lost, and its later turns settle as session-lost without a new worker", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[say("one")], [{ exit: 1 }]] });
  const session = runtime.createWorkerSession({ engine: "agy" });
  t.after(() => session.close());
  assert.equal(await session.send("first"), "one");
  assert.equal(await session.send("second"), null);
  assert.equal(runtime.lastAgentRecord()?.attempts[0]?.failure?.kind, "session-lost");
  assert.equal(await session.send("third"), null);
  const third = runtime.lastAgentRecord();
  assert.equal(third?.attempts.length, 1, "a lost session settles without a retry");
  assert.equal(third?.attempts[0]?.failure?.kind, "session-lost");
});

test("agy refuses a capability strip and a lean start before any worker spawns", async (t) => {
  const { runtime } = await scriptedRuntime(t, {});
  await assert.rejects(runtime.agent("go", { engine: "agy", strip: ["skills"] }), /agy/);
  await assert.rejects(runtime.agent("go", { engine: "agy", lean: true }), /agy/);
});

/**
 * An `agy acp` held in this process, for timing the whitespace bound under
 * mocked timers: it answers `initialize`, `session/new` and a model
 * setting at once, and leaves each prompt to the test.
 */
function inProcessAgent(t: TestContext): {
  commands: CommandContainment;
  update: (body: Record<string, unknown>) => void;
  prompts: { text: string; answer: (stopReason: string) => void }[];
  cancels: () => number;
} {
  const child = new ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr: new PassThrough() });
  const commands = new CommandContainment(new NoWorkerScopes());
  t.mock.method(commands, "contain", async () => ({
    child, reach: { kind: "scope", unit: "fixture.scope" },
    stop: async () => {
      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");
      return { outcome: { kind: "stopped" as const }, attemptAccount: null };
    }
  }));
  const send = (value: object): void => { stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`); };
  const prompts: { text: string; answer: (stopReason: string) => void }[] = [];
  let cancels = 0;
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const { id, method, params } = JSON.parse(line) as { id?: number; method: string; params: { prompt?: { text: string }[] } };
      if (method === "initialize") send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
      if (method === "session/new") {
        send({ id, result: { sessionId: "held", configOptions: [{ id: "model", category: "model", type: "select", currentValue: "m", options: [{ value: "m" }] }] } });
      }
      if (method === "session/prompt") {
        prompts.push({ text: params.prompt?.[0]?.text ?? "", answer: (stopReason) => send({ id, result: { stopReason } }) });
      }
      if (method === "session/cancel") {
        cancels += 1;
        prompts.at(-1)?.answer("cancelled");
      }
    }
  });
  return {
    commands,
    update: (body) => send({ method: "session/update", params: { sessionId: "held", update: body } }),
    prompts,
    cancels: () => cancels
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !condition(); tries += 1) await flush();
  assert.ok(condition(), "the condition was never met");
}

test("agy's whitespace bound is reset by text, tool activity and thought, and a stop spends one attempt and is corrected in-session", async (t) => {
  const agent = inProcessAgent(t);
  const runtime = new EnsembleRuntime({
    defaultMaxAttempts: 2,
    engines: new EngineRegistry([new AgyEngineAdapter({ commands: agent.commands })])
  });
  t.after(() => runtime.close());
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  t.after(() => t.mock.timers.reset());
  const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const pending = runtime.agent("answer", { engine: "agy", timeoutMs: 3_600_000 });
  await until(() => agent.prompts.length === 1);
  for (const activity of [
    chunk("partial answer"),
    { sessionUpdate: "tool_call", toolCallId: "t", status: "pending" },
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } }
  ]) {
    agent.update(chunk(" "));
    await flush();
    t.mock.timers.tick(110_000);
    agent.update(activity);
    await flush();
  }
  agent.update(chunk("\t\n"));
  await flush();
  t.mock.timers.tick(119_999);
  await flush();
  assert.equal(agent.cancels(), 0, "the bound has not passed");
  t.mock.timers.tick(1);
  await until(() => agent.prompts.length === 2);
  assert.equal(agent.cancels(), 1, "the bound cancels the turn and keeps the session");
  assert.equal(agent.prompts[1]?.text, inSessionCorrection({ kind: "WhitespaceStreamError", message: "worker streamed only whitespace for two minutes" }));
  agent.update(chunk("the answer"));
  await flush();
  agent.prompts[1]?.answer("end_turn");
  assert.equal(await pending, "the answer");
  const record = runtime.lastAgentRecord();
  assert.equal(record?.attempts.length, 2);
  assert.equal(record?.attempts[0]?.failure?.kind, "WhitespaceStreamError");
  assert.deepEqual(record?.attempts[0]?.classification, { class: "output", rule: "output" });
});

test("agy's usage summarises with the cached share beside the input and thought tokens inside the output", () => {
  // agy 1.5.14's counts for a second turn on gemini-4-hydrogen at low, 2026-11-22.
  const last = { inputTokens: 2217, cachedInputTokens: 7331, cacheCreationInputTokens: 0, outputTokens: 74, reasoningOutputTokens: 59, totalTokens: 9622 };
  assert.deepEqual(summariseUsage("agy", [{ threadId: "s", turnId: "s:agy-1", last, total: last, raw: {} }]), {
    freshInputTokens: 2217, cachedInputTokens: 7331, cacheReadTokens: 7331, cacheCreationTokens: 0,
    outputTokens: 15, reasoningOutputTokens: 59, unclassifiedTokens: 0, totalTokens: 9622
  });
});

test("a held agy worker reads stale after five minutes idle", async (t) => {
  const { runtime } = await scriptedRuntime(t, {});
  const session = runtime.createWorkerSession({ engine: "agy" });
  t.after(() => session.close());
  assert.equal(session.staleAfterMs, 300_000);
});

test("a fallback chain may name an agy entry", () => {
  assert.doesNotThrow(() => assertValidFallbackOption([{ engine: "agy", model: "gemini-4-hydrogen" }]));
});

test("a dispatch remap routes a call to agy and records the move", async (t) => {
  const { adapter, dir } = await scriptedAdapter(t, { turns: [[say("from agy")]] });
  const remap = new DispatchRemap(["codex=agy:tiered-model"]);
  const runtime = new EnsembleRuntime({ dispatchRemap: remap, defaultMaxAttempts: 1, cwd: dir, engines: new EngineRegistry([adapter]) });
  t.after(() => runtime.close());
  assert.equal(await runtime.agent("go", { engine: "codex", model: "gpt-6.2-sol" }), "from agy");
  const record = runtime.lastAgentRecord();
  assert.equal(record?.resolvedModel, "tiered-model");
  assert.deepEqual(record?.attempts[0]?.remap, { key: "codex", requested: { engine: "codex", model: "gpt-6.2-sol" } });
});
