import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { AcpClient } from "../../src/acp-client.js";
import { AgyEngineAdapter } from "../../src/agy-engine.js";
import { CommandContainment, type CommandStop } from "../../src/contained-command.js";
import { DispatchRemap } from "../../src/dispatch-remap.js";
import { EngineRegistry, type EngineAttemptResult } from "../../src/engines.js";
import { AgySubstrateRefusedError, EngineShutdownError, InvalidAgentOptionValueError, TurnTimeoutError, WhitespaceStreamError, failedTurnResultOf } from "../../src/errors.js";
import { assertValidFallbackOption } from "../../src/engine-option-validation.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { summariseUsage } from "../../src/usage-summary.js";
import { openingPrompt, previousFailureNotice, laterTurnPrompt, inSessionCorrection } from "../../src/worker-instructions.js";
import { NoWorkerScopes } from "../../src/worker-scopes.js";

import type { TokenUsageEvent } from "../../src/types.js";

const scriptedAgent = path.resolve("test/fixtures/acp/scripted-agent.mjs");

/** What the scripted agent is told to do (`test/fixtures/acp/scripted-agent.mjs` lists the steps). */
interface AgentScript {
  signedOut?: boolean;
  signInAfterFirstRefusal?: string;
  turns?: Record<string, unknown>[][];
  counter?: string;
}

const say = (text: string) => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
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
      /tiered-model \| single-level-model \| gpt-oss-120b-medium/.test(error.message) && /a name carries no level/.test(error.message)
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

test("a model with no thought-level setting serves the level in its name", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[say("done")]] });
  assert.equal(await runtime.agent("go", { engine: "agy", model: "gpt-oss-120b-medium", effort: "max" }), "done");
  const record = runtime.lastAgentRecord();
  assert.deepEqual(record?.effortResolution?.served, { source: "engine-report", level: "medium" });
  assert.equal(record?.resolvedEffort, "medium");
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

test("an agy session-opening refusal advances to the next fallback entry without spending an attempt", async (t) => {
  const { dir } = await scriptedAgy(t);
  const { runtime } = await scriptedRuntime(t, {
    signInAfterFirstRefusal: path.join(dir, "refused"), turns: [[say("from fallback")]]
  }, 1);
  const target = { engine: "agy" as const, model: "single-level-model" };
  assert.equal(await runtime.agent("go", { engine: "agy", fallback: [target] }), "from fallback");
  const record = runtime.lastAgentRecord();
  assert.deepEqual(record?.attempts.map(({ status, target, classification }) => [status, target, classification]), [
    ["failed", { engine: "agy", model: null }, { class: "availability", rule: "agy.substrate-refused" }],
    ["complete", target, null]
  ]);
  assert.deepEqual(record?.answeredBy, { entry: 0, ...target });
});

test("a one-shot schema answer that fails the check is retried on a fresh worker told of the failure", async (t) => {
  const { dir } = await scriptedAgy(t);
  const { runtime } = await scriptedRuntime(t, { counter: path.join(dir, "turns"), turns: [[say("not json")], [ECHO, say('\n{"ok": true}')]] });
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  assert.deepEqual(await runtime.agent("check it", { engine: "agy", schema }), { ok: true });
  const record = runtime.lastAgentRecord();
  assert.equal(record?.attempts.length, 2);
  assert.equal(record?.attempts[0]?.failure?.kind, "invalid-json");
  const previousFailure = { kind: "invalid-json", message: String(record?.attempts[0]?.failure?.message) };
  assert.ok(String(record?.attempts[1]?.rawOutput).startsWith(openingPrompt({ task: "check it", schema, previousFailure })));
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

test("a turn past its deadline is cancelled, classed as agy's deadline, and retried on a fresh worker told of it", async (t) => {
  const { dir } = await scriptedAgy(t);
  const { runtime } = await scriptedRuntime(t, { counter: path.join(dir, "turns"), turns: [[say("working"), { untilCancelled: true }], [ECHO]] }, 2);
  const answer = await runtime.agent("slow task", { engine: "agy", timeoutMs: 300 });
  const record = runtime.lastAgentRecord();
  const first = record?.attempts[0];
  assert.equal(first?.failure?.kind, "TurnTimeoutError");
  assert.deepEqual(first?.classification, { class: "unclassified", rule: "agy.deadline" });
  assert.equal(answer, openingPrompt({ task: "slow task", previousFailure: { kind: "TurnTimeoutError", message: String(first?.failure?.message) } }));
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

test("a malformed prompt reply fails as output without advancing the fallback chain", async (t) => {
  const { runtime } = await scriptedRuntime(t, { turns: [[say("partial"), { result: {} }]] }, 1);
  assert.equal(await runtime.agent("go", {
    engine: "agy", fallback: [{ engine: "agy", model: "single-level-model" }]
  }), null);
  const attempts = runtime.lastAgentRecord()?.attempts;
  assert.equal(attempts?.length, 1);
  assert.equal(attempts?.[0]?.failure?.kind, "agy-invalid-prompt-reply");
  assert.deepEqual(attempts?.[0]?.classification, { class: "output", rule: "agy.invalid-prompt-reply" });
});

test("a held agy session retries a malformed reply in the same worker", async (t) => {
  const { adapter, dir } = await scriptedAdapter(t, { turns: [[{ result: {} }], [ECHO]] });
  const runtime = new EnsembleRuntime({ defaultMaxAttempts: 2, cwd: dir, engines: new EngineRegistry([adapter]) });
  t.after(() => runtime.close());
  const session = runtime.createWorkerSession({ engine: "agy" });
  const answer = await session.send("go");
  const attempts = runtime.lastAgentRecord()?.attempts;
  assert.equal(attempts?.length, 2);
  const failure = attempts?.[0]?.failure;
  assert.equal(failure?.kind, "agy-invalid-prompt-reply");
  assert.equal(answer, inSessionCorrection({ kind: "agy-invalid-prompt-reply", message: String(failure?.message) }));
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
  const agent = inProcessAgent(t);
  const runtime = new EnsembleRuntime({ defaultMaxAttempts: 1, engines: new EngineRegistry([new AgyEngineAdapter({ commands: agent.commands })]) });
  t.after(() => runtime.close());
  await assert.rejects(runtime.agent("go", { engine: "agy", strip: ["skills"] }), /agy/);
  assert.equal(agent.started(), 0);
  await assert.rejects(runtime.agent("go", { engine: "agy", lean: true }), /agy/);
  assert.equal(agent.started(), 0);
});

/**
 * `agy acp` held in this process, for timing under mocked timers and for
 * observing stops: every worker gets a fresh process that answers
 * `initialize` (held back with `holdOpen` until `releaseOpen()`),
 * `session/new` and a model setting at once, and leaves each prompt to the
 * test. Each stop reports `stopAccount` as its attempt account.
 */
function inProcessAgent(t: TestContext, options: {
  holdOpen?: boolean;
  ignoreCancel?: boolean;
  cancelError?: { code: number; message: string };
  holdPipes?: boolean;
  stopAccount?: { owner: string; reason: string };
} = {}): {
  commands: CommandContainment;
  children: ChildProcess[];
  update: (body: Record<string, unknown>) => void;
  prompts: { text: string; answer: (stopReason: string, usage?: { totalTokens: number }) => void; reject: (error: { code: number; message: string }) => void }[];
  cancels: () => number;
  stops: () => number;
  started: () => number;
  releaseOpen: () => void;
} {
  const commands = new CommandContainment(new NoWorkerScopes());
  const children: ChildProcess[] = [];
  const prompts: { text: string; answer: (stopReason: string, usage?: { totalTokens: number }) => void; reject: (error: { code: number; message: string }) => void }[] = [];
  let cancels = 0;
  let stops = 0;
  let started = 0;
  let send: (value: object) => void = () => undefined;
  const heldOpen: (() => void)[] = [];
  let released = options.holdOpen !== true;
  t.mock.method(commands, "contain", async () => {
    started += 1;
    const child = new ChildProcess();
    children.push(child);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr: new PassThrough() });
    const write = (value: object): void => { stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`); };
    send = write;
    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const { id, method, params } = JSON.parse(line) as { id?: number; method: string; params: { prompt?: { text: string }[] } };
        if (method === "initialize") {
          const answer = (): void => write({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          if (released) answer(); else heldOpen.push(answer);
        }
        if (method === "session/new") {
          write({ id, result: { sessionId: "held", configOptions: [{ id: "model", category: "model", type: "select", currentValue: "m", options: [{ value: "m" }] }] } });
        }
        if (method === "session/prompt") {
          prompts.push({
            text: params.prompt?.[0]?.text ?? "",
            answer: (stopReason, usage) => write({ id, result: { stopReason, usage } }),
            reject: (error) => write({ id, error })
          });
        }
        if (method === "session/cancel") {
          cancels += 1;
          if (options.cancelError !== undefined) prompts.at(-1)?.reject(options.cancelError);
          else if (!options.ignoreCancel) prompts.at(-1)?.answer("cancelled");
        }
      }
    });
    let stopped: Promise<CommandStop> | undefined;
    return {
      child, reach: { kind: "scope", unit: "fixture.scope" },
      stop: () => stopped ??= (async () => {
        stops += 1;
        await Promise.resolve();
        if (options.holdPipes) {
          return { outcome: { kind: "unconfirmed", reason: "fixture pipes still open" }, attemptAccount: null };
        }
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
        return { outcome: { kind: "stopped" }, attemptAccount: options.stopAccount ?? null };
      })()
    };
  });
  return {
    commands,
    children,
    update: (body) => send({ method: "session/update", params: { sessionId: "held", update: body } }),
    prompts,
    cancels: () => cancels,
    stops: () => stops,
    started: () => started,
    releaseOpen: () => {
      released = true;
      for (const answer of heldOpen.splice(0)) answer();
    }
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !condition(); tries += 1) await flush();
  assert.ok(condition(), "the condition was never met");
}

test("ACP releases the child and its pipes when they outlive the drain deadline", async (t) => {
  const agent = inProcessAgent(t, { holdPipes: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = await AcpClient.start({
    name: "fixture agy",
    file: "agy", args: ["acp"], cwd: process.cwd(), env: process.env, commands: agent.commands,
    clientInfo: { name: "ensemble-test", version: "0" },
    permissionPolicy: () => null
  });
  const child = agent.children[0]!;
  const unref = t.mock.method(child, "unref");
  const session = await client.newSession({ cwd: process.cwd(), onUpdate: () => undefined });
  const rejected = assert.rejects(session.prompt("wait"), /was stopped by the harness/);
  assert.equal((await client.close()).outcome.kind, "unconfirmed");
  t.mock.timers.tick(999);
  assert.equal(child.stdout?.destroyed, false);
  t.mock.timers.tick(1);
  await client.exited;
  await rejected;
  assert.equal(child.stdin?.destroyed, true);
  assert.equal(child.stdout?.destroyed, true);
  assert.equal(child.stderr?.destroyed, true);
  assert.equal(unref.mock.callCount(), 1);
});

test("an agy attempt waits for every background command and uses the automatic follow-up as its answer", async (t) => {
  const agent = inProcessAgent(t);
  const adapter = new AgyEngineAdapter({ commands: agent.commands });
  t.after(() => adapter.close());
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const invocation = adapter.createInvocation("run commands", { cwd: process.cwd() });
  const pending = invocation.runAttempt({ attempt: 1 });
  await until(() => agent.prompts.length === 1);
  const start = (id: string): void => agent.update({ sessionUpdate: "tool_call", name: "run_command", toolCallId: id, status: "in_progress" });
  const finish = (id: string, status = "completed"): void => agent.update({ sessionUpdate: "tool_call_update", toolCallId: id, status });
  const text = (value: string): void => agent.update(say(value).update);
  const usage = (): void => agent.update({ sessionUpdate: "usage_update", used: 500, size: 1000 });

  start("short");
  start("long");
  text("Command still running. ");
  agent.prompts[0]?.answer("end_turn", { totalTokens: 42 });
  // Frames after the reply can arrive in the same read.
  finish("short");
  text("Short command done. ");
  usage();
  await flush();
  assert.equal(agent.stops(), 0);
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(agent.stops(), 0, "the second command is still running");

  finish("long", "failed");
  usage();
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(agent.stops(), 0, "a usage update alone is not a follow-up answer");

  text("Checking results. ");
  usage();
  await flush();
  start("check");
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(agent.stops(), 0, "a new tool call supersedes the answer in progress");

  finish("check");
  text("Final ");
  text("answer.");
  usage();
  await flush();
  t.mock.timers.tick(1_000);
  const result = await pending;
  assert.equal(result.text, "Final answer.");
  assert.equal(result.deltaText, "Command still running. Short command done. Checking results. Final answer.");
  assert.equal(result.tokenUsageEvents[0]?.last.totalTokens, 42);
  const transcript = result.transcripts?.[0]?.content ?? "";
  assert.ok(transcript.indexOf('"type":"reply"') < transcript.indexOf("Short command done."));
  assert.match(transcript, /"status":"failed"/);
  assert.equal(agent.prompts.length, 1, "agy follows up without a new prompt");
  assert.equal(agent.stops(), 1);
});

test("a held agy turn's deadline still applies after the prompt reply", async (t) => {
  const agent = inProcessAgent(t, { ignoreCancel: true });
  const adapter = new AgyEngineAdapter({ commands: agent.commands });
  t.after(() => adapter.close());
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const session = adapter.createSession({ cwd: process.cwd(), timeoutMs: 500 }, { onLost: () => undefined });
  const pending = session.beginTurn("wait", {}).runAttempt({ attempt: 1 }).catch((error: unknown) => error);
  await until(() => agent.prompts.length === 1);
  agent.update({ sessionUpdate: "tool_call", toolCallId: "pending", name: "run_command", status: "in_progress" });
  agent.prompts[0]?.answer("end_turn", { totalTokens: 42 });
  await flush();
  t.mock.timers.tick(500);
  await flush();
  assert.equal(agent.cancels(), 1);
  t.mock.timers.tick(10_000);
  const failure = await pending;
  assert.ok(failure instanceof TurnTimeoutError);
  assert.equal(failedTurnResultOf(failure)?.tokenUsageEvents[0]?.last.totalTokens, 42);
  assert.equal((await session.beginTurn("next", {}).runAttempt({ attempt: 1 })).attemptFailure?.kind, "session-lost");
});

test("an agy worker that exits during its automatic follow-up keeps partial text and prompt usage", async (t) => {
  const agent = inProcessAgent(t);
  const adapter = new AgyEngineAdapter({ commands: agent.commands });
  t.after(() => adapter.close());
  const invocation = adapter.createInvocation("wait", { cwd: process.cwd() });
  const pending = invocation.runAttempt({ attempt: 1 });
  await until(() => agent.prompts.length === 1);
  agent.update({ sessionUpdate: "tool_call", toolCallId: "pending", name: "run_command", status: "in_progress" });
  agent.update(say("Started.").update);
  agent.prompts[0]?.answer("end_turn", { totalTokens: 42 });
  agent.children[0]?.emit("exit", 3, null);
  agent.children[0]?.emit("close", 3, null);
  const result = await pending;
  assert.equal(result.attemptFailure?.kind, "agy-worker-lost");
  assert.deepEqual(result.workerExit, { exitCode: 3, signal: null });
  assert.equal(result.deltaText, "Started.");
  assert.equal(result.tokenUsageEvents[0]?.last.totalTokens, 42);
  assert.equal(result.transcripts?.[0]?.partial, true);
});

test("an agy worker that ignores cancel is stopped after ten seconds and its attempt accounts for one stop", async (t) => {
  const stopAccount = { owner: "agy acp", reason: "the process group's end could not be established" };
  const agent = inProcessAgent(t, { ignoreCancel: true, stopAccount });
  const adapter = new AgyEngineAdapter({ commands: agent.commands });
  t.after(() => adapter.close());
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const invocation = adapter.createInvocation("wait", { cwd: process.cwd(), timeoutMs: 500 });
  const pending = invocation.runAttempt({ attempt: 1 }).catch((error: unknown) => error);
  await until(() => agent.prompts.length === 1);
  t.mock.timers.tick(500);
  await flush();
  assert.equal(agent.cancels(), 1);
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(agent.stops(), 0);
  t.mock.timers.tick(1);
  const failure = await pending;
  assert.ok(failure instanceof TurnTimeoutError);
  assert.deepEqual(failedTurnResultOf(failure)?.diagnostics?.unestablishedStops, [stopAccount]);
  await invocation.close?.();
  assert.equal(agent.stops(), 1);
});

for (const bound of [
  { name: "deadline", timeoutMs: 500, expiry: 500, error: TurnTimeoutError, text: "partial" },
  { name: "whitespace bound", timeoutMs: 3_600_000, expiry: 120_000, error: WhitespaceStreamError, text: "  " }
]) {
  test(`a held agy turn stopped at its ${bound.name} keeps that failure and the stop account, then the session is lost`, async (t) => {
    const stopAccount = { owner: "agy acp", reason: "the process group's end could not be established" };
    const agent = inProcessAgent(t, { ignoreCancel: true, stopAccount });
    const adapter = new AgyEngineAdapter({ commands: agent.commands });
    t.after(() => adapter.close());
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const losses: unknown[] = [];
    const session = adapter.createSession({ cwd: process.cwd(), timeoutMs: bound.timeoutMs }, { onLost: (loss) => losses.push(loss) });
    const pending = session.beginTurn("wait", {}).runAttempt({ attempt: 1 }).catch((error: unknown) => error);
    await until(() => agent.prompts.length === 1);
    agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: bound.text } });
    await flush();
    t.mock.timers.tick(bound.expiry);
    await flush();
    assert.equal(agent.cancels(), 1);
    assert.equal(agent.stops(), 0);
    t.mock.timers.tick(10_000);
    const failure = await pending;
    assert.ok(failure instanceof bound.error);
    assert.equal(failedTurnResultOf(failure)?.deltaText, bound.text);
    assert.deepEqual(failedTurnResultOf(failure)?.diagnostics?.unestablishedStops, [stopAccount]);
    assert.equal(losses.length, 1);
    const later = await session.beginTurn("next", {}).runAttempt({ attempt: 1 });
    assert.equal(later.attemptFailure?.kind, "session-lost");
    assert.equal(later.diagnostics, undefined);
    assert.equal(agent.prompts.length, 1);
    assert.equal(agent.stops(), 1);
  });
}

test("an agy RPC error after deadline cancellation preserves the deadline and keeps the RPC diagnostic", async (t) => {
  const cancelError = { code: -32603, message: "interrupting the prompt" };
  const agent = inProcessAgent(t, { cancelError });
  const adapter = new AgyEngineAdapter({ commands: agent.commands });
  t.after(() => adapter.close());
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const invocation = adapter.createInvocation("wait", { cwd: process.cwd(), timeoutMs: 500 });
  const pending = invocation.runAttempt({ attempt: 1 }).catch((error: unknown) => error);
  await until(() => agent.prompts.length === 1);
  t.mock.timers.tick(500);
  const failure = await pending;
  assert.ok(failure instanceof TurnTimeoutError);
  assert.deepEqual(failedTurnResultOf(failure)?.diagnostics?.agy, {
    session_id: "held", stop_reason: null, error: { code: cancelError.code, message: "agy acp: session/prompt failed (-32603): interrupting the prompt" }
  });
});

test("agy's whitespace bound is reset by text, tool activity and thought, and a stop spends one attempt and is retried", async (t) => {
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
  assert.equal(agent.cancels(), 1, "the bound cancels the turn");
  assert.equal(agent.prompts[1]?.text, openingPrompt({
    task: "answer", previousFailure: { kind: "WhitespaceStreamError", message: "worker streamed only whitespace for two minutes" }
  }));
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

test("a one-shot agy turn cut short by its invocation closing keeps its text, usage and transcript on the shutdown", async (t) => {
  const { adapter, dir } = await scriptedAdapter(t, { turns: [[say("partial-evidence"), { untilCancelled: true }]] });
  const invocation = adapter.createInvocation("long task", { cwd: dir });
  let seen!: () => void;
  const output = new Promise<void>((resolve) => (seen = resolve));
  const pending = invocation.runAttempt({ attempt: 1, onOutput: () => seen() }).catch((error: unknown) => error);
  await output;
  await invocation.close?.();
  const failure = await pending;
  assert.ok(failure instanceof EngineShutdownError);
  const result = failedTurnResultOf(failure) as EngineAttemptResult;
  assert.equal(result.text, "partial-evidence");
  assert.match(result.transcripts![0]!.content, /partial-evidence/);
  assert.equal(result.transcripts![0]!.partial, true);
});

test("a held agy turn cut short by its session closing keeps the stop account and transcript", async (t) => {
  const { adapter, dir } = await scriptedAdapter(t, { turns: [[say("partial-evidence"), { untilCancelled: true }]] });
  const session = adapter.createSession({ cwd: dir }, { onLost: () => assert.fail("closing a session is not a loss") });
  let seen!: () => void;
  const output = new Promise<void>((resolve) => (seen = resolve));
  const pending = session.beginTurn("long task", {}).runAttempt({ attempt: 1, onOutput: () => seen() }).catch((error: unknown) => error);
  await output;
  await session.close();
  const failure = await pending;
  assert.ok(failure instanceof EngineShutdownError);
  const evidence = failedTurnResultOf(failure);
  assert.match(evidence?.transcripts?.[0]?.content ?? "", /partial-evidence/);
  assert.equal((evidence?.diagnostics?.unestablishedStops as unknown[])?.length, 1);
  assert.match(JSON.stringify(evidence?.diagnostics?.unestablishedStops), /agy acp in process group/);
});

test("run teardown owns the stop of a held agy worker, and its attempt keeps the partial transcript", async (t) => {
  const { bin, dir } = await scriptedAgy(t);
  const commands = new CommandContainment(new NoWorkerScopes());
  const adapter = new AgyEngineAdapter({
    bin, cwd: dir, commands,
    workerEnv: { SCRIPTED_ACP_AGENT: JSON.stringify({ turns: [[say("partial-evidence"), { untilCancelled: true }]] }) }
  });
  const runtime = new EnsembleRuntime({ cwd: dir, defaultMaxAttempts: 1, engines: new EngineRegistry([adapter], [commands]) });
  t.after(() => runtime.close().catch(() => undefined));
  const session = runtime.createWorkerSession({ engine: "agy" });
  const output = new Promise<void>((resolve) => {
    const unsubscribe = runtime.progress.onChange(() => {
      if (!runtime.progress.snapshot().agents.some((entry) => entry.firstEvidenceAtMs !== null)) return;
      unsubscribe();
      resolve();
    });
  });
  const pending = session.send("long task").catch((error: unknown) => error);
  await output;
  await assert.rejects(runtime.close(), /agy acp in process group/);
  assert.ok(await pending instanceof EngineShutdownError);
  const attempt = runtime.lastAgentRecord()?.attempts[0];
  assert.equal(attempt?.rawOutput, "partial-evidence");
  assert.equal(attempt?.diagnostics?.unestablishedStops, undefined);
});

test("a worker that replaces a dead one accounts its session's usage from zero", async (t) => {
  const { bin, dir } = await scriptedAgy(t);
  const commands = new CommandContainment(new NoWorkerScopes());
  const adapter = new AgyEngineAdapter({
    bin, cwd: dir, commands,
    workerEnv: { SCRIPTED_ACP_AGENT: JSON.stringify({ counter: path.join(dir, "turns"), turns: [[say("not a number")], [{ exit: 1 }], [say("7")]] }) }
  });
  const runtime = new EnsembleRuntime({ defaultMaxAttempts: 3, cwd: dir, engines: new EngineRegistry([adapter]) });
  t.after(async () => {
    await runtime.close();
    await commands.close();
  });
  assert.equal(await runtime.agent("count", { engine: "agy", schema: { type: "number" } }), 7);
  const attempts = runtime.lastAgentRecord()!.attempts;
  assert.equal(attempts.length, 3);
  const [first] = attempts[0]!.tokenUsageEvents;
  const [replaced] = attempts[2]!.tokenUsageEvents;
  assert.equal(first?.total.totalTokens, 110);
  assert.equal(replaced?.last.totalTokens, 110);
  assert.equal(replaced?.total.totalTokens, 110, "the new session's total starts at its own first turn");
  assert.match(String(replaced?.turnId), /:agy-1$/);
});

test("a one-shot agy worker is stopped when its attempt ends, and the stop's account rides that attempt", async (t) => {
  const stopAccount = { owner: "agy acp", reason: "the process group's end could not be established" };
  const agent = inProcessAgent(t, { stopAccount });
  const adapter = new AgyEngineAdapter({ commands: agent.commands });
  t.after(() => adapter.close());
  const invocation = adapter.createInvocation("answer", { cwd: process.cwd() });
  const pending = invocation.runAttempt({ attempt: 1 });
  await until(() => agent.prompts.length === 1);
  agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
  await flush();
  agent.prompts[0]?.answer("end_turn");
  const result = await pending;
  assert.equal(result.text, "done");
  assert.equal(agent.stops(), 1, "the worker is stopped before the attempt settles");
  assert.deepEqual(result.diagnostics?.unestablishedStops, [stopAccount]);
  await invocation.close?.();
  assert.equal(agent.stops(), 1);
});

test("a one-shot agy worker that finishes opening after its invocation closed is stopped", async (t) => {
  const agent = inProcessAgent(t, { holdOpen: true });
  const adapter = new AgyEngineAdapter({ commands: agent.commands });
  t.after(() => adapter.close());
  const invocation = adapter.createInvocation("answer", { cwd: process.cwd() });
  const pending = invocation.runAttempt({ attempt: 1 }).catch((error: unknown) => error);
  await until(() => agent.started() === 1);
  const closing = invocation.close?.();
  agent.releaseOpen();
  assert.ok((await pending) instanceof EngineShutdownError);
  await closing;
  assert.equal(agent.stops(), 1, "the worker the close raced is not left running");
  assert.equal(agent.prompts.length, 0, "nothing was prompted");
});
