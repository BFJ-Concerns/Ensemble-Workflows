#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") {
  process.exit(2);
}

// A fake codex is never a legitimate source of the protocol schemas that
// validate its own payloads — those must come from the real pinned CLI. Refuse
// the subcommand outright rather than detecting who asked: this runs before the
// validator is imported, so no spelling of the schema-CLI pointer, no parent
// process, and no inherited environment can route schema generation back into
// this fixture and fork.
if (process.argv.includes("generate-json-schema")) {
  process.stderr.write(
    "Codex fixture refused to generate protocol schemas: a recording fixture is never a schema source\n"
  );
  process.exit(2);
}

const { validateCodexFixturePayload } = await import("./protocol-schema-validator.mjs");

const capturePath = process.env.ENSEMBLE_FAKE_CODEX_CAPTURE;
const responseText = process.env.ENSEMBLE_FAKE_CODEX_RESPONSE ?? "worker-ok";
const barrierSize = Number(process.env.ENSEMBLE_FAKE_CODEX_BARRIER ?? "1");
const errorSequence = JSON.parse(process.env.ENSEMBLE_FAKE_CODEX_ERROR_SEQUENCE ?? "[]");
const notificationSequences = JSON.parse(process.env.ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES ?? "[]");
const stallAfterNotificationSequence = process.env.ENSEMBLE_FAKE_CODEX_STALL_AFTER_NOTIFICATION_SEQUENCE === "1";
const rejectInterrupt = process.env.ENSEMBLE_FAKE_CODEX_REJECT_INTERRUPT === "1";
const withholdInterruptResponse = process.env.ENSEMBLE_FAKE_CODEX_WITHHOLD_INTERRUPT_RESPONSE === "1";
const stallAfterTurnStart = process.env.ENSEMBLE_FAKE_CODEX_STALL_AFTER_TURN_START === "1";
const schemaDrift = process.env.ENSEMBLE_FAKE_CODEX_SCHEMA_DRIFT;
const oversizedLineBytes = Number(process.env.ENSEMBLE_FAKE_CODEX_OVERSIZED_LINE_BYTES ?? "0");
if (!Number.isSafeInteger(oversizedLineBytes) || oversizedLineBytes < 0) {
  throw new Error("ENSEMBLE_FAKE_CODEX_OVERSIZED_LINE_BYTES must be a non-negative safe integer");
}
let threadCounter = 0;
let turnCounter = 0;
const pendingTurns = [];

const send = (message, schemaPath, payload = message, options) => {
  validateCodexFixturePayload(schemaPath, payload, options);
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const finishTurn = (threadId, turnId) => {
  const item = {
    id: `agent-message-${turnId}`,
    type: "agentMessage",
    text: responseText
  };
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item,
      completedAtMs: Date.now()
    }
  }, "ServerNotification.json");
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        items: [item],
        status: "completed"
      }
    }
  }, "ServerNotification.json");
};
const notificationParamsForTurn = (notification, threadId, turnId) => {
  const params = {
    ...notification.params,
    threadId
  };
  if (
    notification.method === "error" ||
    notification.method === "thread/tokenUsage/updated" ||
    notification.method.startsWith("item/") ||
    notification.method === "turn/diff/updated" ||
    notification.method === "turn/plan/updated"
  ) {
    params.turnId = turnId;
  }
  return params;
};
const completeTurn = ({ threadId, turnId, turnIndex }) => {
  const notificationSequence = notificationSequences[turnIndex];
  if (notificationSequence !== undefined) {
    for (const notification of notificationSequence) {
      send({
        method: notification.method,
        params: notificationParamsForTurn(notification, threadId, turnId)
      }, "ServerNotification.json", undefined, {
        allowMalformed: notification.allowMalformed
      });
    }
    if (!stallAfterNotificationSequence) {
      finishTurn(threadId, turnId);
    }
    return;
  }

  const errorNotification = errorSequence[turnIndex];
  if (errorNotification !== undefined) {
    send({
      method: "error",
      params: {
        ...errorNotification,
        threadId,
        turnId: `turn-${turnCounter}`
      }
    }, "ServerNotification.json");
    if (errorNotification.willRetry === true) {
      finishTurn(threadId, turnId);
    }
    return;
  }
  finishTurn(threadId, turnId);
};

const handleLine = (line) => {
  if (capturePath !== undefined) {
    appendFileSync(capturePath, `${line}\n`);
  }

  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(
      { id: message.id, result: {} },
      "v1/InitializeResponse.json",
      {},
      { allowMalformed: "the established fixture predates required initialise metadata" }
    );
    return;
  }
  if (message.method === "thread/start") {
    threadCounter += 1;
    const response = {
      id: message.id,
      result: {
        thread: { id: `thread-${threadCounter}` },
        model: "gpt-estate-recorder",
        reasoningEffort: "medium"
      }
    };
    send(
      response,
      "v2/ThreadStartResponse.json",
      response.result,
      { allowMalformed: "the established fixture omits server-owned thread metadata" }
    );
    return;
  }
  if (message.method === "turn/interrupt") {
    if (withholdInterruptResponse) {
      return;
    }
    if (rejectInterrupt) {
      const response = { id: message.id, error: { code: -32000, message: "turn already finished" } };
      send(response, "JSONRPCError.json");
    } else {
      send({ id: message.id, result: {} }, "JSONRPCResponse.json");
    }
    return;
  }
  if (message.method === "turn/start") {
    const { threadId } = message.params;
    turnCounter += 1;
    const turnId = `turn-${turnCounter}`;
    const response = { id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } };
    send(response, "v2/TurnStartResponse.json", response.result);
    if (stallAfterTurnStart) {
      return;
    }
    const turnStarted = {
      method: "turn/started",
      params: {
        threadId,
        turn: {
          id: turnId,
          items: [],
          status: "inProgress"
        }
      }
    };
    if (schemaDrift === "unknown-field") {
      turnStarted.params.protocolDrift = true;
    } else if (schemaDrift === "missing-required") {
      delete turnStarted.params.threadId;
    }
    send(turnStarted, "ServerNotification.json");
    if (schemaDrift === "allowed--32001") {
      send({
        method: "error",
        params: {
          threadId,
          turnId,
          willRetry: false,
          error: {
            code: -32001,
            message: "backpressure while validating invalid_json_schema payloads",
            data: { note: "mentions invalid_json_schema in passing" }
          }
        }
      }, "ServerNotification.json", undefined, {
        allowMalformed: "the -32001 classifier regression deliberately includes schema-forbidden error fields"
      });
      return;
    }
    if (oversizedLineBytes > 0) {
      // This cannot be elicited from a live provider on cue. Deliberately
      // bypass schema validation: the frame is malformed by construction and
      // exists to exercise the client's bounded stdout assembly.
      process.stdout.write(`${"x".repeat(oversizedLineBytes)}\n`);
    }
    pendingTurns.push({ threadId, turnId, turnIndex: turnCounter - 1 });
    if (pendingTurns.length >= barrierSize) {
      for (const pending of pendingTurns.splice(0)) {
        completeTurn(pending);
      }
    }
  }
};

if (process.env.ENSEMBLE_FAKE_CODEX_UNICODE_LINES === "1") {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r\n|[\n\r\u2028\u2029]/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      handleLine(line);
    }
  });
} else {
  const reader = createInterface({ input: process.stdin });
  reader.on("line", handleLine);
}
