import assert from "node:assert/strict";
import test from "node:test";

import { CodexRuntime } from "../../src/runtime.js";
import { BudgetExceededError } from "../../src/errors.js";

import type {
  RuntimeTransport,
  ThreadStartOptions,
  TurnResult,
  TurnStartOptions
} from "../../src/types.js";

class FakeTransport implements RuntimeTransport {
  openedThreads: ThreadStartOptions[] = [];
  turns: Array<{ threadId: string; prompt: string; options: TurnStartOptions }> = [];

  #responses: TurnResult[];

  constructor(responses: TurnResult[]) {
    this.#responses = responses;
  }

  async openThread(options: ThreadStartOptions): Promise<string> {
    this.openedThreads.push(options);
    return `thread-${this.openedThreads.length}`;
  }

  async runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult> {
    this.turns.push({ threadId, prompt, options });
    const response = this.#responses.shift();
    assert.ok(response, "fake transport response was not configured");
    return response;
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

const schema = {
  type: "object",
  required: ["answer"],
  additionalProperties: false,
  properties: {
    answer: { type: "string", enum: ["yes"] }
  }
};

test("schema agents retry invalid output and return null after the bounded attempts", async () => {
  const transport = new FakeTransport([turn("not json"), turn("{\"answer\":\"no\"}")]);
  const runtime = new CodexRuntime({
    transport,
    concurrency: 1,
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 2
  });

  const result = await runtime.agent("return JSON", { schema });

  assert.equal(result, null);
  assert.equal(transport.turns.length, 2);
});

test("schema agents return the validated object when a retry succeeds", async () => {
  const transport = new FakeTransport([turn("not json"), turn("{\"answer\":\"yes\"}")]);
  const runtime = new CodexRuntime({
    transport,
    concurrency: 1,
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 3
  });

  const result = await runtime.agent("return JSON", { schema });

  assert.deepEqual(result, { answer: "yes" });
  assert.equal(transport.turns.length, 2);
});

test("budget records tokenUsage.last deltas and blocks later calls after exhaustion", async () => {
  const transport = new FakeTransport([turn("ok")]);
  const runtime = new CodexRuntime({
    transport,
    concurrency: 1,
    budgetTotal: 5,
    defaultTurnTimeoutMs: 1_000,
    defaultMaxAttempts: 1
  });

  runtime.handleTransportEvent({
    method: "thread/tokenUsage/updated",
    receivedAt: Date.now(),
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: usage(3),
        total: usage(3)
      }
    }
  });
  runtime.handleTransportEvent({
    method: "thread/tokenUsage/updated",
    receivedAt: Date.now(),
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: usage(2),
        total: usage(5)
      }
    }
  });

  assert.equal(runtime.budget.spent(), 5);
  await assert.rejects(() => runtime.agent("blocked"), BudgetExceededError);
});

function turn(text: string): TurnResult {
  return {
    text,
    deltaText: text,
    durationMs: 10,
    firstDeltaMs: 5,
    items: {},
    tokenUsageEvents: []
  };
}

function usage(totalTokens: number) {
  return {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: totalTokens,
    reasoningOutputTokens: 0,
    totalTokens
  };
}
