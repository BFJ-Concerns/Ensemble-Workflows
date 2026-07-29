#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") {
  process.exit(2);
}

const capturePath = process.env.ENSEMBLE_FAKE_CODEX_CAPTURE;
const responseText = process.env.ENSEMBLE_FAKE_CODEX_RESPONSE ?? "worker-ok";
const barrierSize = Number(process.env.ENSEMBLE_FAKE_CODEX_BARRIER ?? "1");
const errorSequence = JSON.parse(process.env.ENSEMBLE_FAKE_CODEX_ERROR_SEQUENCE ?? "[]");
const notificationSequences = JSON.parse(process.env.ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES ?? "[]");
const stallAfterNotificationSequence = process.env.ENSEMBLE_FAKE_CODEX_STALL_AFTER_NOTIFICATION_SEQUENCE === "1";
let threadCounter = 0;
let turnCounter = 0;
const pendingTurns = [];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
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
  });
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
  });
};
const notificationParamsForTurn = (notification, threadId, turnId) => {
  const params = {
    ...notification.params,
    threadId
  };
  if (
    notification.method === "error" ||
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
    });
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
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/start") {
    threadCounter += 1;
    send({
      id: message.id,
      result: {
        thread: { id: `thread-${threadCounter}` },
        model: "gpt-estate-recorder",
        reasoningEffort: "medium"
      }
    });
    return;
  }
  if (message.method === "turn/start") {
    const { threadId } = message.params;
    turnCounter += 1;
    const turnId = `turn-${turnCounter}`;
    send({ id: message.id, result: {} });
    send({
      method: "turn/started",
      params: {
        threadId,
        turn: {
          id: turnId,
          items: [],
          status: "inProgress"
        }
      }
    });
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
