import assert from "node:assert/strict";
import test from "node:test";

import { presentOperationalError, presentTerminalError } from "../../src/operator-diagnosis.js";
import {
  AppServerExitedError,
  BudgetExceededError,
  CodexSchemaSubsetUnsupportedError,
  EngineShutdownError,
  InvalidAgentSchemaError,
  TurnTimeoutError,
  attachAgentIdentity,
  attachAppServerDiagnostic,
  attachWorkerExitStatus
} from "../../src/errors.js";
import { AmbientConfigError } from "../../src/ambient-settings.js";
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
        rawOutput: ""
      }
    ]
  } as unknown as RuntimeAgentRecord;

  const rendered = presentTerminalError(failed, { archiveDir: "/data/runs/x", lastAgentRecord: record });
  assert.ok(rendered !== null);
  const lines = rendered.split("\n");
  assert.equal(lines[0], "Agent exhausted its attempts without producing a result");
  assert.match(lines[1] ?? "", /attempt 1 \(invalid-json\): agent output did not contain parseable JSON/);
  assert.match(lines[1] ?? "", /worker diagnosis: The schema's minLength 2 and maxLength 1 are contradictory\./);
  assert.equal(lines[2], "  attempt 2 (empty-output): agent returned empty text on attempt 2");
  assert.match(lines[3] ?? "", /agents\/000001\/agent\.json$/);
  // Detail lines are indented beneath the cause, never a stack.
  assert.equal(lines.length, 4);
  assert.ok(lines.slice(1).every((line) => line.startsWith("  ")));
  assert.equal(lines.some((line) => /^\s*at\s/.test(line)), false);
});

test("every diagnosis-less raw-output route omits the worker-diagnosis label", () => {
  const failed = new Error("Agent exhausted its attempts without producing a result");
  failed.name = "SingleAgentFailedError";
  const record = {
    id: 3,
    attempts: [
      { attempt: 1, failure: { kind: "empty-output", message: "no text" }, rawOutput: null },
      { attempt: 2, failure: { kind: "empty-output", message: "no text" }, rawOutput: "" },
      { attempt: 3, failure: { kind: "empty-output", message: "no text" }, rawOutput: "  \n\t  " }
    ]
  } as unknown as RuntimeAgentRecord;

  const rendered = presentTerminalError(failed, { archiveDir: null, lastAgentRecord: record });
  assert.ok(rendered !== null);
  const lines = rendered.split("\n");
  assert.equal(lines.length, 4);
  for (const [index, line] of lines.slice(1).entries()) {
    assert.match(line, new RegExp(`attempt ${index + 1} \\(empty-output\\): no text$`));
    assert.equal(line.includes("worker diagnosis"), false);
  }
});

test("an oversized worker diagnosis is bounded with the full evidence behind the record pointer", () => {
  const failed = new Error("Agent exhausted its attempts without producing a result");
  failed.name = "SingleAgentFailedError";
  const atLimit = "a".repeat(400);
  const oversized = `${"b".repeat(400)}TAIL-BEYOND-THE-BOUND`;
  const record = {
    id: 7,
    attempts: [
      {
        attempt: 1,
        failure: { kind: "invalid-json", message: "agent output did not contain parseable JSON" },
        rawOutput: oversized
      },
      {
        attempt: 2,
        failure: { kind: "invalid-json", message: "agent output did not contain parseable JSON" },
        rawOutput: atLimit
      }
    ]
  } as unknown as RuntimeAgentRecord;

  const rendered = presentTerminalError(failed, { archiveDir: "/data/runs/x", lastAgentRecord: record });
  assert.ok(rendered !== null);
  const lines = rendered.split("\n");
  // Beyond the bound the slice keeps exactly the limit then marks the cut;
  // the tail never reaches stderr.
  assert.ok(lines[1]?.endsWith(`worker diagnosis: ${"b".repeat(400)}…`), lines[1]);
  assert.equal(rendered.includes("TAIL-BEYOND-THE-BOUND"), false);
  // At the bound nothing is cut and no marker is invented.
  assert.ok(lines[2]?.endsWith(`worker diagnosis: ${atLimit}`), lines[2]);
  // The complete evidence stays reachable through the archived record alone.
  assert.match(lines[3] ?? "", /agents\/000007\/agent\.json$/);
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

test("an ambient-configuration failure renders as its own message, never a stack", () => {
  const line = presentTerminalError(new AmbientConfigError("Invalid value for ENSEMBLE_STATUS_DIR: expected a non-empty directory path"), noContext);
  assert.equal(line, "Configuration error: Invalid value for ENSEMBLE_STATUS_DIR: expected a non-empty directory path");
});

test("a Codex schema rejection leads with the remedy and carries the diagnostic once, bounded", () => {
  const rejection = attachAppServerDiagnostic(
    new CodexSchemaSubsetUnsupportedError(
      { code: -32602, message: "invalid schema", data: { detail: "unsupported keyword" } },
      { code: -32602, httpStatusCode: null, message: "invalid schema", payload: '{"detail":"unsupported keyword"}' }
    ),
    { code: -32602, httpStatusCode: null, message: "invalid schema", payload: '{"detail":"unsupported keyword"}' }
  );
  const rendered = presentTerminalError(rejection, noContext);
  assert.ok(rendered !== null);
  const lines = rendered.split("\n");
  assert.match(lines[0] ?? "", /^Codex rejected outputSchema before generation/);
  assert.match(lines[1] ?? "", /Codex's outputSchema subset/);
  // The diagnostic appears exactly once, and no frame reaches the surface.
  assert.equal(rendered.split("invalid schema").length - 1, 1);
  assert.equal(lines.some((line) => /^\s*at\s/.test(line)), false);
});

test("operator diagnostics strip 7-bit terminal controls while UTF-8 renders a C1 code point as text", () => {
  const rendered = presentTerminalError(
    new AppServerExitedError("before \u001b[31mred\u001b[0m after \u009b31mC1"),
    noContext
  );
  assert.ok(rendered !== null);
  // eslint-disable-next-line no-control-regex -- the assertion proves the 7-bit escape bytes are absent.
  assert.doesNotMatch(rendered, /\u001b\[/);
  assert.match(rendered, /before red after \u009b31mC1/);
  // The rendered diagnostic emits U+009B in UTF-8, not as a lone 0x9B C1
  // byte for a UTF-8 terminal to interpret as CSI.
  const renderedBytes = Buffer.from(rendered, "utf8");
  assert.deepEqual([...renderedBytes.subarray(-13)], [0x61, 0x66, 0x74, 0x65, 0x72, 0x20, 0xc2, 0x9b, 0x33, 0x31, 0x6d, 0x43, 0x31]);
});

test("a teardown-time engine shutdown is attributed to the run ending, not the author's call", () => {
  const line = presentTerminalError(new EngineShutdownError("codex"), noContext);
  assert.ok(line !== null);
  assert.match(line, /interrupted by the run ending, not by its own failure/);
  assert.equal(line.includes("\n"), false);
});

test("a per-agent turn deadline names the author's own timeoutMs as the lever", () => {
  const rendered = presentTerminalError(
    new TurnTimeoutError("turn on 01a05c53 timed out after 30001ms", {
      kind: "turn",
      timeoutMs: 30_001,
      threadId: "01a05c53"
    }),
    noContext
  );
  assert.ok(rendered !== null);
  const lines = rendered.split("\n");
  assert.match(lines[0] ?? "", /^Worker exceeded its per-agent turn deadline of 30001ms/);
  // The remedy is the option the author actually holds, not a restatement.
  assert.match(lines[0] ?? "", /timeoutMs on this agent\(\) call/);
  // No identity was declared, so the thread is the only handle there is.
  assert.match(lines[1] ?? "", /^\s+thread: 01a05c53$/);
  // On the pre-fix tree this class fell through to the caller's stack.
  assert.equal(lines.some((line) => /^\s*at\s/.test(line)), false);
  assert.doesNotMatch(rendered, /TurnTimeoutError/);
});

test("a declared identity replaces the thread handle with the author's own call label", () => {
  const rendered = presentTerminalError(
    attachAgentIdentity(
      new TurnTimeoutError("turn on 01a05c53 timed out after 5000ms", {
        kind: "turn",
        timeoutMs: 5_000,
        threadId: "01a05c53"
      }),
      { label: "planner", phase: "fanout" }
    ),
    noContext
  );
  assert.ok(rendered !== null);
  assert.match(rendered, /^\s+call: planner \(phase fanout\)$/m);
  assert.doesNotMatch(rendered, /thread: /);
});

test("a transport request deadline sends the operator to the server, not to timeoutMs", () => {
  const rendered = presentTerminalError(
    new TurnTimeoutError("thread/start request 4 timed out after 30000ms", {
      kind: "request",
      timeoutMs: 30_000,
      method: "thread/start"
    }),
    noContext
  );
  assert.ok(rendered !== null);
  const lines = rendered.split("\n");
  assert.match(lines[0] ?? "", /^Codex app-server did not answer thread\/start within/);
  // The whole point of discriminating the two causes: the turn branch's
  // remedy is wrong here, and the line must say so rather than repeat it.
  assert.match(lines[0] ?? "", /not the agent's timeoutMs and raising it will not help/);
  assert.doesNotMatch(lines[0] ?? "", /raise or remove timeoutMs/);
  assert.match(lines[1] ?? "", /codex binary is healthy/);
  assert.equal(lines.some((line) => /^\s*at\s/.test(line)), false);
});

test("an author's call label cannot smuggle terminal control onto the diagnosis", () => {
  const rendered = presentTerminalError(
    attachAgentIdentity(
      new TurnTimeoutError("turn on t1 timed out after 10ms", {
        kind: "turn",
        timeoutMs: 10,
        threadId: "t1"
      }),
      { label: "plan\x1b]0;pwned\x07ner", phase: null }
    ),
    noContext
  );
  assert.ok(rendered !== null);
  // eslint-disable-next-line no-control-regex -- the control bytes are the subject of the assertion
  assert.equal(/[\x00-\x08\x0b-\x1f]/.test(rendered), false, "no control bytes in the rendered surface");
  assert.doesNotMatch(rendered, /pwned/);
  assert.match(rendered, /call: planner/);
});

test("worker-controlled terminal control sequences never reach operator stderr", () => {
  // OSC (title write), CSI (erase), a bare ESC dispatch, and a stray BEL,
  // interleaved with the text an operator must still see.
  const hostile =
    "before \x1b]0;pwned\x07middle \x1b[2Jkept \x1b(Balso\x07 after \x1b]8;;http://evil\x1b\\done";
  const failed = new Error("Agent exhausted its attempts without producing a result");
  failed.name = "SingleAgentFailedError";
  const record = {
    id: 7,
    attempts: [{ attempt: 1, failure: { kind: "invalid-json", message: "no JSON" }, rawOutput: hostile }]
  } as unknown as RuntimeAgentRecord;

  const rendered = presentTerminalError(failed, { archiveDir: null, lastAgentRecord: record });
  assert.ok(rendered !== null);
  // eslint-disable-next-line no-control-regex -- the control bytes are the subject of the assertion
  assert.equal(/[\x00-\x08\x0b-\x1f]/.test(rendered), false, "no control bytes in the rendered surface");
  assert.match(rendered, /before/);
  assert.match(rendered, /middle/);
  assert.match(rendered, /kept/);
  assert.match(rendered, /done/);
  // On the pre-fix tree the OSC payload and CSI bytes passed through whole;
  // the payload is consumed with its sequence, not just the introducer.
  assert.doesNotMatch(rendered, /pwned/);
});

test("the combinators' context-free presentation uses the same seam", () => {
  assert.equal(
    presentOperationalError(new EngineShutdownError("claude")),
    "claude engine is shutting down — this worker was interrupted by the run ending, not by its own failure"
  );
  assert.equal(presentOperationalError(new Error("novel failure")), null);
});

// The shape Codex's app-server actually sends for an out-of-subset schema:
// the readable message, with the same text echoed as an escaped JSON string
// inside the payload's `error.message`.
const serverBody =
  '{\n  "type": "error",\n  "error": {\n    "code": "invalid_json_schema",\n    "message": "Invalid schema for response_format \'codex_output_schema\': In context=(), \'if\' is not permitted."\n  },\n  "status": 400\n}';
const echoingDiagnostic = {
  code: "other",
  httpStatusCode: null,
  message: `other: ${serverBody}`,
  payload: JSON.stringify({ error: { message: serverBody, codexErrorInfo: "other" }, willRetry: false })
};

function echoingRejection(): CodexSchemaSubsetUnsupportedError {
  return attachAppServerDiagnostic(
    new CodexSchemaSubsetUnsupportedError({ code: "other", message: echoingDiagnostic.message }, echoingDiagnostic),
    echoingDiagnostic
  );
}

test("a Codex schema rejection's remedy names engines the author can move to, not Codex", () => {
  for (const text of [presentTerminalError(echoingRejection(), noContext) ?? "", echoingRejection().message]) {
    const remedy = text.split(/(?<=\.)\s/).find((sentence) => sentence.includes("client-side")) ?? "";
    assert.match(remedy, /'claude' or 'opencode'/);
    assert.doesNotMatch(remedy, /run (?:\S+ )*on an engine that/);
  }
});

test("a recorded Codex schema rejection carries the server's diagnostic once, not again as escaped JSON", () => {
  const message = echoingRejection().message;
  assert.equal(message.split("is not permitted").length - 1, 1, message);
  // The payload's other fields survive beside the dropped echo.
  assert.match(message, /"codexErrorInfo":"other"/);
  const rendered = presentTerminalError(echoingRejection(), noContext) ?? "";
  assert.equal(rendered.split("is not permitted").length - 1, 1, rendered);
});

test("a zero token budget says it admitted nothing and names the ceiling to set, without a stack", () => {
  const rendered = presentTerminalError(new BudgetExceededError("codex", 0, 0), noContext);
  assert.ok(rendered !== null, "the budget refusal must be diagnosed, not handed back to the stack renderer");
  const lines = rendered.split("\n");
  assert.equal(lines[0], "Token budget for codex is 0, which admits no agent: this agent was not started");
  assert.match(lines[1] ?? "", /--budget codex=<tokens>/);
  assert.doesNotMatch(rendered, /exhausted|spent 0 of 0|BudgetExceededError/);
  assert.equal(lines.some((line) => /^\s*at\s/.test(line)), false);
});

test("a spent token budget keeps its spend figures and gains the same remedy", () => {
  const rendered = presentTerminalError(new BudgetExceededError("claude", 5, 7), noContext) ?? "";
  assert.match(rendered, /^Token budget exhausted for claude: spent 7 of 5 tokens\n {2}Raise the claude ceiling/);
});

test("an exhausted agent's attempt line keeps vocabulary kinds but never prints an internal error class name", () => {
  const failed = new Error("Agent exhausted its attempts without producing a result");
  failed.name = "SingleAgentFailedError";
  const record = {
    id: 1,
    attempts: [
      { attempt: 1, failure: { kind: "CodexSchemaSubsetUnsupportedError", message: "Codex rejected outputSchema before generation" }, rawOutput: null },
      { attempt: 2, failure: { kind: "empty-output", message: "agent returned empty text on attempt 2" }, rawOutput: null }
    ]
  } as unknown as RuntimeAgentRecord;
  const rendered = presentTerminalError(failed, { archiveDir: null, lastAgentRecord: record }) ?? "";
  const lines = rendered.split("\n");
  assert.equal(lines[1], "  attempt 1: Codex rejected outputSchema before generation");
  assert.equal(lines[2], "  attempt 2 (empty-output): agent returned empty text on attempt 2");
  assert.doesNotMatch(rendered, /[A-Z][A-Za-z]*Error\b/);
});
