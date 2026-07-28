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
let threadCounter = 0;
const pendingTurns = [];

const reader = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const completeTurn = ({ threadId }) => {
  send({
    method: "item/completed",
    params: {
      threadId,
      item: { itemType: "agentMessage", text: responseText }
    }
  });
  send({ method: "turn/completed", params: { threadId } });
};

reader.on("line", (line) => {
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
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId } });
    pendingTurns.push({ threadId });
    if (pendingTurns.length >= barrierSize) {
      for (const pending of pendingTurns.splice(0)) {
        completeTurn(pending);
      }
    }
  }
});
