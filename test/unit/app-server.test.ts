import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerTransport, LazyCodexAppServerTransport } from "../../src/app-server.js";
import { createDefaultEngineRegistry } from "../../src/engines.js";
import { AppServerExitedError, AppServerStartupTimeoutError, TurnTimeoutError } from "../../src/errors.js";

test("default engine registry does not start Codex during construction or unused close", async () => {
  const codexBin = path.join(tmpdir(), "ensemble-no-such-lazy-codex-bin");
  const registry = await createDefaultEngineRegistry(defaultRegistryOptions(codexBin));

  assert.deepEqual(registry.names(), ["codex", "claude", "opencode"]);
  await registry.close();
});

test("default engine registry starts Codex on first use and memoises a missing-binary failure", async () => {
  const codexBin = path.join(tmpdir(), "ensemble-no-such-lazy-codex-bin");
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
  assert.match(firstError.message, /process error.*ENOENT/);

  let secondError: unknown;
  try {
    await invocation.runAttempt({ attempt: 2 });
    assert.fail("second Codex use should retain the startup failure");
  } catch (error) {
    secondError = error;
  }
  assert.strictEqual(secondError, firstError);
  await registry.close();
});

test("lazy Codex transport does not respawn after startup failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-failing-codex-"));
  const capturePath = path.join(directory, "starts.txt");
  const codexBin = await fakeCodexExitServer(capturePath);
  const transport = new LazyCodexAppServerTransport(defaultTransportOptions(codexBin));

  let firstError: unknown;
  try {
    await transport.openThread({});
  } catch (error) {
    firstError = error;
  }
  assert.ok(firstError instanceof AppServerExitedError);

  await assert.rejects(() => transport.openThread({}), (error: unknown) => error === firstError);
  assert.equal((await readFile(capturePath, "utf8")).trim().split("\n").length, 1);
  await transport.close();
});

test("concurrent first Codex calls share one app-server handshake", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-lazy-codex-"));
  const capturePath = path.join(directory, "messages.txt");
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
async function fakeCodexTurnServer(options: { returnPromptBase64?: boolean; capturePath?: string } = {}): Promise<string> {
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

async function fakeCodexExitServer(capturePath: string): Promise<string> {
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
