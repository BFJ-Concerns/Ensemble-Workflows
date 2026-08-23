import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { appServerErrorFromPayload } from "../../src/app-server.js";
import { AppServerBackpressureError, CodexSchemaSubsetUnsupportedError } from "../../src/errors.js";

const fixturePath = path.resolve("test/fixtures/codex/recording-app-server.mjs");

test("valid outbound Codex notifications pass the pinned protocol schema", async () => {
  const result = await runFixture();

  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.stderr, "");
  assert.ok(
    result.validations.some(
      (entry) => entry.schemaPath === "ServerNotification.json" && entry.outcome === "valid"
    ),
    "the fixture must record successful notification validation"
  );
});

test("an unknown outbound Codex notification field fails under the locally closed pinned schema", async () => {
  const result = await runFixture("unknown-field");

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Codex fixture payload failed ServerNotification\.json validation/);
  assert.match(result.stderr, /additional properties/);
});

test("a missing required outbound Codex notification field fails loudly", async () => {
  const result = await runFixture("missing-required");

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Codex fixture payload failed ServerNotification\.json validation/);
  assert.match(result.stderr, /must have required property 'threadId'/);
});

test("the -32001 regression uses an opt-out required by the locally closed pinned schema", async () => {
  const result = await runFixture("allowed--32001");

  assert.equal(result.signal, "SIGTERM");
  const optOut = result.validations.find(
    (entry) => entry.schemaPath === "ServerNotification.json" && entry.outcome === "allowed-malformed"
  );
  assert.deepEqual(optOut, {
    schemaPath: "ServerNotification.json",
    outcome: "allowed-malformed",
    reason: "the -32001 classifier regression deliberately includes schema-forbidden error fields"
  });
  const emittedError = result.messages.find((message) => message.method === "error");
  assert.ok(emittedError?.params?.error);
  assert.equal(emittedError.params.error.code, -32001);
  const classified = appServerErrorFromPayload("turn/start", emittedError.params.error);
  assert.ok(classified instanceof AppServerBackpressureError);
  assert.ok(!(classified instanceof CodexSchemaSubsetUnsupportedError));
});

test("caller-authored notification sequences validate by default", async () => {
  const result = await runFixture(undefined, [[{
    method: "turn/started",
    params: {
      protocolDrift: true,
      turn: { id: "authored-turn", items: [], status: "inProgress" }
    }
  }]]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Codex fixture payload failed ServerNotification\.json validation/);
  assert.match(result.stderr, /additional properties/);
});

test("the oversized-line fixture knob emits a schema-validated notification", async () => {
  const result = await runFixture(undefined, undefined, 1_048_577);

  assert.ok(result.code === 0 || result.signal === "SIGTERM", result.stderr);
  assert.ok(
    result.validations.some(
      (entry) => entry.schemaPath === "ServerNotification.json" && entry.outcome === "valid"
    )
  );
  assert.ok(result.messages.some((message) => message.method === "item/agentMessage/delta"));
});

interface ValidationRecord {
  schemaPath: string;
  outcome: "valid" | "allowed-malformed";
  reason?: string;
}

interface WireMessage {
  method?: string;
  params?: { error?: { code: number; message: string; data?: unknown } };
}

async function runFixture(schemaDrift?: string, notificationSequences?: unknown[], oversizedLineBytes?: number): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  messages: WireMessage[];
  validations: ValidationRecord[];
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-wire-schema-estate-"));
  const validationCapture = path.join(directory, "validation.jsonl");
  await writeFile(validationCapture, "");

  try {
    const codexCli = await executablePath("codex");
    const child = spawn(process.execPath, [fixturePath, "app-server"], {
      env: {
        ...process.env,
        ENSEMBLE_CODEX_SCHEMA_CLI: codexCli,
        ENSEMBLE_FAKE_CODEX_VALIDATION_CAPTURE: validationCapture,
        ...(notificationSequences === undefined ? {} : {
          ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify(notificationSequences)
        }),
        ...(schemaDrift === undefined ? {} : { ENSEMBLE_FAKE_CODEX_SCHEMA_DRIFT: schemaDrift }),
        ...(oversizedLineBytes === undefined ? {} : { ENSEMBLE_FAKE_CODEX_OVERSIZED_LINE_BYTES: String(oversizedLineBytes) })
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end([
      JSON.stringify({ id: 1, method: "initialize", params: {} }),
      JSON.stringify({ id: 2, method: "thread/start", params: {} }),
      JSON.stringify({ id: 3, method: "turn/start", params: { threadId: "thread-1" } }),
      ""
    ].join("\n"));

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if ((stdout.match(/\n/g) ?? []).length >= 5) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }
    );
    const messages = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as WireMessage);
    const validations = (await readFile(validationCapture, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ValidationRecord);
    return { code, signal, stderr, messages, validations };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function executablePath(name: string): Promise<string> {
  const child = spawn("which", [name], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, `required executable ${name} is unavailable: ${stderr}`);
  return stdout.trim();
}
