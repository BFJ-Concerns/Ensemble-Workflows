import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerTransport, LazyCodexAppServerTransport, appServerErrorFromPayload } from "../../src/app-server.js";
import { createDefaultEngineRegistry } from "../../src/engines.js";
import {
  AppServerBackpressureError,
  AppServerExitedError,
  AppServerStartupTimeoutError,
  CodexSchemaSubsetUnsupportedError,
  TurnTimeoutError,
  partialWorkerTextOf
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

test("exact -32001 backpressure outranks an incidental invalid_json_schema mention", () => {
  const error = appServerErrorFromPayload("turn/start", {
    code: -32001,
    message: "backpressure while validating invalid_json_schema payloads",
    data: { note: "mentions invalid_json_schema in passing" }
  });
  assert.ok(error instanceof AppServerBackpressureError);
  assert.ok(!(error instanceof CodexSchemaSubsetUnsupportedError));
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

test("an undecodable inbound frame leaves a decode diagnostic event", async () => {
  const codexBin = await fakeCodexFailingTurnServer("garbage-line");
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport = await CodexAppServerTransport.start({
    ...defaultTransportOptions(codexBin),
    onEvent: (event) => events.push({ method: event.method, params: event.params as Record<string, unknown> })
  });
  try {
    const threadId = await transport.openThread({});
    await assert.rejects(() => transport.runTurn(threadId, "emit garbage", {}));
    const decodeFailures = events.filter((event) => event.method === "transport/decodeFailed");
    assert.equal(decodeFailures.length, 1);
    assert.match(String(decodeFailures[0]?.params.linePrefix), /^this is not JSON/);
    assert.ok(Number(decodeFailures[0]?.params.byteLength) > 0);
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
    requestTimeoutMs: 2_000,
    startupHandshakeTimeoutMs: 2_000,
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
  options: { returnPromptBase64?: boolean; capturePath?: string } = {}
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-fake-codex-"));
  const bin = path.join(directory, "codex");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") {
  process.exit(2);
}

let threadCounter = 0;
const returnPromptBase64 = ${JSON.stringify(options.returnPromptBase64 ?? false)};
const capturePath = ${JSON.stringify(options.capturePath ?? null)};
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
        model: "gpt-test-default",
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
  mode: "error-notification" | "system-error" | "exit-mid-turn" | "hang-after-delta" | "garbage-line"
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
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

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
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId } });
    if (mode === "exit-mid-turn") {
      // Exit only after the delta has flushed, or the partial text never
      // reaches the transport and the test measures the pipe, not the code.
      process.stdout.write(
        JSON.stringify({ method: "item/agentMessage/delta", params: { threadId, delta: "nine tenths of an answer" } }) + "\\n",
        () => process.exit(7)
      );
      return;
    }
    send({ method: "item/agentMessage/delta", params: { threadId, delta: "nine tenths of an answer" } });
    if (mode === "error-notification") {
      send({ method: "error", params: { threadId, willRetry: false, error: { message: "upstream fell over" } } });
    } else if (mode === "system-error") {
      send({ method: "thread/status/changed", params: { threadId, status: { type: "systemError" } } });
    } else if (mode === "garbage-line") {
      process.stdout.write("this is not JSON at all\\n");
      send({ method: "error", params: { threadId, willRetry: false, error: { message: "and then it failed" } } });
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
