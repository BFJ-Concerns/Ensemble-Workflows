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
    "For the ship `oak` it is `SIGNAL-OAK-KESTREL`. With no ship name given, it is `SIGNAL-HARBOUR-KESTREL`.",
    "Answer with the signal and nothing else.",
    "",
    "Arguments: $ARGUMENTS",
    ""
  ].join("\n"));
  return project;
}

interface AgentRecord {
  status: string;
  attempts: Array<{ failure: { kind: string; message: string } | null; classification: unknown }>;
  transcripts: Array<{ path: string }>;
}

/**
 * Run the workflow and read back each agent's record and first transcript,
 * in dispatch order. `answered` (the default) requires every call to have
 * been delivered and answered in one attempt.
 */
async function runWorkflow(dir: string, body: string, answered = true): Promise<{ output: unknown; transcripts: TranscriptEntry[][]; records: AgentRecord[] }> {
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
  const records: AgentRecord[] = [];
  for (const file of files) {
    const record = JSON.parse(await readFile(path.join(archive, file), "utf8")) as AgentRecord;
    records.push(record);
    if (answered) {
      assert.equal(record.status, "complete");
      assert.deepEqual(record.attempts.map(attempt => attempt.failure), [null], "the opening is delivered and answered in one attempt");
    }
    // A command that opened a panel leaves no transcript to archive.
    const reference = record.transcripts[0];
    if (answered) assert.ok(reference);
    transcripts.push(reference === undefined ? [] : parseTranscriptText(await readFile(path.join(archive, reference.path), "utf8")));
  }
  return { output: JSON.parse(result.stdout), transcripts, records };
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

test("a one-shot Claude worker runs a skill named with no arguments, its schema contract on the next lines", { skip, timeout: 360_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opening-skill-bare-"));
  let testFailed = false;
  try {
    const project = await projectWithSkill(dir);
    const schema = { type: "object", additionalProperties: false, required: ["signal"], properties: { signal: { type: "string" } } };
    // Claude records no separator between a bare command and the contract
    // after it; the attempt's exact receipt is what runWorkflow requires.
    const { output, transcripts } = await runWorkflow(dir, `
      return await agent("/harbour-signal", ${JSON.stringify({ ...worker, cwd: project, schema })});
    `);
    assert.deepEqual(output, { signal: "SIGNAL-HARBOUR-KESTREL" });
    assert.match(firstSubmission(transcripts[0]!), /<command-name>\/harbour-signal<\/command-name>\n<command-args>When finished/);
    console.log(JSON.stringify({ case: "bare-command-schema", answer: output, expanded: true }));
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

/** A record's single attempt failed at once on the command, named, and was not retried. */
function assertCommandNotSkill(record: AgentRecord | undefined, what: string, command: string): void {
  assert.ok(record);
  assert.equal(record.status, "failed");
  assert.equal(record.attempts.length, 1, "the call is not retried");
  const failure = record.attempts[0]?.failure;
  assert.equal(failure?.kind, "claude-command-not-skill", failure?.message);
  assert.deepEqual(record.attempts[0]?.classification, { class: "unclassified", rule: "claude.command-not-skill" });
  assert.ok(failure?.message.startsWith(`${what} opens with ${command}, which Claude Code took as a command, and no skill named ${command} ran: `), failure?.message);
}

test("a Claude task opening with an unknown /word fails at once naming it, unretried, while one opening with a path is answered", { skip, timeout: 360_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opening-unknown-"));
  let testFailed = false;
  try {
    const project = await projectWithSkill(dir);
    const name = ship();
    // maxAttempts above one: the record must still hold one attempt. The
    // lean worker loads no installed skills, the project's included.
    const { output, records } = await runWorkflow(dir, `
      const options = ${JSON.stringify({ ...worker, cwd: project, maxAttempts: 3 })};
      const started = Date.now();
      const unknown = await agent("/frobnicate-xyz is not a command. Reply with exactly the word OK.", options);
      const unknownMs = Date.now() - started;
      const lean = await agent(${JSON.stringify(`/harbour-signal ${name}`)}, { ...options, lean: true });
      const path = await agent("/etc/hostname is a file on this machine. Reply with exactly the word OK and nothing else.", options);
      const panelStarted = Date.now();
      const panel = await agent("/help please. Reply with exactly the word OK.", options);
      const panelMs = Date.now() - panelStarted;
      const clearStarted = Date.now();
      const clear = await agent("/clear", options);
      const clearMs = Date.now() - clearStarted;
      return { unknown, unknownMs, lean, path, panel, panelMs, clear, clearMs };
    `, false);
    const result = output as { unknown: unknown; unknownMs: number; lean: unknown; path: unknown; panel: unknown; panelMs: number; clear: unknown; clearMs: number };
    assert.equal(result.unknown, null);
    assert.equal(result.lean, null);
    assert.equal(result.panel, null);
    assert.ok(result.panelMs < 30_000, `the panel command took ${result.panelMs}ms, as long as a missing receipt`);
    assert.equal(result.clear, null);
    assert.ok(result.clearMs < 30_000, `the session-replacing command took ${result.clearMs}ms, as long as a missing receipt`);
    assert.ok(result.unknownMs < 30_000, `the unknown command took ${result.unknownMs}ms, as long as a missing receipt`);
    assert.match(String(result.path).trim(), /^OK\.?$/);
    assert.equal(records.length, 5);
    assertCommandNotSkill(records[0], "the opening prompt", "/frobnicate-xyz");
    assert.match(records[0]!.attempts[0]!.failure!.message, /knows no skill or command named \/frobnicate-xyz where the worker runs/);
    assertCommandNotSkill(records[1], "the opening prompt", "/harbour-signal");
    assert.deepEqual(records[2]?.attempts.map(attempt => attempt.failure), [null]);
    assertCommandNotSkill(records[3], "the opening prompt", "/help");
    assert.match(records[3]!.attempts[0]!.failure!.message, /opened an interactive panel/);
    assertCommandNotSkill(records[4], "the opening prompt", "/clear");
    console.log(JSON.stringify({ case: "unknown-command", unknownMs: result.unknownMs, path: result.path, panelMs: result.panelMs, clearMs: result.clearMs }));
  } catch (error) {
    testFailed = true;
    throw error;
  } finally { await removeTestDirectory(dir, testFailed); }
});

test("a held Claude session's follow-up opening with an unknown /word fails that turn alone, and the session answers the next", { skip, timeout: 360_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-opening-unknown-session-"));
  let testFailed = false;
  try {
    const { output, records } = await runWorkflow(dir, `
      const held = session(${JSON.stringify({ ...worker, cwd: dir, maxAttempts: 3 })});
      try {
        const first = await held.send("Reply with exactly the word FIRST and nothing else.");
        const unknown = await held.send("/frobnicate-xyz now. Reply with exactly the word OK.");
        const panel = await held.send("/help now. Reply with exactly the word OK.");
        const third = await held.send("Reply with exactly the word THIRD and nothing else.");
        return { first, unknown, panel, third };
      } finally { await held.close(); }
    `, false);
    const result = output as { first: unknown; unknown: unknown; panel: unknown; third: unknown };
    assert.equal(String(result.first).trim(), "FIRST");
    assert.equal(result.unknown, null);
    assert.equal(result.panel, null);
    assert.equal(String(result.third).trim(), "THIRD");
    assertCommandNotSkill(records[1], "the follow-up turn", "/frobnicate-xyz");
    assertCommandNotSkill(records[2], "the follow-up turn", "/help");
    console.log(JSON.stringify({ case: "unknown-command-session", answer: output }));
  } catch (error) {
    testFailed = true;
    throw error;
  } finally { await removeTestDirectory(dir, testFailed); }
});
