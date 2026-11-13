import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { removeTestDirectory } from "../failure-evidence.js";
import { parseTranscriptText } from "../../src/claude-transcript.js";
import { findOnlyFile, runNode } from "../integration/estate-process.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

test("built Claude follow-up preserves leading and trailing whitespace in one exact native turn", {
  skip: process.env.ENSEMBLE_LIVE !== "1" ? "ENSEMBLE_LIVE must be 1" : false, timeout: 360_000
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-follow-up-whitespace-"));
  let testFailed = false;
  try {
    const task = "Reply with exactly the word PINEAPPLE and nothing else.";
    const prompt = "\n\t \u00a0" + task + "\r\n \t\u2003\n";
    const workflow = path.join(dir, "workflow.mjs");
    await writeFile(workflow, `
      export const meta = { name: "follow-up-whitespace-receipt" };
      const held = session(${JSON.stringify({ engine: "claude", model: "claude-haiku-5-5", effort: "low", cwd: dir, timeoutMs: 120_000, maxAttempts: 1 })});
      try {
        const first = await held.send(${JSON.stringify(task)});
        const followUp = await held.send(${JSON.stringify(prompt)});
        return { first, followUp };
      } finally { await held.close(); }
    `);
    const store = path.join(dir, "records");
    const result = await runNode([bundle, "--timeout", "300000", workflow], {
      NODE_TEST_CONTEXT: undefined, ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: store, ENSEMBLE_STATUS: "0"
    }, 330_000);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { first: "PINEAPPLE", followUp: "PINEAPPLE" });
    const archive = path.dirname(await findOnlyFile(store, "manifest.json"));
    const files = (await readdir(archive, { recursive: true })).filter(file => path.basename(file) === "agent.json");
    const records = await Promise.all(files.map(async file => JSON.parse(await readFile(path.join(archive, file), "utf8")) as {
      status: string; session: { id: number; turn: number };
      attempts: Array<{ failure: unknown }>; transcripts: Array<{ path: string; session_id: string }>
    }));
    records.sort((a, b) => a.session.turn - b.session.turn);
    assert.equal(records.length, 2);
    assert.equal(new Set(records.map(record => record.session.id)).size, 1);
    assert.equal(new Set(records.flatMap(record => record.transcripts.map(ref => ref.session_id))).size, 1);
    for (const record of records) {
      assert.equal(record.status, "complete");
      assert.equal(record.attempts.length, 1);
      assert.equal(record.attempts[0]?.failure, null);
    }
    const reference = records[1]?.transcripts[0];
    assert.ok(reference);
    const entries = parseTranscriptText(await readFile(path.join(archive, reference.path), "utf8"));
    const inputs = entries.filter(entry => entry.type === "user" && typeof entry.message?.content === "string");
    assert.equal(inputs.length, 2, "no bootstrap, retry or extra turn may be submitted");
    const sent = inputs[1]?.message?.content as string;
    assert.equal(sent.trim(), sent);
    const boundary = /\n<(ensemble_task_\d+)>/.exec(sent);
    assert.ok(boundary);
    const enclosed = sent.slice(boundary.index + boundary[0].length, -`</${boundary[1]}>`.length);
    assert.deepEqual(Buffer.from(enclosed), Buffer.from(prompt), "the native receipt must preserve every task byte");
    console.log(JSON.stringify({ session: reference.session_id, attempts: records.map(record => record.attempts.length), exact: true, answer: JSON.parse(result.stdout) }));
  } catch (error) {
    testFailed = true;
    throw error;
  } finally { await removeTestDirectory(dir, testFailed); }
});
