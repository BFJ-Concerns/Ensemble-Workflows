import assert from "node:assert/strict";
import test from "node:test";

import { AdmissionController } from "../../src/admission.js";
import { EngineShutdownError } from "../../src/errors.js";

import type { AdmissionEvent } from "../../src/admission.js";
import type { EngineName } from "../../src/types.js";

test("admission acquires both counters atomically and skips an ineligible waiter", async () => {
  const events: AdmissionEvent[] = [];
  const controller = new AdmissionController({
    ceiling: 2,
    caps: caps({ codex: 1, claude: 1, opencode: 1 }),
    onAdmission: (event) => events.push(event)
  });
  const codexGate = deferred<void>();
  const claudeGate = deferred<void>();
  const opencodeGate = deferred<void>();

  const codexActive = controller.admit("codex", 1, () => codexGate.promise);
  const codexWaiting = controller.admit("codex", 2, async () => undefined);
  const claude = controller.admit("claude", 3, () => claudeGate.promise);
  const opencode = controller.admit("opencode", 4, () => opencodeGate.promise);
  await drainMicrotasks();

  assert.deepEqual(
    events.filter((event) => event.kind === "admitted").map((event) => event.agentId),
    [1, 3]
  );
  assert.ok(
    events.some(
      (event) => event.kind === "skipped" && event.agentId === 2 && event.reason === "engine-cap"
    )
  );
  for (const event of events.filter((candidate) => candidate.kind === "queued")) {
    assert.equal(
      events.some(
        (candidate) =>
          candidate.agentId === event.agentId &&
          candidate.seq <= event.seq &&
          candidate.kind === "admitted"
      ),
      false
    );
  }
  for (const event of events.filter((candidate) => candidate.kind === "admitted")) {
    assert.ok(event.ceilingHeld >= 1);
    assert.ok(event.engineHeld >= 1);
  }

  claudeGate.resolve(undefined);
  await admitted(events, 4);
  opencodeGate.resolve(undefined);
  codexGate.resolve(undefined);
  await admitted(events, 2);
  await Promise.all([codexActive, codexWaiting, claude, opencode]);
  assert.deepEqual(controller.snapshot(), {
    ceilingActive: 0,
    engineActive: new Map([
      ["codex", 0],
      ["claude", 0],
      ["opencode", 0]
    ]),
    waiting: 0
  });
});

test("the oldest eligible worker is admitted on the first ceiling release", async () => {
  const events: AdmissionEvent[] = [];
  const controller = new AdmissionController({
    ceiling: 2,
    caps: caps({ codex: 4, claude: 4 }),
    onAdmission: (event) => events.push(event)
  });
  const gates = Array.from({ length: 8 }, () => deferred<void>());
  const codex = gates.map((gate, index) => controller.admit("codex", index + 1, () => gate.promise));
  const verifierGate = deferred<void>();
  const verifier = controller.admit("claude", 9, () => verifierGate.promise);
  await drainMicrotasks();

  gates[0]?.resolve(undefined);
  await codex[0];
  await drainMicrotasks();
  await admitted(events, 3);
  assert.deepEqual(
    events.filter((event) => event.kind === "admitted").slice(0, 3).map((event) => event.agentId),
    [1, 2, 3]
  );

  for (const gate of gates) {
    gate.resolve(undefined);
  }
  verifierGate.resolve(undefined);
  await Promise.all([...codex, verifier]);
});

test("null and thrown failures release a slot to the next waiter", async () => {
  const events: AdmissionEvent[] = [];
  const controller = new AdmissionController({
    ceiling: 1,
    caps: caps({ codex: 1, claude: 1, opencode: 1 }),
    onAdmission: (event) => events.push(event)
  });

  const nullCall = controller.admit("codex", 1, async () => null);
  const thrownCall = controller.admit("claude", 2, async () => {
    throw new Error("controlled");
  });
  const successor = controller.admit("opencode", 3, async () => "done");

  assert.equal(await nullCall, null);
  await assert.rejects(thrownCall, /controlled/);
  assert.equal(await successor, "done");
  await drainMicrotasks();
  assert.deepEqual(
    events.filter((event) => event.kind === "released").map((event) => event.agentId),
    [1, 2, 3]
  );
});

test("close rejects waiting calls without acquiring their slots", async () => {
  const events: AdmissionEvent[] = [];
  const activeGate = deferred<void>();
  const controller = new AdmissionController({
    ceiling: 1,
    caps: caps({ codex: 1, claude: 1 }),
    onAdmission: (event) => events.push(event)
  });
  const active = controller.admit("codex", 1, () => activeGate.promise);
  const waiting = controller.admit("claude", 2, async () => undefined);
  const sameEngineWaiting = controller.admit("codex", 3, async () => undefined);
  await drainMicrotasks();

  controller.close();
  // Shutdown is a cancellation, not a dispatch: the queued entries reject
  // and the ceiling never exceeds its limit — only the already-admitted
  // worker holds a slot until it settles. The rejected claude entry never
  // acquired a counter, so its engine never appears in the snapshot.
  assert.deepEqual(controller.snapshot(), {
    ceilingActive: 1,
    engineActive: new Map([["codex", 1]]),
    waiting: 0
  });
  await assert.rejects(waiting, EngineShutdownError);
  await assert.rejects(sameEngineWaiting, EngineShutdownError);

  activeGate.resolve(undefined);
  await active;
  await drainMicrotasks();

  assert.equal(events.filter((event) => event.kind === "admitted").length, 1);
  assert.equal(events.filter((event) => event.kind === "released").length, 1);
  assert.deepEqual(controller.snapshot(), {
    ceilingActive: 0,
    engineActive: new Map([["codex", 0]]),
    waiting: 0
  });
});

test("skip events identify engine-cap arbitration without quadratic repeats", async () => {
  const events: AdmissionEvent[] = [];
  const activeGate = deferred<void>();
  const controller = new AdmissionController({
    ceiling: 2,
    caps: caps({ codex: 1, claude: 1 }),
    onAdmission: (event) => events.push(event)
  });
  const active = controller.admit("codex", 1, () => activeGate.promise);
  const waiting = Array.from({ length: 200 }, (_, index) =>
    controller.admit("codex", index + 2, async () => undefined)
  );
  await drainMicrotasks();

  assert.equal(events.filter((event) => event.kind === "skipped").length, 0);

  const verifier = controller.admit("claude", 202, async () => undefined);
  await verifier;
  const skipped = events.filter((event) => event.kind === "skipped");
  assert.equal(skipped.length, 200);
  assert.ok(skipped.every((event) => event.reason === "engine-cap"));

  activeGate.resolve(undefined);
  await Promise.all([active, ...waiting]);
  assert.equal(events.filter((event) => event.kind === "skipped").length, 200);
});

test("routine ceiling saturation does not emit an anti-starvation skip", async () => {
  const events: AdmissionEvent[] = [];
  const activeGate = deferred<void>();
  const controller = new AdmissionController({
    ceiling: 1,
    caps: caps({ codex: 2, claude: 2 }),
    onAdmission: (event) => events.push(event)
  });
  const active = controller.admit("codex", 1, () => activeGate.promise);
  const waiting = controller.admit("claude", 2, async () => undefined);
  await drainMicrotasks();

  assert.equal(events.filter((event) => event.kind === "skipped").length, 0);

  activeGate.resolve(undefined);
  await Promise.all([active, waiting]);
  assert.equal(events.filter((event) => event.kind === "skipped").length, 0);
});

function caps(values: Partial<Record<EngineName, number>>): ReadonlyMap<EngineName, number> {
  return new Map(Object.entries(values) as Array<[EngineName, number]>);
}

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

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function admitted(events: AdmissionEvent[], agentId: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (events.some((event) => event.kind === "admitted" && event.agentId === agentId)) {
      return;
    }
    await Promise.resolve();
  }
  assert.fail(`agent ${agentId} was not admitted`);
}
