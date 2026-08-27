import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerTransport, LazyCodexAppServerTransport, appServerErrorFromPayload } from "../../src/app-server.js";
import { createDefaultEngineRegistry } from "../../src/engines.js";
import { createRuntime } from "../../src/runtime.js";
import type { RunRecordWriter, RuntimeAgentRecord } from "../../src/run-record.js";
import {
  AppServerBackpressureError,
  AppServerExitedError,
  AppServerFirstOutputTimeoutError,
  AppServerRetryPromiseBrokenError,
  AppServerStartupTimeoutError,
  CodexSchemaSubsetUnsupportedError,
  TurnTimeoutError,
  appServerDiagnosticOf,
  partialWorkerTextOf,
  workerExitStatusOf
} from "../../src/errors.js";

test("default engine registry performs no Codex I/O at construction or unused close", async () => {
  // The binary does not exist; construction and close must not care.
  const codexBin = path.join(tmpdir(), "ensemble-no-such-codex-bin-lazy");
  const registry = await createDefaultEngineRegistry(defaultRegistryOptions(codexBin));

  assert.deepEqual(registry.names(), ["codex", "claude", "opencode"]);
  await registry.close();
});

test("a missing Codex binary fails the first use and the failure is memoised", async () => {
  const codexBin = path.join(tmpdir(), "ensemble-no-such-codex-bin-lazy");
  const registry = await createDefaultEngineRegistry(defaultRegistryOptions(codexBin));
  const codex = registry.get("codex");
  assert.ok(codex);
  const invocation = codex.createInvocation("hello", {});

  let firstError: unknown;
  try {
    await invocation.runAttempt({ attempt: 1 });
    assert.fail("first Codex use should fail when its binary is missing");
  } catch (error) {
    firstError = error;
  }
  assert.ok(firstError instanceof AppServerExitedError);
  assert.match(firstError.message, /ENOENT/);

  // The same startup failure, not a fresh spawn attempt with a new error.
  let secondError: unknown;
  try {
    await invocation.runAttempt({ attempt: 2 });
    assert.fail("second Codex use should reuse the memoised startup failure");
  } catch (error) {
    secondError = error;
  }
  assert.strictEqual(secondError, firstError);
  await registry.close();
});

test("lazy Codex transport spawns once even after a startup failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-lazy-codex-fail-"));
  const capturePath = path.join(directory, "starts.txt");
  const codexBin = await fakeCodexExitingServer(capturePath);
  const transport = new LazyCodexAppServerTransport(defaultTransportOptions(codexBin));

  let firstError: unknown;
  try {
    await transport.openThread({});
  } catch (error) {
    firstError = error;
  }
  assert.ok(firstError instanceof AppServerExitedError);

  await assert.rejects(
    () => transport.openThread({}),
    (error: unknown) => error === firstError
  );
  assert.equal((await readFile(capturePath, "utf8")).trim().split("\n").length, 1);
  await transport.close();
});

test("concurrent first Codex uses share a single app-server handshake", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-lazy-codex-"));
  const capturePath = path.join(directory, "methods.txt");
  const codexBin = await fakeCodexTurnServer({ capturePath });
  const transport = new LazyCodexAppServerTransport(defaultTransportOptions(codexBin));

  try {
    const threadIds = await Promise.all([transport.openThread({}), transport.openThread({})]);
    assert.equal(new Set(threadIds).size, 2);
    const methods = (await readFile(capturePath, "utf8")).trim().split("\n");
    assert.equal(methods.filter((method) => method === "initialize").length, 1);
  } finally {
    await transport.close();
  }
});

test("every failing terminal path carries the worker's partial text", async () => {
  // One fake per path: each streams a delta and then ends the turn a
  // different way. The invariant is unconditional, so every rejection must
  // carry the streamed text — a path that loses it is the regression.
  const paths = [
    { name: "error notification", mode: "error-notification" },
    { name: "systemError status", mode: "system-error" },
    { name: "process exit mid-turn", mode: "exit-mid-turn" }
  ] as const;

  for (const terminal of paths) {
    const codexBin = await fakeCodexFailingTurnServer(terminal.mode);
    const transport = await CodexAppServerTransport.start(defaultTransportOptions(codexBin));
    try {
      const threadId = await transport.openThread({});
      await assert.rejects(
        () => transport.runTurn(threadId, "stream then die", {}),
        (error: unknown) => {
          assert.equal(
            partialWorkerTextOf(error),
            "nine tenths of an answer",
            `${terminal.name} lost the worker's partial text`
          );
          return true;
        }
      );
    } finally {
      await transport.close();
    }
  }
});

test("a turn ended by process death carries how the process died", async () => {
  // The evidence sibling to the partial-text carrier: an exit-terminalised
  // turn records the exit status or signal, so a killed leg is
  // distinguishable from one that returned nothing.
  const codexBin = await fakeCodexFailingTurnServer("exit-mid-turn");
  const transport = await CodexAppServerTransport.start(defaultTransportOptions(codexBin));
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(
      () => transport.runTurn(threadId, "stream then die", {}),
      (error: unknown) => {
        assert.deepEqual(workerExitStatusOf(error), { exitCode: 7, signal: null });
        // Both carriers ride the same rejection; neither displaces the other.
        assert.equal(partialWorkerTextOf(error), "nine tenths of an answer");
        return true;
      }
    );
  } finally {
    await transport.close();
  }
});

test("a turn that fails without a process death carries no exit status", async () => {
  // The carrier reports only observed process deaths: an in-band error
  // notification ends the turn while the server lives, so inventing an exit
  // would misattribute the failure.
  const codexBin = await fakeCodexFailingTurnServer("error-notification");
  const transport = await CodexAppServerTransport.start(defaultTransportOptions(codexBin));
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(
      () => transport.runTurn(threadId, "stream then fail in-band", {}),
      (error: unknown) => {
        assert.equal(workerExitStatusOf(error), null);
        return true;
      }
    );
  } finally {
    await transport.close();
  }
});

test("Codex terminal paths retain observed diagnostics and leave an ordinary timeout null", async () => {
  const paths = [
    {
      mode: "turn-start-error",
      options: {},
      expected: { code: -32001, message: "request cause", payload: /request payload/ }
    },
    {
      mode: "error-notification",
      options: {},
      expected: { code: null, message: "upstream fell over", payload: /upstream fell over/ }
    },
    {
      mode: "promise-then-silence",
      options: { retryPromiseSilenceTimeoutMs: 100 },
      expected: { code: "serverOverloaded", message: /stream disconnected/, payload: /serverOverloaded/ }
    }
  ] as const;

  for (const path of paths) {
    const codexBin = await fakeCodexFailingTurnServer(path.mode);
    const transport = await CodexAppServerTransport.start({ ...defaultTransportOptions(codexBin), ...path.options });
    try {
      const threadId = await transport.openThread({});
      await assert.rejects(
        () => transport.runTurn(threadId, "preserve the engine cause", {}),
        (error: unknown) => {
          const diagnostic = appServerDiagnosticOf(error);
          assert.ok(diagnostic, `${path.mode} should retain the observed diagnostic`);
          assert.equal(diagnostic.code, path.expected.code);
          if (typeof path.expected.message === "string") {
            assert.equal(diagnostic.message, path.expected.message);
          } else {
            assert.match(diagnostic.message, path.expected.message);
          }
          assert.match(diagnostic.payload, path.expected.payload);
          return true;
        }
      );
    } finally {
      await transport.close();
    }
  }

  const codexBin = await fakeCodexFailingTurnServer("hang-after-delta");
  const transport = await CodexAppServerTransport.start(defaultTransportOptions(codexBin));
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(
      () => transport.runTurn(threadId, "time out without an engine diagnostic", { timeoutMs: 100 }),
      (error: unknown) => {
        assert.ok(error instanceof TurnTimeoutError);
        assert.equal(appServerDiagnosticOf(error), null);
        return true;
      }
    );
  } finally {
    await transport.close();
  }
});

test("a declared codex worker environment reaches the app-server child, above inheritance", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-codex-worker-env-"));
  const envPath = path.join(directory, "observed-env.json");
  const bin = path.join(directory, "codex");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") {
  process.exit(2);
}
writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({
  base: process.env.OPENAI_BASE_URL ?? null,
  inherited: process.env.ENSEMBLE_TEST_INHERITED ?? null
}));
const reader = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
  }
});
`
  );
  await chmod(bin, 0o755);

  // Save-and-restore, not delete: a pre-existing value on the invoking
  // machine must survive this test for later tests in the process.
  const savedBase = process.env.OPENAI_BASE_URL;
  const savedInherited = process.env.ENSEMBLE_TEST_INHERITED;
  process.env.OPENAI_BASE_URL = "https://inherited.example";
  process.env.ENSEMBLE_TEST_INHERITED = "still-here";
  let transport: CodexAppServerTransport;
  try {
    transport = await CodexAppServerTransport.start({
      ...defaultTransportOptions(bin),
      workerEnv: { OPENAI_BASE_URL: "https://declared.example" }
    });
  } finally {
    restoreEnv("OPENAI_BASE_URL", savedBase);
    restoreEnv("ENSEMBLE_TEST_INHERITED", savedInherited);
  }
  try {
    const observed = JSON.parse(await readFile(envPath, "utf8")) as { base: string | null; inherited: string | null };
    assert.equal(observed.base, "https://declared.example");
    assert.equal(observed.inherited, "still-here");
  } finally {
    await transport.close();
  }
});

test("the default registry does not leak a Claude worker environment into Codex", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-registry-worker-env-scope-"));
  const envPath = path.join(directory, "codex-env.txt");
  const codexBin = await fakeCodexTurnServer({ envCapturePath: envPath });
  const savedScoped = process.env.ENSEMBLE_TEST_SCOPED;
  process.env.ENSEMBLE_TEST_SCOPED = "codex-inherited";
  const registry = await createDefaultEngineRegistry({
    ...defaultRegistryOptions(codexBin),
    workerEnvironment: { claude: { ENSEMBLE_TEST_SCOPED: "claude-declared" } }
  });

  try {
    const codex = registry.get("codex");
    assert.ok(codex);
    await codex.createInvocation("hello", {}).runAttempt({ attempt: 1 });
    assert.equal(await readFile(envPath, "utf8"), "codex-inherited");
  } finally {
    restoreEnv("ENSEMBLE_TEST_SCOPED", savedScoped);
    await registry.close();
  }
});

test("per-turn timeout carries the worker's partial text", async () => {
  const codexBin = await fakeCodexFailingTurnServer("hang-after-delta");
  const transport = await CodexAppServerTransport.start(defaultTransportOptions(codexBin));
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(
      () => transport.runTurn(threadId, "stream then hang", { timeoutMs: 300 }),
      (error: unknown) => {
        assert.ok(error instanceof TurnTimeoutError);
        assert.equal(partialWorkerTextOf(error), "nine tenths of an answer");
        return true;
      }
    );
  } finally {
    await transport.close();
  }
});

test("per-turn timeout is not deferred by ongoing MCP tool progress", { timeout: 1_000 }, async () => {
  // The tool keeps reporting progress past this deadline, while the worker
  // produces neither more text nor usage. This is deliberately distinct from
  // the idle-hang regression above: resetting or rearming the turn deadline
  // on side traffic would let this turn run indefinitely.
  const codexBin = await fakeCodexFailingTurnServer("tool-active-output-silent");
  const toolProgress: unknown[] = [];
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    onEvent: (event) => {
      if (event.method === "item/mcpToolCall/progress") {
        toolProgress.push(event);
      }
    }
  });
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(
      () => transport.runTurn(threadId, "remain silent while the tool works", { timeoutMs: 150 }),
      (error: unknown) => {
        assert.ok(error instanceof TurnTimeoutError);
        assert.equal(partialWorkerTextOf(error), "nine tenths of an answer");
        return true;
      }
    );
    assert.ok(toolProgress.length >= 2, "the tool must remain active across the output-silent deadline");
  } finally {
    await transport.close();
  }
});

test("transport close carries each live turn's own partial text", async () => {
  const codexBin = await fakeCodexFailingTurnServer("hang-after-delta");
  let deltaArrived: () => void = () => undefined;
  const deltaSeen = new Promise<void>((resolve) => {
    deltaArrived = resolve;
  });
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    onEvent: (event) => {
      if (event.method === "item/agentMessage/delta") {
        deltaArrived();
      }
    }
  });
  const threadId = await transport.openThread({});
  const turn = transport.runTurn(threadId, "stream then hang", {});
  // The rejection lands during close(), before assert.rejects attaches its
  // handler — pre-attach a no-op catch so it is never counted unhandled.
  turn.catch(() => undefined);
  await deltaSeen;
  await transport.close();
  await assert.rejects(
    () => turn,
    (error: unknown) => {
      assert.ok(error instanceof AppServerExitedError);
      assert.equal(partialWorkerTextOf(error), "nine tenths of an answer");
      return true;
    }
  );
});

test("a closed lazy transport refuses first use instead of spawning", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-lazy-codex-latch-"));
  const capturePath = path.join(directory, "starts.txt");
  const codexBin = await fakeCodexExitingServer(capturePath);
  const transport = new LazyCodexAppServerTransport(defaultTransportOptions(codexBin));

  await transport.close();
  await assert.rejects(() => transport.openThread({}), AppServerExitedError);
  // The latch means no spawn ever happened: nothing to leak after teardown.
  await assert.rejects(() => readFile(capturePath, "utf8"), /ENOENT/);
});

test("a turn terminalised before its turn/start response surfaces the turn's cause", async () => {
  // The server streams a delta, then never answers turn/start — the per-turn
  // timeout fires while the request is still pending. The caller must see
  // the turn's own terminalisation (with partial text), not the later
  // request timeout, and no unhandled rejection may escape.
  const codexBin = await fakeCodexFailingTurnServer("delta-no-turn-start-ack");
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    requestTimeoutMs: 5_000
  });
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(
      () => transport.runTurn(threadId, "stream then stall", { timeoutMs: 200 }),
      (error: unknown) => {
        assert.ok(error instanceof TurnTimeoutError);
        assert.equal(partialWorkerTextOf(error), "nine tenths of an answer");
        return true;
      }
    );
  } finally {
    await transport.close();
  }
});

test("itemText reaches the terminal rejection when no deltas were streamed", async () => {
  const codexBin = await fakeCodexFailingTurnServer("item-then-error");
  const transport = await CodexAppServerTransport.start(defaultTransportOptions(codexBin));
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(
      () => transport.runTurn(threadId, "item then die", {}),
      (error: unknown) => {
        assert.equal(partialWorkerTextOf(error), "a whole item answer");
        return true;
      }
    );
  } finally {
    await transport.close();
  }
});

test("a started turn with no output expires before its ordinary timeout and records the terminal attempt", async () => {
  const codexBin = await fakeCodexFailingTurnServer("no-first-delta");
  const runtime = await createRuntime({
    codexBin,
    firstDeltaTimeoutMs: 250,
    requestTimeoutMs: 2_000
  });
  const records: RuntimeAgentRecord[] = [];
  runtime.setRunRecorder({
    recordAgent: async (record: RuntimeAgentRecord) => records.push(structuredClone(record))
  } as unknown as RunRecordWriter);

  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => runtime.agent("start but never speak", { engine: "codex", timeoutMs: 2_000, maxAttempts: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof AppServerFirstOutputTimeoutError);
        assert.match(error.message, /first output-bearing frame within 250ms/);
        return true;
      }
    );
    assert.ok(Date.now() - startedAt < 1_000, "first-output expiry must win over the 2s turn timeout");
    const attempt = records.at(-1)?.attempts.at(-1);
    assert.equal(records.at(-1)?.status, "failed");
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.failure?.kind, "AppServerFirstOutputTimeoutError");
    assert.match(attempt?.failure?.message ?? "", /first output-bearing frame within 250ms/);
  } finally {
    await runtime.close();
  }
});

test("a delayed first delta inside the deadline completes after the deadline would otherwise expire", async () => {
  const codexBin = await fakeCodexFailingTurnServer("delayed-first-delta");
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    firstDeltaTimeoutMs: 250
  });
  try {
    const threadId = await transport.openThread({});
    const result = await transport.runTurn(threadId, "speak slowly", { timeoutMs: 2_000 });
    assert.equal(result.text, "the delayed whole answer");
    assert.equal(result.deltaText, "the delayed first delta");
    assert.ok((result.firstDeltaMs ?? Infinity) < 250, "the client must ingest the first delta before expiry");
  } finally {
    await transport.close();
  }
});

test("permanent silence after a retry promise terminalises at the deadline with partial text", async () => {
  const codexBin = await fakeCodexFailingTurnServer("promise-then-silence");
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    retryPromiseSilenceTimeoutMs: 250
  });
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(
      () => transport.runTurn(threadId, "promise then vanish", {}),
      (error: unknown) => {
        assert.ok(error instanceof AppServerRetryPromiseBrokenError);
        assert.match(error.message, /silent for 250ms after a promised retry/);
        // The expiry rejection carries the promise's own diagnostic and the
        // worker's accumulated text — the terminalisation invariant.
        assert.match(error.message, /serverOverloaded|stream disconnected/);
        assert.equal(partialWorkerTextOf(error), "nine tenths of an answer");
        return true;
      }
    );
  } finally {
    await transport.close();
  }
});

test("an inbound frame after the promise disarms the deadline and the recovered answer returns", async () => {
  const codexBin = await fakeCodexFailingTurnServer("promise-then-delta-recovery");
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    // The disarm delta arrives at ~100ms and the completion at ~450ms, so a
    // 250ms deadline expires between them unless the delta genuinely
    // disarmed it — the test fails if the notification-path disarm is lost.
    retryPromiseSilenceTimeoutMs: 250
  });
  try {
    const threadId = await transport.openThread({});
    const result = await transport.runTurn(threadId, "promise then recover", {});
    assert.equal(result.text, "the recovered whole answer");
  } finally {
    await transport.close();
  }
});

test("a turn-scoped server request disarms the silence deadline", async () => {
  // The request is answered (denied) before #handleNotification is ever
  // reached, so this exercises the request path's own disarm: with a 250ms
  // deadline and the completion arriving at ~450ms, only the approval frame
  // at ~100ms keeps the turn alive.
  const codexBin = await fakeCodexFailingTurnServer("promise-then-server-request-recovery");
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    retryPromiseSilenceTimeoutMs: 250
  });
  try {
    const threadId = await transport.openThread({});
    const result = await transport.runTurn(threadId, "promise then approval then answer", {});
    assert.equal(result.text, "answered after approval");
  } finally {
    await transport.close();
  }
});

test("a frame naming a different turn does not disarm the deadline", async () => {
  const codexBin = await fakeCodexFailingTurnServer("promise-foreign-frame-then-silence");
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    retryPromiseSilenceTimeoutMs: 300
  });
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(
      () => transport.runTurn(threadId, "promise then stale straggler", {}),
      (error: unknown) => {
        assert.ok(error instanceof AppServerRetryPromiseBrokenError);
        assert.match(error.message, /silent for 300ms/);
        return true;
      }
    );
  } finally {
    await transport.close();
  }
});

test("MCP tool-call progress does not reset the consecutive-promise bound", async () => {
  // 40 promise/heartbeat pairs at 5ms: without the exclusion the counter
  // resets every pair and the alternation runs without limit; with it the
  // sixth promise trips the bound in well under a second. The short silence
  // deadline makes a regression fail the elapsed-time assertion promptly
  // (~2.2s) instead of hanging on the 15-minute default after the fake goes
  // quiet.
  const codexBin = await fakeCodexFailingTurnServer("promise-mcp-alternation");
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    retryPromiseSilenceTimeoutMs: 2_000
  });
  try {
    const threadId = await transport.openThread({});
    const startedAt = Date.now();
    await assert.rejects(
      () => transport.runTurn(threadId, "promise and heartbeat for ever", {}),
      AppServerRetryPromiseBrokenError
    );
    assert.ok(Date.now() - startedAt < 1_000, "the bound should trip on the sixth promise, not run the alternation out");
  } finally {
    await transport.close();
  }
});

test("retryPromiseSilenceTimeoutMs threads from RuntimeOptions to the live transport", async () => {
  // The whole option seam at once — RuntimeOptions → registry → lazy
  // transport — so the deadline is reachable from a programmatic caller, not
  // only at the transport constructor. maxAttempts 1: the expiry error is
  // retryable by design, and one attempt is enough to prove the threading.
  const codexBin = await fakeCodexFailingTurnServer("promise-then-silence");
  const runtime = await createRuntime({
    codexBin,
    retryPromiseSilenceTimeoutMs: 250,
    requestTimeoutMs: 2_000
  });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => runtime.agent("promise then vanish", { engine: "codex", maxAttempts: 1 }),
      AppServerRetryPromiseBrokenError
    );
    assert.ok(Date.now() - startedAt < 5_000, "the configured 250ms deadline should fire, not the 15-minute default");
  } finally {
    await runtime.close();
  }
});

test("exact -32001 backpressure outranks an incidental invalid_json_schema mention", () => {
  const error = appServerErrorFromPayload("turn/start", {
    code: -32001,
    message: "backpressure while validating invalid_json_schema payloads",
    data: { note: "mentions invalid_json_schema in passing" }
  });
  assert.ok(error instanceof AppServerBackpressureError);
  assert.ok(!(error instanceof CodexSchemaSubsetUnsupportedError));
  assert.match(error.message, /-32001/);
  assert.match(error.message, /mentions invalid_json_schema in passing/);
});

test("a pathologically nested payload classifies without crashing", () => {
  let nested: unknown = "leaf";
  for (let i = 0; i < 20_000; i += 1) {
    nested = { error: nested };
  }
  const error = appServerErrorFromPayload("turn/start", {
    code: -32602,
    message: "broken payload",
    data: nested
  });
  // Depth-capped scan: the classification lands (as the generic request
  // error) instead of a RangeError killing the process.
  assert.ok(!(error instanceof CodexSchemaSubsetUnsupportedError));
});

test("an unterminated undecodable inbound frame leaves a decode diagnostic event", async () => {
  const codexBin = await fakeCodexFailingTurnServer("garbage-line");
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    onEvent: (event) => events.push({ method: event.method, params: event.params as Record<string, unknown> })
  });
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(() => transport.runTurn(threadId, "emit garbage", {}), AppServerExitedError);
    const decodeFailures = events.filter((event) => event.method === "transport/decodeFailed");
    assert.equal(decodeFailures.length, 1);
    assert.match(String(decodeFailures[0]?.params.linePrefix), /^this is not JSON/);
    assert.ok(Number(decodeFailures[0]?.params.byteLength) > 0);
  } finally {
    await transport.close();
  }
});

test("a newline-terminated undecodable inbound frame leaves a decode diagnostic event", async () => {
  const codexBin = await fakeCodexFailingTurnServer("terminated-garbage-line");
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    onEvent: (event) => events.push({ method: event.method, params: event.params as Record<string, unknown> })
  });
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(() => transport.runTurn(threadId, "emit terminated garbage", {}), AppServerExitedError);
    const decodeFailures = events.filter((event) => event.method === "transport/decodeFailed");
    assert.equal(decodeFailures.length, 1);
    assert.match(String(decodeFailures[0]?.params.linePrefix), /^this is not JSON/);
    assert.ok(Number(decodeFailures[0]?.params.byteLength) > 0);
  } finally {
    await transport.close();
  }
});

test("an oversized stdout frame leaves bounded decode evidence and the transport processes the next line", async () => {
  const codexBin = await fakeCodexFailingTurnServer("oversized-line");
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    onEvent: (event) => events.push({ method: event.method, params: event.params as Record<string, unknown> })
  });
  try {
    const threadId = await transport.openThread({});
    const result = await transport.runTurn(threadId, "survive oversized provider frame", {});

    const decodeFailures = events.filter((event) => event.method === "transport/decodeFailed");
    assert.equal(decodeFailures.length, 1);
    assert.equal(decodeFailures[0]?.params.byteLength, 1_048_699);
    assert.equal(String(decodeFailures[0]?.params.linePrefix).length, 512);
    assert.equal(result.text, "answer after oversized frame");
  } finally {
    await transport.close();
  }
});

test("a just-under-limit stdout frame is processed normally", async () => {
  const codexBin = await fakeCodexFailingTurnServer("just-under-limit-line");
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    onEvent: (event) => events.push({ method: event.method, params: event.params as Record<string, unknown> })
  });
  try {
    const threadId = await transport.openThread({});
    const result = await transport.runTurn(threadId, "accept just-under provider frame", {});

    assert.equal(events.filter((event) => event.method === "transport/decodeFailed").length, 0);
    assert.ok(result.text.length > 1_000_000);
    assert.match(result.text, /^under-limit frame/);
  } finally {
    await transport.close();
  }
});

test("Codex app-server initialize uses the startup handshake budget", async () => {
  const codexBin = await fakeCodexAppServer({ initializeDelayMs: 0, respondToInitialize: true });
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin,
    // An app-server response necessarily crosses a process boundary, so it
    // cannot complete within the ordinary zero-millisecond request budget.
    // Successful initialisation therefore proves that #handshake selected its
    // dedicated startup budget; the generous bound is only a runaway guard.
    requestTimeoutMs: 0,
    startupHandshakeTimeoutMs: 5_000,
    clientName: "ensemble-test",
    clientVersion: "0.0.0"
  });

  await transport.close();
});

test("Codex app-server initialize timeout is reported as a startup failure", async () => {
  const codexBin = await fakeCodexAppServer({ initializeDelayMs: 0, respondToInitialize: false });

  await assert.rejects(
    () =>
      CodexAppServerTransport.start({
        cwd: process.cwd(),
        codexBin,
        requestTimeoutMs: 200,
        startupHandshakeTimeoutMs: 20,
        clientName: "ensemble-test",
        clientVersion: "0.0.0"
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppServerStartupTimeoutError);
      assert.ok(!(error instanceof TurnTimeoutError));
      assert.match(error.message, /initialize handshake timed out after 20ms/);
      return true;
    }
  );
});

test("Codex app-server missing binary rejects start instead of crashing", async () => {
  await assert.rejects(
    () =>
      CodexAppServerTransport.start({
        cwd: process.cwd(),
        codexBin: path.join(tmpdir(), "ensemble-no-such-codex-bin"),
        requestTimeoutMs: 200,
        startupHandshakeTimeoutMs: 200,
        clientName: "ensemble-test",
        clientVersion: "0.0.0"
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppServerExitedError);
      assert.match(error.message, /process error/);
      return true;
    }
  );
});

test("Codex app-server prunes a thread's transcript once its turn completes", async () => {
  const codexBin = await fakeCodexTurnServer();
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin,
    // Generous budgets, deliberately: these bound a real spawned child, and
    // every assertion below latches on deterministic signals (the settled
    // runTurn promise, transcript content, openTranscripts()), so a slow or
    // contended host only makes the test slower, never red. Tight budgets
    // here bought nothing and flaked under contention.
    requestTimeoutMs: 30_000,
    startupHandshakeTimeoutMs: 30_000,
    clientName: "ensemble-test",
    clientVersion: "0.0.0"
  });

  try {
    const threadId = await transport.openThread({});
    assert.equal(transport.openTranscripts(), 1);

    const result = await transport.runTurn(threadId, "hello?", {});
    assert.equal(result.text, "hello");
    assert.equal(result.resolvedModel, "gpt-test-default");
    assert.equal(result.resolvedEffort, "medium");
    assert.ok(result.transcripts?.[0]?.content.includes("turn/completed"));
    assert.equal(transport.openTranscripts(), 0);
  } finally {
    await transport.close();
  }
});

test("Codex app-server keeps the server-reported model when a turn requests a different pin", async () => {
  const codexBin = await fakeCodexTurnServer({ servedModel: "gpt-served" });
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin,
    requestTimeoutMs: 2_000,
    startupHandshakeTimeoutMs: 2_000,
    clientName: "ensemble-test",
    clientVersion: "0.0.0"
  });

  try {
    const threadId = await transport.openThread({});
    const result = await transport.runTurn(threadId, "hello?", { model: "gpt-requested" });

    assert.equal(result.resolvedModel, "gpt-served");
  } finally {
    await transport.close();
  }
});

test("Codex app-server does not infer a served model when the server omits it", async () => {
  const codexBin = await fakeCodexTurnServer({ servedModel: null });
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin,
    requestTimeoutMs: 2_000,
    startupHandshakeTimeoutMs: 2_000,
    clientName: "ensemble-test",
    clientVersion: "0.0.0"
  });

  try {
    const threadId = await transport.openThread({});
    const result = await transport.runTurn(threadId, "hello?", { model: "gpt-requested" });

    assert.equal(result.resolvedModel, undefined);
  } finally {
    await transport.close();
  }
});

test("Codex app-server preserves Unicode line and paragraph separators in prompts", async () => {
  const codexBin = await fakeCodexTurnServer({ returnPromptBase64: true });
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin,
    requestTimeoutMs: 2_000,
    startupHandshakeTimeoutMs: 2_000,
    clientName: "ensemble-test",
    clientVersion: "0.0.0"
  });

  try {
    const prompt = "before\u2028between\u2029after";
    const threadId = await transport.openThread({});
    const result = await transport.runTurn(threadId, prompt, {});

    assert.equal(Buffer.from(result.text, "base64").toString("utf8"), prompt);
  } finally {
    await transport.close();
  }
});

test("Codex app-server sends full access explicitly on the thread and every turn", async () => {
  const codexBin = await fakeCodexTurnServer();
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin,
    requestTimeoutMs: 2_000,
    startupHandshakeTimeoutMs: 2_000,
    clientName: "ensemble-test",
    clientVersion: "0.0.0"
  });
  try {
    const threadId = await transport.openThread({});
    const result = await transport.runTurn(threadId, "hello?", {});
    const transcript = result.transcripts?.[0]?.content;
    assert.ok(transcript);
    const events = transcript
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    const threadStart = events.find((event) => event.method === "thread/start");
    const turnStart = events.find((event) => event.method === "turn/start");

    assert.deepEqual(threadStart?.params, {
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true
    });
    assert.deepEqual(turnStart?.params?.sandboxPolicy, { type: "dangerFullAccess" });
  } finally {
    await transport.close();
  }
});

/** A fake app-server that answers the handshake, opens threads, and completes one text turn per thread. */
async function fakeCodexTurnServer(
  options: { returnPromptBase64?: boolean; capturePath?: string; envCapturePath?: string; servedModel?: string | null } = {}
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-fake-codex-"));
  const bin = path.join(directory, "codex");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") {
  process.exit(2);
}

let threadCounter = 0;
const returnPromptBase64 = ${JSON.stringify(options.returnPromptBase64 ?? false)};
const capturePath = ${JSON.stringify(options.capturePath ?? null)};
const envCapturePath = ${JSON.stringify(options.envCapturePath ?? null)};
const servedModel = ${JSON.stringify(options.servedModel === undefined ? "gpt-test-default" : options.servedModel)};
if (envCapturePath !== null) {
  writeFileSync(envCapturePath, process.env.ENSEMBLE_TEST_SCOPED ?? "__ABSENT__");
}
const reader = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (capturePath !== null) {
    appendFileSync(capturePath, message.method + "\\n");
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start") {
    threadCounter += 1;
    send({
      id: message.id,
      result: {
        thread: { id: "thread-" + threadCounter },
        ...(servedModel === null ? {} : { model: servedModel }),
        reasoningEffort: "medium"
      }
    });
    return;
  }
  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const text = returnPromptBase64
      ? Buffer.from(message.params.input[0].text, "utf8").toString("base64")
      : "hello";
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId } });
    send({ method: "item/completed", params: { threadId, item: { itemType: "agentMessage", text } } });
    send({ method: "turn/completed", params: { threadId } });
  }
});
`
  );
  await chmod(bin, 0o755);
  return bin;
}

/**
 * A fake app-server that streams one agent-message delta ("nine tenths of an
 * answer") and then ends the turn per the requested failure mode.
 */
async function fakeCodexFailingTurnServer(
  mode:
    | "error-notification"
    | "system-error"
    | "exit-mid-turn"
    | "hang-after-delta"
    | "garbage-line"
    | "terminated-garbage-line"
    | "delta-no-turn-start-ack"
    | "item-then-error"
    | "promise-then-silence"
    | "promise-then-delta-recovery"
    | "promise-then-server-request-recovery"
    | "promise-foreign-frame-then-silence"
    | "promise-mcp-alternation"
    | "turn-start-error"
    | "oversized-line"
    | "just-under-limit-line"
    | "tool-active-output-silent"
    | "no-first-delta"
    | "delayed-first-delta"
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-fake-codex-failing-"));
  const bin = path.join(directory, "codex");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") {
  process.exit(2);
}

const mode = ${JSON.stringify(mode)};
let threadCounter = 0;
const reader = createInterface({ input: process.stdin });
const send = (message, afterWrite) => process.stdout.write(JSON.stringify(message) + "\\n", afterWrite);

reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start") {
    threadCounter += 1;
    send({ id: message.id, result: { thread: { id: "thread-" + threadCounter } } });
    return;
  }
  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    if (mode === "turn-start-error") {
      send({ id: message.id, error: { code: -32001, message: "request cause", data: { detail: "request payload" } } });
      return;
    }
    if (mode === "delta-no-turn-start-ack") {
      // Stream the delta but never acknowledge turn/start: the turn's own
      // deadline must fire while the request is still pending.
      send({ method: "turn/started", params: { threadId } });
      send({ method: "item/agentMessage/delta", params: { threadId, delta: "nine tenths of an answer" } });
      return;
    }
    if (mode === "item-then-error") {
      send({ id: message.id, result: {} });
      send({ method: "turn/started", params: { threadId } });
      send({ method: "item/completed", params: { threadId, item: { itemType: "agentMessage", text: "a whole item answer" } } });
      send({ method: "error", params: { threadId, willRetry: false, error: { message: "upstream fell over" } } });
      return;
    }
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId } });
    if (mode === "no-first-delta") {
      // The accepted turn stays alive but never produces output: only the
      // client's first-output deadline can free the worker slot.
      return;
    }
    if (mode === "delayed-first-delta") {
      // The first delta arrives inside the test deadline, while completion is
      // deliberately after it. This proves the client, not the fixture log,
      // disarmed the deadline when it ingested the delta.
      setTimeout(() => {
        send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", delta: "the delayed first delta" } });
      }, 100);
      setTimeout(() => {
        send({ method: "item/completed", params: { threadId, item: { itemType: "agentMessage", text: "the delayed whole answer" } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1" } } });
      }, 450);
      return;
    }
    if (mode === "exit-mid-turn") {
      // Exit only after the delta has flushed, or the partial text never
      // reaches the transport and the test measures the pipe, not the code.
      send(
        { method: "item/agentMessage/delta", params: { threadId, delta: "nine tenths of an answer" } },
        () => process.exit(7)
      );
      return;
    }
    if (mode === "oversized-line" || mode === "just-under-limit-line") {
      const prefix = mode === "oversized-line" ? "over-limit frame" : "under-limit frame";
      const targetByteLength = mode === "oversized-line" ? 1_048_699 : 1_048_575;
      const frame = { method: "item/agentMessage/delta", params: { threadId, delta: prefix } };
      const delta = prefix + "x".repeat(targetByteLength - Buffer.byteLength(JSON.stringify(frame)));
      send({ method: "item/agentMessage/delta", params: { threadId, delta } });
      if (mode === "oversized-line") {
        send({ method: "item/completed", params: { threadId, item: { itemType: "agentMessage", text: "answer after oversized frame" } } });
      }
      send({ method: "turn/completed", params: { threadId } });
      return;
    }
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", delta: "nine tenths of an answer" } });
    if (mode === "error-notification") {
      send({ method: "error", params: { threadId, willRetry: false, error: { message: "upstream fell over" } } });
    } else if (mode === "system-error") {
      send({ method: "thread/status/changed", params: { threadId, status: { type: "systemError" } } });
    } else if (mode === "garbage-line") {
      process.stdout.write("this is not JSON at all", () => process.exit(7));
    } else if (mode === "terminated-garbage-line") {
      process.stdout.write("this is not JSON at all\\n", () => process.exit(7));
    } else if (mode === "promise-then-silence") {
      send({ method: "error", params: { threadId, turnId: "turn-1", willRetry: true, error: { message: "stream disconnected before completion", codexErrorInfo: "serverOverloaded" } } });
      // Then nothing at all: the silence deadline is the only way out.
    } else if (mode === "promise-then-delta-recovery") {
      send({ method: "error", params: { threadId, turnId: "turn-1", willRetry: true, error: { message: "stream disconnected before completion" } } });
      // Disarm delta well before the test's deadline; completion well after
      // it. Only the notification-path disarm carries the turn across the
      // gap — with it removed, the deadline fires before the completion.
      setTimeout(() => {
        send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", delta: " and the last tenth" } });
      }, 100);
      setTimeout(() => {
        send({ method: "item/completed", params: { threadId, item: { itemType: "agentMessage", text: "the recovered whole answer" } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1" } } });
      }, 450);
    } else if (mode === "promise-then-server-request-recovery") {
      send({ method: "error", params: { threadId, turnId: "turn-1", willRetry: true, error: { message: "stream disconnected before completion" } } });
      // A turn-scoped server request (an approval) after the promise: it must
      // disarm the clock. The turn then completes normally well after the
      // short test deadline would have fired.
      setTimeout(() => {
        send({ id: 999, method: "item/commandExecution/requestApproval", params: { threadId, turnId: "turn-1", itemId: "item-1", startedAtMs: Date.now() } });
      }, 100);
      setTimeout(() => {
        send({ method: "item/completed", params: { threadId, item: { itemType: "agentMessage", text: "answered after approval" } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1" } } });
      }, 450);
    } else if (mode === "promise-foreign-frame-then-silence") {
      send({ method: "error", params: { threadId, turnId: "turn-1", willRetry: true, error: { message: "stream disconnected before completion" } } });
      // A straggler naming a different turn: it must NOT disarm the clock,
      // so the deadline still fires despite this frame arriving after the
      // promise.
      setTimeout(() => {
        send({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn-0-stale", delta: "stale text from an abandoned turn" } });
      }, 100);
    } else if (mode === "promise-mcp-alternation") {
      // Alternate retry promises with MCP tool-call heartbeats. The heartbeat
      // must not reset the consecutive-promise counter, so the sixth promise
      // trips the bound; without the exclusion this alternation runs without
      // limit.
      let round = 0;
      const tick = setInterval(() => {
        round += 1;
        send({ method: "error", params: { threadId, turnId: "turn-1", willRetry: true, error: { message: "stream disconnected before completion" } } });
        send({ method: "item/mcpToolCall/progress", params: { threadId, turnId: "turn-1", itemId: "item-1", message: "tool still alive" } });
        if (round >= 40) {
          clearInterval(tick);
        }
      }, 5);
    } else if (mode === "tool-active-output-silent") {
      // The product must not mistake ongoing tool activity for worker output:
      // the scripted heartbeats cross the per-turn deadline without a later
      // delta, item completion, or usage update.
      setInterval(() => {
        send({ method: "item/mcpToolCall/progress", params: { threadId, turnId: "turn-1", itemId: "item-1", message: "tool still active" } });
      }, 20);
    }
    // hang-after-delta: send nothing further.
  }
});
`
  );
  await chmod(bin, 0o755);
  return bin;
}

/** A fake codex binary that records each spawn and exits immediately. */
async function fakeCodexExitingServer(capturePath: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-fake-codex-exit-"));
  const bin = path.join(directory, "codex");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(capturePath)}, "start\\n");
process.exit(23);
`
  );
  await chmod(bin, 0o755);
  return bin;
}

function defaultTransportOptions(codexBin: string) {
  return {
    cwd: process.cwd(),
    codexBin,
    requestTimeoutMs: 2_000,
    startupHandshakeTimeoutMs: 2_000,
    clientName: "ensemble-test",
    clientVersion: "0.0.0"
  };
}

function defaultRegistryOptions(codexBin: string) {
  return {
    ...defaultTransportOptions(codexBin),
    onEvent: () => undefined,
    onClaudeEvent: () => undefined,
    onOpenCodeEvent: () => undefined
  };
}

async function fakeCodexAppServer(options: {
  initializeDelayMs: number;
  respondToInitialize: boolean;
}): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-fake-codex-"));
  const bin = path.join(directory, "codex");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") {
  process.exit(2);
}

const initializeDelayMs = ${JSON.stringify(options.initializeDelayMs)};
const respondToInitialize = ${JSON.stringify(options.respondToInitialize)};
const reader = createInterface({ input: process.stdin });

reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (!respondToInitialize) {
      return;
    }
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    }, initializeDelayMs);
  }
});
`
  );
  await chmod(bin, 0o755);
  return bin;
}

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = saved;
  }
}

test("the first output-bearing frame fires the supervisor-facing liveness callback once", async () => {
  const codexBin = await fakeCodexFailingTurnServer("delayed-first-delta");
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    firstDeltaTimeoutMs: 250
  });
  try {
    const threadId = await transport.openThread({});
    let fires = 0;
    const result = await transport.runTurn(threadId, "speak slowly", {
      timeoutMs: 2_000,
      onFirstOutput: () => {
        fires += 1;
      }
    });
    assert.equal(result.text, "the delayed whole answer");
    // Later output frames (the completed item, turn completion) must not
    // re-fire it: once per turn is the contract.
    assert.equal(fires, 1);
  } finally {
    await transport.close();
  }
});
