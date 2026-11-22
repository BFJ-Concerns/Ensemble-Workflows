import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { archivedAgent, assertEach, runLauncher } from "./launcher.js";
import { liveZCodeModel } from "./live-models.js";

const liveSkip = process.env.ENSEMBLE_LIVE !== "1"
  ? "ENSEMBLE_LIVE must be 1"
  : liveZCodeModel === undefined ? "ENSEMBLE_LIVE_ZCODE_MODEL is unset" : false;

test("live built CLI dispatches zcode workers: a text answer, a schema answer, and a held session that resumes", {
  skip: liveSkip, timeout: 600_000
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-zcode-"));
  const recordStore = path.join(directory, "records");
  const script = path.join(directory, "workflow.js");
  const model = JSON.stringify(liveZCodeModel);
  await writeFile(script, `export const meta = { name: "zcode-live" };
const text = await agent("Reply with exactly the word ZCODE_TEXT_OK and nothing else.", {
  engine: "zcode", model: ${model}, effort: "low", label: "text", maxAttempts: 2
});
const shaped = await agent("Report the number 7 as the value of n.", {
  engine: "zcode", model: ${model}, effort: "low", label: "schema", maxAttempts: 2,
  schema: { type: "object", required: ["n"], additionalProperties: false, properties: { n: { type: "integer" } } }
});
const held = session({ engine: "zcode", model: ${model}, effort: "low", label: "held", maxAttempts: 2 });
await held.send("Remember the code word HELD_PELICAN. Reply with exactly OK.");
const recalled = await held.send("What was the code word? Reply with the code word alone.");
await held.close();
return { text, shaped, recalled };
`);
  try {
    const result = await runLauncher([script], {
      cwd: directory,
      env: { ...process.env, ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: recordStore, ENSEMBLE_STATUS: "0" },
      signal: t.signal,
      timeoutMs: 540_000
    });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { text: string; shaped: { n: number }; recalled: string };
    const text = await archivedAgent(recordStore, "text");
    const shaped = await archivedAgent(recordStore, "schema");
    const transcript = await readFile(path.join(text.archiveDirectory, text.transcripts[0]?.path ?? "missing"), "utf8");
    assertEach([
      ["text answer", () => assert.match(output.text, /ZCODE_TEXT_OK/)],
      ["schema answer", () => assert.deepEqual(output.shaped, { n: 7 })],
      ["held session carried its context", () => assert.match(output.recalled, /HELD_PELICAN/)],
      ["text worker ran on zcode", () => assert.equal(text.engine, "zcode")],
      ["schema worker validated", () => assert.deepEqual(shaped.validated_output, { n: 7 })],
      ["spend recorded", () => assert.ok((text.attempts[0]?.token_usage_events[0]?.total?.totalTokens ?? 0) > 0)],
      ["transcript archived", () => assert.match(transcript, /"type":"result"/)]
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
