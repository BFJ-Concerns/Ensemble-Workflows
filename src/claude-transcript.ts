import { readFile } from "node:fs/promises";

import { ClaudeTranscriptError } from "./errors.js";

import type { TokenUsageBreakdown } from "./types.js";

/**
 * A Claude background session persists its conversation as newline-delimited
 * JSON at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. This module is
 * the *only* load-bearing reader of that file: `claude logs` emits mangled TUI
 * frames, so the worker's answer is recovered here from the clean transcript.
 *
 * It is deliberately pure (bar one thin `readFile` helper) and tolerant — the
 * transcript is a research-preview surface that may grow fields or interleave
 * entry types, so unknown shapes are skipped, never fatal.
 */

/** One JSONL line. We model only the fields we read; everything else is ignored. */
export interface TranscriptEntry {
  type?: string;
  message?: TranscriptMessage;
  /**
   * Claude Code's record of a queued prompt absorbed into a turn already
   * in flight (`attachment.type === "queued_command"`, the prompt in
   * `attachment.prompt`): a task notification that lands mid-turn reaches
   * the model this way rather than as a `user` row. Read by
   * `outstandingBackgroundTasks`.
   */
  attachment?: unknown;
  /**
   * The effort level Claude Code served this entry at — a top-level field
   * on every assistant entry since Claude Code 2.1.283 (measured
   * 2026-09-27; absent on older builds). Read by `effortSince`.
   */
  effort?: unknown;
  /**
   * Claude Code's own annotation on a synthetic reply written in place of
   * a model answer because the API refused the request (observed
   * 2026-08-30 on Claude Code 2.1.251): the HTTP status and the API's
   * error code beside the diagnostic text. Read by `apiErrorSince` so the
   * failure classifier judges a refusal from the engine's structured
   * account, never from the diagnostic prose.
   */
  isApiErrorMessage?: unknown;
  apiErrorStatus?: unknown;
  error?: unknown;
}

/** The API refusal a synthetic reply reports, as its structured fields say it. */
export interface TranscriptApiError {
  status: number | null;
  code: string | null;
}

export interface TranscriptFile {
  path: string;
  text: string;
  entries: TranscriptEntry[];
}

interface TranscriptMessage {
  role?: string;
  /**
   * The API message id (`msg_…`). Claude Code writes one API call's reply
   * as several transcript rows — a `thinking` row, a `text` row, a
   * `tool_use` row — each carrying the whole message's `usage`, so the id
   * is what identifies one call across its rows. Read by `usageSince`.
   */
  id?: unknown;
  model?: unknown;
  content?: unknown;
  usage?: unknown;
  stop_reason?: unknown;
}

/** Parse a whole transcript file's text into entries, skipping blank/garbled lines. */
export function parseTranscriptText(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = parseLine(line);
    if (entry !== null) {
      entries.push(entry);
    }
  }
  return entries;
}

/** Read and parse a transcript file. Missing/unreadable file → a worker error. */
export async function readTranscript(path: string): Promise<TranscriptEntry[]> {
  return (await readTranscriptFile(path)).entries;
}

/** Read a transcript with its raw JSONL text, used by the durable archive. */
export async function readTranscriptFile(path: string): Promise<TranscriptFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new ClaudeTranscriptError(`could not read Claude transcript at ${path}`, { cause: error });
  }
  return { path, text, entries: parseTranscriptText(text) };
}

/**
 * The worker's answer: the last assistant message that carries any text,
 * considering only entries appended at or after `fromIndex`. Intermediate
 * narration interleaved with tool calls is naturally superseded by the final
 * text-bearing message; pure thinking/tool_use entries are ignored.
 *
 * `fromIndex` is the high-water mark recorded before an in-session correction,
 * so a re-prompted session yields only the corrected answer, never the stale one.
 */
export function finalAssistantText(entries: TranscriptEntry[], fromIndex = 0): string | null {
  for (let index = entries.length - 1; index >= Math.max(0, fromIndex); index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.type !== "assistant") {
      continue;
    }
    const text = textFromContent(entry.message?.content);
    if (text !== null && text.length > 0) {
      return text;
    }
  }
  return null;
}

/**
 * Claude Code's placeholder model id on a message it composed itself — a
 * client-side diagnostic rather than a model reply. It names no served
 * model, so it is never reported as one.
 */
export const SYNTHETIC_MODEL_PLACEHOLDER = "<synthetic>";

/**
 * Whether the turn's last assistant message is Claude Code's own synthetic
 * reply: the client answered in place of a model, so whatever text the
 * message carries is a diagnostic, not the worker's answer.
 */
export function endsInSyntheticReply(entries: TranscriptEntry[], fromIndex = 0): boolean {
  for (let index = entries.length - 1; index >= Math.max(0, fromIndex); index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.type !== "assistant") {
      continue;
    }
    return entry.message?.model === SYNTHETIC_MODEL_PLACEHOLDER;
  }
  return false;
}

/**
 * The API refusal behind the turn's last synthetic reply, when the entry
 * annotates one: `{ status, code }` from Claude Code's own fields, or null
 * where the last assistant entry is not synthetic or carries no
 * annotation. A synthetic reply for an unknown model name arrives without
 * these fields; one for a 429 arrives with both.
 */
export function apiErrorSince(entries: TranscriptEntry[], fromIndex = 0): TranscriptApiError | null {
  for (let index = entries.length - 1; index >= Math.max(0, fromIndex); index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.type !== "assistant") {
      continue;
    }
    if (entry.message?.model !== SYNTHETIC_MODEL_PLACEHOLDER || entry.isApiErrorMessage !== true) {
      return null;
    }
    return {
      status: typeof entry.apiErrorStatus === "number" ? entry.apiErrorStatus : null,
      code: typeof entry.error === "string" ? entry.error : null
    };
  }
  return null;
}

/**
 * The last model id Claude reports for an assistant message in this turn.
 * The synthetic placeholder is not a model id: a record that published it as
 * `resolved_model` would put a sentinel string in a typed slot, so it reads
 * as "no model reported" (the same honesty rule as `worker_exit: null`).
 */
export function resolvedModelSince(entries: TranscriptEntry[], fromIndex = 0): string | null {
  for (let index = entries.length - 1; index >= Math.max(0, fromIndex); index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.type !== "assistant") {
      continue;
    }
    const model = entry.message?.model;
    if (typeof model === "string" && model.length > 0 && model !== SYNTHETIC_MODEL_PLACEHOLDER) {
      return model;
    }
  }
  return null;
}

/**
 * The effort level Claude Code reports serving for the last assistant
 * message in this turn. Served evidence, never the dispatched flag: a
 * clamped or ignored `--effort` shows here as the level the CLI actually
 * ran at, and a turn whose entries carry no `effort` field reads as "no
 * effort reported" (`null`), the same honesty rule as `resolvedModelSince`.
 */
export function effortSince(entries: TranscriptEntry[], fromIndex = 0): string | null {
  for (let index = entries.length - 1; index >= Math.max(0, fromIndex); index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.type !== "assistant") {
      continue;
    }
    if (typeof entry.effort === "string" && entry.effort.length > 0) {
      return entry.effort;
    }
  }
  return null;
}

/**
 * Whether the worker's turn has *completed* — the load-bearing done-signal.
 *
 * In `claude 2.1.178` the daemon's `state` field is unreliable as a turn-done
 * marker: it can stick at `working` long after a turn has cleanly ended (verified
 * live — a worker whose transcript shows `stop_reason: end_turn` still reported
 * `idle/working` indefinitely). The transcript is authoritative instead: a turn
 * is complete when the **last** assistant message at or after `fromIndex` carries
 * a terminal `stop_reason` (anything other than `tool_use`, which means "expecting
 * a tool result, still mid-turn"). Returns false when no assistant message has
 * landed yet, or the latest is awaiting a tool result.
 */
export function turnComplete(entries: TranscriptEntry[], fromIndex = 0): boolean {
  for (let index = entries.length - 1; index >= Math.max(0, fromIndex); index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.type !== "assistant") {
      continue;
    }
    const stopReason = entry.message?.stop_reason;
    return typeof stopReason === "string" && stopReason !== "tool_use";
  }
  return false;
}

/**
 * The turn's token usage, counted once per API call over the assistant
 * entries at or after `fromIndex`.
 *
 * Claude Code persists one API call's reply as several rows — a `thinking`
 * row, a `text` row, a `tool_use` row — and every row repeats the call's
 * full `usage` (measured 2026-09-28 on Claude Code 2.1.283: three rows,
 * one `message.id`, identical usage on each). A row is therefore not a
 * call: the rows sharing a `message.id` are one call, counted once. Every
 * figure is then summed across the turn's distinct calls — output, and the
 * input and cache sides alike — because each call is billed its own input
 * (a two-call tool turn pays two contexts, not the last one). Rows with no
 * id (an older build) count as one call each.
 *
 * A `message.id` already seen before `fromIndex` belongs to an earlier turn
 * of the same session and is never counted again, so a held session's later
 * turn attributes only the calls it made. Claude does not report a separate
 * reasoning measurement, so the optional field stays absent and thinking
 * rides `outputTokens`. Returns all-zero when no assistant usage is present.
 */
export function usageSince(entries: TranscriptEntry[], fromIndex = 0): TokenUsageBreakdown {
  const start = Math.max(0, fromIndex);
  const counted = new Set<string>();
  for (let index = 0; index < Math.min(start, entries.length); index += 1) {
    const id = entries[index]?.type === "assistant" ? entries[index]?.message?.id : undefined;
    if (typeof id === "string") {
      counted.add(id);
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let sawUsage = false;

  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.type !== "assistant") {
      continue;
    }
    const usage = asRecord(entry.message?.usage);
    if (usage === null) {
      continue;
    }
    const id = entry.message?.id;
    if (typeof id === "string") {
      if (counted.has(id)) {
        continue;
      }
      counted.add(id);
    }
    sawUsage = true;
    inputTokens += numeric(usage.input_tokens);
    outputTokens += numeric(usage.output_tokens);
    cacheRead += numeric(usage.cache_read_input_tokens);
    cacheCreation += numeric(usage.cache_creation_input_tokens);
  }

  if (!sawUsage) {
    return zeroUsage();
  }

  // Claude separates cache reads from cache creation and they mean different
  // things to a consumer scoring cache efficiency, so the creation share is
  // carried beside the combined figure: `cachedInputTokens` stays the sum
  // (the budget's admission arithmetic is unchanged), and
  // `cacheCreationInputTokens` says how much of it was writes.
  const cachedInputTokens = cacheRead + cacheCreation;
  return {
    cachedInputTokens,
    cacheCreationInputTokens: cacheCreation,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + cachedInputTokens + outputTokens
  };
}

/** A background task a session started, as its tool result and notification name it. */
export interface BackgroundTask {
  id: string;
  description: string;
}

/** The tool results by which Claude Code reports a task it backgrounded (measured 2026-09-28, Claude Code 2.1.283). */
const BACKGROUND_TASK_STARTS = [/Command running in background with ID: ([A-Za-z0-9_-]+)/, /Monitor started \(task ([A-Za-z0-9_-]+)/];
/** The notification block by which Claude Code wakes the model about a task; its id, status, and event are read inside the block only. */
const TASK_NOTIFICATION_BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TASK_NOTIFICATION_ID = /<task-id>([^<]+)<\/task-id>/;
const TASK_NOTIFICATION_STATUS = /<status>([^<]+)<\/status>/;
const TASK_NOTIFICATION_EVENT = /<event>([\s\S]*?)<\/event>/;
/**
 * The statuses by which a backgrounded command's notification reports the
 * task ended: Claude Code 2.1.285's own alternation is
 * `completed|failed|killed|blocked`, and the operator's transcripts add
 * `stopped` (measured 2026-09-29). An allow-list, so a status it does not
 * name — `running` (a Monitor event), `blocked`, or one a later build adds —
 * holds the wait: the call's deadline then ends it, never an interim reply
 * promoted to the answer.
 */
const TASK_ENDED_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);
/**
 * A Monitor's events carry no `<status>` — each arrives with `<summary>`
 * and `<event>` alone — and the Monitor ends two ways. Its watched source
 * ending is reported like a command's: a status-bearing notification
 * (`completed`, `failed`, `killed`; summary `Monitor "…" stream ended`),
 * which the status branch of `notificationEnded` owns. Its own expiry,
 * timeout, or stop is a notice in the event slot — `[Monitor expired after
 * …]`, `[Monitor timed out …]`, `[Monitor stopped — too much output …]`
 * or the bare `[Monitor stopped]` — the notices Claude Code 2.1.285 writes
 * (measured from its binary and the operator's transcripts, 2026-09-29),
 * matched by their opening words so watched output that merely begins with
 * `[Monitor` is not taken for one. Any other event is the source's output:
 * the Monitor is still running.
 */
const MONITOR_OWN_NOTICE = /^\s*\[Monitor (?:expired after|timed out|stopped)\b/;

/**
 * The background tasks the session started at or after `fromIndex` whose
 * ending has not yet reached the model — the evidence that a turn ending in
 * `end_turn` is an interim message, not the answer.
 *
 * Claude Code backgrounds a long command (`run_in_background`) or a Monitor
 * and lets the model end its turn; the tool result names the task
 * (`Command running in background with ID: <id>`, `Monitor started (task
 * <id>`), and only a call that backgrounds work can start one — a worker
 * reading a file that quotes the phrase has started nothing. When the task
 * ends, Claude Code notifies the model with a `<task-notification>` block
 * naming the `<task-id>`, and the model's next turn is the one to collect.
 * The block is written twice — enqueued the moment the task ends, then
 * delivered once the model can receive it — and only the delivery counts
 * (`deliveredNotifications`): a task that ends while the model is composing
 * its interim reply is enqueued before that reply and delivered after it,
 * so a wait closed on the enqueue row takes the interim reply as the answer.
 * A task is outstanding from its start until a delivered notification
 * reports it ended (`notificationEnded`) **and an assistant entry follows
 * the delivery**: the delivery lands seconds before the model's reply, and
 * a turn read in that window still ends on the interim message. The
 * description is the tool call's own (`description`, else a bounded
 * `command`, else the tool name), matched to the result by `tool_use_id`.
 */
export function outstandingBackgroundTasks(entries: TranscriptEntry[], fromIndex = 0): BackgroundTask[] {
  const toolCalls = new Map<string, { description: string; backgrounds: boolean }>();
  const outstanding = new Map<string, BackgroundTask>();
  // Tasks whose ending has been delivered but not yet answered: they leave
  // the outstanding set at the next assistant entry, the model's reply.
  const notified = new Set<string>();
  for (let index = Math.max(0, fromIndex); index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    if (entry.type === "assistant") {
      for (const id of notified) {
        outstanding.delete(id);
      }
      notified.clear();
      for (const call of toolUseBlocks(entry.message?.content)) {
        toolCalls.set(call.id, call);
      }
      continue;
    }
    for (const result of toolResultBlocks(entry.message?.content)) {
      // Only a call that backgrounds work can start a task: a worker that
      // reads a file quoting the start phrase (this repository's own tests
      // do) has started nothing, and its `cat` must not hold the turn open.
      const call = toolCalls.get(result.toolUseId);
      if (call === undefined || !call.backgrounds) {
        continue;
      }
      for (const pattern of BACKGROUND_TASK_STARTS) {
        const started = pattern.exec(result.text);
        if (started?.[1] !== undefined) {
          outstanding.set(started[1], { id: started[1], description: call.description });
        }
      }
    }
    for (const notification of deliveredNotifications(entry)) {
      if (notification.ended && outstanding.has(notification.id)) {
        notified.add(notification.id);
      }
    }
  }
  return [...outstanding.values()];
}

/** The tools whose call can background work: Bash with `run_in_background`, and Monitor always. */
const BACKGROUNDING_TOOLS: Record<string, (input: Record<string, unknown> | null) => boolean> = {
  Bash: (input) => input?.run_in_background === true,
  Monitor: () => true
};

function toolUseBlocks(content: unknown): Array<{ id: string; description: string; backgrounds: boolean }> {
  if (!Array.isArray(content)) {
    return [];
  }
  const calls: Array<{ id: string; description: string; backgrounds: boolean }> = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== "tool_use" || typeof record.id !== "string") {
      continue;
    }
    const input = asRecord(record.input);
    const backgrounds = typeof record.name === "string" && (BACKGROUNDING_TOOLS[record.name]?.(input) ?? false);
    const description =
      typeof input?.description === "string" && input.description.length > 0
        ? input.description
        : typeof input?.command === "string" && input.command.length > 0
          ? input.command.slice(0, 200)
          : typeof record.name === "string"
            ? record.name
            : "background task";
    calls.push({ id: record.id, description, backgrounds });
  }
  return calls;
}

function toolResultBlocks(content: unknown): Array<{ toolUseId: string; text: string }> {
  if (!Array.isArray(content)) {
    return [];
  }
  const results: Array<{ toolUseId: string; text: string }> = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== "tool_result" || typeof record.tool_use_id !== "string") {
      continue;
    }
    results.push({ toolUseId: record.tool_use_id, text: blockText(record.content) });
  }
  return results;
}

/**
 * The task notifications this row delivered to the model, each with whether
 * it reports its task ended. A delivery is a `user` row carrying the block
 * (the session was idle when the task ended) or an `attachment` row of type
 * `queued_command` carrying it as its prompt (the notification was absorbed
 * into a turn already in flight; Claude Code marks the matching queue row
 * `remove`, `reason: "absorbed_mid_turn"`). A `queue-operation` row is
 * bookkeeping about the queue, never a delivery, whatever block it carries.
 */
function deliveredNotifications(entry: TranscriptEntry): Array<{ id: string; ended: boolean }> {
  let texts: string[];
  if (entry.type === "user") {
    texts = messageTexts(entry.message?.content);
  } else if (entry.type === "attachment") {
    const attachment = asRecord(entry.attachment);
    texts = attachment?.type === "queued_command" && typeof attachment.prompt === "string" ? [attachment.prompt] : [];
  } else {
    return [];
  }
  const notifications: Array<{ id: string; ended: boolean }> = [];
  for (const text of texts) {
    for (const block of text.matchAll(TASK_NOTIFICATION_BLOCK)) {
      const body = block[1] ?? "";
      const id = TASK_NOTIFICATION_ID.exec(body)?.[1];
      if (id !== undefined) {
        notifications.push({ id, ended: notificationEnded(body) });
      }
    }
  }
  return notifications;
}

/** Whether a notification reports its task ended: by status where it carries one (a command; a Monitor whose source ended), else by the Monitor's own notice. */
function notificationEnded(body: string): boolean {
  const status = TASK_NOTIFICATION_STATUS.exec(body)?.[1]?.trim();
  if (status !== undefined) {
    return TASK_ENDED_STATUSES.has(status);
  }
  return MONITOR_OWN_NOTICE.test(TASK_NOTIFICATION_EVENT.exec(body)?.[1] ?? "");
}

/** Every text a message carries: its string content, or its text blocks. */
function messageTexts(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      texts.push(record.text);
    }
  }
  return texts;
}

/** A tool result's content: a string, or text blocks joined. */
function blockText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("\n");
}

function parseLine(line: string): TranscriptEntry | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return asRecord(parsed) === null ? null : (parsed as TranscriptEntry);
  } catch {
    return null;
  }
}

/** Join the text blocks of an assistant message; tolerate a bare-string content. */
function textFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function zeroUsage(): TokenUsageBreakdown {
  return {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}
