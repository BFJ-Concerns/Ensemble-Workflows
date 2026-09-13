import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngineRegistry } from "../../src/engines.js";
import { EngineShutdownError } from "../../src/errors.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { Scheduler } from "../../src/scheduler.js";
import { runWorkflowScript } from "../../src/script-runner.js";

import type {
  EngineAdapter,
  EngineAttemptContext,
  EngineInvocation,
} from "../../src/engines.js";
import type { EngineName, JsonSchema, TurnResult } from "../../src/types.js";

test(
  "agent ceiling admits atomically, skips an ineligible waiter, and does not starve another engine",
  { timeout: 5_000 },
  async () => {
    const codex = new ControlledEngine("codex", 1);
    const claude = new ControlledEngine("claude", 1);
    const opencode = new ControlledEngine("opencode", 1);
    const runtime = runtimeWithCeiling([codex, claude, opencode], 2);
    const calls: Array<Promise<unknown>> = [];

    try {
      calls.push(runtime.agent("codex-active", { engine: "codex" }));
      await codex.waitForStarts(1);

      // This is the longest-waiting queued call. Its engine cap is occupied,
      // so it must not reserve a ceiling slot while it waits.
      calls.push(runtime.agent("codex-ineligible", { engine: "codex" }));
      calls.push(runtime.agent("cross-engine-verifier", { engine: "claude" }));
      await claude.waitForStarts(1);

      calls.push(runtime.agent("eligible-behind-codex", { engine: "opencode" }));
      await drainMicrotasks();

      assert.deepEqual(runtime.progress.snapshot().totals, {
        active: 2,
        queued: 2,
        done: 0,
        failed: 0,
      });
      assert.deepEqual(codex.startedPrompts, ["codex-active"]);
      assert.deepEqual(claude.startedPrompts, ["cross-engine-verifier"]);
      assert.deepEqual(opencode.startedPrompts, []);

      claude.release("cross-engine-verifier");
      await opencode.waitForStarts(1);
      assert.deepEqual(opencode.startedPrompts, ["eligible-behind-codex"]);
      assert.deepEqual(codex.startedPrompts, ["codex-active"]);

      opencode.release("eligible-behind-codex");
      codex.release("codex-active");
      await codex.waitForStarts(2);
      assert.deepEqual(codex.startedPrompts, ["codex-active", "codex-ineligible"]);
      codex.release("codex-ineligible");

      await Promise.all(calls);
    } finally {
      await runtime.close();
      await Promise.allSettled(calls);
    }
  },
);

test(
  "one ceiling slot spans every retry in a logical agent call",
  { timeout: 5_000 },
  async () => {
    const retrying = new RetryingEngine();
    const verifier = new ControlledEngine("claude", 1);
    const runtime = runtimeWithCeiling([retrying, verifier], 1);
    const schema: JsonSchema = {
      type: "object",
      required: ["answer"],
      additionalProperties: false,
      properties: {
        answer: { type: "string", enum: ["accepted"] },
      },
    };
    const retryCall = runtime.agent("retrying-worker", {
      engine: "codex",
      schema,
      maxAttempts: 2,
    });
    let verifierCall: Promise<string | null> | undefined;

    try {
      await retrying.secondAttemptStarted;
      verifierCall = runtime.agent("verifier", { engine: "claude" });
      await drainMicrotasks();

      assert.deepEqual(retrying.attempts, [1, 2]);
      assert.deepEqual(runtime.progress.snapshot().totals, {
        active: 1,
        queued: 1,
        done: 0,
        failed: 0,
      });
      assert.deepEqual(verifier.startedPrompts, []);

      retrying.releaseSecondAttempt();
      assert.deepEqual(await retryCall, { answer: "accepted" });
      await verifier.waitForStarts(1);
      verifier.release("verifier");
      assert.equal(await verifierCall, "claude:verifier");
    } finally {
      retrying.releaseSecondAttempt();
      await runtime.close();
      await Promise.allSettled([retryCall, ...(verifierCall === undefined ? [] : [verifierCall])]);
    }
  },
);

test(
  "a failed logical call releases its ceiling slot to a queued engine",
  { timeout: 5_000 },
  async () => {
    const failing = new ControlledEngine("codex", 1);
    const successor = new ControlledEngine("claude", 1);
    const runtime = runtimeWithCeiling([failing, successor], 1);
    const failedCall = runtime.agent("fail-after-admission", { engine: "codex" });
    let successorCall: Promise<string | null> | undefined;

    try {
      await failing.waitForStarts(1);
      successorCall = runtime.agent("successor", { engine: "claude" });
      await drainMicrotasks();

      assert.deepEqual(runtime.progress.snapshot().totals, {
        active: 1,
        queued: 1,
        done: 0,
        failed: 0,
      });
      assert.deepEqual(successor.startedPrompts, []);

      failing.reject("fail-after-admission", new Error("ESTATE_CONTROLLED_FAILURE"));
      // The dispatched worker's failure is the call's value; the slot
      // it held is what the successor below observes released.
      assert.equal(await failedCall, null);
      await successor.waitForStarts(1);
      successor.release("successor");
      assert.equal(await successorCall, "claude:successor");
    } finally {
      failing.releaseAll();
      successor.releaseAll();
      await runtime.close();
      await Promise.allSettled([failedCall, ...(successorCall === undefined ? [] : [successorCall])]);
    }
  },
);

test(
  "two concurrent runtimes enforce their ceilings independently",
  { timeout: 5_000 },
  async () => {
    const firstEngine = new ControlledEngine("codex", 1);
    const secondEngine = new ControlledEngine("codex", 1);
    const firstRuntime = runtimeWithCeiling([firstEngine], 1);
    const secondRuntime = runtimeWithCeiling([secondEngine], 1);
    const first = firstRuntime.agent("first-run", { engine: "codex" });
    const second = secondRuntime.agent("second-run", { engine: "codex" });

    try {
      await Promise.all([firstEngine.waitForStarts(1), secondEngine.waitForStarts(1)]);
      assert.deepEqual(firstRuntime.progress.snapshot().totals, {
        active: 1,
        queued: 0,
        done: 0,
        failed: 0,
      });
      assert.deepEqual(secondRuntime.progress.snapshot().totals, {
        active: 1,
        queued: 0,
        done: 0,
        failed: 0,
      });

      firstEngine.release("first-run");
      secondEngine.release("second-run");
      assert.deepEqual(await Promise.all([first, second]), ["codex:first-run", "codex:second-run"]);
    } finally {
      await Promise.all([firstRuntime.close(), secondRuntime.close()]);
      await Promise.allSettled([first, second]);
    }
  },
);

test(
  "a composed child workflow draws on its parent runtime ceiling",
  { timeout: 5_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-ceiling-child-estate-"));
    const childPath = path.join(directory, "child.js");
    const parentPath = path.join(directory, "parent.js");
    const codex = new ControlledEngine("codex", 1);
    const claude = new ControlledEngine("claude", 1);
    const runtime = runtimeWithCeiling([codex, claude], 1);
    await writeFile(
      childPath,
      `
        export const meta = { name: "ceiling-child" };
        return await agent("child-worker", { engine: "claude" });
      `,
    );
    const parentRun = runWorkflowScript({
      source: `
        export const meta = { name: "ceiling-parent" };
        return await parallel([
          () => agent("parent-worker", { engine: "codex" }),
          () => workflow({ scriptPath: args.child })
        ]);
      `,
      filename: parentPath,
      cwd: directory,
      runtime,
      args: { child: childPath },
      log: () => {},
    });

    try {
      await codex.waitForStarts(1);
      await waitForProgress(runtime, (active, queued) => active === 1 && queued === 1);
      await drainMicrotasks();

      assert.deepEqual(runtime.progress.snapshot().totals, {
        active: 1,
        queued: 1,
        done: 0,
        failed: 0,
      });
      assert.deepEqual(claude.startedPrompts, []);

      codex.release("parent-worker");
      await claude.waitForStarts(1);
      claude.release("child-worker");
      assert.deepEqual((await parentRun).result, ["codex:parent-worker", "claude:child-worker"]);
    } finally {
      codex.releaseAll();
      claude.releaseAll();
      await runtime.close();
      await Promise.allSettled([parentRun]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "runtime close settles admitted and queued ceiling calls without leaking a slot",
  { timeout: 5_000 },
  async () => {
    const codex = new ControlledEngine("codex", 1);
    const claude = new ControlledEngine("claude", 1);
    const runtime = runtimeWithCeiling([codex, claude], 1);
    const admitted = runtime.agent("interrupted-active", { engine: "codex" });
    const queued = runtime.agent("interrupted-queued", { engine: "claude" });

    await codex.waitForStarts(1);
    await runtime.close();
    const settlements = await Promise.allSettled([admitted, queued]);

    // Shutdown cancels rather than dispatches: the admitted worker settles
    // through its engine's own close, and the queued one rejects without
    // ever taking a slot — the ceiling is never exceeded during close.
    assert.equal(settlements[0]?.status, "fulfilled");
    assert.equal(settlements[1]?.status, "rejected");
    assert.ok(
      settlements[1]?.status === "rejected" && settlements[1].reason instanceof EngineShutdownError
    );
    const totals = runtime.progress.snapshot().totals;
    assert.equal(totals.active, 0);
    assert.equal(totals.queued, 0);
    assert.equal(totals.done, 1);
  },
);

function runtimeWithCeiling(engines: EngineAdapter[], agentCeiling: number): EnsembleRuntime {
  const ambientOptions = { agentCeiling } as Record<string, unknown>;
  return new EnsembleRuntime({
    engines: new EngineRegistry(engines),
    defaultMaxAttempts: 1,
    ...ambientOptions,
  });
}

class ControlledEngine implements EngineAdapter {
  readonly startedPrompts: string[] = [];
  readonly concurrency: number;

  #scheduler: Scheduler;
  #gates = new Map<string, Deferred<TurnResult>>();
  #startWaiters: Array<{ count: number; resolve: () => void }> = [];
  #closed = false;

  constructor(
    readonly name: EngineName,
    concurrency: number,
  ) {
    this.concurrency = concurrency;
    this.#scheduler = new Scheduler(concurrency);
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(task);
  }

  createInvocation(prompt: string): EngineInvocation {
    return {
      runAttempt: async () => {
        if (this.#closed) {
          return turn(`${this.name}:${prompt}`);
        }
        const gate = deferred<TurnResult>();
        this.#gates.set(prompt, gate);
        this.startedPrompts.push(prompt);
        this.#notifyStarts();
        return gate.promise;
      },
    };
  }

  waitForStarts(count: number): Promise<void> {
    if (this.startedPrompts.length >= count) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#startWaiters.push({ count, resolve });
    });
  }

  release(prompt: string): void {
    this.#gates.get(prompt)?.resolve(turn(`${this.name}:${prompt}`));
    this.#gates.delete(prompt);
  }

  reject(prompt: string, error: Error): void {
    this.#gates.get(prompt)?.reject(error);
    this.#gates.delete(prompt);
  }

  releaseAll(): void {
    for (const [prompt, gate] of this.#gates) {
      gate.resolve(turn(`${this.name}:${prompt}`));
    }
    this.#gates.clear();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.releaseAll();
  }

  #notifyStarts(): void {
    const ready = this.#startWaiters.filter((waiter) => this.startedPrompts.length >= waiter.count);
    this.#startWaiters = this.#startWaiters.filter((waiter) => this.startedPrompts.length < waiter.count);
    for (const waiter of ready) {
      waiter.resolve();
    }
  }
}

class RetryingEngine implements EngineAdapter {
  readonly name = "codex" satisfies EngineName;
  readonly concurrency = 1;
  readonly attempts: number[] = [];
  readonly secondAttemptStarted: Promise<void>;

  #scheduler = new Scheduler(1);
  #secondAttemptGate = deferred<TurnResult>();
  #notifySecondAttempt: () => void;

  constructor() {
    const started = deferred<void>();
    this.secondAttemptStarted = started.promise;
    this.#notifySecondAttempt = () => started.resolve();
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(task);
  }

  createInvocation(): EngineInvocation {
    return {
      runAttempt: async (context: EngineAttemptContext) => {
        this.attempts.push(context.attempt);
        if (context.attempt === 1) {
          return turn("not-json");
        }
        this.#notifySecondAttempt();
        return this.#secondAttemptGate.promise;
      },
    };
  }

  releaseSecondAttempt(): void {
    this.#secondAttemptGate.resolve(turn('{"answer":"accepted"}'));
  }

  async close(): Promise<void> {
    this.releaseSecondAttempt();
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function waitForProgress(
  runtime: EnsembleRuntime,
  predicate: (active: number, queued: number) => boolean,
): Promise<void> {
  const initial = runtime.progress.snapshot().totals;
  if (predicate(initial.active, initial.queued)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const unsubscribe = runtime.progress.onChange(() => {
      const totals = runtime.progress.snapshot().totals;
      if (predicate(totals.active, totals.queued)) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function turn(text: string): TurnResult {
  return {
    text,
    deltaText: text,
    durationMs: 0,
    firstDeltaMs: 0,
    items: {},
    tokenUsageEvents: [],
  };
}
