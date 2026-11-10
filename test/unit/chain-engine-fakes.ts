import assert from "node:assert/strict";

import { Scheduler } from "../../src/scheduler.js";

import type { EngineAdapter, EngineAttemptResult, EngineInvocation, EngineTurnOptions } from "../../src/engines.js";
import type { EngineName } from "../../src/types.js";

// Scripted engines for the fallback-chain tests. The runtime tests read the
// dispatch log to see *which target answered*; the CLI tests read the notices
// the same scripted turns produce on stderr.

/**
 * One scripted engine: each attempt consumes the next step in dispatch order,
 * so a chain's targets on one engine share the script. The cap is the
 * adapter's own — the runtime reads an injected adapter's `concurrency`, never
 * the `concurrencyCaps` option, which only shapes the default registry — so a
 * test that wants a cap of one says so here.
 */
export class ChainEngine implements EngineAdapter {
  readonly concurrency: number;
  readonly dispatches: Array<{ model: string | undefined; effort: string | undefined; prompt: string }> = [];
  readonly scheduler: Scheduler;
  #steps: Array<() => Promise<EngineAttemptResult>>;

  constructor(
    readonly name: EngineName,
    steps: Array<() => Promise<EngineAttemptResult>>,
    concurrency = 4
  ) {
    this.#steps = [...steps];
    this.concurrency = concurrency;
    this.scheduler = new Scheduler(concurrency);
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule(task);
  }

  createInvocation(prompt: string, options: EngineTurnOptions): EngineInvocation {
    this.dispatches.push({ model: options.model, effort: options.effort, prompt });
    return {
      runAttempt: async () => {
        const step = this.#steps.shift();
        assert.ok(step, `${this.name} engine ran out of scripted steps`);
        return step();
      }
    };
  }

  async close(): Promise<void> {}
}

/**
 * A Claude API refusal as the engine returns it: a failed turn carrying the
 * status and code the classifier reads as availability.
 */
export function claudeRefusal(
  status: number,
  code: string | null,
  message = `API Error: Request rejected (${status})`
): () => Promise<EngineAttemptResult> {
  return async () => ({
    text: "",
    deltaText: "",
    durationMs: 10,
    firstDeltaMs: 5,
    items: {},
    tokenUsageEvents: [],
    attemptFailure: { kind: "claude-worker-diagnostic", message },
    diagnostics: { apiError: { status, code } }
  });
}
