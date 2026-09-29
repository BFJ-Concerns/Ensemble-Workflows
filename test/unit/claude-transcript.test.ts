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

// A task's notification block as Claude Code composes it: a backgrounded
// command's carries a `<status>`; a Monitor's carries an `<event>` and no
// status (rows measured 2026-09-29, Claude Code 2.1.285).
function commandNotification(taskId: string, status: string): string {
  return `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>Background command "sleep" ${status}</summary>\n</task-notification>`;
}

function monitorNotification(taskId: string, event: string): string {
  return `<task-notification>\n<task-id>${taskId}</task-id>\n<summary>Monitor event: "background task completion"</summary>\n<event>${event}</event>\n</task-notification>`;
}

// The rows a notification occupies. Claude Code enqueues the block the moment
// the task ends — a `queue-operation` row, bookkeeping about the queue — and
// delivers it once the model can receive it: as a `user` row when the session
// is idle (after a `dequeue` row), or absorbed into a turn already in flight
// as a `queued_command` attachment (the queue row then `remove`d).
function enqueued(block: string): string {
  return JSON.stringify({ type: "queue-operation", operation: "enqueue", content: block });
}

function deliveredIdle(block: string): string[] {
  return [
    JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
    JSON.stringify({ type: "user", message: { role: "user", content: block }, origin: { kind: "task-notification" } })
  ];
}

function absorbedMidTurn(block: string): string[] {
  return [
    JSON.stringify({ type: "queue-operation", operation: "remove", content: block, reason: "absorbed_mid_turn" }),
    JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: block, commandMode: "task-notification" } })
  ];
}

// The wake as a session that was idle receives it: enqueued, then delivered.
function taskNotification(taskId: string, status: string): string[] {
  const block = commandNotification(taskId, status);
  return [enqueued(block), ...deliveredIdle(block)];
}

test("outstandingBackgroundTasks names a backgrounded command from its start until a delivered notification reports it ended", () => {
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

  // A status outside the ended set — `running`, or `blocked` from Claude
  // Code's own alternation — leaves the task outstanding even once answered.
  for (const status of ["running", "blocked"]) {
    const held = parseTranscriptText([...started, ...taskNotification("bya9z1l44", status), assistant([textBlock("still going")])].join("\n"));
    assert.equal(outstandingBackgroundTasks(held).length, 1, status);
  }

  // The notification rows land seconds before the model's reply: a turn
  // read in that window still ends on the interim message, so the task
  // stays outstanding until an assistant entry follows the notification.
  const notifiedOnly = parseTranscriptText([...started, ...taskNotification("bya9z1l44", "completed")].join("\n"));
  assert.equal(outstandingBackgroundTasks(notifiedOnly).length, 1, "notified but not yet answered");
  // A delivered ending closes the wait once the reply lands.
  for (const status of ["completed", "failed", "killed", "stopped"]) {
    const ended = parseTranscriptText([...started, ...taskNotification("bya9z1l44", status), assistant([textBlock("done")])].join("\n"));
    assert.deepEqual(outstandingBackgroundTasks(ended), [], status);
  }
  // A notification for a task this turn never started is not this turn's.
  const foreign = parseTranscriptText([...started, ...taskNotification("someoneelse", "completed"), assistant([textBlock("still waiting")])].join("\n"));
  assert.equal(outstandingBackgroundTasks(foreign).length, 1);
});

test("outstandingBackgroundTasks holds a task whose ending is enqueued but not delivered: the interim reply after the enqueue row is not the answer", () => {
  // Measured 2026-09-29 (a command that exited in ~2 s): the tool result at
  // 15:57:36.225, the enqueue row at 15:57:36.259, the interim reply at
  // 15:57:39.311 — and no delivery, because the wait closed on the enqueue
  // row and the session was stopped with the interim text as the answer.
  const block = commandNotification("blfzk0hh4", "completed");
  const enqueuedBeforeInterim = [
    assistant([toolUse("toolu_short", "Bash", { command: "node spawn-nested.mjs", description: "Run spawn-nested.mjs script in background", run_in_background: true })], { stop: "tool_use" }),
    toolResult("toolu_short", "Command running in background with ID: blfzk0hh4. Output is being written to: /tmp/x.output."),
    enqueued(block),
    assistant([textBlock("The script is now running in the background (task ID: `blfzk0hh4`). You will be notified when it completes.")])
  ];
  const interim = parseTranscriptText(enqueuedBeforeInterim.join("\n"));
  assert.equal(turnComplete(interim), true);
  assert.deepEqual(outstandingBackgroundTasks(interim).map((task) => task.id), ["blfzk0hh4"], "enqueued is not delivered");

  // Delivered once the session is idle, then answered: the wait closes.
  const deliveredLater = parseTranscriptText([...enqueuedBeforeInterim, ...deliveredIdle(block), assistant([textBlock("done: exit 0")])].join("\n"));
  assert.deepEqual(outstandingBackgroundTasks(deliveredLater), []);

  // Absorbed into a turn already in flight — the attachment row is the
  // delivery — and answered by that turn's reply: the wait closes too.
  const absorbed = parseTranscriptText([...enqueuedBeforeInterim, ...absorbedMidTurn(block), assistant([textBlock("done: exit 0")])].join("\n"));
  assert.deepEqual(outstandingBackgroundTasks(absorbed), []);
  // The attachment alone, unanswered, is the notified-but-unanswered window.
  assert.equal(outstandingBackgroundTasks(parseTranscriptText([...enqueuedBeforeInterim, ...absorbedMidTurn(block)].join("\n"))).length, 1);
});

test("outstandingBackgroundTasks keeps a Monitor outstanding through its events and ends it at the Monitor's own notice", () => {
  // Measured 2026-09-29: a Monitor on a background task's output file. Its
  // event (the watched output, then `[exited with code 0]` from the task
  // file) carries no status and is not the Monitor ending; its expiry notice
  // a minute later is.
  const started = [
    assistant([toolUse("toolu_mon", "Monitor", { command: "tail -f /tmp/x.output", description: "background task completion" })], { stop: "tool_use" }),
    toolResult("toolu_mon", "Monitor started (task b7zb0kfnb, expires in 1m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch)."),
    assistant([textBlock("Waiting for the background task to complete...")])
  ];
  const event = monitorNotification("b7zb0kfnb", "BG-19-8bdca0417a34\n[exited with code 0]");
  const afterEvent = parseTranscriptText([...started, ...absorbedMidTurn(event), assistant([textBlock("Nonce: BG-19-8bdca0417a34")])].join("\n"));
  assert.deepEqual(outstandingBackgroundTasks(afterEvent).map((task) => task.id), ["b7zb0kfnb"], "an event is the Monitor still running");

  // Each notice Claude Code itself writes into the event slot ends the watch.
  for (const notice of [
    "[Monitor expired after 1m with 1 event delivered. Re-arm it if you still need the watch.]",
    "[Monitor expired after 5m with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]",
    "[Monitor timed out — re-arm if needed.]",
    "[Monitor stopped — too much output (40 events suppressed over 12s). Restart with a more selective filter.]"
  ]) {
    const ended = parseTranscriptText(
      [...started, ...absorbedMidTurn(event), assistant([textBlock("Nonce: BG-19-8bdca0417a34")]), ...deliveredIdle(monitorNotification("b7zb0kfnb", notice)), assistant([textBlock("Task is complete.")])].join("\n")
    );
    assert.deepEqual(outstandingBackgroundTasks(ended), [], notice);
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

test("outstandingBackgroundTasks ignores the start phrase quoted by a call that backgrounds nothing", () => {
  // A worker that reads a file quoting the phrase — this repository's own
  // test suite, say — has started no task; only Bash with
  // run_in_background, or a Monitor, can. (Found live: a `cat`
  // of these tests held its own turn open.)
  const quoted = "test fixture: Command running in background with ID: bya9z1l44. Monitor started (task mon00001, expires";
  const entries = parseTranscriptText(
    [
      assistant([toolUse("toolu_cat", "Bash", { command: "cat test/unit/claude-transcript.test.ts", description: "Read the transcript tests" })], { stop: "tool_use" }),
      toolResult("toolu_cat", quoted),
      assistant([toolUse("toolu_read", "Read", { file_path: "/x/claude-engine.test.ts" })], { stop: "tool_use" }),
      toolResult("toolu_read", quoted),
      assistant([textBlock("read both files")])
    ].join("\n")
  );
  assert.deepEqual(outstandingBackgroundTasks(entries), []);
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
