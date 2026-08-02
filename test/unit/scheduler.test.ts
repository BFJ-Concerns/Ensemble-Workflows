import assert from "node:assert/strict";
import test from "node:test";

import { EngineShutdownError } from "../../src/errors.js";
import { Scheduler } from "../../src/scheduler.js";

test("close rejects queued tasks, spares active ones, and refuses new work", async () => {
  const scheduler = new Scheduler(1);
  const activeGate = deferred<string>();
  let queuedRan = false;

  const active = scheduler.schedule(() => activeGate.promise);
  const queued = scheduler.schedule(async () => {
    queuedRan = true;
    return "queued";
  });
  assert.equal(scheduler.active(), 1);
  assert.equal(scheduler.queued(), 1);

  scheduler.close(new EngineShutdownError("codex"));

  await assert.rejects(queued, EngineShutdownError);
  assert.equal(queuedRan, false);
  assert.equal(scheduler.queued(), 0);

  // The active task is the adapter's to cancel; the scheduler leaves it be.
  activeGate.resolve("done");
  assert.equal(await active, "done");

  await assert.rejects(scheduler.schedule(async () => "late"), EngineShutdownError);
});

test("close is idempotent and keeps the first rejection", async () => {
  const scheduler = new Scheduler(1);
  const first = new EngineShutdownError("claude");
  scheduler.close(first);
  scheduler.close(new EngineShutdownError("opencode"));

  await assert.rejects(
    scheduler.schedule(async () => undefined),
    (error: unknown) => error === first
  );
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
