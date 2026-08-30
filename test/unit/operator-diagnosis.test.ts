import assert from "node:assert/strict";
import test from "node:test";

import { presentTerminalError } from "../../src/operator-diagnosis.js";
import { AppServerExitedError, InvalidAgentSchemaError, attachWorkerExitStatus } from "../../src/errors.js";
import { WorkflowTimeoutError } from "../../src/script-runner.js";
import { assertCompilableSchema } from "../../src/schema.js";

import type { RuntimeAgentRecord } from "../../src/run-record.js";

const noContext = { archiveDir: null, lastAgentRecord: null };

function interruptError(signal: string): Error {
  const error = new Error(`Workflow interrupted by ${signal}`);
  error.name = "WorkflowInterruptedError";
  (error as Error & { signal: string }).signal = signal;
  return error;
}

test("an interrupt the user requested renders as one line, not a stack into the signal handler", () => {
  const line = presentTerminalError(interruptError("SIGINT"), { ...noContext, archiveDir: "/data/runs/abc" });
  assert.equal(line, "Interrupted (SIGINT) — partial result on stdout; record: /data/runs/abc");
  // Without recording there is no record pointer to invent.
  assert.equal(presentTerminalError(interruptError("SIGTERM"), noContext), "Interrupted (SIGTERM) — partial result on stdout");
});

test("a whole-run timeout renders cause-first with the salvage pointers", () => {
  const line = presentTerminalError(new WorkflowTimeoutError(90_000), { ...noContext, archiveDir: "/data/runs/t" });
  assert.ok(line !== null);
  assert.match(line, /— partial result on stdout; record: \/data\/runs\/t$/);
  assert.equal(line.includes("\n"), false);
});

test("an exhausted direct agent surfaces each worker diagnosis beside its harness failure without a stack", () => {
  const failed = new Error("Agent exhausted its attempts without producing a result");
  failed.name = "SingleAgentFailedError";
  const record = {
    id: 1,
    attempts: [
      {
        attempt: 1,
        failure: { kind: "invalid-json", message: "agent output did not contain parseable JSON" },
        rawOutput: "The schema's minLength 2 and maxLength 1 are contradictory."
      },
      {
        attempt: 2,
        failure: { kind: "empty-output", message: "agent returned empty text on attempt 2" },
        rawOutput: null
      }
    ]
  } as unknown as RuntimeAgentRecord;

  const rendered = presentTerminalError(failed, { archiveDir: "/data/runs/x", lastAgentRecord: record });
  assert.ok(rendered !== null);
  const lines = rendered.split("\n");
  assert.equal(lines[0], "Agent exhausted its attempts without producing a result");
  assert.match(lines[1] ?? "", /attempt 1 \(invalid-json\): agent output did not contain parseable JSON/);
  assert.match(lines[1] ?? "", /worker diagnosis: The schema's minLength 2 and maxLength 1 are contradictory\./);
  assert.match(lines[2] ?? "", /attempt 2 \(empty-output\): agent returned empty text on attempt 2/);
  assert.match(lines[3] ?? "", /agents\/000001\/agent\.json$/);
  // Detail lines are indented beneath the cause, never a stack.
  assert.ok(lines.slice(1).every((line) => line.startsWith("  ")));
  assert.equal(rendered.includes("at presentTerminalError"), false);
});

test("an oversized prompt renders as the named platform limit, not raw spawn E2BIG frames", () => {
  const spawnError = Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });
  const wrapped = new Error("dispatch failed", { cause: spawnError });
  const line = presentTerminalError(wrapped, noContext);
  assert.ok(line !== null);
  assert.match(line, /argument-size limit \(E2BIG\)/);
  assert.match(line, /shorten the prompt \(this engine passes it as a process argument\)/);
});

test("a dead app-server discriminates how it died from the evidence the error carries", () => {
  const terminated = new AppServerExitedError("codex app-server exited before responding");
  attachWorkerExitStatus(terminated, { exitCode: null, signal: "SIGTERM" });
  assert.match(presentTerminalError(terminated, noContext) ?? "", /terminated by SIGTERM/);

  const crashed = new AppServerExitedError("codex app-server exited before responding");
  attachWorkerExitStatus(crashed, { exitCode: 137, signal: null });
  assert.match(presentTerminalError(crashed, noContext) ?? "", /exited with code 137/);

  const unknown = new AppServerExitedError("codex app-server exited before responding");
  assert.match(presentTerminalError(unknown, noContext) ?? "", /exited unexpectedly/);
});

test("an unknown error is not diagnosed: the caller keeps its stack as evidence", () => {
  assert.equal(presentTerminalError(new Error("novel failure"), noContext), null);
});

test("a rejected schema echoes the offending value beside the validator's reason", () => {
  assert.throws(
    () => assertCompilableSchema({ type: { not: "a type" } }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidAgentSchemaError);
      assert.match(error.message, /offending schema: \{"type":\{"not":"a type"\}\}/);
      return true;
    }
  );
});
