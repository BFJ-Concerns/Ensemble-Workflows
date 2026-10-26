import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executablePath, findOnlyFile, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const appServerFixturePath = path.resolve("test/fixtures/codex/post-promise-app-server.mjs");
const deadlineAcceleratorPath = path.resolve(
  "test/fixtures/codex/accelerate-post-promise-deadline.mjs"
);
const firstOutputDeadlineAcceleratorPath = path.resolve(
  "test/fixtures/codex/accelerate-first-output-deadline.mjs"
);
const whitespaceDeadlineAcceleratorPath = path.resolve("test/fixtures/codex/accelerate-whitespace-deadline.mjs");

interface Action {
  type: "deadline" | "whitespace-deadline" | "delta" | "malformed-delta" | "promise" | "mcp-progress" | "reasoning" | "oversized-command" | "approval" | "success" | "silence";
  text?: string;
  diagnostic?: string;
  afterMs?: number;
  requireDisarm?: boolean;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

test("built consumer terminalises permanent silence after a retry promise with its evidence intact", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run(
      [[
        { type: "delta", text: "PARTIAL_BEFORE_SILENCE" },
        { type: "promise", diagnostic: "PROMISE_ABANDONED_41" },
        { type: "deadline" },
        { type: "silence" }
      ]],
      1
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "null\n");
    assert.match(result.stderr, /\[codex\] agent 1 failed after 1 attempt — AppServerRetryPromiseBrokenError/);
    assert.match(result.stderr, /silent for 900000ms after a promised retry/);
    assert.match(result.stderr, /PROMISE_ABANDONED_41/);

    const attempts = await fixture.attempts();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, "failed");
    assert.equal(attempts[0]?.raw_output, "PARTIAL_BEFORE_SILENCE");
    assert.match(attempts[0]?.failure?.message ?? "", /PROMISE_ABANDONED_41/);
    assertFirstOutputDeadlineDisarmed(await fixture.deadlineControl());
  });
});

test("built consumer retries a whitespace stream on a fresh Codex thread", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([
      [
        { type: "delta", text: "ANSWER_BEFORE_WHITESPACE" },
        { type: "delta", text: "   " },
        { type: "whitespace-deadline" },
        { type: "silence" }
      ],
      [{ type: "success", text: "recovered-answer" }]
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '"recovered-answer"\n');
    const attempts = await fixture.attempts();
    assert.equal(attempts[0]?.failure?.kind, "AppServerWhitespaceStreamTimeoutError");
    assert.equal(attempts[0]?.classification?.class, "output");
    assert.match(attempts[0]?.raw_output ?? "", /^ANSWER_BEFORE_WHITESPACE\s+$/);
    assert.equal(attempts[1]?.status, "complete");
    const requests = await fixture.messages();
    assert.equal(requests.filter((message) => message.method === "thread/start").length, 2);
  });
});

test("built consumer keeps a turn open when a tool frame follows whitespace", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([[
      { type: "delta", text: " " },
      { type: "mcp-progress" },
      { type: "whitespace-deadline", requireDisarm: true },
      { type: "success", text: "tool-finished", afterMs: 100 }
    ]], 1);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '"tool-finished"\n');
    assert.equal((await fixture.attempts()).length, 1);
  });
});

test("built consumer keeps a turn open when a reasoning frame follows whitespace", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([[
      { type: "delta", text: " " },
      { type: "reasoning" },
      { type: "whitespace-deadline", requireDisarm: true },
      { type: "success", text: "reasoning-finished", afterMs: 100 }
    ]], 1);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '"reasoning-finished"\n', result.stderr);
    assert.equal((await fixture.attempts()).length, 1);
  });
});

test("built consumer records a dropped command event without losing the answer", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([[
      { type: "oversized-command" },
      { type: "success", text: "research-answer" }
    ]], 1);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '"research-answer"\n');
    const record = await fixture.agentRecord();
    assert.equal(record.status, "complete");
    assert.deepEqual(record.oversized_event, {
      byte_length: 1_056_599,
      dropped: "whole inbound event",
      event_method: "item/completed",
      item_type: "commandExecution",
      result_affected: false
    });
  });
});

test("built consumer continues after a post-promise delta disarms the silence deadline", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([
      abandonedAttempt("DELTA_FIRST_ATTEMPT"),
      [
        { type: "promise", diagnostic: "DELTA_RECOVERY_PROMISE" },
        { type: "delta", text: "recovery-in-progress", afterMs: 10 },
        { type: "deadline", requireDisarm: true },
        { type: "success", text: "delta-recovered", afterMs: 100 }
      ]
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"delta-recovered"\n`);
    assert.equal((await fixture.attempts()).length, 2);
    assertFirstOutputDeadlineDisarmed(await fixture.deadlineControl());
  });
});

test("built consumer returns a recovered answer when the app-server keeps its retry promise", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([
      abandonedAttempt("SUCCESS_FIRST_ATTEMPT"),
      [
        { type: "promise", diagnostic: "KEPT_PROMISE_52" },
        { type: "success", text: "promise-kept", afterMs: 20 }
      ]
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"promise-kept"\n`);
    const attempts = await fixture.attempts();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]?.status, "complete");
    assertFirstOutputDeadlineDisarmed(await fixture.deadlineControl());
  });
});

test("built consumer rejects promise and MCP-progress alternation at the bounded count", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const alternating = [{ type: "delta", text: "PARTIAL_BEFORE_HEARTBEATS" } as Action];
    for (let index = 0; index < 5; index += 1) {
      alternating.push({ type: "promise", diagnostic: `ALTERNATING_PROMISE_${index}` });
      alternating.push({ type: "mcp-progress" });
    }
    alternating.push({ type: "promise", diagnostic: "ALTERNATING_PROMISE_5" });
    alternating.push({ type: "deadline" });
    alternating.push({ type: "silence" });

    const result = await fixture.run([alternating], 1);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "null\n");
    assert.match(result.stderr, /\[codex\] agent 1 failed after 1 attempt — AppServerRetryPromiseBrokenError/);
    assert.doesNotMatch(result.stderr, /silent for 900000ms after a promised retry/);
    assert.match(result.stderr, /ALTERNATING_PROMISE_5/);
    const attempts = await fixture.attempts();
    assert.equal(attempts[0]?.raw_output, "PARTIAL_BEFORE_HEARTBEATS");
    assertFirstOutputDeadlineDisarmed(await fixture.deadlineControl());
  });
});

test("built consumer answers a turn-scoped request and continues after it disarms the deadline", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([
      abandonedAttempt("APPROVAL_FIRST_ATTEMPT"),
      [
        { type: "promise", diagnostic: "APPROVAL_RECOVERY_PROMISE" },
        { type: "approval", afterMs: 10 },
        { type: "deadline", requireDisarm: true },
        { type: "success", text: "approval-request-handled", afterMs: 100 }
      ]
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"approval-request-handled"\n`);
    const denial = (await fixture.messages()).find(
      (message) => message.id === 10_001 && message.result?.decision === "denied"
    );
    assert.equal(denial?.result?.reason, "Ensemble workers run with approvalPolicy never");
    assertFirstOutputDeadlineDisarmed(await fixture.deadlineControl());
  });
});

test("post-promise fixture validates every emitted frame without an opt-out", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([[
      { type: "delta", text: "VALIDATED_POST_PROMISE_DELTA" },
      { type: "promise", diagnostic: "VALIDATED_POST_PROMISE_PROMISE" },
      { type: "success", text: "validated-post-promise" }
    ]], 1);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"validated-post-promise"\n`);
    const validations = await fixture.validations();
    const emittedNotifications = await fixture.emittedNotifications();
    const validatedSchemas = new Set(validations.filter((entry) => entry.outcome === "valid").map((entry) => entry.schemaPath));
    for (const schemaPath of [
      "v1/InitializeResponse.json",
      "v2/ThreadStartResponse.json",
      "v2/TurnStartResponse.json",
      "ServerNotification.json"
    ]) {
      assert.ok(validatedSchemas.has(schemaPath), `missing successful validation for ${schemaPath}`);
    }
    assert.ok(validations.length > 0, "the fixture must record every emitted frame validation");
    assert.ok(
      validations.every((entry) => entry.outcome === "valid"),
      `post-promise frames must not rely on opt-outs: ${JSON.stringify(validations)}`
    );
    assertNotificationValidationCorrespondence(emittedNotifications, validations);
  });
});

test("built consumer rejects the post-promise fixture's malformed partial assistant delta", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([[
      { type: "malformed-delta", text: "MALFORMED_POST_PROMISE_DELTA" },
      { type: "success", text: "must-not-arrive" }
    ]], 1);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "null\n");
    assert.match(result.stderr, /\[codex\] agent 1 failed after 1 attempt — Codex app-server exited/);
    assert.match(result.stderr, /ServerNotification\.json validation for item\/agentMessage\/delta/);
    assert.match(result.stderr, /must have required property 'itemId'/);
  });
});

function abandonedAttempt(partialText: string): Action[] {
  return [
    { type: "delta", text: partialText },
    { type: "promise", diagnostic: `ABANDONED_${partialText}` },
    { type: "deadline" },
    { type: "silence" }
  ];
}

function assertFirstOutputDeadlineDisarmed(control: string): void {
  const armed = [...control.matchAll(/armed:first-output:(\d+)/g)].at(-1)?.[1];
  assert.notEqual(armed, undefined, "the client must control its first-output deadline");
  assert.match(
    control,
    new RegExp(`disarmed:first-output:${armed}`),
    "the first output must disarm its client-controlled deadline"
  );
}

interface RecordedAttempt {
  status: string;
  raw_output: string | null;
  failure: { kind?: string; message?: string } | null;
  classification?: { class: string };
}

interface RecordedMessage {
  id?: number;
  method?: string;
  result?: { decision?: string; reason?: string };
}

interface ValidationRecord {
  schemaPath: string;
  outcome: "valid" | "allowed-malformed";
  method?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  deltaByteLength?: number;
}

async function withFixture(run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-post-promise-estate-"));
  const binDirectory = path.join(directory, "bin");
  const fakeCodex = path.join(binDirectory, "codex");
  const capturePath = path.join(directory, "codex-input.jsonl");
  const validationCapturePath = path.join(directory, "validation.jsonl");
  const emittedFrameCapturePath = path.join(directory, "emitted-notifications.jsonl");
  const deadlineControlPath = path.join(directory, "deadline-control");
  const firstOutputDeadlineControlPath = path.join(directory, "first-output-deadline-control");
  const whitespaceDeadlineControlPath = path.join(directory, "whitespace-deadline-control");
  const recordStore = path.join(directory, "records");
  const workflow = path.join(directory, "workflow.js");
  await mkdir(binDirectory);
  await writeFile(capturePath, "");
  await writeFile(validationCapturePath, "");
  await writeFile(emittedFrameCapturePath, "");
  await writeFile(deadlineControlPath, "");
  await writeFile(firstOutputDeadlineControlPath, "");
  await writeFile(whitespaceDeadlineControlPath, "");
  await writeFile(fakeCodex, `#!/usr/bin/env node\nimport ${JSON.stringify(appServerFixturePath)};\n`);
  await chmod(fakeCodex, 0o755);

  const schemaCodexPath = await executablePath("codex");

  return {
    run: async (scenarios: Action[][], maxAttempts = 2): Promise<ProcessResult> => {
      await writeFile(
        workflow,
        `
          export const meta = { name: "post-promise-silence-estate" };
          return await agent("exercise post-promise lifecycle", {
            engine: "codex",
            maxAttempts: ${maxAttempts}
          });
        `
      );
      return runNode(
        [
          "--import", deadlineAcceleratorPath,
          "--import", firstOutputDeadlineAcceleratorPath,
          "--import", whitespaceDeadlineAcceleratorPath,
          bundledCliPath,
          workflow
        ],
        {
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          ENSEMBLE_POST_PROMISE_CAPTURE: capturePath,
          ENSEMBLE_FAKE_CODEX_VALIDATION_CAPTURE: validationCapturePath,
          ENSEMBLE_POST_PROMISE_EMITTED_CAPTURE: emittedFrameCapturePath,
          ENSEMBLE_POST_PROMISE_DEADLINE_CONTROL: deadlineControlPath,
          ENSEMBLE_POST_PROMISE_DEADLINE_KIND: "retry-promise",
          ENSEMBLE_FIRST_OUTPUT_DEADLINE_CONTROL: firstOutputDeadlineControlPath,
          ENSEMBLE_WHITESPACE_DEADLINE_CONTROL: whitespaceDeadlineControlPath,
          ENSEMBLE_POST_PROMISE_SCENARIOS: JSON.stringify(scenarios),
          ENSEMBLE_CODEX_SCHEMA_CLI: schemaCodexPath,
          ENSEMBLE_RUN_RECORD: "1",
          ENSEMBLE_RUN_RECORD_DIR: recordStore,
          ENSEMBLE_STATUS: "0",
          XDG_DATA_HOME: path.join(directory, "data")
        },
        45_000
      );
    },
    attempts: async (): Promise<RecordedAttempt[]> => {
      const pathToAgent = await findOnlyFile(recordStore, "agent.json");
      const agent = JSON.parse(await readFile(pathToAgent, "utf8")) as { attempts: RecordedAttempt[] };
      return agent.attempts;
    },
    agentRecord: async (): Promise<{ status: string; oversized_event: unknown }> => {
      const pathToAgent = await findOnlyFile(recordStore, "agent.json");
      return JSON.parse(await readFile(pathToAgent, "utf8"));
    },
    messages: async (): Promise<RecordedMessage[]> =>
      (await readFile(capturePath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedMessage),
    validations: async (): Promise<ValidationRecord[]> =>
      (await readFile(validationCapturePath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ValidationRecord),
    emittedNotifications: async (): Promise<string[]> =>
      (await readFile(emittedFrameCapturePath, "utf8"))
        .split("\n")
        .filter(Boolean),
    deadlineControl: () => readFile(firstOutputDeadlineControlPath, "utf8"),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

function assertNotificationValidationCorrespondence(emittedNotifications: string[], validations: ValidationRecord[]): void {
  const validatedFrames = new Map<string, number>();
  for (const validation of validations) {
    if (validation.outcome !== "valid" || validation.method === undefined) continue;
    const identity = JSON.stringify({
      method: validation.method,
      ...(validation.threadId === undefined ? {} : { threadId: validation.threadId }),
      ...(validation.turnId === undefined ? {} : { turnId: validation.turnId }),
      ...(validation.itemId === undefined ? {} : { itemId: validation.itemId }),
      ...(validation.deltaByteLength === undefined ? {} : { deltaByteLength: validation.deltaByteLength })
    });
    validatedFrames.set(identity, (validatedFrames.get(identity) ?? 0) + 1);
  }
  for (const frame of emittedNotifications) {
    const identity = notificationValidationIdentity(frame);
    const remaining = validatedFrames.get(identity) ?? 0;
    assert.ok(remaining > 0, `emitted notification has no matching validation: ${frame}`);
    validatedFrames.set(identity, remaining - 1);
  }
}

function notificationValidationIdentity(frame: string): string {
  const message = JSON.parse(frame) as { method: string; params?: Record<string, unknown> };
  const params = message.params ?? {};
  const delta = params.delta;
  return JSON.stringify({
    method: message.method,
    ...(typeof params.threadId !== "string" ? {} : { threadId: params.threadId }),
    ...(typeof params.turnId !== "string" ? {} : { turnId: params.turnId }),
    ...(typeof params.itemId !== "string" ? {} : { itemId: params.itemId }),
    ...(typeof delta !== "string" ? {} : { deltaByteLength: Buffer.byteLength(delta) })
  });
}
