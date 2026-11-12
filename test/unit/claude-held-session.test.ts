import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeCliControlPlane } from "../../src/claude-control-plane.js";
import { ClaudeEngineAdapter, EngineRegistry } from "../../src/engines.js";
import { RunRecordWriter } from "../../src/run-record.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { waitForCondition } from "../wait-for-condition.js";
import type { ClaudeSessionHandle } from "../../src/claude-control-plane.js";
import type { EngineSessionLoss } from "../../src/engines.js";
import type { RuntimeAgentRecord } from "../../src/run-record.js";
import type { RuntimeEvent } from "../../src/types.js";

/** Real roster/watch/attachment ownership over controlled executable endpoints. */
async function fixture(watchMs = 60_000, multiple = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-held-"));
  const mode = path.join(dir, "mode");
  const actions = path.join(dir, "attachments");
  const transcript = path.join(dir, "transcript.jsonl");
  const cli = path.join(dir, "claude.mjs");
  const tmux = path.join(dir, "tmux.mjs");
  await writeFile(mode, "present");
  await writeFile(mode + ".names", "[]");
  await writeFile(actions, "");
  await writeFile(cli, `#!${process.execPath}
    import {readFile,writeFile,rename} from 'node:fs/promises';
    const mode=${JSON.stringify(mode)};
    const multiple=${JSON.stringify(multiple)};
    const names=async()=>JSON.parse(await readFile(mode+'.names','utf8'));
    const save=async values=>{await writeFile(mode+'.names-next',JSON.stringify(values));await rename(mode+'.names-next',mode+'.names');};
    if(process.argv[2]==='--bg') {
      const name=process.argv[process.argv.indexOf('--name')+1];
      if(multiple) await save([...(await names()),name]); else await writeFile(mode+'.name',name);
      for await(const chunk of process.stdin) void chunk;
    }
    if(process.argv[2]==='agents') {
      const state=(await readFile(mode,'utf8')).trim();
      if(state==='unavailable') process.exit(1);
      const hidden=JSON.parse(await readFile(mode+'.hidden','utf8').catch(()=>'[]'));
      const listed=multiple?await names():[await readFile(mode+'.name','utf8')];
      process.stdout.write(JSON.stringify(state==='absent'?[]:listed.filter(name=>!hidden.includes(name)).map(name=>({id:multiple?name:'held',sessionId:multiple?'native-'+name:'native-held',name,kind:'background',pid:process.pid,cwd:${JSON.stringify(dir)},status:'idle',state:'done'}))));
    }
    if(['stop','rm'].includes(process.argv[2])) {
      if(multiple) await save((await names()).filter(name=>name!==process.argv[3])); else await writeFile(mode,'absent');
    }
  `, { mode: 0o700 });
  await writeFile(tmux, `#!${process.execPath}
    import {access,appendFile,writeFile,unlink,readFile} from 'node:fs/promises';
    const a=process.argv.slice(2), marker=a[1]+'.attached';
    if(a.includes('new-session')) {
      const name=a[a.indexOf('-s')+1];
      await appendFile(${JSON.stringify(mode)}+'.attempts',name+'\\n');
      if((await readFile(${JSON.stringify(mode)}+'.refused-attachment','utf8').catch(()=>''))===name) {
        process.stderr.write('controlled attachment refusal'); process.exit(1);
      }
      await writeFile(marker,'alive'); await appendFile(${JSON.stringify(actions)},marker+'\\n');
      await writeFile(${JSON.stringify(mode)}+'.attachment-env',JSON.stringify({worker:process.env.ENSEMBLE_CLAUDE_WORKER??null}));
      if((await readFile(${JSON.stringify(mode)}+'.attachment','utf8').catch(()=>''))==='hold') setInterval(()=>{},1000);
    }
    if(a.includes('has-session')) { try {await access(marker);} catch {process.exit(1);} }
    if(a.includes('kill-server')) await unlink(marker).catch(()=>{});
  `, { mode: 0o700 });
  class Plane extends ClaudeCliControlPlane {
    steers = 0;
    pending = false;
    handle: ClaudeSessionHandle | undefined;
    override async steer(handle: ClaudeSessionHandle, message: string) {
      this.handle = handle;
      this.steers++;
      await appendFile(transcript, JSON.stringify({ type: "user", message: { content: message } }) + "\n");
      if (!this.pending) await appendFile(transcript, JSON.stringify({ type: "assistant", message: {
        model: "claude-fixture", content: [{ type: "text", text: "done" }], stop_reason: "end_turn"
      } }) + "\n");
      return { submitted: true as const };
    }
    override async transcriptPath() { return transcript; }
    override async tmuxAvailable() { return true; }
  }
  const events: RuntimeEvent[] = [];
  const plane = new Plane({ claudeBin: cli, tmuxBin: tmux, placementWatchIntervalMs: watchMs, valveAttachSettleMs: 0,
    onEvent: event => events.push(event) });
  return { dir, mode, actions, plane, events, async dispose() { await plane.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("held Claude roster loss excludes failed queries, parking gaps and intentional close", async () => {
  const f = await fixture();
  const losses: EngineSessionLoss[] = [];
  const handle = await f.plane.dispatch({ prompt: "first", name: "held", cwd: f.dir, onLost: loss => { losses.push(loss); throw new Error("observer"); } });
  try {
    await writeFile(f.mode, "unavailable");
    for (let i = 0; i < 4; i++) assert.equal((await f.plane.poll(handle)).present, true);
    assert.equal(losses.length, 0);
    await writeFile(f.mode, "absent");
    await f.plane.poll(handle); await f.plane.poll(handle);
    await writeFile(f.mode, "present");
    await f.plane.poll(handle);
    assert.equal(losses.length, 0, "a parking gap became a permanent loss");
    await writeFile(f.mode, "absent");
    await f.plane.poll(handle); await f.plane.poll(handle);
    assert.equal(losses.length, 0);
    await f.plane.poll(handle);
    assert.equal(losses.length, 1);
    assert.equal(losses[0]?.nativeSession, handle.sessionId);
    await f.plane.poll(handle);
    assert.equal(losses.length, 1, "loss repeated after confirmation");
    await f.plane.stop(handle);
    await writeFile(f.mode, "present");
    const next = await f.plane.dispatch({ prompt: "first", name: "held", cwd: f.dir, onLost: loss => losses.push(loss) });
    await f.plane.stop(next);
    for (let i = 0; i < 3; i++) await f.plane.poll(next);
    assert.equal(losses.length, 1, "intentional close was reported lost");
  } finally { await f.plane.stop(handle); await f.dispose(); }
});

test("held Claude keeps its attachment, repairs a dead client between turns and removes it on close", async () => {
  const f = await fixture(10);
  const handle = await f.plane.dispatch({ prompt: "first", name: "held", cwd: f.dir, keepAlive: true });
  const markers = async () => (await readFile(f.actions, "utf8")).trim().split("\n");
  try {
    const first = (await markers())[0]!;
    assert.deepEqual(JSON.parse(await readFile(f.mode + ".attachment-env", "utf8")), {
      worker: process.env.ENSEMBLE_CLAUDE_WORKER ?? null
    }, "an attach client that can start the shared daemon must not receive this session's ownership tag");
    assert.equal((await readFile(first, "utf8")), "alive");
    await rm(first);
    await waitForCondition(async () => (await markers()).length === 2, "idle client to be reattached", 10_000, 10);
    assert.equal(f.plane.steers, 1, "attachment recovery submitted another prompt");
    const current = (await markers())[1]!;
    assert.equal(await readFile(current, "utf8"), "alive");
    await f.plane.stop(handle);
    await assert.rejects(readFile(current), { code: "ENOENT" });
  } finally { await f.plane.stop(handle); await f.dispose(); }
});

for (const schema of [undefined, { type: "string" }] as const) {
  test(`Claude loss between turns is archived once and later ${schema ? "schema" : "text"} sends spend one attempt without steering`, async () => {
    const f = await fixture(10);
    const runtime = new EnsembleRuntime({ defaultMaxAttempts: 3, engines: new EngineRegistry([new ClaudeEngineAdapter({ controlPlane: f.plane, config: { pollIntervalMs: 1 } })]) });
    const writer = await RunRecordWriter.start({ storeDir: path.join(f.dir, "records"), runUuid: "held-loss", cwd: f.dir,
      workflowPath: path.join(f.dir, "workflow.js"), workflowSource: "return true;", args: [], cliFlags: { jsonArgs: false } });
    runtime.setRunRecorder(writer);
    const held = runtime.createWorkerSession({ engine: "claude", maxAttempts: 3 });
    try {
      assert.equal(await held.send("first"), "done");
      await writeFile(f.mode, "absent");
      await waitForCondition(async () => held.lost, "idle roster loss to reach the handle", 10_000, 10);
      assert.equal(await held.send("second", schema ? { schema } : {}), null);
      assert.equal(await held.send("third"), null);
      assert.equal(f.plane.steers, 1);
      await runtime.close();
      await writer.finish({ status: "complete", exitCode: 0, result: null });
      const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8"));
      assert.equal(manifest.session_events.length, 1);
      assert.equal(manifest.session_events[0].native_session, "native-held");
      for (const id of [2, 3]) {
        const record = JSON.parse(await readFile(path.join(writer.archiveDir, `agents/${String(id).padStart(6, "0")}/agent.json`), "utf8"));
        assert.equal(record.attempts.length, 1);
        assert.equal(record.attempts[0].failure.kind, "session-lost");
        assert.equal(record.attempts[0].classification.rule, "session.lost");
      }
    } finally { await runtime.close(); await f.dispose(); }
  });
}

test("a send that discovers Claude missing reports loss before returning and never opens the valve", async () => {
  const f = await fixture();
  const runtime = new EnsembleRuntime({ defaultMaxAttempts: 3, engines: new EngineRegistry([new ClaudeEngineAdapter({ controlPlane: f.plane, config: { pollIntervalMs: 1 } })]) });
  const held = runtime.createWorkerSession({ engine: "claude" });
  try {
    assert.equal(await held.send("first"), "done");
    await writeFile(f.mode, "absent");
    assert.equal(await held.send("second"), null);
    assert.equal(held.lost, true);
    assert.equal(f.plane.steers, 1);
  } finally { await runtime.close(); await f.dispose(); }
});

test("loss during preflight delay leaves the unsent turn's archived output empty", { timeout: 10_000 }, async () => {
  const f = await fixture();
  const runtime = new EnsembleRuntime({ defaultMaxAttempts: 3,
    engines: new EngineRegistry([new ClaudeEngineAdapter({ controlPlane: f.plane, config: { pollIntervalMs: 60_000 } })]) });
  const records: RuntimeAgentRecord[] = [];
  runtime.setRunRecorder({ recordAgent: async record => { records.push(structuredClone(record)); } } as RunRecordWriter);
  const held = runtime.createWorkerSession({ engine: "claude" });
  try {
    assert.equal(await held.send("first"), "done");
    const handle = f.plane.handle;
    assert.ok(handle);
    const poll = f.plane.poll.bind(f.plane);
    const preflight = Promise.withResolvers<void>();
    f.plane.poll = async current => {
      const status = await poll(current);
      if (!status.present) preflight.resolve();
      return status;
    };
    await writeFile(f.mode, "absent");
    const pending = held.send("second");
    await preflight.promise;
    // Let the engine enter its poll delay, then supply the two remaining
    // observations through the watch's real presence accounting.
    await new Promise<void>(setImmediate);
    await poll(handle);
    await poll(handle);
    assert.equal(await pending, null);
    assert.equal(held.lost, true);
    const record = records.at(-1)!;
    assert.equal(record.attempts.length, 1);
    assert.equal(record.attempts[0]?.failure?.kind, "session-lost");
    assert.equal(record.attempts[0]?.rawOutput, null);
    assert.equal(record.rawOutput, null);
    assert.equal(f.plane.steers, 1);
  } finally { await runtime.close(); await f.dispose(); }
});

test("Claude reports a mid-turn loss before settling its sole attempt and keeps partial evidence", async () => {
  const f = await fixture(10);
  const runtime = new EnsembleRuntime({ defaultMaxAttempts: 3,
    engines: new EngineRegistry([new ClaudeEngineAdapter({ controlPlane: f.plane, config: { pollIntervalMs: 1 } })]) });
  const records: RuntimeAgentRecord[] = [];
  const losses: unknown[] = [];
  runtime.setRunRecorder({
    recordAgent: async record => { records.push(structuredClone(record)); },
    recordSessionEvent: async event => { losses.push(event); }
  } as RunRecordWriter);
  const held = runtime.createWorkerSession({ engine: "claude" });
  try {
    assert.equal(await held.send("first"), "done");
    f.plane.pending = true;
    const pending = held.send("second");
    await waitForCondition(async () => f.plane.steers === 2, "the second turn to submit", 10_000, 10);
    const transcript = await f.plane.transcriptPath();
    await appendFile(transcript, JSON.stringify({ type: "assistant", message: {
      content: [{ type: "text", text: "partial answer" }], stop_reason: "tool_use"
    } }) + "\n");
    await writeFile(f.mode, "absent");
    assert.equal(await pending, null);
    assert.equal(held.lost, true);
    assert.equal(losses.length, 1);
    const record = records.at(-1)!;
    assert.equal(record.attempts.length, 1);
    assert.equal(record.attempts[0]?.failure?.kind, "session-lost");
    assert.equal(record.attempts[0]?.rawOutput, "partial answer");
    assert.equal(f.plane.steers, 2);
  } finally { await runtime.close(); await f.dispose(); }
});

test("Claude loss after the opening transcript settles the creating send once and stays lost", { timeout: 10_000 }, async () => {
  const f = await fixture();
  f.plane.pending = true;
  const runtime = new EnsembleRuntime({ defaultMaxAttempts: 3,
    engines: new EngineRegistry([new ClaudeEngineAdapter({ controlPlane: f.plane, config: { pollIntervalMs: 1 } })]) });
  const records: RuntimeAgentRecord[] = [];
  const losses: unknown[] = [];
  runtime.setRunRecorder({
    recordAgent: async record => { records.push(structuredClone(record)); },
    recordSessionEvent: async event => { losses.push(event); }
  } as RunRecordWriter);
  const held = runtime.createWorkerSession({ engine: "claude" });
  const firstLife = Promise.withResolvers<void>();
  const disappear = Promise.withResolvers<void>();
  const poll = f.plane.poll.bind(f.plane);
  f.plane.poll = async handle => {
    firstLife.resolve();
    await disappear.promise;
    return poll(handle);
  };
  try {
    const pending = held.send("first");
    // The engine polls only after reading and verifying its opening receipt.
    await firstLife.promise;
    assert.equal(held.lost, false);
    await appendFile(await f.plane.transcriptPath(), JSON.stringify({ type: "assistant", message: {
      content: [{ type: "text", text: "opening partial answer" }], stop_reason: "tool_use"
    } }) + "\n");
    await writeFile(f.mode, "absent");
    disappear.resolve();
    assert.equal(await pending, null);
    assert.equal(held.lost, true);
    assert.equal(records.at(-1)?.attempts.length, 1);
    assert.equal(records.at(-1)?.attempts[0]?.failure?.kind, "session-lost");
    assert.equal(records.at(-1)?.rawOutput, "opening partial answer");
    assert.equal(await held.send("second"), null);
    assert.equal(records.at(-1)?.attempts.length, 1);
    assert.equal(records.at(-1)?.attempts[0]?.failure?.kind, "session-lost");
    assert.equal(losses.length, 1);
    assert.equal(f.plane.steers, 1, "a lost opening worker received more input");
  } finally { disappear.resolve(); await runtime.close(); await f.dispose(); }
});

test("a throwing Claude session-loss observer cannot fail later attempts or repeat the notice", async () => {
  const f = await fixture(10);
  const adapter = new ClaudeEngineAdapter({ controlPlane: f.plane, cwd: f.dir });
  let notices = 0;
  const session = adapter.createSession({}, { onLost: () => { notices++; throw new Error("observer refused"); } });
  try {
    assert.equal((await session.beginTurn("first", {}).runAttempt({ attempt: 1 })).text, "done");
    await writeFile(f.mode, "absent");
    await waitForCondition(async () => notices === 1, "loss observer to run", 10_000, 10);
    for (let i = 0; i < 2; i++) {
      const result = await session.beginTurn("next", {}).runAttempt({ attempt: 1 });
      assert.equal(result.attemptFailure?.kind, "session-lost");
    }
    assert.equal(notices, 1);
    assert.equal(f.plane.steers, 1);
  } finally { await adapter.close(); await f.dispose(); }
});

for (const closing of [false, true]) {
  test(`a held attachment being established is reclaimed on ${closing ? "control-plane close" : "dispatch cancellation"}`, async () => {
    const f = await fixture();
    await writeFile(f.mode + ".attachment", "hold");
    const controller = new AbortController();
    const pending = f.plane.dispatch({ prompt: "first", name: "held", cwd: f.dir, keepAlive: true, signal: controller.signal });
    // Observe the rejection immediately; cancellation may settle it before
    // the close-side reclamation returns.
    const rejected = assert.rejects(pending);
    try {
      await waitForCondition(async () => (await readFile(f.actions, "utf8")).trim().length > 0,
        "the held attachment launch to begin", 10_000, 10);
      if (closing) await f.plane.close();
      else controller.abort(new Error("dispatch cancelled"));
      await rejected;
      await f.plane.close();
      assert.equal(f.plane.steers, 0, "cancelling attachment setup submitted the opening");
      const markers = (await readFile(f.actions, "utf8")).trim().split("\n");
      for (const marker of markers) await assert.rejects(readFile(marker), { code: "ENOENT" });
    } finally { controller.abort(); await f.dispose(); }
  });
}

test("a refused attachment repair cannot starve another worker's loss or client repair", { timeout: 15_000 }, async () => {
  const f = await fixture(10, true);
  const handles: ClaudeSessionHandle[] = [];
  const losses: EngineSessionLoss[] = [];
  try {
    for (const name of ["first", "second", "third"]) handles.push(await f.plane.dispatch({
      prompt: "first", name, cwd: f.dir, keepAlive: true, onLost: loss => losses.push(loss)
    }));
    const markers = (await readFile(f.actions, "utf8")).trim().split("\n");
    assert.equal(markers.length, 3);
    await writeFile(f.mode + ".refused-attachment", "ensemble-held-first");
    await writeFile(f.mode + ".hidden", JSON.stringify(["second"]));
    await rm(markers[0]!);
    await rm(markers[2]!);
    await waitForCondition(async () => (await readFile(f.mode + ".attempts", "utf8")).split("\n")
      .filter(name => name === "ensemble-held-first").length >= 7,
    "six unsuccessful first-client repairs", 10_000, 10);
    assert.deepEqual(losses.map(loss => loss.nativeSession), ["native-second"],
      "the first client's refusal starved the missing worker's observations");
    const created = (await readFile(f.actions, "utf8")).trim().split("\n");
    assert.equal(created.length, 4, "the third worker's dead client was not repaired");
    assert.equal(await readFile(created[3]!, "utf8"), "alive");
    assert.equal(f.plane.steers, 3, "repair submitted a model turn");
    assert.ok(f.events.some(event => event.method === "claude/workerScopeWatchError" && event.params.sessionId === "native-first"));
  } finally {
    for (const handle of handles) await f.plane.stop(handle);
    await f.dispose();
  }
});

test("opening absences keep the watch available until the native worker is established", async () => {
  const f = await fixture();
  const losses: EngineSessionLoss[] = [];
  let ready = false;
  const handle = await f.plane.dispatch({ prompt: "first", name: "held", cwd: f.dir,
    lossReady: () => ready, onLost: loss => losses.push(loss) });
  try {
    await writeFile(f.mode, "absent");
    for (let i = 0; i < 4; i++) await f.plane.poll(handle);
    assert.equal(losses.length, 0, "opening availability became a held-worker loss");
    await writeFile(f.mode, "present");
    await f.plane.poll(handle);
    ready = true;
    await writeFile(f.mode, "absent");
    for (let i = 0; i < 3; i++) await f.plane.poll(handle);
    assert.equal(losses.length, 1, "early absence permanently removed the worker's watch");
  } finally { await f.plane.stop(handle); await f.dispose(); }
});
