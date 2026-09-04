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
 * Best-effort per-turn token usage, summed over the assistant messages at or
 * after `fromIndex`. `output_tokens` is additive across messages (genuinely new
 * generation, no double-count) and is the dominant, exactly-correct signal; the
 * input side is taken as the final message's snapshot (the representative
 * context size, charged once) rather than summed, which would multiply-count the
 * context carried into every step. Claude does not report a separate reasoning
 * measurement, so the optional field stays absent and thinking rides
 * `outputTokens`. Documented as best-effort: what Claude tokens
 * should mean against a subscription allowance is not yet settled.
 * Returns all-zero when no assistant usage is present.
 */
export function usageSince(entries: TranscriptEntry[], fromIndex = 0): TokenUsageBreakdown {
  let outputTokens = 0;
  let lastInput = 0;
  let lastCacheRead = 0;
  let lastCacheCreation = 0;
  let sawUsage = false;

  for (let index = Math.max(0, fromIndex); index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.type !== "assistant") {
      continue;
    }
    const usage = asRecord(entry.message?.usage);
    if (usage === null) {
      continue;
    }
    sawUsage = true;
    outputTokens += numeric(usage.output_tokens);
    // Overwrite (not accumulate) the input side: each step's input restates the
    // running context, so the final message's snapshot is the right charge-once value.
    lastInput = numeric(usage.input_tokens);
    lastCacheRead = numeric(usage.cache_read_input_tokens);
    lastCacheCreation = numeric(usage.cache_creation_input_tokens);
  }

  if (!sawUsage) {
    return zeroUsage();
  }

  // Claude separates cache reads from cache creation and they mean different
  // things to a consumer scoring cache efficiency, so the creation share is
  // carried beside the combined figure: `cachedInputTokens` stays the sum
  // (the budget's admission arithmetic is unchanged), and
  // `cacheCreationInputTokens` says how much of it was writes.
  const lastCached = lastCacheRead + lastCacheCreation;
  return {
    cachedInputTokens: lastCached,
    cacheCreationInputTokens: lastCacheCreation,
    inputTokens: lastInput,
    outputTokens,
    totalTokens: lastInput + lastCached + outputTokens
  };
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
