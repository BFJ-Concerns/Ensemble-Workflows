import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  effortSince,
  finalAssistantText,
  parseTranscriptText,
  readTranscript,
  resolvedModelSince,
  turnComplete,
  usageSince
} from "../../src/claude-transcript.js";
import { ClaudeTranscriptError } from "../../src/errors.js";

// A realistic assistant entry: standard Anthropic message shape, as Claude Code
// persists it. `content` is an array of typed blocks; `usage` mirrors the API.
// `stop` defaults to a terminal turn (end_turn); pass "tool_use" for mid-turn.
function assistant(
  blocks: unknown[],
  options: { usage?: Record<string, number>; stop?: string; model?: string; effort?: string } = {}
): string {
  return JSON.stringify({
    type: "assistant",
    // Claude Code writes the served effort beside the message, not inside it.
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    message: {
      role: "assistant",
      ...(options.model !== undefined ? { model: options.model } : {}),
      content: blocks,
      stop_reason: options.stop ?? "end_turn",
      ...(options.usage !== undefined ? { usage: options.usage } : {})
    }
  });
}

function textBlock(textValue: string): unknown {
  return { type: "text", text: textValue };
}

test("parseTranscriptText keeps well-formed entries and skips blank and garbled lines", () => {
  const text = [
    assistant([textBlock("first")]),
    "",
    "{ not valid json",
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    "   ",
    assistant([textBlock("second")])
  ].join("\n");

  const entries = parseTranscriptText(text);

  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ["assistant", "user", "assistant"]
  );
});

test("finalAssistantText returns the last text-bearing assistant message, joining its text blocks", () => {
  const entries = parseTranscriptText(
    [
      assistant([textBlock("intermediate narration")]),
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      assistant([textBlock("final "), textBlock("answer")])
    ].join("\n")
  );

  assert.equal(finalAssistantText(entries), "final answer");
});

test("finalAssistantText ignores thinking-only and tool-use-only assistant entries", () => {
  const entries = parseTranscriptText(
    [
      assistant([textBlock("the answer")]),
      assistant([{ type: "thinking", thinking: "pondering" }]),
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: {} }])
    ].join("\n")
  );

  // The trailing thinking/tool_use entries carry no text, so the real answer stands.
  assert.equal(finalAssistantText(entries), "the answer");
});

test("finalAssistantText honours fromIndex so a corrected turn never returns the stale answer", () => {
  const entries = parseTranscriptText(
    [
      assistant([textBlock("stale wrong answer")]),
      JSON.stringify({ type: "user", message: { role: "user", content: "correct it" } }),
      assistant([textBlock("corrected answer")])
    ].join("\n")
  );

  // Reading from the mark recorded before the correction (index 1) skips the stale one.
  assert.equal(finalAssistantText(entries, 1), "corrected answer");
  // And the whole transcript still surfaces the latest text overall.
  assert.equal(finalAssistantText(entries, 0), "corrected answer");
});

test("finalAssistantText returns null when no assistant text exists in range", () => {
  const entries = parseTranscriptText(assistant([{ type: "tool_use", id: "t", name: "Bash", input: {} }]));
  assert.equal(finalAssistantText(entries), null);
  assert.equal(finalAssistantText([]), null);
});

test("resolvedModelSince returns the latest served model in range", () => {
  const entries = parseTranscriptText(
    [
      assistant([textBlock("old")], { model: "claude-old" }),
      assistant([textBlock("current")], { model: "claude-served" })
    ].join("\n")
  );

  assert.equal(resolvedModelSince(entries), "claude-served");
  assert.equal(resolvedModelSince(entries, 1), "claude-served");
  assert.equal(resolvedModelSince(entries, 2), null);
});

test("effortSince returns the latest served effort in range, or null when no entry reports one", () => {
  const entries = parseTranscriptText(
    [
      assistant([textBlock("old")], { effort: "low" }),
      assistant([textBlock("current")], { effort: "high" }),
      // An older Claude Code build's entry: no effort field at all.
      assistant([textBlock("unreported")])
    ].join("\n")
  );

  assert.equal(effortSince(entries), "high");
  assert.equal(effortSince(entries, 1), "high");
  assert.equal(effortSince(entries, 2), null);
  assert.equal(effortSince([]), null);
});

test("usageSince sums output tokens and snapshots the final input side", () => {
  const entries = parseTranscriptText(
    [
      assistant([textBlock("a")], {
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }
      }),
      assistant([textBlock("b")], {
        usage: { input_tokens: 220, output_tokens: 30, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }
      })
    ].join("\n")
  );

  const usage = usageSince(entries);

  // output is additive (10 + 30); input/cached are the final message's snapshot
  // (220 input; 7 + 3 cached), charged once rather than summed across steps.
  assert.equal(usage.outputTokens, 40);
  assert.equal(usage.inputTokens, 220);
  assert.equal(usage.cachedInputTokens, 10);
  // The creation share travels beside the combined figure, so a consumer can
  // tell input served from cache (7) from cache being written (3).
  assert.equal(usage.cacheCreationInputTokens, 3);
  assert.equal("reasoningOutputTokens" in usage, false);
  assert.equal(usage.totalTokens, 220 + 10 + 40);
});

test("turnComplete is true only when the latest assistant message has settled", () => {
  // Latest assistant message is mid-turn (awaiting a tool result) → not complete.
  const midTurn = parseTranscriptText(
    [assistant([textBlock("let me check")], { stop: "tool_use" })].join("\n")
  );
  assert.equal(turnComplete(midTurn), false);

  // A terminal end_turn after the tool result → complete.
  const settled = parseTranscriptText(
    [
      assistant([{ type: "tool_use", id: "t", name: "Bash", input: {} }], { stop: "tool_use" }),
      assistant([textBlock("done")], { stop: "end_turn" })
    ].join("\n")
  );
  assert.equal(turnComplete(settled), true);

  // No assistant message yet → not complete.
  assert.equal(turnComplete([]), false);
});

test("turnComplete honours fromIndex: an old end_turn before the mark does not count", () => {
  const entries = parseTranscriptText(
    [
      assistant([textBlock("previous answer")], { stop: "end_turn" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "again" } }),
      assistant([{ type: "tool_use", id: "t", name: "Read", input: {} }], { stop: "tool_use" })
    ].join("\n")
  );
  // From the mark (index 1) the latest assistant is mid-turn → not complete,
  // even though an earlier end_turn exists before the mark.
  assert.equal(turnComplete(entries, 1), false);
  // Across the whole transcript the latest assistant is still the tool_use one.
  assert.equal(turnComplete(entries, 0), false);
});

test("usageSince returns all-zero when no assistant usage is present", () => {
  const entries = parseTranscriptText(assistant([textBlock("no usage field")]));
  assert.deepEqual(usageSince(entries), {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  });
});

test("readTranscript parses a real on-disk file and errors clearly when missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-transcript-"));
  try {
    const file = path.join(dir, "session.jsonl");
    await writeFile(file, [assistant([textBlock("disk answer")]), ""].join("\n"));

    const entries = await readTranscript(file);
    assert.equal(finalAssistantText(entries), "disk answer");

    await assert.rejects(() => readTranscript(path.join(dir, "absent.jsonl")), ClaudeTranscriptError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("apiErrorSince reads the synthetic reply's structured refusal, and nothing from a model reply", async () => {
  const { apiErrorSince } = await import("../../src/claude-transcript.js");
  // The observed 2026-08-30 shape: Claude Code's own annotation beside its
  // synthetic reply, status and code as fields, prose in the content.
  const refused = parseTranscriptText(
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "work" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error: Request rejected (429)" }], stop_reason: "stop_sequence" },
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        error: "rate_limit"
      })
    ].join("\n")
  );
  assert.deepEqual(apiErrorSince(refused), { status: 429, code: "rate_limit" });

  // A synthetic reply with no annotation (an unknown model name) is not an
  // API refusal the classifier can read a status from.
  const unannotated = parseTranscriptText(
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error: 400 unknown provider" }] }
    })
  );
  assert.equal(apiErrorSince(unannotated), null);

  // A real model reply carrying stray fields is never read as a refusal.
  const answered = parseTranscriptText(
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "done" }] },
      isApiErrorMessage: true,
      apiErrorStatus: 429
    })
  );
  assert.equal(apiErrorSince(answered), null);
});
