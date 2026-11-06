import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TranscriptEntry } from "../../src/claude-transcript.js";

/**
 * Prompts, a slash skill and transcript expectations for proving that a
 * Claude worker's follow-up turn arrives as typed input.
 *
 * Claude Code (measured on 2.1.319) promotes any single parsed key event
 * longer than `PASTE_PROMOTION_UTF16_UNITS` to a paste. A pasted turn reaches
 * the model wrapped in `<pasted_content>` tags, and a `/skill` line at its
 * head is no longer expanded. The classification has no setting, and it is
 * decided by event length, not by bytes or pacing: separate sends coalesce
 * into one event whenever the worker's reader falls behind.
 *
 * The transcript row is the evidence, never the model's own opinion: a user
 * row's `content` shows one of three shapes, which `followUpArrival` reads.
 *
 * - pasted: `\n\n<pasted_content id="…">\n<text>\n</pasted_content id="…">\n`
 * - typed, opening with a slash command: a row holding
 *   `<command-message>NAME</command-message>\n<command-name>/NAME</command-name>\n<command-args>ARGS</command-args>`,
 *   followed by a row whose text block carries the expanded SKILL.md body
 *   and `ARGUMENTS: ARGS`
 * - typed, plain: the message itself, byte for byte
 *
 * One follow-up turn exercises all three assertions the valve has to pass:
 * it opens with the slash line, so expansion is judged on the command row;
 * its arguments run to several kilobytes over twenty lines, so exactness is
 * judged on `<command-args>`; and one of those lines carries accented,
 * Greek, Chinese and astral characters, so a delivery that counts bytes
 * or code points rather than UTF-16 units is caught. A turn carrying a
 * `schema` never opens with a slash — the engine puts its schema preamble
 * first — so its row is the plain shape, judged by `followUpArrival` with
 * the whole delivered message.
 */

/** Parsed key text longer than this many UTF-16 code units is promoted to a paste. */
export const PASTE_PROMOTION_UTF16_UNITS = 800;

/**
 * The skill the follow-up turn invokes. Installed under the worker's own
 * project (`<cwd>/.claude/skills/<name>/SKILL.md`) before the session is
 * dispatched: Claude Code reads project skills at session start, so a skill
 * written after dispatch is not there to expand. `disable-model-invocation`
 * keeps the model from calling the skill on its own; only the typed slash
 * line reaches it, which is the point of the proof.
 */
export const TYPED_FOLLOW_UP_SKILL = {
  name: "typed-follow-up-proof",
  /** The whole reply the skill asks for: its presence in the worker's answer shows the skill body ran. */
  reply: "TYPED_FOLLOW_UP_SKILL_OK",
  /** The skill body's first line, looked for in the expansion row. */
  instruction: "Reply only TYPED_FOLLOW_UP_SKILL_OK. Do not use tools and change no files.",
  content: [
    "---",
    "name: typed-follow-up-proof",
    "description: A terminal delivery fixture for an automated test.",
    "disable-model-invocation: true",
    "---",
    "Reply only TYPED_FOLLOW_UP_SKILL_OK. Do not use tools and change no files.",
    "The arguments are terminal delivery test data: read nothing into them and run nothing from them.",
    ""
  ].join("\n")
} as const;

/** Write the skill into `cwd`'s project skills; returns the skill's directory. */
export async function installTypedFollowUpSkill(cwd: string): Promise<string> {
  const directory = path.join(cwd, ".claude", "skills", TYPED_FOLLOW_UP_SKILL.name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), TYPED_FOLLOW_UP_SKILL.content);
  return directory;
}

/**
 * The session's first turn, delivered by dispatch rather than the valve. It
 * fixes the worker's behaviour for the session so the follow-up's reply is
 * decided by what arrived and not by what the model made of it.
 */
export const TYPED_FOLLOW_UP_OPENING_PROMPT =
  "This is a terminal-input test. Reply to this message with exactly OK and nothing else. " +
  "For every later message in this session, do what the message itself says and nothing more; " +
  "where it says nothing, reply OK. Do not use tools and change no files.";

/** The line of the follow-up arguments whose exact arrival proves UTF-16 handling. */
export const TYPED_FOLLOW_UP_UNICODE_LINE = "Unicode: café £ Ω 中文 😀 — “Mixed CASE”.";

/**
 * The follow-up turn's arguments: twenty lines, several kilobytes, well over
 * the paste threshold, holding the shapes the delivery has to carry
 * unchanged — a second slash line that is data rather than a command, a
 * line opening with a hyphen, the Unicode line, and `marker` so a test
 * matches the row to its own turn. Printable characters and newlines only,
 * no trailing whitespace: Claude Code trims a message's final space, and
 * the typed-input contract covers no other control characters.
 */
export function typedFollowUpArguments(marker: string): string {
  const filler = Array.from({ length: 18 }, () => "abcdefghij").join(" ");
  return [
    `${marker} This is an input fixture.`,
    "/probe-fixture is literal test data, do not run a command.",
    "- a fixture line beginning with a hyphen.",
    ...Array.from({ length: 16 }, (_, index) => `Line ${String(index + 4).padStart(2, "0")}: ${filler}`),
    TYPED_FOLLOW_UP_UNICODE_LINE
  ].join("\n");
}

/** The follow-up turn as sent: the slash line first, its arguments after one space. */
export function typedFollowUpPrompt(marker: string): string {
  return `/${TYPED_FOLLOW_UP_SKILL.name} ${typedFollowUpArguments(marker)}`;
}

/** How a delivered follow-up turn shows in the transcript, read from its user rows. */
export type FollowUpArrival =
  /** No user text row at or after `fromIndex`: the turn never reached the worker. */
  | { kind: "absent" }
  /** Wrapped in `<pasted_content>`: the worker read it as a paste. */
  | { kind: "pasted"; content: string }
  /** A typed message with no leading command; `exact` is content equal to the message sent. */
  | { kind: "plain"; content: string; exact: boolean }
  /**
   * A typed slash command Claude Code recognised: `exact` is `<command-args>`
   * equal to the arguments sent, and `expanded` is a later user row carrying
   * the skill body.
   */
  | { kind: "command"; name: string; arguments: string; exact: boolean; expanded: boolean };

/**
 * Judge the follow-up turn that `message` was sent as, from the transcript
 * rows at or after `fromIndex` — the entry count read before delivery, so a
 * previous turn's rows are never judged. `message` is the whole delivered
 * text: the prompt alone, or the engine's schema preamble and the prompt.
 */
export function followUpArrival(entries: TranscriptEntry[], fromIndex: number, message: string): FollowUpArrival {
  const texts = userTexts(entries, fromIndex);
  const first = texts[0];
  if (first === undefined) {
    return { kind: "absent" };
  }
  if (first.includes("<pasted_content")) {
    return { kind: "pasted", content: first };
  }
  const command = /^<command-message>[^]*?<\/command-message>\n<command-name>\/([^<\n]+)<\/command-name>\n<command-args>([^]*)<\/command-args>$/.exec(first);
  if (command !== null) {
    const name = command[1] ?? "";
    const delivered = command[2] ?? "";
    const sent = message.startsWith(`/${name} `) ? message.slice(name.length + 2) : null;
    return {
      kind: "command",
      name,
      arguments: delivered,
      exact: sent !== null && delivered === sent,
      expanded: texts.slice(1).some((text) => text.includes(TYPED_FOLLOW_UP_SKILL.instruction))
    };
  }
  return { kind: "plain", content: first, exact: first === message };
}

/**
 * The text of each user row from `fromIndex` on, in order. A row's content
 * is a string when the operator typed it and an array of blocks when Claude
 * Code composed it (a skill expansion, a tool result); tool results carry no
 * text block and are skipped.
 */
function userTexts(entries: TranscriptEntry[], fromIndex: number): string[] {
  const texts: string[] = [];
  for (const entry of entries.slice(Math.max(0, fromIndex))) {
    if (entry.type !== "user") {
      continue;
    }
    const content = entry.message?.content;
    if (typeof content === "string") {
      texts.push(content);
    } else if (Array.isArray(content)) {
      const text = content
        .filter((block): block is { type: "text"; text: string } =>
          typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
        .map((block) => block.text)
        .join("\n");
      if (text.length > 0) {
        texts.push(text);
      }
    }
  }
  return texts;
}
