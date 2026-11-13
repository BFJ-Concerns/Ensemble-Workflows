import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { removeTestDirectory } from "../failure-evidence.js";
import { parseTranscriptText } from "../../src/claude-transcript.js";
import { findOnlyFile, runNode } from "../integration/estate-process.js";
import {
  TYPED_FOLLOW_UP_OPENING_PROMPT,
  TYPED_FOLLOW_UP_SKILL,
  followUpArrival,
  installTypedFollowUpSkill,
  typedFollowUpArguments,
  typedFollowUpPrompt
} from "./claude-follow-up-typed-prompts.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

interface AgentRecord {
  status: string;
  session: { id: number; turn: number };
  transcripts: Array<{ path: string; source: string; session_id: string }>;
}

// The public session journey uses the shared daemon, touches only its own
// session, and judges delivery from Claude's native input rows.
test("built Claude follow-ups arrive typed, exact and expanded through the prompt editor", {
  skip: process.env.ENSEMBLE_LIVE !== "1" ? "ENSEMBLE_LIVE must be 1" : false, timeout: 900_000
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-typed-follow-up-"));
  let testFailed = false;
  try {
    await installTypedFollowUpSkill(directory);
    const store = path.join(directory, "records");
    await mkdir(store);
    const commandMarker = `COMMAND_${randomUUID()}`;
    const plainMarker = `PLAIN_${randomUUID()}`;
    const command = typedFollowUpPrompt(commandMarker);
    // Reuse the authored fixture text and extend it with indexed Unicode data.
    const plain = typedFollowUpArguments(plainMarker) + "\n\n" +
      Array.from({ length: 8_000 }, (_, index) => `${index}: café £ Ω 中文 😀; Mixed CASE.`).join("\n");
    assert.ok(Buffer.byteLength(plain) > 300_000);
    const workflow = path.join(directory, "workflow.mjs");
    await writeFile(workflow, `
      export const meta = { name: "typed-follow-up" };
      const held = session(${JSON.stringify({ engine: "claude", model: "claude-haiku-5-5", effort: "low", cwd: directory, timeoutMs: 240_000, maxAttempts: 1 })});
      try {
        await held.send(${JSON.stringify(TYPED_FOLLOW_UP_OPENING_PROMPT)});
        await held.send(${JSON.stringify(command)});
        await held.send(${JSON.stringify(plain)});
        await held.send(${JSON.stringify(`/${TYPED_FOLLOW_UP_SKILL.name}`)});
      } finally { await held.close(); }
      return "complete";
    `);
    const result = await runNode([bundle, "--timeout", "800000", workflow], {
      NODE_TEST_CONTEXT: undefined,
      ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: store, ENSEMBLE_STATUS: "0"
    }, 850_000);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), "complete");
    assert.match(result.stderr, /\[sentinel\]/);

    const archive = path.dirname(await findOnlyFile(store, "manifest.json"));
    const files = (await readdir(archive, { recursive: true })).filter((file) => path.basename(file) === "agent.json");
    const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(archive, file), "utf8")) as AgentRecord));
    records.sort((left, right) => left.session.turn - right.session.turn);
    assert.equal(records.length, 4, "the held session must retain all four turns");
    assert.equal(new Set(records.map((record) => record.session.id)).size, 1);
    assert.equal(new Set(records.flatMap((record) => record.transcripts.map((ref) => ref.session_id))).size, 1);

    for (const [index, marker, prompt, kind] of [
      [1, commandMarker, command, "command"],
      [2, plainMarker, plain, "plain"],
      [3, TYPED_FOLLOW_UP_SKILL.name, `/${TYPED_FOLLOW_UP_SKILL.name}`, "command"]
    ] as const) {
      const reference = records[index]?.transcripts[0];
      assert.ok(reference, "turn has no native transcript");
      assert.equal(reference.source, "claude-session-jsonl");
      const entries = parseTranscriptText(await readFile(path.join(archive, reference.path), "utf8"));
      // Claude writes typed input as string-content user rows and skill
      // expansion as text blocks. Count every input, including fragments
      // without our marker, rather than trusting the runtime's turn count.
      const inputs = entries.filter((entry) => entry.type === "user" && typeof entry.message?.content === "string");
      // Locate this test's unique input row, never an assistant's echo or
      // an earlier turn's classification. No transcript rows are seeded.
      const start = index === 3
        ? entries.findLastIndex((entry) => entry.type === "user" && typeof entry.message?.content === "string")
        : entries.findIndex((entry) => entry.type === "user" && (JSON.stringify(entry.message?.content) ?? "").includes(marker));
      assert.ok(start >= 0, "the follow-up's input row is missing");
      // Retain the native arrival rows before assertions, including failures.
      // The fixture owns their text; credentials and unrelated rows are
      // not captured. These TAP diagnostics survive a failed delivery check.
      const rows = entries.slice(start, start + (kind === "command" ? 2 : 1)).filter((entry) => entry.type === "user").map((entry) => {
        const row = entry as typeof entry & { uuid?: string; timestamp?: string };
        return { type: row.type, uuid: row.uuid, timestamp: row.timestamp, content: row.message?.content };
      });
      console.log(JSON.stringify({ kind, rows: rows.map(row => ({ ...row, content: (typeof row.content === "string" ? row.content : JSON.stringify(row.content))?.slice(0, 160) })) }));
      const arrival = followUpArrival(entries, start, prompt);
      assert.equal(arrival.kind, kind, `unexpected native input shape: ${JSON.stringify(arrival).slice(0, 400)}`);
      if (arrival.kind === "command") {
        assert.equal(arrival.name, TYPED_FOLLOW_UP_SKILL.name);
        assert.equal(arrival.exact, true, "the command arguments changed in transit");
        assert.equal(arrival.expanded, true, "the native transcript has no skill expansion");
      } else if (arrival.kind === "plain") {
        assert.equal(arrival.exact, true, "the plain input changed in transit");
      }
      assert.equal(inputs.length, index + 1, "a follow-up split into extra native submissions");
    }
    assert.deepEqual(records.map((record) => record.status), ["complete", "complete", "complete", "complete"]);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    await removeTestDirectory(directory, testFailed);
  }
});
