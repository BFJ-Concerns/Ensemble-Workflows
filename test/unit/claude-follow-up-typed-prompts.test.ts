import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTranscriptText } from "../../src/claude-transcript.js";
import {
  PASTE_PROMOTION_UTF16_UNITS,
  TYPED_FOLLOW_UP_SKILL,
  TYPED_FOLLOW_UP_UNICODE_LINE,
  followUpArrival,
  installTypedFollowUpSkill,
  typedFollowUpArguments,
  typedFollowUpPrompt
} from "../live/claude-follow-up-typed-prompts.js";

// The fixture's own contract, checked without a worker: the prompt has the
// shape that defeats a byte-stream delivery, and the arrival judge reads the
// three transcript shapes Claude Code writes. The row texts below follow the
// rows measured on Claude Code 2.1.319: a pasted turn, a typed slash command
// with its expansion row, and a plain typed message.

const marker = "FOLLOW_UP_0123";
const prompt = typedFollowUpPrompt(marker);
const sentArguments = typedFollowUpArguments(marker);

test("the follow-up prompt opens with the slash line and is long, multi-line, mixed-script typed text", () => {
  assert.ok(prompt.startsWith(`/${TYPED_FOLLOW_UP_SKILL.name} ${marker} `));
  assert.ok(prompt.length > PASTE_PROMOTION_UTF16_UNITS, `only ${prompt.length} UTF-16 units: a single event this short is never a paste`);
  assert.ok(Buffer.byteLength(prompt, "utf8") > 3_000, "the turn should run to several kilobytes");
  assert.equal(prompt.split("\n").length, 20);
  assert.ok(prompt.endsWith(TYPED_FOLLOW_UP_UNICODE_LINE));
  // A delivery that splits on code points or bytes instead of UTF-16 units is
  // caught by the astral character: one code point, two units.
  assert.ok([...TYPED_FOLLOW_UP_UNICODE_LINE].some((character) => character.length === 2));
  // Printable text and newlines only: the typed-input contract covers nothing else.
  const controls = [...prompt].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 10) || (code >= 127 && code < 160);
  });
  assert.deepEqual(controls, []);
  assert.equal(prompt, prompt.trimEnd());
});

test("installTypedFollowUpSkill writes the skill where Claude Code reads a project's skills", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "typed-follow-up-skill-"));
  try {
    const directory = await installTypedFollowUpSkill(cwd);
    assert.equal(directory, path.join(cwd, ".claude", "skills", TYPED_FOLLOW_UP_SKILL.name));
    const content = await readFile(path.join(directory, "SKILL.md"), "utf8");
    assert.equal(content, TYPED_FOLLOW_UP_SKILL.content);
    assert.match(content, new RegExp(`^name: ${TYPED_FOLLOW_UP_SKILL.name}$`, "m"));
    assert.ok(content.includes(TYPED_FOLLOW_UP_SKILL.instruction));
    assert.ok(TYPED_FOLLOW_UP_SKILL.instruction.includes(TYPED_FOLLOW_UP_SKILL.reply));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("followUpArrival reads a pasted turn from its wrapper", () => {
  const entries = parseTranscriptText([
    user("earlier turn, before the mark"),
    user(`\n\n<pasted_content id="bf49">\n${prompt}\n</pasted_content id="bf49">\n`)
  ].join("\n"));

  assert.deepEqual(followUpArrival(entries, 1, prompt), {
    kind: "pasted",
    content: `\n\n<pasted_content id="bf49">\n${prompt}\n</pasted_content id="bf49">\n`
  });
});

test("followUpArrival reads a typed slash command, its exact arguments and its expansion", () => {
  const skillDirectory = `/work/.claude/skills/${TYPED_FOLLOW_UP_SKILL.name}`;
  const entries = parseTranscriptText([
    user("earlier turn, before the mark"),
    user(commandRow(TYPED_FOLLOW_UP_SKILL.name, sentArguments)),
    user([{ type: "text", text: `Base directory for this skill: ${skillDirectory}\n\n${TYPED_FOLLOW_UP_SKILL.instruction}\n\n\nARGUMENTS: ${sentArguments}` }]),
    assistant(TYPED_FOLLOW_UP_SKILL.reply)
  ].join("\n"));

  assert.deepEqual(followUpArrival(entries, 1, prompt), {
    kind: "command",
    name: TYPED_FOLLOW_UP_SKILL.name,
    arguments: sentArguments,
    exact: true,
    expanded: true
  });
});

test("followUpArrival reports a command whose arguments lost a character as inexact", () => {
  const torn = sentArguments.slice(0, 1048) + sentArguments.slice(1049);
  const entries = parseTranscriptText(user(commandRow(TYPED_FOLLOW_UP_SKILL.name, torn)));

  const arrival = followUpArrival(entries, 0, prompt);
  assert.equal(arrival.kind, "command");
  assert.equal(arrival.kind === "command" && arrival.exact, false);
  assert.equal(arrival.kind === "command" && arrival.expanded, false);
});

test("followUpArrival reads a plain typed message against the whole delivered text", () => {
  const preamble = "For this reply, include in your FINAL message a JSON value that conforms to this JSON Schema.\n{}\n\n";
  const message = preamble + sentArguments;
  const entries = parseTranscriptText(user(message));

  assert.deepEqual(followUpArrival(entries, 0, message), { kind: "plain", content: message, exact: true });
  assert.deepEqual(followUpArrival(entries, 0, sentArguments), { kind: "plain", content: message, exact: false });
});

test("followUpArrival reports a turn with no user row after the mark as absent", () => {
  const entries = parseTranscriptText([user("earlier turn"), assistant("OK")].join("\n"));

  assert.deepEqual(followUpArrival(entries, 2, prompt), { kind: "absent" });
  // A tool result is a user row Claude Code composed, not the operator's turn.
  const toolResult = parseTranscriptText(user([{ type: "tool_result", tool_use_id: "t1", content: "ls output" }]));
  assert.deepEqual(followUpArrival(toolResult, 0, prompt), { kind: "absent" });
});

/** A user row as Claude Code persists it: string content for typed text, blocks for composed content. */
function user(content: unknown): string {
  return JSON.stringify({ type: "user", message: { role: "user", content } });
}

function assistant(text: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } });
}

/** The row Claude Code writes for a typed `/name args` line it recognised as a command. */
function commandRow(name: string, delivered: string): string {
  return `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${delivered}</command-args>`;
}
