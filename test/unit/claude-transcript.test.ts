import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  effortSince,
  finalAssistantText,
  outstandingBackgroundTasks,
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
  options: { id?: string; usage?: Record<string, number>; stop?: string; model?: string; effort?: string } = {}
): string {
  return JSON.stringify({
    type: "assistant",
    // Claude Code writes the served effort beside the message, not inside it.
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    message: {
      role: "assistant",
      // The API message id: rows of one call share it (see usageSince).
      ...(options.id !== undefined ? { id: options.id } : {}),
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

test("usageSince counts every figure once per API call and sums across the turn's calls", () => {
  const entries = parseTranscriptText(
    [
      assistant([textBlock("a")], {
        id: "msg_call_a",
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }
      }),
      assistant([textBlock("b")], {
        id: "msg_call_b",
        usage: { input_tokens: 220, output_tokens: 30, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }
      })
    ].join("\n")
  );

  const usage = usageSince(entries);

  // Each call is billed its own context, so the input and cache sides sum
  // across calls exactly as output does: a two-call tool turn pays two
  // contexts, never only the final one.
  assert.equal(usage.outputTokens, 40);
  assert.equal(usage.inputTokens, 320);
  assert.equal(usage.cachedInputTokens, 15);
  // The creation share travels beside the combined figure, so a consumer can
  // tell input served from cache (12) from cache being written (3).
  assert.equal(usage.cacheCreationInputTokens, 3);
  assert.equal("reasoningOutputTokens" in usage, false);
  assert.equal(usage.totalTokens, 320 + 15 + 40);
});

test("usageSince counts one API call written across several transcript rows once", () => {
  // Claude Code writes a call's thinking, text, and tool_use blocks as
  // separate rows, each repeating the call's whole usage: three rows, one
  // message id, one charge.
  const usage = { input_tokens: 10, output_tokens: 280, cache_read_input_tokens: 25_629, cache_creation_input_tokens: 18_359 };
  const entries = parseTranscriptText(
    [
      assistant([{ type: "thinking", thinking: "…" }], { id: "msg_one_call", usage, stop: "tool_use" }),
      assistant([textBlock("looking")], { id: "msg_one_call", usage, stop: "tool_use" }),
      assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }], { id: "msg_one_call", usage, stop: "tool_use" }),
      // Rows without an id (an older build) are one call each.
      assistant([textBlock("done")], { usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    ].join("\n")
  );

  const counted = usageSince(entries);

  assert.equal(counted.outputTokens, 282);
  assert.equal(counted.inputTokens, 11);
  assert.equal(counted.cachedInputTokens, 25_629 + 18_359);
  assert.equal(counted.cacheCreationInputTokens, 18_359);
  assert.equal(counted.totalTokens, 11 + 25_629 + 18_359 + 282);
});

test("usageSince never re-counts a message id an earlier turn already counted", () => {
  // A held session's later turn reads from its high-water mark; a row past
  // the mark that repeats an earlier turn's message id is that earlier call
  // again, not new spend.
  const first = { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const second = { input_tokens: 70, output_tokens: 9, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 };
  const entries = parseTranscriptText(
    [
      assistant([textBlock("turn one")], { id: "msg_turn_one", usage: first }),
      assistant([textBlock("turn one again")], { id: "msg_turn_one", usage: first }),
      assistant([textBlock("turn two")], { id: "msg_turn_two", usage: second })
    ].join("\n")
  );

  const later = usageSince(entries, 1);

  assert.equal(later.outputTokens, 9);
  assert.equal(later.inputTokens, 70);
  assert.equal(later.cachedInputTokens, 4);
  assert.equal(later.totalTokens, 83);
  // The whole session, read from the start, still counts each call once.
  assert.equal(usageSince(entries).totalTokens, 55 + 83);
});

// A tool result row as Claude Code persists it: a user entry whose content
// is a tool_result block naming the call it answers.
function toolResult(toolUseId: string, text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }] } });
}

function toolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return { type: "tool_use", id, name, input };
}

// The wake Claude Code enqueues when a task ends: a bookkeeping row with the
// block at top level, then a user turn carrying the same block as its content.
function taskNotification(taskId: string, status: string): string[] {
  const block = `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>Background command "sleep" ${status}</summary>\n</task-notification>`;
  return [
    JSON.stringify({ type: "queue-operation", operation: "enqueue", content: block }),
    JSON.stringify({ type: "user", message: { role: "user", content: block }, origin: { kind: "task-notification" } })
  ];
}

test("outstandingBackgroundTasks names a backgrounded command from its start until a non-running notification ends it", () => {
  const started = [
    assistant([toolUse("toolu_bg", "Bash", { command: "sleep 45", description: "Wait 45 seconds in background", run_in_background: true })], { stop: "tool_use" }),
    toolResult("toolu_bg", "Command running in background with ID: bya9z1l44. Output is being written to: /tmp/x.output. You will be notified when it completes."),
    assistant([textBlock("Waiting for the sleep to finish.")])
  ];
  const entries = parseTranscriptText(started.join("\n"));
  // The turn reads complete, and yet the task is outstanding: this is the
  // interim message, and the description is Claude Code's own.
  assert.equal(turnComplete(entries), true);
  assert.deepEqual(outstandingBackgroundTasks(entries), [{ id: "bya9z1l44", description: "Wait 45 seconds in background" }]);

  // A Monitor event is a `running` notification: the task is still outstanding.
  const running = parseTranscriptText([...started, ...taskNotification("bya9z1l44", "running")].join("\n"));
  assert.equal(outstandingBackgroundTasks(running).length, 1);

  // The ending notification, in either of its two rows, closes the wait.
  for (const status of ["completed", "failed", "killed", "stopped"]) {
    const ended = parseTranscriptText([...started, ...taskNotification("bya9z1l44", status), assistant([textBlock("done")])].join("\n"));
    assert.deepEqual(outstandingBackgroundTasks(ended), [], status);
  }
});

test("outstandingBackgroundTasks reads Monitor starts, falls back to the command or tool name, and honours fromIndex", () => {
  const earlier = [
    assistant([toolUse("toolu_old", "Bash", { command: "make", run_in_background: true })], { stop: "tool_use" }),
    toolResult("toolu_old", "Command running in background with ID: oldtask1."),
    assistant([textBlock("earlier turn")])
  ];
  const later = [
    assistant([toolUse("toolu_mon", "Monitor", { command: "tail -f log", description: "errors in deploy.log" })], { stop: "tool_use" }),
    toolResult("toolu_mon", "Monitor started (task mon00001, expires in 5m unless the source ends first)."),
    assistant([toolUse("toolu_cmd", "Bash", { command: "npm run build --long", run_in_background: true })], { stop: "tool_use" }),
    toolResult("toolu_cmd", "Command running in background with ID: cmd00002."),
    assistant([textBlock("waiting on both")])
  ];
  const entries = parseTranscriptText([...earlier, ...later].join("\n"));

  // From the start, every task the session ever started is outstanding.
  assert.deepEqual(
    outstandingBackgroundTasks(entries).map((task) => task.id),
    ["oldtask1", "mon00001", "cmd00002"]
  );
  // From the later turn's mark, the earlier turn's task is not this turn's wait.
  const thisTurn = outstandingBackgroundTasks(entries, earlier.length);
  assert.deepEqual(thisTurn, [
    { id: "mon00001", description: "errors in deploy.log" },
    { id: "cmd00002", description: "npm run build --long" }
  ]);
  // No tasks, no waits.
  assert.deepEqual(outstandingBackgroundTasks(parseTranscriptText(assistant([textBlock("plain answer")]))), []);
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
