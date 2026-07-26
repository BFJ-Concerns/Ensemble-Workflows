import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerTransport } from "../../src/app-server.js";
import { AppServerExitedError, AppServerStartupTimeoutError, TurnTimeoutError } from "../../src/errors.js";

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
    const threadId = await transport.openThread({ webSearch: false, sandbox: "read-only" });
    assert.equal(transport.openTranscripts(), 1);

    const result = await transport.runTurn(threadId, "hello?", { sandbox: "read-only", network: true });
    assert.equal(result.text, "hello");
    assert.equal(result.resolvedModel, "gpt-test-default");
    assert.equal(result.resolvedEffort, "medium");
    assert.ok(result.transcripts?.[0]?.content.includes("turn/completed"));
    assert.equal(transport.openTranscripts(), 0);
  } finally {
    await transport.close();
  }
});

test("Codex app-server emits the exact turn sandbox policy for each supported posture", async () => {
  const codexBin = await fakeCodexTurnServer();
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin,
    requestTimeoutMs: 2_000,
    startupHandshakeTimeoutMs: 2_000,
    clientName: "ensemble-test",
    clientVersion: "0.0.0"
  });
  const cases = [
    {
      sandbox: "read-only" as const,
      network: true,
      expected: { type: "readOnly", networkAccess: true }
    },
    {
      sandbox: "read-only" as const,
      network: false,
      expected: { type: "readOnly", networkAccess: false }
    },
    {
      sandbox: "workspace-write" as const,
      network: true,
      expected: { type: "workspaceWrite", networkAccess: true }
    },
    {
      sandbox: "workspace-write" as const,
      network: false,
      expected: { type: "workspaceWrite", networkAccess: false }
    },
    {
      sandbox: "danger-full-access" as const,
      network: true,
      expected: { type: "dangerFullAccess" }
    }
  ];

  try {
    for (const scenario of cases) {
      const threadId = await transport.openThread({ webSearch: false, sandbox: scenario.sandbox });
      const result = await transport.runTurn(threadId, "hello?", {
        sandbox: scenario.sandbox,
        network: scenario.network
      });
      const transcript = result.transcripts?.[0]?.content;
      assert.ok(transcript);
      const turnStart = transcript
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method?: string; params?: { sandboxPolicy?: unknown } })
        .find((event) => event.method === "turn/start");

      assert.deepEqual(turnStart?.params?.sandboxPolicy, scenario.expected);
    }
  } finally {
    await transport.close();
  }
});

/** A fake app-server that answers the handshake, opens threads, and completes one text turn per thread. */
async function fakeCodexTurnServer(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-fake-codex-"));
  const bin = path.join(directory, "codex");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") {
  process.exit(2);
}

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
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId } });
    send({ method: "item/completed", params: { threadId, item: { itemType: "agentMessage", text: "hello" } } });
    send({ method: "turn/completed", params: { threadId } });
  }
});
`
  );
  await chmod(bin, 0o755);
  return bin;
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
