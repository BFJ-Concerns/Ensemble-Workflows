import assert from "node:assert/strict";
import test from "node:test";

import { EngineShutdownError } from "../../src/errors.js";
import { Scheduler } from "../../src/scheduler.js";

test("scheduler close rejects queued tasks without disturbing active work", async () => {
  const scheduler = new Scheduler(1);
  const activeGate = deferred<void>();
  let queuedStarted = false;
  const active = scheduler.schedule(async () => {
    await activeGate.promise;
    return "active-complete";
  });
  const queued = scheduler.schedule(async () => {
    queuedStarted = true;
    return "queued-complete";
  });
  const shutdown = new EngineShutdownError("claude");

  scheduler.close(shutdown);

  await assert.rejects(queued, (error: unknown) => error === shutdown);
  assert.equal(queuedStarted, false);
  assert.equal(scheduler.active(), 1);
  activeGate.resolve(undefined);
  assert.equal(await active, "active-complete");
});

test("scheduler rejects calls made after close with the original shutdown error", async () => {
  const scheduler = new Scheduler(1);
  const shutdown = new EngineShutdownError("opencode");
  scheduler.close(shutdown);

  await assert.rejects(
    scheduler.schedule(async () => "never"),
    (error: unknown) => error === shutdown
  );
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
