import assert from "node:assert/strict";
import test from "node:test";

import { CodexEngineAdapter } from "../../src/engines.js";
import {
  AppServerExitedError, CodexSubstrateRefusedError, EngineShutdownError,
  attachPartialTranscript, attachPartialWorkerText, attachWorkerExitStatus
} from "../../src/errors.js";
import type { EngineSessionLoss } from "../../src/engines.js";
import type { RuntimeTransport, TurnResult } from "../../src/types.js";

const answer: TurnResult = {
  text: "answer", deltaText: "answer", durationMs: 1, firstDeltaMs: 1,
  items: {}, tokenUsageEvents: []
};

class HeldTransport implements RuntimeTransport {
  cwd = "/fake";
  listeners = new Set<(error: Error) => void>();
  opens = 0;
  turns = 0;
  opening: (() => void) | undefined;
  attempt: () => Promise<TurnResult> = async () => answer;

  onTermination(listener: (error: Error) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async openThread(): Promise<string> {
    this.opens++;
    this.opening?.();
    return `thread-${this.opens}`;
  }
  async runTurn(): Promise<TurnResult> {
    this.turns++;
    return this.attempt();
  }
  die(error = new AppServerExitedError("app-server died")): void {
    for (const listener of this.listeners) listener(error);
  }
  async close(): Promise<void> { this.die(); }
}

test("Codex death loses each established open session once and isolates a throwing observer", async () => {
  const transport = new HeldTransport();
  const adapter = new CodexEngineAdapter({ transport, concurrency: 3 });
  const losses: EngineSessionLoss[] = [];
  const throwing = adapter.createSession({}, { onLost: () => { throw new Error("observer"); } });
  const held = adapter.createSession({}, { onLost: loss => losses.push(loss) });
  const unexpected: EngineSessionLoss[] = [];
  const closed = adapter.createSession({}, { onLost: loss => unexpected.push(loss) });
  const threadless = adapter.createSession({}, { onLost: loss => unexpected.push(loss) });
  try {
    for (const session of [throwing, held, closed]) await session.beginTurn("first", {}).runAttempt({ attempt: 1 });
    await closed.close();
    transport.die();
    transport.die();
    assert.equal(losses.length, 1);
    assert.equal(losses[0]?.nativeSession, "thread-2");
    for (const session of [throwing, held]) {
      const result = await session.beginTurn("after death", {}).runAttempt({ attempt: 1 });
      assert.equal(result.attemptFailure?.kind, "session-lost");
    }
    assert.equal(transport.turns, 3);
    await threadless.close();
    assert.deepEqual(unexpected, []);
  } finally { await adapter.close(); }
  assert.equal(transport.listeners.size, 0);
});

test("a Codex turn interrupted by substrate death retains its own partial evidence and exit status", async () => {
  const transport = new HeldTransport();
  const adapter = new CodexEngineAdapter({ transport, concurrency: 1 });
  const losses: EngineSessionLoss[] = [];
  const held = adapter.createSession({}, { onLost: loss => losses.push(loss) });
  const transcript = { filename: "transcript.codex.jsonl", source: "codex-app-server" as const,
    format: "jsonl" as const, content: "partial transcript", partial: true, threadId: "thread-1" };
  transport.attempt = async () => {
    const error = attachWorkerExitStatus(new AppServerExitedError("killed"), { exitCode: null, signal: "SIGKILL" });
    transport.die(error);
    attachPartialWorkerText(error, "unfinished answer");
    attachPartialTranscript(error, transcript);
    throw error;
  };
  try {
    const result = await held.beginTurn("first", {}).runAttempt({ attempt: 1 });
    assert.equal(result.attemptFailure?.kind, "session-lost");
    assert.equal(result.text, "unfinished answer");
    assert.deepEqual(result.transcripts, [transcript]);
    assert.deepEqual(result.workerExit, { exitCode: null, signal: "SIGKILL" });
    assert.equal(losses.length, 1);
  } finally { await adapter.close(); }
});

test("Codex death observed during a successful thread open is applied before its first turn", async () => {
  const transport = new HeldTransport();
  const adapter = new CodexEngineAdapter({ transport, concurrency: 1 });
  const losses: EngineSessionLoss[] = [];
  const held = adapter.createSession({}, { onLost: loss => losses.push(loss) });
  transport.opening = () => transport.die();
  try {
    const result = await held.beginTurn("first", {}).runAttempt({ attempt: 1 });
    assert.equal(result.attemptFailure?.kind, "session-lost");
    assert.equal(transport.turns, 0);
    assert.equal(losses.length, 1);
  } finally { await adapter.close(); }
});

test("a Codex startup refusal does not lose a worker that never existed", async () => {
  const transport = new HeldTransport();
  const adapter = new CodexEngineAdapter({ transport, concurrency: 1 });
  const losses: EngineSessionLoss[] = [];
  const held = adapter.createSession({}, { onLost: loss => losses.push(loss) });
  transport.opening = () => { transport.die(); throw new AppServerExitedError("startup failed"); };
  try {
    await assert.rejects(held.beginTurn("first", {}).runAttempt({ attempt: 1 }), CodexSubstrateRefusedError);
    await assert.rejects(held.beginTurn("retry", {}).runAttempt({ attempt: 2 }), CodexSubstrateRefusedError);
    assert.deepEqual(losses, []);
  } finally { await adapter.close(); }
});

test("Codex adapter shutdown detaches sessions before transport close and closes admission", async () => {
  const transport = new HeldTransport();
  const adapter = new CodexEngineAdapter({ transport, concurrency: 1 });
  const losses: EngineSessionLoss[] = [];
  const held = adapter.createSession({}, { onLost: loss => losses.push(loss) });
  await held.beginTurn("first", {}).runAttempt({ attempt: 1 });
  await adapter.close();
  assert.equal(transport.listeners.size, 0);
  assert.deepEqual(losses, []);
  assert.throws(() => adapter.createSession({}), EngineShutdownError);
});
