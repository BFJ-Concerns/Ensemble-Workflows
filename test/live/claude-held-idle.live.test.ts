import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";

import { removeTestDirectory } from "../failure-evidence.js";
import { resolveAmbientSettings } from "../../src/ambient-settings.js";
import { ClaudeCliControlPlane } from "../../src/claude-control-plane.js";
import { parseTranscriptText } from "../../src/claude-transcript.js";
import { ClaudeEngineAdapter, EngineRegistry } from "../../src/engines.js";
import { RunRecordWriter } from "../../src/run-record.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { waitForCondition } from "../wait-for-condition.js";
import { TYPED_FOLLOW_UP_OPENING_PROMPT } from "./claude-follow-up-typed-prompts.js";
import { suiteClaudeDaemon, suiteClaudeEnvironment } from "./suite-claude-daemon.js";
import type { ClaudeDispatchOptions, ClaudeSessionHandle } from "../../src/claude-control-plane.js";

const exec = promisify(execFile);
const idleMs = Number(process.env.ENSEMBLE_LIVE_CLAUDE_IDLE_MS ?? "1000");

test("native held Claude retains its attachment and context through idle, then reports external loss", {
  skip: process.env.ENSEMBLE_LIVE !== "1" ? "ENSEMBLE_LIVE must be 1" : false,
  timeout: (Number.isFinite(idleMs) ? idleMs : 0) + 360_000
}, async () => {
  assert.ok(Number.isSafeInteger(idleMs) && idleMs >= 0, "ENSEMBLE_LIVE_CLAUDE_IDLE_MS must be non-negative milliseconds");
  const daemon = await suiteClaudeDaemon();
  assert.notEqual(daemon.origin, "unavailable", "the suite did not establish its Claude daemon");
  const dir = await mkdtemp(path.join(tmpdir(), "claude-held-native-"));
  const actions = path.join(dir, "tmux.jsonl");
  await writeFile(actions, "");
  const tmux = path.join(dir, "tmux.mjs");
  await writeFile(tmux, `#!${process.execPath}
    import {appendFileSync} from 'node:fs';
    import {spawnSync} from 'node:child_process';
    const args=process.argv.slice(2);
    appendFileSync(${JSON.stringify(actions)},JSON.stringify(args)+'\\n');
    const result=spawnSync('tmux',args,{stdio:'inherit'});
    process.exit(result.status??1);
  `, { mode: 0o700 });
  const ambient = resolveAmbientSettings({ env: process.env, cwd: dir });
  const env = suiteClaudeEnvironment();
  class Plane extends ClaudeCliControlPlane {
    handle: ClaudeSessionHandle | undefined;
    steers = 0;
    override async dispatch(options: ClaudeDispatchOptions) {
      return this.handle = await super.dispatch(options);
    }
    override async steer(handle: ClaudeSessionHandle, message: string) {
      this.steers++;
      return super.steer(handle, message);
    }
  }
  const plane = new Plane({ tmuxBin: tmux, workerEnv: ambient.workerEnvironment.claude ?? {} });
  const runtime = new EnsembleRuntime({ defaultMaxAttempts: 3,
    engines: new EngineRegistry([new ClaudeEngineAdapter({ cwd: dir, controlPlane: plane })]) });
  const held = runtime.createWorkerSession({ engine: "claude", model: process.env.ENSEMBLE_LIVE_CLAUDE_MODEL ?? "haiku", effort: "low", timeoutMs: 120_000 });
  const writer = await RunRecordWriter.start({ storeDir: path.join(dir, "records"), cwd: dir, runUuid: "native-held",
    workflowPath: path.join(dir, "workflow.js"), workflowSource: "return true;", args: [], cliFlags: { jsonArgs: false } });
  runtime.setRunRecorder(writer);
  const attachments = async () => (await readFile(actions, "utf8")).trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as string[]).filter(args => args.includes("new-session") && args.some(arg => arg.startsWith("ensemble-held-")));
  let testFailed = false;
  try {
    // Reuse the existing input-test instructions unchanged: its later plain
    // data message must receive OK from the same native conversation.
    assert.equal(await held.send(TYPED_FOLLOW_UP_OPENING_PROMPT), "OK");
    const handle = plane.handle;
    assert.ok(handle);
    const first = (await attachments())[0];
    assert.ok(first);
    await exec("tmux", ["-S", first[1]!, "has-session"]);
    // Kill only this run's private attach client. The worker stays owned and
    // the idle watch must repair the attachment without submitting a turn.
    await exec("tmux", ["-S", first[1]!, "kill-server"]);
    await waitForCondition(async () => (await attachments()).length >= 2, "native keep-alive attachment to recover", 30_000, 100);
    await waitForCondition(async () => {
      const latest = (await attachments()).at(-1)!;
      try { await exec("tmux", ["-S", latest[1]!, "has-session"]); return true; } catch { return false; }
    }, "replacement native attach client to stay up", 30_000, 100);
    assert.equal(plane.steers, 1, "attachment repair submitted a prompt");
    console.log(JSON.stringify({ nativeSession: handle.sessionId, idleStartedAt: new Date().toISOString(), idleMs, attachmentRecovered: true }));
    await delay(idleMs);
    assert.equal((await plane.poll(handle)).present, true, "native worker disappeared during idle");
    assert.equal(held.lost, false);
    assert.equal(await held.send("next"), "OK");
    assert.equal(plane.handle?.sessionId, handle.sessionId);
    const transcript = await plane.transcriptPath(handle);
    assert.ok(transcript);
    const entries = parseTranscriptText(await readFile(transcript, "utf8"));
    assert.equal(entries.filter(entry => entry.type === "user" && typeof entry.message?.content === "string").length, 2,
      "the held worker acquired a bootstrap or keep-alive model turn");
    // External deletion of this test's own session is distinct from close().
    await exec("claude", ["rm", handle.id], { env, timeout: 30_000 });
    await waitForCondition(async () => held.lost, "native roster loss to reach the handle between turns", 30_000, 100);
    assert.equal(await held.send("next"), null);
    assert.equal(plane.steers, 2, "lost session was steered again");
    await runtime.close();
    await writer.finish({ status: "complete", exitCode: 0, result: null });
    const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8"));
    assert.equal(manifest.session_events.length, 1);
    const failed = JSON.parse(await readFile(path.join(writer.archiveDir, "agents/000003/agent.json"), "utf8"));
    assert.equal(failed.attempts.length, 1);
    assert.equal(failed.attempts[0].failure.kind, "session-lost");
    for (const args of await attachments()) await assert.rejects(exec("tmux", ["-S", args[1]!, "has-session"]));
    console.log(JSON.stringify({ nativeSession: handle.sessionId, idleMs, contextContinued: true, userTurns: 2, lossEvents: 1, lostAttempts: 1, attachmentsRemoved: true }));
  } catch (error) {
    testFailed = true;
    throw error;
  } finally { await runtime.close(); await plane.close(); await removeTestDirectory(dir, testFailed); }
});
