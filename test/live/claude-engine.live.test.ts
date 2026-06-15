import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeCliControlPlane } from "../../src/claude-control-plane.js";
import { ClaudeEngineAdapter, EngineRegistry } from "../../src/engines.js";
import { validateJsonSchema } from "../../src/schema.js";
import { EnsembleRuntime } from "../../src/runtime.js";

const isLive = process.env.ENSEMBLE_LIVE === "1";

// One real journey: a `claude --bg` worker, dispatched and polled to done, its
// answer read from the JSONL transcript and validated client-side. Gated and
// kept minimal — each background session draws the Claude subscription
// allowance. The session is stopped/removed by the shared loop's close() in
// finally, so the test leaves no worker behind.
const liveSchema = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: {
    token: { type: "string", enum: ["LIVE_CLAUDE_OK"] }
  }
};

test(
  "live Claude background worker returns a client-validated object",
  { skip: !isLive, timeout: 300_000 },
  async () => {
    // A Claude-only runtime — no Codex app-server is spawned for this journey.
    let runtime: EnsembleRuntime | null = null;
    const adapter = new ClaudeEngineAdapter({
      cwd: process.cwd(),
      controlPlane: new ClaudeCliControlPlane(),
      onEvent: (event) => runtime?.handleEngineEvent(event)
    });
    runtime = new EnsembleRuntime({
      engines: new EngineRegistry([adapter]),
      budgetTotal: null,
      defaultTurnTimeoutMs: 240_000,
      defaultMaxAttempts: 2
    });

    try {
      const result = await runtime.agent(
        "Return JSON conforming to the provided schema, with token set to exactly LIVE_CLAUDE_OK.",
        { engine: "claude", schema: liveSchema }
      );

      assert.ok(result !== null, "expected a validated object, got null after retries");
      assert.equal(validateJsonSchema(result, liveSchema).ok, true);
      // Best-effort transcript-derived usage fed the shared budget.
      assert.ok(runtime.budget.spent() > 0, "expected Claude worker tokens to feed the budget");
    } finally {
      await runtime.close();
    }
  }
);
