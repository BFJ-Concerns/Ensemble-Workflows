import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeCliControlPlane } from "../../src/claude-control-plane.js";
import { ClaudeRegistrationTimeoutError, failedTurnResultOf } from "../../src/errors.js";
import { parseTranscriptText } from "../../src/claude-transcript.js";
import { findOnlyFile, runNode } from "../integration/estate-process.js";
import { TYPED_FOLLOW_UP_OPENING_PROMPT } from "./claude-follow-up-typed-prompts.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const [size, trailingNewline] of [[300_000, false], [2_000_000, false], [0, true]] as const) {
  test(`built Claude opening arrives as one exact native user turn at ${size} characters${trailingNewline ? " with a trailing newline" : ""}`, {
    skip: process.env.ENSEMBLE_LIVE !== "1", timeout: 360_000
  }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opening-live-"));
    try {
      // Reuse the existing authored opening; the suffix is indexed test data.
      const data = Array.from({ length: 70_000 }, (_, i) => `${i}: café £ Ω 中文 😀; Mixed CASE.`).join("\n");
      const prompt = trailingNewline ? TYPED_FOLLOW_UP_OPENING_PROMPT + "\n" :
        (TYPED_FOLLOW_UP_OPENING_PROMPT + "\n" + data).slice(0, size) + "END";
      const promptFile = path.join(dir, "prompt.txt");
      await writeFile(promptFile, prompt);
      const workflow = path.join(dir, "workflow.mjs");
      await writeFile(workflow, `
        export const meta = { name: "opening-receipt" };
        const fs = await import("node:fs/promises");
        await agent(await fs.readFile(${JSON.stringify(promptFile)}, "utf8"), ${JSON.stringify({ engine: "claude", model: "claude-haiku-5-5", effort: "low", cwd: dir, timeoutMs: 240_000, maxAttempts: 1, ...(trailingNewline ? { fallback: [{engine: "claude", model: "claude-haiku-5-5"}] } : {}) })});
        return "finished";
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
        status: string; attempts: Array<{ failure: {kind: string} | null; classification: {class: string} | null; chain_decision: string | null }>; transcripts: Array<{ path: string; source: string; session_id: string }>
      };
      const reference = record.transcripts[0];
      assert.ok(reference, result.stderr);
      assert.equal(reference.source, "claude-session-jsonl");
      const entries = parseTranscriptText(await readFile(path.join(archive, reference.path), "utf8"));
      const users = entries.filter(entry => entry.type === "user");
      assert.equal(users.length, 1, "opening split into multiple turns or acquired a bootstrap turn");
      const opening = users[0]?.message?.content;
      assert.equal(typeof opening, "string");
      // The engine supplies its existing autonomy preamble before Task:.
      const boundary = (opening as string).indexOf("\nTask:\n");
      assert.ok(boundary >= 0, "native opening lacks the dispatch task boundary");
      const task = (opening as string).slice(boundary + "\nTask:\n".length);
      if (trailingNewline && task !== prompt) {
        assert.equal(task, prompt.trimEnd());
        assert.equal(record.status, "failed");
        assert.equal(record.attempts.length, 1, "a native trim advanced fallback");
        assert.equal(record.attempts[0]?.failure?.kind, "claude-delivery-error");
        assert.equal(record.attempts[0]?.classification?.class, "unclassified");
        assert.equal(record.attempts[0]?.chain_decision, "exhausted");
      } else assert.equal(task, prompt);
      console.log(JSON.stringify({ size: prompt.length, bytes: Buffer.byteLength(prompt), sha256: createHash("sha256").update(prompt).digest("hex"), session: reference.session_id, status: record.status, failure: record.attempts.at(-1)?.failure, exact: task === prompt }));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("a native empty launch that cannot submit is removed before its availability failure is reported", {
  skip: process.env.ENSEMBLE_LIVE !== "1", timeout: 120_000
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
      assert.ok(error instanceof ClaudeRegistrationTimeoutError);
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
