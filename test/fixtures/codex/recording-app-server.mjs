#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";
import { setInterval } from "node:timers";
import { setTimeout as wait } from "node:timers/promises";

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

const { codexFixtureSchemaIncludesDefinitionProperty, validateCodexFixturePayload } = await import("./protocol-schema-validator.mjs");

const capturePath = process.env.ENSEMBLE_FAKE_CODEX_CAPTURE;
const responseText = process.env.ENSEMBLE_FAKE_CODEX_RESPONSE ?? "worker-ok";
const responseTexts = JSON.parse(process.env.ENSEMBLE_FAKE_CODEX_RESPONSES ?? "[]");
const servedModel = process.env.ENSEMBLE_FAKE_CODEX_SERVED_MODEL ?? "gpt-estate-recorder";
const threadResolutions = JSON.parse(process.env.ENSEMBLE_FAKE_CODEX_THREAD_RESOLUTIONS ?? "[]");
const requiredThreadModel = process.env.ENSEMBLE_FAKE_CODEX_REQUIRE_THREAD_MODEL;
const barrierSize = Number(process.env.ENSEMBLE_FAKE_CODEX_BARRIER ?? "1");
const errorSequence = JSON.parse(process.env.ENSEMBLE_FAKE_CODEX_ERROR_SEQUENCE ?? "[]");
const notificationSequences = JSON.parse(process.env.ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES ?? "[]");
const stallAfterNotificationSequence = process.env.ENSEMBLE_FAKE_CODEX_STALL_AFTER_NOTIFICATION_SEQUENCE === "1";
const rejectInterrupt = process.env.ENSEMBLE_FAKE_CODEX_REJECT_INTERRUPT === "1";
const withholdInterruptResponse = process.env.ENSEMBLE_FAKE_CODEX_WITHHOLD_INTERRUPT_RESPONSE === "1";
const stallAfterTurnStart = process.env.ENSEMBLE_FAKE_CODEX_STALL_AFTER_TURN_START === "1";
const signalAfterInitialise = process.env.ENSEMBLE_FAKE_CODEX_SIGNAL_AFTER_INITIALISE;
const turnStartError = JSON.parse(process.env.ENSEMBLE_FAKE_CODEX_TURN_START_ERROR ?? "null");
const toolActiveOutputSilent = process.env.ENSEMBLE_FAKE_CODEX_TOOL_ACTIVE_OUTPUT_SILENT === "1";
const toolProgressIntervalMs = Number(process.env.ENSEMBLE_FAKE_CODEX_TOOL_PROGRESS_INTERVAL_MS ?? "20");
const completionDelayMs = Number(process.env.ENSEMBLE_FAKE_CODEX_COMPLETION_DELAY_MS ?? "0");
const turnStartMarkerPath = process.env.ENSEMBLE_FAKE_CODEX_TURN_START_MARKER;
const firstDeltaControlPath = process.env.ENSEMBLE_FAKE_CODEX_FIRST_DELTA_CONTROL;
const firstDeltaDeadlineKind = process.env.ENSEMBLE_POST_PROMISE_DEADLINE_KIND ?? "first-delta";
const releaseFirstDeltaAfterArm = process.env.ENSEMBLE_FAKE_CODEX_RELEASE_FIRST_DELTA_AFTER_ARM === "1";
const completeAfterFirstDeltaDisarm = process.env.ENSEMBLE_FAKE_CODEX_COMPLETE_AFTER_FIRST_DELTA_DISARM === "1";
const schemaDrift = process.env.ENSEMBLE_FAKE_CODEX_SCHEMA_DRIFT;
const emitDecodeFailure = process.env.ENSEMBLE_FAKE_CODEX_DECODE_FAILURE === "1";
const turnTimeoutControl = process.env.ENSEMBLE_TURN_TIMEOUT_CONTROL;
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
const finishTurn = (threadId, turnId, turnIndex) => {
  const item = {
    id: `agent-message-${turnId}`,
    type: "agentMessage",
    text: responseTexts[turnIndex] ?? responseText
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
const releaseTurnTimeoutAfterClientProcessesStart = () => {
  if (turnTimeoutControl === undefined) {
    return;
  }
  const waitForClient = () => {
    let control = "";
    try {
      control = readFileSync(turnTimeoutControl, "utf8");
    } catch {
      // The preload creates the control file when it arms the per-turn timer.
    }
    if (control.includes("turn-start-processed\n")) {
      appendFileSync(turnTimeoutControl, "release\n");
      return;
    }
    const poll = globalThis.setTimeout(waitForClient, 5);
    poll.unref();
  };
  waitForClient();
};
const waitForFirstDeltaControl = async (marker) => {
  if (firstDeltaControlPath === undefined) {
    throw new Error(`first-delta control path is required to wait for ${marker}`);
  }
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    let control = "";
    try {
      control = readFileSync(firstDeltaControlPath, "utf8");
    } catch {
      // The preload writes the file when the client arms the deadline.
    }
    if (control.includes(marker)) {
      return control;
    }
    // This is a fixture hang-guard poll, never an assertion release: the
    // client-written marker above is the only condition that releases us.
    await wait(5);
  }
  throw new Error(`client never wrote first-delta control marker ${marker}`);
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
const completeTurn = async ({ threadId, turnId, turnIndex }) => {
  if (emitDecodeFailure) {
    process.stdout.write("this is not JSON at all\n");
  }
  const notificationSequence = notificationSequences[turnIndex];
  if (notificationSequence !== undefined) {
    for (const notification of notificationSequence) {
      if (notification.afterFirstDeltaControl !== undefined) {
        await waitForFirstDeltaControl(notification.afterFirstDeltaControl);
      }
      if (notification.afterMs !== undefined) {
        await wait(notification.afterMs);
      }
      send({
        method: notification.method,
        params: notificationParamsForTurn(notification, threadId, turnId)
      }, "ServerNotification.json", undefined, {
        // A deliberately malformed partial assistant delta would conceal the
        // producer contract this fixture is meant to guard. Other established
        // exceptional frames retain their explicitly recorded regressions.
        ...(notification.method === "item/agentMessage/delta" ? {} : { allowMalformed: notification.allowMalformed })
      });
    }
    if (!stallAfterNotificationSequence) {
      if (completeAfterFirstDeltaDisarm) {
        await waitForFirstDeltaControl(`disarmed:${firstDeltaDeadlineKind}:`);
      }
      if (completionDelayMs > 0) {
        await wait(completionDelayMs);
      }
      finishTurn(threadId, turnId, turnIndex);
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
      finishTurn(threadId, turnId, turnIndex);
    }
    return;
  }
  finishTurn(threadId, turnId, turnIndex);
};

const handleLine = (line) => {
  if (capturePath !== undefined) {
    appendFileSync(capturePath, `${line}\n`);
  }

  const message = JSON.parse(line);
  if (message.method === "initialize") {
    const result = {
      codexHome: process.cwd(),
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: "ensemble-recording-fixture"
    };
    if (schemaDrift === "missing-initialize-user-agent") {
      delete result.userAgent;
    }
    send({ id: message.id, result }, "v1/InitializeResponse.json", result);
    if (signalAfterInitialise !== undefined) {
      process.kill(process.pid, signalAfterInitialise);
    }
    return;
  }
  if (message.method === "thread/start") {
    if (requiredThreadModel !== undefined && message.params.model !== requiredThreadModel) {
      throw new Error(`thread/start model was ${JSON.stringify(message.params.model)}, expected ${JSON.stringify(requiredThreadModel)}`);
    }
    threadCounter += 1;
    const resolution = threadResolutions[threadCounter - 1] ?? {};
    const response = {
      id: message.id,
      result: {
        thread: {
          cliVersion: "ensemble-recording-fixture",
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
        model: resolution.model ?? servedModel,
        modelProvider: "openai",
        // As the live server answers (codex-cli 0.157.1): a thread-start
        // `config.model_reasoning_effort` overlay is confirmed back as the
        // thread's effort; otherwise the configured default.
        reasoningEffort: message.params.config?.model_reasoning_effort ?? resolution.effort ?? "medium",
        sandbox: { type: "dangerFullAccess" }
      }
    };
    send(response, "v2/ThreadStartResponse.json", response.result);
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
    if (turnStartError !== null) {
      send({ id: message.id, error: turnStartError }, "JSONRPCError.json");
      return;
    }
    if (turnStartMarkerPath !== undefined) {
      writeFileSync(turnStartMarkerPath, String(Date.now()));
    }
    const response = { id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } };
    send(response, "v2/TurnStartResponse.json", response.result);
    if (stallAfterTurnStart) {
      if (releaseFirstDeltaAfterArm) {
        void waitForFirstDeltaControl(`armed:${firstDeltaDeadlineKind}:`).then((control) => {
          const armed = [...control.matchAll(new RegExp(`armed:${firstDeltaDeadlineKind}:(\\d+)`, "g"))].at(-1)?.[1];
          if (armed === undefined) {
            throw new Error("first-delta control marker did not identify an armed deadline");
          }
          appendFileSync(firstDeltaControlPath, `release:${firstDeltaDeadlineKind}:${armed}\n`);
        });
      }
      releaseTurnTimeoutAfterClientProcessesStart();
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
    if (toolActiveOutputSilent) {
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "agent-message-1", delta: "partial before ongoing tool activity" }
      }, "ServerNotification.json");
      setInterval(() => {
        send({
          method: "item/mcpToolCall/progress",
          params: { threadId, turnId, itemId: "tool-1", message: "tool still active" }
        }, "ServerNotification.json");
      }, toolProgressIntervalMs);
      return;
    }
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
      // This cannot be elicited from a live provider on cue. Its payload is
      // still protocol-valid: exercise the client boundary without opening a
      // hole in the fixture's wire-schema guard.
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: `agent-message-${turnId}`, delta: "x".repeat(oversizedLineBytes) }
      }, "ServerNotification.json");
    }
    pendingTurns.push({ threadId, turnId, turnIndex: turnCounter - 1 });
    if (pendingTurns.length >= barrierSize) {
      for (const pending of pendingTurns.splice(0)) {
        void completeTurn(pending);
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
