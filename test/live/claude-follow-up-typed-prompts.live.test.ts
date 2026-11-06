import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeCliControlPlane } from "../../src/claude-control-plane.js";
import { readTranscript } from "../../src/claude-transcript.js";
import { ClaudeEngineAdapter } from "../../src/engines.js";
import {
  TYPED_FOLLOW_UP_OPENING_PROMPT,
  TYPED_FOLLOW_UP_SKILL,
  followUpArrival,
  installTypedFollowUpSkill,
  typedFollowUpPrompt
} from "./claude-follow-up-typed-prompts.js";

const isLive = process.env.ENSEMBLE_LIVE === "1";

// One held Claude worker, two turns. The first is delivered by dispatch and
// fixes the worker's behaviour; the second rides the reply valve and is the
// turn under proof: several kilobytes over twenty lines, opening with a
// `/skill` line. The transcript row is the evidence — `followUpArrival`
// reads it from the entry count taken before delivery — and the worker's
// reply shows the skill body ran. The session is driven at the engine
// adapter so the test can take the transcript path from the attempt's
// observer; a runtime session's `send()` exposes no such observer.
//
// Left for the delivery change: a run that pauses the attach client's
// reader mid-delivery (SIGSTOP on the `claude attach` process, resumed
// under a second), which is what separates a delivery that happens to
// type from one that cannot paste. The valve does not expose that process
// today, so the pause rides whatever surface the change gives it.
test(
  "live Claude follow-up of several kilobytes opening with a slash line arrives typed, exact and expanded",
  { skip: !isLive, timeout: 600_000 },
  async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-typed-follow-up-"));
    // Before the dispatch: Claude Code reads project skills at session start.
    await installTypedFollowUpSkill(cwd);
    const adapter = new ClaudeEngineAdapter({ cwd, controlPlane: new ClaudeCliControlPlane() });
    const session = adapter.createSession({ cwd, timeoutMs: 240_000 });
    let transcriptPath: string | null = null;
    const observers = {
      attempt: 1,
      onTranscriptPath: (observed: string) => {
        transcriptPath = observed;
      }
    };

    try {
      const opening = await session.beginTurn(TYPED_FOLLOW_UP_OPENING_PROMPT, {}).runAttempt(observers);
      assert.equal(opening.attemptFailure, undefined, `opening turn failed: ${JSON.stringify(opening.attemptFailure)}`);
      assert.ok(transcriptPath !== null, "the opening turn reported no transcript path");
      const mark = (await readTranscript(transcriptPath)).length;

      const prompt = typedFollowUpPrompt(`FOLLOW_UP_${randomUUID()}`);
      const followUp = await session.beginTurn(prompt, {}).runAttempt(observers);
      assert.equal(followUp.attemptFailure, undefined, `follow-up turn failed: ${JSON.stringify(followUp.attemptFailure)}`);

      const arrival = followUpArrival(await readTranscript(transcriptPath), mark, prompt);
      assert.equal(arrival.kind, "command", `the follow-up did not arrive as a typed command: ${JSON.stringify(arrival).slice(0, 400)}`);
      if (arrival.kind === "command") {
        assert.equal(arrival.name, TYPED_FOLLOW_UP_SKILL.name);
        assert.equal(arrival.exact, true, "the command's arguments differ from the text sent");
        assert.equal(arrival.expanded, true, "no later row carries the expanded skill body");
      }
      assert.ok(followUp.text.includes(TYPED_FOLLOW_UP_SKILL.reply), `the worker did not answer with the skill's reply: ${followUp.text}`);
    } finally {
      await session.close();
      await adapter.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
);
