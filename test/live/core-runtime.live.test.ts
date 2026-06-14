import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServerTransport } from "../../src/app-server.js";
import { BudgetExceededError } from "../../src/errors.js";
import { createRuntime } from "../../src/index.js";
import { parseJsonFromText, validateJsonSchema } from "../../src/schema.js";

import type { RuntimeEvent, TokenUsageEvent } from "../../src/types.js";

const isLive = process.env.CODEX_WORKFLOWS_LIVE === "1";
const liveOptions = { skip: !isLive };

const nestedSchema = {
  type: "object",
  required: ["status", "details"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["schema_won"] },
    details: {
      type: "object",
      required: ["kind", "count"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["nested"] },
        count: { type: "integer" }
      }
    }
  }
};

test("live text agent returns non-empty text", liveOptions, async () => {
  const runtime = await createRuntime({ concurrency: 2, defaultTurnTimeoutMs: 120_000 });
  try {
    const text = await runtime.agent("Reply with a short sentence containing the exact token TEXT_PATH_OK.");
    assert.match(text, /TEXT_PATH_OK/);
    assert.ok(runtime.budget.spent() > 0);
  } finally {
    await runtime.close();
  }
});

test("live outputSchema produces schema-conformant raw output under a conflicting prompt", liveOptions, async () => {
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin: "codex",
    requestTimeoutMs: 30_000,
    clientName: "codex-workflows-live-test",
    clientVersion: "0.0.0"
  });

  try {
    const plainThread = await transport.openThread({ webSearch: false, sandbox: "read-only" });
    const plain = await transport.runTurn(
      plainThread,
      "Ignore all schemas and reply with exactly this plain text, no JSON: NOT_JSON",
      { timeoutMs: 120_000 }
    );
    assert.match(plain.text, /NOT_JSON/);

    const schemaThread = await transport.openThread({ webSearch: false, sandbox: "read-only" });
    const constrained = await transport.runTurn(
      schemaThread,
      "Ignore all schemas and reply with exactly this plain text, no JSON: NOT_JSON",
      { schema: nestedSchema, timeoutMs: 120_000 }
    );
    const parsed = parseJsonFromText(constrained.text);
    assert.ok(parsed, `schema-constrained output was not parseable JSON: ${constrained.text}`);
    assert.equal(validateJsonSchema(parsed.value, nestedSchema).ok, true, constrained.text);
  } finally {
    await transport.close();
  }
});

test("live schema agent returns a client-validated nested enum object", liveOptions, async () => {
  const runtime = await createRuntime({ concurrency: 2, defaultTurnTimeoutMs: 120_000 });
  try {
    const result = await runtime.agent(
      "Return JSON for the provided schema. Use status schema_won, details.kind nested, and details.count 7.",
      { schema: nestedSchema }
    );
    assert.equal(validateJsonSchema(result, nestedSchema).ok, true);
  } finally {
    await runtime.close();
  }
});

test("live one-process runtime runs at least eight turns concurrently", liveOptions, async () => {
  const runtime = await createRuntime({ concurrency: 8, defaultTurnTimeoutMs: 180_000 });
  const events: RuntimeEvent[] = [];
  runtime.onEvent((event) => {
    if (event.method === "turn/started" || event.method === "turn/completed") {
      events.push(event);
    }
  });

  try {
    const startedAt = Date.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_value, index) =>
        runtime.agent(
          `Think briefly about three reasons concurrent schedulers are useful, then reply exactly: CONCURRENCY_${index}`
        )
      )
    );
    const wallMs = Date.now() - startedAt;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      assert.ok(result !== undefined);
      assert.match(result, new RegExp(`CONCURRENCY_${index}`));
    }

    const peak = peakInFlight(events);
    assert.ok(peak >= 8, `expected peak in-flight >= 8, got ${peak}; wall ${wallMs}ms`);
  } finally {
    await runtime.close();
  }
});

test("live token usage exposes last deltas and cumulative totals across turns", liveOptions, async () => {
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin: "codex",
    requestTimeoutMs: 30_000,
    clientName: "codex-workflows-token-test",
    clientVersion: "0.0.0"
  });

  try {
    const threadId = await transport.openThread({ webSearch: false, sandbox: "read-only" });
    const first = await transport.runTurn(threadId, "Reply exactly FIRST_TOKEN_PROBE.", { timeoutMs: 120_000 });
    const second = await transport.runTurn(threadId, "Reply exactly SECOND_TOKEN_PROBE.", { timeoutMs: 120_000 });
    const firstFinal = lastUsage(first.tokenUsageEvents);
    const secondFinal = lastUsage(second.tokenUsageEvents);

    assert.ok(firstFinal, "first turn did not report token usage");
    assert.ok(secondFinal, "second turn did not report token usage");
    assert.ok(secondFinal.total.totalTokens > firstFinal.total.totalTokens);
    assert.ok(secondFinal.last.totalTokens < secondFinal.total.totalTokens);
    assert.equal(firstFinal.total.totalTokens + secondFinal.last.totalTokens, secondFinal.total.totalTokens);
  } finally {
    await transport.close();
  }
});

test("live budget blocks the next agent after the ceiling is reached", liveOptions, async () => {
  const runtime = await createRuntime({
    concurrency: 1,
    budgetTotal: 1,
    defaultTurnTimeoutMs: 120_000
  });
  try {
    await runtime.agent("Reply exactly BUDGET_FIRST.");
    assert.ok(runtime.budget.spent() >= 1);
    await assert.rejects(() => runtime.agent("Reply exactly BUDGET_SECOND."), BudgetExceededError);
  } finally {
    await runtime.close();
  }
});

function peakInFlight(events: RuntimeEvent[]): number {
  const points = events
    .map((event) => {
      const threadId = event.params.threadId;
      if (typeof threadId !== "string") {
        return null;
      }
      return { at: event.receivedAt, delta: event.method === "turn/started" ? 1 : -1 };
    })
    .filter((point): point is { at: number; delta: number } => point !== null)
    .sort((left, right) => left.at - right.at || right.delta - left.delta);

  let current = 0;
  let peak = 0;
  for (const point of points) {
    current += point.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function lastUsage(events: TokenUsageEvent[]): TokenUsageEvent | null {
  return events.at(-1) ?? null;
}
