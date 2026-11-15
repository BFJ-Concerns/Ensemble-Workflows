import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { removeTestDirectory } from "../failure-evidence.js";
import { parseTranscriptText, type TranscriptEntry } from "../../src/claude-transcript.js";
import { findOnlyFile, runNode } from "../integration/estate-process.js";
import { suiteClaudeDaemon } from "./suite-claude-daemon.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const skip = process.env.ENSEMBLE_LIVE !== "1" ? "ENSEMBLE_LIVE must be 1" : false;
const worker = { engine: "claude", model: "claude-haiku-5-5", effort: "low", timeoutMs: 120_000, maxAttempts: 1 };

/**
 * A project whose only skill is one the test wrote: its answer carries a
 * word the model can produce only by reading the skill, around a ship name
 * the caller passes as the skill's arguments.
 */
async function projectWithSkill(dir: string): Promise<string> {
  const project = path.join(dir, "project");
  const skill = path.join(project, ".claude", "skills", "harbour-signal");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), [
    "---",
    "name: harbour-signal",
    "description: Give the harbour signal for a ship name.",
    "---",
    "",
    "The harbour signal for a ship is `SIGNAL-`, then the ship name given as the arguments in upper case, then `-KESTREL`.",
    "For the ship `oak` it is `SIGNAL-OAK-KESTREL`. Answer with the signal and nothing else.",
    "",
    "Arguments: $ARGUMENTS",
    ""
  ].join("\n"));
  return project;
}

async function runWorkflow(dir: string, body: string): Promise<{ output: unknown; transcripts: TranscriptEntry[][] }> {
  // The workers run under the suite's shared daemon; never let a launch
  // here start one on demand.
  const daemon = await suiteClaudeDaemon();
  assert.notEqual(daemon.origin, "unavailable", "the suite did not establish its Claude daemon");
  const workflow = path.join(dir, "workflow.mjs");
  await writeFile(workflow, `export const meta = { name: "claude-opening-skill" };\n${body}`);
  const store = path.join(dir, "records");
  const result = await runNode([bundle, "--timeout", "300000", workflow], {
    NODE_TEST_CONTEXT: undefined, ENSEMBLE_RUN_RECORD: "1", ENSEMBLE_RUN_RECORD_DIR: store, ENSEMBLE_STATUS: "0"
  }, 330_000);
  assert.equal(result.code, 0, result.stderr);
  const archive = path.dirname(await findOnlyFile(store, "manifest.json"));
  const files = (await readdir(archive, { recursive: true })).filter(file => path.basename(file) === "agent.json").sort();
  const transcripts: TranscriptEntry[][] = [];
  for (const file of files) {
    const record = JSON.parse(await readFile(path.join(archive, file), "utf8")) as {
      status: string; attempts: Array<{ failure: unknown }>; transcripts: Array<{ path: string }>
    };
    assert.equal(record.status, "complete");
    assert.deepEqual(record.attempts.map(attempt => attempt.failure), [null], "the opening is delivered and answered in one attempt");
    const reference = record.transcripts[0];
    assert.ok(reference);
    transcripts.push(parseTranscriptText(await readFile(path.join(archive, reference.path), "utf8")));
  }
  return { output: JSON.parse(result.stdout), transcripts };
}

/** The first message the session recorded from its submitter. */
function firstSubmission(entries: TranscriptEntry[]): string {
  const first = entries.find(entry => entry.type === "user" && !entry.isMeta && typeof entry.message?.content === "string");
  assert.ok(first, "the transcript records the opening message");
  return first.message?.content as string;
}

function ship(): string {
  return `brig${randomBytes(3).toString("hex")}`;
}

test("a one-shot Claude worker runs a project skill named at the head of its task, a trailing newline included", { skip, timeout: 360_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opening-skill-"));
  let testFailed = false;
  try {
    const project = await projectWithSkill(dir);
    const names = [ship(), ship()];
    // The second task ends in a newline, as a template literal's often does.
    const tasks = [`/harbour-signal ${names[0]}`, `/harbour-signal ${names[1]}\n`];
    const { output, transcripts } = await runWorkflow(dir, `
      const options = ${JSON.stringify({ ...worker, cwd: project })};
      const answers = [];
      for (const task of ${JSON.stringify(tasks)}) answers.push(await agent(task, options));
      return answers;
    `);
    assert.deepEqual((output as unknown[]).map(answer => String(answer).trim()), names.map(name => `SIGNAL-${name.toUpperCase()}-KESTREL`));
    assert.equal(transcripts.length, 2);
    for (const transcript of transcripts) {
      const opening = firstSubmission(transcript);
      assert.match(opening, /^<command-message>[^]*<command-name>\/harbour-signal<\/command-name>/, "Claude Code expanded the skill natively");
      assert.equal(opening.includes("automated worker dispatched"), false);
    }
    console.log(JSON.stringify({ case: "one-shot", answer: output, expanded: true }));
  } catch (error) {
    testFailed = true;
    throw error;
  } finally { await removeTestDirectory(dir, testFailed); }
});

test("a held Claude session's first turn runs a skill named at its head, its schema contract after the task", { skip, timeout: 360_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opening-skill-session-"));
  let testFailed = false;
  try {
    const project = await projectWithSkill(dir);
    const name = ship();
    const schema = { type: "object", additionalProperties: false, required: ["signal"], properties: { signal: { type: "string" } } };
    const { output, transcripts } = await runWorkflow(dir, `
      const held = session(${JSON.stringify({ ...worker, cwd: project })});
      try {
        return await held.send(${JSON.stringify(`/harbour-signal ${name}`)}, { schema: ${JSON.stringify(schema)} });
      } finally { await held.close(); }
    `);
    assert.deepEqual(output, { signal: `SIGNAL-${name.toUpperCase()}-KESTREL` });
    const opening = firstSubmission(transcripts[0]!);
    assert.match(opening, /<command-name>\/harbour-signal<\/command-name>/, "Claude Code expanded the skill natively");
    assert.match(opening, /<command-args>[^]*JSON Schema[^]*<\/command-args>/, "the schema contract follows the task");
    console.log(JSON.stringify({ case: "session-first-turn", answer: output, expanded: true }));
  } catch (error) {
    testFailed = true;
    throw error;
  } finally { await removeTestDirectory(dir, testFailed); }
});

test("a lean Claude worker holds the standing instructions in its system prompt, not its first message", { skip, timeout: 360_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opening-standing-"));
  let testFailed = false;
  try {
    const task = "Your system prompt ends with instructions about how you were dispatched. " +
      "Quote their first sentence exactly, and reply with nothing else.";
    const { output, transcripts } = await runWorkflow(dir, `
      return await agent(${JSON.stringify(task)}, ${JSON.stringify({ ...worker, cwd: dir, lean: true })});
    `);
    assert.match(String(output), /automated worker dispatched by the Ensemble orchestration harness/);
    assert.equal(firstSubmission(transcripts[0]!), task, "the first message is the task alone");
    console.log(JSON.stringify({ case: "lean-standing", answer: output }));
  } catch (error) {
    testFailed = true;
    throw error;
  } finally { await removeTestDirectory(dir, testFailed); }
});
