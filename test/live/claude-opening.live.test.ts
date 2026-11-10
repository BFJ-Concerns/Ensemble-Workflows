import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import { ClaudeCliControlPlane } from "../../src/claude-control-plane.js";
import { ClaudeRegistrationTimeoutError, failedTurnResultOf } from "../../src/errors.js";
import { parseTranscriptText } from "../../src/claude-transcript.js";
import { findOnlyFile, runNode } from "../integration/estate-process.js";
import { TYPED_FOLLOW_UP_OPENING_PROMPT } from "./claude-follow-up-typed-prompts.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const [size, suffix, expectedAnswer, description] of [
  [0, "\n", "PINEAPPLE", "a trailing newline"],
  [0, "\n \t\u00a0\u2003\n", "PINEAPPLE", "mixed trailing whitespace"],
  [300_000, "END", "OK", "300,000 characters"],
  [300_000, "END\n \t\u00a0\u2003\n", "OK", "whitespace after 300,000 characters"],
  [2_000_000, "END\n", null, "whitespace after 2,000,000 characters"]
] as const) {
  test(`built Claude opening preserves ${description} in one exact native user turn`, {
    skip: process.env.ENSEMBLE_LIVE !== "1" ? "ENSEMBLE_LIVE must be 1" : false, timeout: 360_000
  }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opening-live-"));
    try {
      // The short prompt is the verifier's witness; long prompts reuse the
      // existing authored opening with indexed terminal-delivery test data.
      const data = Array.from({ length: 70_000 }, (_, i) => `${i}: café £ Ω 中文 😀; Mixed CASE.`).join("\n");
      const prompt = size === 0 ? "Reply with exactly the word PINEAPPLE and nothing else." + suffix :
        (TYPED_FOLLOW_UP_OPENING_PROMPT + "\n" + data).slice(0, size) + suffix;
      const promptFile = path.join(dir, "prompt.txt");
      await writeFile(promptFile, prompt);
      const workflow = path.join(dir, "workflow.mjs");
      await writeFile(workflow, `
        export const meta = { name: "opening-receipt" };
        const fs = await import("node:fs/promises");
        return await agent(await fs.readFile(${JSON.stringify(promptFile)}, "utf8"), ${JSON.stringify({ engine: "claude", model: "claude-haiku-5-5", effort: "low", cwd: dir, timeoutMs: 240_000, maxAttempts: 1 })});
      `);
      const store = path.join(dir, "records");
      const result = await runNode([bundle, "--timeout", "300000", workflow], {
        NODE_TEST_CONTEXT: undefined, ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: store, ENSEMBLE_STATUS: "0"
      }, 330_000);
      assert.equal(result.code, 0, result.stderr);
      const archive = path.dirname(await findOnlyFile(store, "manifest.json"));
      const files = (await readdir(archive, { recursive: true })).filter(file => path.basename(file) === "agent.json");
      assert.equal(files.length, 1);
      const record = JSON.parse(await readFile(path.join(archive, files[0]!), "utf8")) as {
        status: string; attempts: Array<{ failure: {kind: string} | null }>; transcripts: Array<{ path: string; source: string; session_id: string }>
      };
      const reference = record.transcripts[0];
      assert.ok(reference, result.stderr);
      assert.equal(reference.source, "claude-session-jsonl");
      const entries = parseTranscriptText(await readFile(path.join(archive, reference.path), "utf8"));
      const users = entries.filter(entry => entry.type === "user");
      assert.equal(users.length, 1, "opening split into multiple turns or acquired a bootstrap turn");
      const opening = users[0]?.message?.content;
      assert.equal(typeof opening, "string");
      assert.ok((opening as string).includes(prompt), "the native opening lost or transformed the caller's task bytes");
      assert.equal(record.attempts.length, 1);
      assert.equal(JSON.parse(result.stdout), expectedAnswer, result.stderr);
      if (expectedAnswer !== null) {
        assert.equal(record.status, "complete");
        assert.equal(record.attempts[0]?.failure, null);
      } else {
        assert.equal(record.status, "failed", "the oversized task must retain the native context rejection");
        assert.notEqual(record.attempts[0]?.failure?.kind, "claude-delivery-error");
      }
      console.log(JSON.stringify({ size: prompt.length, bytes: Buffer.byteLength(prompt), sha256: createHash("sha256").update(prompt).digest("hex"), session: reference.session_id, status: record.status, failure: record.attempts.at(-1)?.failure, exact: true, answer: JSON.parse(result.stdout) }));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("a native empty launch that cannot submit is removed before its availability failure is reported", {
  skip: process.env.ENSEMBLE_LIVE !== "1" ? "ENSEMBLE_LIVE must be 1" : false, timeout: 120_000
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opening-launch-failure-"));
  try {
    const refusedTmux = path.join(dir, "tmux.mjs");
    await writeFile(refusedTmux, "#!/usr/bin/env node\nprocess.stderr.write('fixture attachment refused'); process.exit(1);\n");
    await chmod(refusedTmux, 0o755);
    const plane = new ClaudeCliControlPlane({ tmuxBin: refusedTmux });
    const capture: { account?: { command: { exitCode: number }; roster: { id: string; sessionId: string; name: string } } } = {};
    await assert.rejects(plane.dispatch({
      prompt: TYPED_FOLLOW_UP_OPENING_PROMPT,
      name: `opening-refusal-${process.pid}`, cwd: dir, model: "claude-haiku-5-5", effort: "low"
    }), error => {
      assert.ok(error instanceof ClaudeRegistrationTimeoutError,
        `Expected ClaudeRegistrationTimeoutError; received ${inspect(error)}`);
      assert.match(error.message, /submission failed.*fixture attachment refused/);
      const account = failedTurnResultOf(error)?.diagnostics?.claudeLaunch as {
        command: { exitCode: number }; roster: { id: string; sessionId: string; name: string }
      };
      assert.equal(account.command.exitCode, 0, "native dispatch status was lost behind the failed submission");
      capture.account = account;
      return true;
    });
    const account = capture.account;
    assert.ok(account);
    const remaining = await plane.poll({ ...account.roster, cwd: dir });
    assert.equal(remaining.present, false, "a rejected launch left its native session behind");
    console.log(JSON.stringify({ removedSession: account.roster.sessionId, dispatchExit: account.command.exitCode, submissionRefused: true }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
