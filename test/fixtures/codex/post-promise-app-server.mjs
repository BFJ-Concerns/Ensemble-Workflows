#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as wait } from "node:timers/promises";

if (process.argv[2] !== "app-server") {
  process.exit(2);
}

const { codexFixtureSchemaIncludesDefinitionProperty, validateCodexFixturePayload } = await import("./protocol-schema-validator.mjs");

const capturePath = process.env.ENSEMBLE_POST_PROMISE_CAPTURE;
const emittedFrameCapturePath = process.env.ENSEMBLE_POST_PROMISE_EMITTED_CAPTURE;
const deadlineControlPath = process.env.ENSEMBLE_POST_PROMISE_DEADLINE_CONTROL;
const whitespaceDeadlineControlPath = process.env.ENSEMBLE_WHITESPACE_DEADLINE_CONTROL;
const deadlineKind = process.env.ENSEMBLE_POST_PROMISE_DEADLINE_KIND ?? "retry-promise";
const scenarios = JSON.parse(process.env.ENSEMBLE_POST_PROMISE_SCENARIOS ?? "[]");
let threadCounter = 0;
let turnCounter = 0;
let requestCounter = 10_000;
const approvals = new Map();

process.stderr.write("POST_PROMISE_FIXTURE_READY\n");

const writeStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
  recordEmittedNotifications(chunk);
  return writeStdout(chunk, encoding, callback);
};

function recordEmittedNotifications(chunk) {
  if (emittedFrameCapturePath === undefined) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof message?.method === "string" && typeof message.id !== "number") {
      appendFileSync(emittedFrameCapturePath, `${JSON.stringify(message)}\n`);
    }
  }
}

const send = (message, schemaPath, payload = message) => {
  validateCodexFixturePayload(schemaPath, payload);
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
async function releaseDeadline(requireDisarm, controlPath = deadlineControlPath, kind = deadlineKind) {
  if (controlPath === undefined) {
    throw new Error("post-promise deadline control path is required");
  }
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    const control = readFileSync(controlPath, "utf8");
    const armed = [...control.matchAll(new RegExp(`armed:${kind}:(\\d+)`, "g"))].at(-1)?.[1];
    if (armed !== undefined && (!requireDisarm || control.includes(`disarmed:${kind}:${armed}`))) {
      appendFileSync(controlPath, `release:${kind}:${armed}\n`);
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
    } else if (action.type === "whitespace-deadline") {
      await releaseDeadline(action.requireDisarm === true, whitespaceDeadlineControlPath, "whitespace-stream");
    } else if (action.type === "delta") {
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "partial-message", delta: action.text }
      }, "ServerNotification.json");
    } else if (action.type === "malformed-delta") {
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, delta: action.text }
      }, "ServerNotification.json");
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
      }, "ServerNotification.json");
    } else if (action.type === "mcp-progress") {
      send({
        method: "item/mcpToolCall/progress",
        params: { threadId, turnId, itemId: "tool-1", message: "tool still alive" }
      }, "ServerNotification.json");
    } else if (action.type === "oversized-command") {
      const frame = {
        method: "item/completed",
        params: {
          threadId, turnId, completedAtMs: Date.now(),
          item: {
            id: `command-${turnId}`, type: "commandExecution", command: "print project files",
            commandActions: [], cwd: process.cwd(), status: "completed",
            aggregatedOutput: ""
          }
        }
      };
      frame.params.item.aggregatedOutput = "x".repeat(1_056_599 - Buffer.byteLength(JSON.stringify(frame)));
      send(frame, "ServerNotification.json");
    } else if (action.type === "approval") {
      requestCounter += 1;
      const approval = Promise.withResolvers();
      approvals.set(requestCounter, approval);
      send({
        id: requestCounter,
        method: "item/commandExecution/requestApproval",
        params: { threadId, turnId, itemId: "command-1", command: "true", startedAtMs: Date.now() }
      }, "ServerRequest.json");
      await approval.promise;
    } else if (action.type === "success") {
      const item = { id: `answer-${turnId}`, type: "agentMessage", text: action.text };
      send({
        method: "item/completed",
        params: { threadId, turnId, item, completedAtMs: Date.now() }
      }, "ServerNotification.json");
      send({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, items: [item], status: "completed" } }
      }, "ServerNotification.json");
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
    send({
      id: message.id,
      result: {
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "ensemble-post-promise-fixture"
      }
    }, "v1/InitializeResponse.json", {
      codexHome: process.cwd(),
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: "ensemble-post-promise-fixture"
    });
  } else if (message.method === "thread/start") {
    threadCounter += 1;
    const result = {
      thread: {
        cliVersion: "ensemble-post-promise-fixture",
        createdAt: Math.floor(Date.now() / 1_000),
        cwd: process.cwd(),
        ephemeral: true,
        id: `thread-${threadCounter}`,
        modelProvider: "openai",
        preview: "",
        ...(codexFixtureSchemaIncludesDefinitionProperty("v2/ThreadStartResponse.json", "Thread", "projectId")
          ? { projectId: null }
          : {}),
        sessionId: `fixture-session-${threadCounter}`,
        source: "appServer",
        status: { type: "idle" },
        turns: [],
        updatedAt: Math.floor(Date.now() / 1_000)
      },
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: process.cwd(),
      model: "gpt-post-promise-fixture",
      modelProvider: "openai",
      reasoningEffort: "medium",
      sandbox: { type: "dangerFullAccess" }
    };
    send({
      id: message.id,
      result
    }, "v2/ThreadStartResponse.json", result);
  } else if (message.method === "turn/start") {
    turnCounter += 1;
    const threadId = message.params.threadId;
    const turnId = `turn-${turnCounter}`;
    const result = { turn: { id: turnId, items: [], status: "inProgress" } };
    send({ id: message.id, result }, "v2/TurnStartResponse.json", result);
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, items: [], status: "inProgress" } }
    }, "ServerNotification.json");
    void playScenario(threadId, turnId, scenarios[turnCounter - 1]);
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} }, "JSONRPCResponse.json");
  }
});
