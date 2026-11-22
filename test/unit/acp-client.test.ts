import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  AcpClient,
  acpPermissionChoice,
  acpUpdateText,
  type AcpDecodeFailure,
  type AcpPermissionPolicy,
  type AcpSession,
  type AcpSessionUpdate
} from "../../src/acp-client.js";
import { CommandContainment } from "../../src/contained-command.js";
import { AcpExitedError, AcpProtocolError, AcpRequestError, workerExitStatusOf } from "../../src/errors.js";
import { NoWorkerScopes } from "../../src/worker-scopes.js";

const scriptedAgent = path.resolve("test/fixtures/acp/scripted-agent.mjs");

/** What the scripted agent is told to do (`test/fixtures/acp/scripted-agent.mjs` lists the steps). */
interface AgentScript {
  signedOut?: boolean;
  protocolVersion?: number;
  turns?: Record<string, unknown>[][];
}

interface Harness {
  client: AcpClient;
  decodeFailures: AcpDecodeFailure[];
  /** Opens a session whose updates collect in the returned array. */
  open(): Promise<{ session: AcpSession; updates: AcpSessionUpdate[] }>;
}

const allow: AcpPermissionPolicy = (request) => acpPermissionChoice(request, "allow_once", "allow_always");

/** Starts the scripted agent inside containment of its own and closes both when the body is done. */
async function withAgent(script: AgentScript, body: (harness: Harness) => Promise<void>, permissionPolicy = allow): Promise<void> {
  const commands = new CommandContainment(new NoWorkerScopes());
  const decodeFailures: AcpDecodeFailure[] = [];
  try {
    const client = await AcpClient.start({
      name: "scripted acp",
      file: process.execPath,
      args: [scriptedAgent],
      cwd: process.cwd(),
      env: { ...process.env, SCRIPTED_ACP_AGENT: JSON.stringify(script) },
      commands,
      clientInfo: { name: "ensemble-test", version: "0" },
      permissionPolicy,
      onDecodeFailure: (failure) => decodeFailures.push(failure)
    });
    try {
      await body({
        client,
        decodeFailures,
        open: async () => {
          const updates: AcpSessionUpdate[] = [];
          const session = await client.newSession({ cwd: process.cwd(), onUpdate: (update) => updates.push(update) });
          return { session, updates };
        }
      });
    } finally {
      await client.close();
    }
  } finally {
    await commands.close();
  }
}

const say = (text: string): Record<string, unknown> => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });

test("a new session reports the agent's default model and thought level, and an update sent with its reply is delivered", async () => {
  await withAgent({}, async ({ client, open }) => {
    assert.equal((client.agent.agentInfo as { name: string }).name, "Scripted ACP agent");
    const { session, updates } = await open();

    assert.equal(session.id, "session-1");
    assert.deepEqual(session.model, { id: "model", category: "model", current: "tiered-model", values: ["tiered-model", "single-level-model"] });
    assert.deepEqual(session.thoughtLevel, { id: "thought_level", category: "thought_level", current: "high", values: ["low", "medium", "high"] });
    assert.deepEqual(session.opened._meta, { scripted: { cwd: process.cwd() } }, "the agent's own fields pass through");
    assert.deepEqual(updates.map((update) => update.kind), ["usage_update"]);
  });
});

test("setting the model restates what the session offers, and a model with one level offers no thought level to set", async () => {
  await withAgent({}, async ({ open }) => {
    const { session } = await open();

    await session.setThoughtLevel("low");
    assert.equal(session.thoughtLevel?.current, "low");

    await session.setModel("single-level-model");
    assert.equal(session.model?.current, "single-level-model");
    assert.equal(session.thoughtLevel, null);
    await assert.rejects(() => session.setThoughtLevel("low"), AcpProtocolError);

    await session.setModel("tiered-model");
    assert.deepEqual(session.selects.find((select) => select.category === "thought_level")?.values, ["low", "medium", "high"]);
  });
});

test("a value the agent does not offer rejects with the agent's JSON-RPC code and words", async () => {
  await withAgent({}, async ({ open }) => {
    const { session } = await open();

    await assert.rejects(() => session.setThoughtLevel("max"), (error: unknown) => {
      assert.ok(error instanceof AcpRequestError);
      assert.equal(error.code, -32602);
      assert.equal(error.method, "session/set_config_option");
      assert.match(error.message, /^scripted acp: session\/set_config_option failed \(-32602\): Thinking level "max" is not offered/);
      return true;
    });
    await assert.rejects(() => session.setModel("no-such-model"), /Unknown model ID: no-such-model/);
    assert.equal(session.model?.current, "tiered-model", "a refused setting leaves the session as it was");
  });
});

test("a session the agent refuses for want of a sign-in rejects with its own error code", async () => {
  await withAgent({ signedOut: true }, async ({ open }) => {
    await assert.rejects(open, (error: unknown) => {
      assert.ok(error instanceof AcpRequestError);
      assert.equal(error.code, -32000);
      assert.match(error.message, /session\/new failed \(-32000\): Authentication required/);
      return true;
    });
  });
});

test("a prompt resolves to its stop reason and usage after every update of the turn has been delivered, and the session takes another", async () => {
  const thought = { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } };
  await withAgent({ turns: [[thought, say("do"), say("ne")], [say("again"), { stop: "max_tokens" }]] }, async ({ open }) => {
    const { session, updates } = await open();
    updates.length = 0;

    const first = await session.prompt("Reply with the word done.");
    assert.equal(first.stopReason, "end_turn");
    assert.deepEqual(first.usage, { inputTokens: 100, outputTokens: 7, cachedReadTokens: 40, cachedWriteTokens: 0, thoughtTokens: 3, totalTokens: 110 });
    assert.deepEqual(updates.map((update) => update.kind), ["agent_thought_chunk", "agent_message_chunk", "agent_message_chunk"]);
    const answer = updates.filter((update) => update.kind === "agent_message_chunk").map(acpUpdateText).join("");
    assert.equal(answer, "done");

    const second = await session.prompt([{ type: "text", text: "And again." }]);
    assert.equal(second.stopReason, "max_tokens");
    assert.equal(acpUpdateText(updates.at(-1)!), "again");
  });
});

test("every approval the agent asks for is answered by the policy, under the id the agent gave its request", async () => {
  const answerSeen = (updates: AcpSessionUpdate[]): unknown =>
    (updates.find((update) => update.kind === "tool_call_update")?.body.rawOutput as { answer: unknown }).answer;

  await withAgent({ turns: [[{ permission: "call-1" }]] }, async ({ open }) => {
    const { session, updates } = await open();
    await session.prompt("Run a command.");
    assert.deepEqual(answerSeen(updates), { jsonrpc: "2.0", result: { outcome: { outcome: "selected", optionId: "allow" } } });
  });

  await withAgent({ turns: [[{ permission: "call-1" }]] }, async ({ open }) => {
    const { session, updates } = await open();
    await session.prompt("Run a command.");
    assert.deepEqual(answerSeen(updates), { jsonrpc: "2.0", result: { outcome: { outcome: "cancelled" } } });
  }, () => null);

  await withAgent({ turns: [[{ permission: "call-1" }]] }, async ({ open }) => {
    const { session, updates } = await open();
    await session.prompt("Run a command.");
    assert.deepEqual(answerSeen(updates), {
      jsonrpc: "2.0",
      error: { code: -32603, message: 'the client could not answer the permission request: the permission policy chose "always", which the request did not offer' }
    });
  }, () => "always");
});

test("a frame that cannot be decoded, or that answers nothing asked, leaves a diagnostic and the turn carries on", async () => {
  const turn = [{ raw: "this is not JSON" }, { raw: JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }) }, say("after")];
  await withAgent({ turns: [turn] }, async ({ open, decodeFailures }) => {
    const { session, updates } = await open();

    const result = await session.prompt("Carry on past the noise.");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(acpUpdateText(updates.at(-1)!), "after");
    assert.deepEqual(decodeFailures, [
      { byteLength: 16, linePrefix: "this is not JSON" },
      { byteLength: 38, linePrefix: '{"jsonrpc":"2.0","id":999,"result":{}}' }
    ]);
  });
});

test("an agent that ends a turn with a JSON-RPC error rejects that prompt and keeps the session", async () => {
  await withAgent({ turns: [[say("partial"), { error: { code: -32603, message: "the model backend failed", data: { retryable: false } } }], [say("fine")]] }, async ({ open }) => {
    const { session, updates } = await open();

    await assert.rejects(() => session.prompt("Fail once."), (error: unknown) => {
      assert.ok(error instanceof AcpRequestError);
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, { retryable: false });
      return true;
    });
    assert.equal(acpUpdateText(updates.at(-1)!), "partial", "what the turn produced before it failed was delivered");
    assert.equal((await session.prompt("Now answer.")).stopReason, "end_turn");
  });
});

test("cancelling ends the turn in flight with the agent's stop reason and leaves the session usable", async () => {
  await withAgent({ turns: [[say("working"), { untilCancelled: true }], [say("next")]] }, async ({ open }) => {
    const { session, updates } = await open();

    const turn = session.prompt("Work until told to stop.");
    while (!updates.some((update) => acpUpdateText(update) === "working")) await new Promise((resolve) => setImmediate(resolve));
    session.cancel();

    assert.equal((await turn).stopReason, "cancelled");
    assert.equal((await session.prompt("And now?")).stopReason, "end_turn");
  });
});

test("an agent that dies mid-turn rejects the turn with how it died and what it last wrote to stderr", async () => {
  await withAgent({ turns: [[say("partial"), { stderr: "fatal: quota exhausted" }, { exit: 3 }]] }, async ({ client, open }) => {
    const { session, updates } = await open();

    await assert.rejects(() => session.prompt("Die."), (error: unknown) => {
      assert.ok(error instanceof AcpExitedError);
      assert.equal(error.message, "scripted acp exited with code 3; its last stderr: fatal: quota exhausted");
      assert.deepEqual(workerExitStatusOf(error), { exitCode: 3, signal: null });
      return true;
    });
    assert.equal(acpUpdateText(updates.at(-1)!), "partial", "frames written before the death were handled first");
    assert.deepEqual(await client.exited, { exitCode: 3, signal: null, stderrTail: "fatal: quota exhausted" });
    await assert.rejects(() => session.prompt("Anyone there?"), AcpExitedError);
  });
});

test("closing stops the agent, hands back the stop for the attempt's account, and rejects the turn it cut short", async () => {
  await withAgent({ turns: [[{ untilCancelled: true }]] }, async ({ client, open }) => {
    const { session } = await open();
    const turn = session.prompt("Wait.");
    const rejected = assert.rejects(turn, /^AcpExitedError: scripted acp was stopped by the harness$/);

    const stop = await client.close();
    assert.equal(client.reach.kind, "process-group");
    assert.equal(stop.outcome.kind, "stopped");
    assert.equal(await client.close(), stop, "every close shares the one stop");
    await rejected;
    assert.equal((await client.exited).signal, "SIGTERM");
  });
});

test("an update consumer that throws stops the agent and fails the turn with the throw as the reason", async () => {
  await withAgent({ turns: [[say("first"), { untilCancelled: true }]] }, async ({ client }) => {
    const session = await client.newSession({
      cwd: process.cwd(),
      onUpdate: (update) => {
        if (update.kind === "agent_message_chunk") throw new Error("transcript write failed");
      }
    });

    await assert.rejects(
      () => session.prompt("Say something."),
      /^AcpExitedError: scripted acp was stopped because the consumer of its updates threw: transcript write failed$/
    );
  });
});

test("an agent on another protocol version is refused at start and its process stopped", async () => {
  await assert.rejects(
    () => withAgent({ protocolVersion: 2 }, async () => assert.fail("the client must not start")),
    (error: unknown) => {
      assert.ok(error instanceof AcpProtocolError);
      assert.equal(error.message, "scripted acp: initialize answered protocol version 2; this client speaks 1");
      return true;
    }
  );
});
