import assert from "node:assert/strict";
import test from "node:test";

import { type CommandStop, unestablishedStopDiagnostics } from "../../src/contained-command.js";
import { failedTurnResultOf } from "../../src/errors.js";
import { OpenCodeEngineInvocation, type OpenCodeRunner } from "../../src/opencode-engine.js";

const runStop: CommandStop = {
  outcome: { kind: "stopped" },
  attemptAccount: { owner: "opencode run in process group 42", reason: "no scope" }
};
const exportStop: CommandStop = {
  outcome: { kind: "unconfirmed", reason: "scope did not empty" },
  attemptAccount: { owner: "opencode export in fixture.scope", reason: "scope did not empty" }
};

for (const ending of ["complete", "failure", "deadline", "run-throw", "export-failure", "export-throw"] as const) {
  test(`opencode ${ending} keeps every command stop on its attempt result`, async () => {
    const thrown = new Error("fixture runner failure");
    const runner: OpenCodeRunner = {
      async run(options) {
        options.onCommandStop?.(runStop);
        if (ending === "run-throw") throw thrown;
        return {
          exitCode: ending === "failure" ? 7 : 0, signal: null,
          stdout: [
            JSON.stringify({ sessionID: "fixture-session" }),
            JSON.stringify({ type: "text", part: { type: "text", text: "retained stream" } })
          ].join("\n"),
          stderr: "", durationMs: 1, deadlineExpired: ending === "deadline"
        };
      },
      async exportSession(_sessionId, _cwd, _signal, onCommandStop) {
        onCommandStop?.(exportStop);
        if (ending === "export-throw") throw thrown;
        if (ending === "export-failure") return { status: "command-failed", exitCode: 8, signal: null, stderr: "export failed" };
        return { status: "ok", stdout: JSON.stringify({ messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "answer" }] }] }) };
      }
    };
    const invocation = new OpenCodeEngineInvocation({
      prompt: "fixture", cwd: process.cwd(), providerModel: "fixture/model", modelKey: "fixture",
      options: { timeoutMs: 10 }, runner
    });
    try {
      const expected = unestablishedStopDiagnostics(ending === "deadline" || ending === "run-throw" ? [runStop] : [runStop, exportStop]);
      if (ending === "deadline" || ending === "run-throw" || ending === "export-throw") {
        await assert.rejects(invocation.runAttempt({ attempt: 1 }), (error: unknown) => {
          if (ending !== "deadline") assert.equal(error, thrown);
          const result = failedTurnResultOf(error);
          assert.ok(result);
          assert.deepEqual(result.diagnostics, expected);
          if (ending !== "run-throw") assert.equal(result.text, "retained stream");
          return true;
        });
      } else {
        const result = await invocation.runAttempt({ attempt: 1 });
        assert.deepEqual(result.diagnostics?.unestablishedStops, expected.unestablishedStops);
        assert.equal(result.attemptFailure?.kind, ending === "failure" ? "opencode-run-error" : undefined);
        assert.equal(result.text, ending === "export-failure" ? "retained stream" : "answer");
        assert.ok(result.diagnostics?.opencode, "the stop account must preserve export diagnostics");
      }
    } finally {
      await invocation.close();
    }
  });
}

test("opencode cancellation during export preserves earlier command stops on the thrown shutdown", async () => {
  let exporting!: () => void;
  const ready = new Promise<void>((resolve) => { exporting = resolve; });
  const runner: OpenCodeRunner = {
    async run(options) {
      options.onCommandStop?.(runStop);
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ sessionID: "fixture-session", type: "text", part: { type: "text", text: "partial" } }), stderr: "", durationMs: 1 };
    },
    async exportSession(_sessionId, _cwd, signal, onCommandStop) {
      exporting();
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      onCommandStop?.(exportStop);
      return { status: "command-failed", exitCode: null, signal: "SIGTERM", stderr: "cancelled" };
    }
  };
  const invocation = new OpenCodeEngineInvocation({ prompt: "fixture", cwd: process.cwd(), providerModel: "fixture/model", modelKey: "fixture", options: {}, runner });
  const attempt = invocation.runAttempt({ attempt: 1 });
  const rejected = assert.rejects(attempt, (error: unknown) => {
    const result = failedTurnResultOf(error);
    assert.equal(result?.text, "partial");
    assert.deepEqual(result?.diagnostics, unestablishedStopDiagnostics([runStop, exportStop]));
    return true;
  });
  await ready;
  await invocation.close();
  await rejected;
});
