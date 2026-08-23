#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";

if (process.argv[2] !== "app-server") {
  process.exit(2);
}

const capturePath = process.env.ENSEMBLE_POST_PROMISE_CAPTURE;
const deadlineControlPath = process.env.ENSEMBLE_POST_PROMISE_DEADLINE_CONTROL;
const deadlineKind = process.env.ENSEMBLE_POST_PROMISE_DEADLINE_KIND ?? "retry-promise";
const scenarios = JSON.parse(process.env.ENSEMBLE_POST_PROMISE_SCENARIOS ?? "[]");
let threadCounter = 0;
let turnCounter = 0;
let requestCounter = 10_000;
const approvals = new Map();

process.stderr.write("POST_PROMISE_FIXTURE_READY\n");

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
async function releaseDeadline(requireDisarm) {
  if (deadlineControlPath === undefined) {
    throw new Error("post-promise deadline control path is required");
  }
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    const control = readFileSync(deadlineControlPath, "utf8");
    const armed = [...control.matchAll(new RegExp(`armed:${deadlineKind}:(\\d+)`, "g"))].at(-1)?.[1];
    if (armed !== undefined && (!requireDisarm || control.includes(`disarmed:${deadlineKind}:${armed}`))) {
      appendFileSync(deadlineControlPath, `release:${deadlineKind}:${armed}\n`);
      return;
    }
    await wait(5);
  }
  throw new Error(`post-promise deadline was never ${requireDisarm ? "disarmed" : "armed"}`);
}
async function playScenario(threadId, turnId, scenario) {
  for (const action of scenario ?? []) {
    if (action.afterMs !== undefined) {
      await wait(action.afterMs);
    }
    if (action.type === "deadline") {
      await releaseDeadline(action.requireDisarm === true);
    } else if (action.type === "delta") {
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "partial-message", delta: action.text }
      });
    } else if (action.type === "promise") {
      send({
        method: "error",
        params: {
          threadId,
          turnId,
          willRetry: true,
          error: {
            message: action.diagnostic,
            additionalDetails: "provider retry stream went quiet",
            codexErrorInfo: "serverOverloaded"
          }
        }
      });
    } else if (action.type === "mcp-progress") {
      send({
        method: "item/mcpToolCall/progress",
        params: { threadId, turnId, itemId: "tool-1", message: "tool still alive" }
      });
    } else if (action.type === "approval") {
      requestCounter += 1;
      const approval = Promise.withResolvers();
      approvals.set(requestCounter, approval);
      send({
        id: requestCounter,
        method: "item/commandExecution/requestApproval",
        params: { threadId, turnId, itemId: "command-1", command: "true" }
      });
      await approval.promise;
    } else if (action.type === "success") {
      const item = { id: `answer-${turnId}`, type: "agentMessage", text: action.text };
      send({ method: "item/completed", params: { threadId, turnId, item } });
      send({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, items: [item], status: "completed" } }
      });
    } else if (action.type === "silence") {
      return;
    }
  }
}

const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  if (capturePath !== undefined) {
    appendFileSync(capturePath, `${line}\n`);
  }
  const message = JSON.parse(line);
  if (typeof message.id === "number" && approvals.has(message.id)) {
    approvals.get(message.id).resolve();
    approvals.delete(message.id);
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
  } else if (message.method === "thread/start") {
    threadCounter += 1;
    send({
      id: message.id,
      result: {
        thread: { id: `thread-${threadCounter}` },
        model: "gpt-post-promise-fixture",
        reasoningEffort: "medium"
      }
    });
  } else if (message.method === "turn/start") {
    turnCounter += 1;
    const threadId = message.params.threadId;
    const turnId = `turn-${turnCounter}`;
    send({ id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, items: [], status: "inProgress" } }
    });
    void playScenario(threadId, turnId, scenarios[turnCounter - 1]);
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
