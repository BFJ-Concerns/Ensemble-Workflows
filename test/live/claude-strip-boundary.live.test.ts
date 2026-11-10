import assert from "node:assert/strict";
import test from "node:test";

/**
 * The Claude strip witnessed at the worker boundary itself: what the served
 * Claude Code offered its model, captured off the wire, never the settings
 * the harness wrote nor a worker's account of itself.
 *
 * Arrangement: a private `CLAUDE_CONFIG_DIR` and a daemon this test owns
 * (as `claude-supervisor-boundary.live.test.ts` arranges them), so no
 * operator context or credential is involved. Each worker's provider is a
 * capture provider (`startCaptureProvider` in `src/provider-capture.ts`),
 * declared as the machine's Claude `worker_environment.ANTHROPIC_BASE_URL`,
 * with a placeholder `ANTHROPIC_API_KEY` whose use `.claude.json`
 * pre-approves. Every turn stops at the provider's 400, so no model is
 * reached and nothing is billed. A captured request is joined to its worker
 * by a nonce in that worker's prompt, never by order. Its surface is read
 * with `readClaudeToolSurface`, which throws on an unreadable shape.
 *
 * The two legs below state their arrangement and oracle, and fail until
 * they are written.
 */

const isLive = process.env.ENSEMBLE_LIVE === "1";

test(
  "a stripped Claude worker is offered no agent or skill tool, while unstripped controls on either side are",
  { skip: !isLive, timeout: 600_000 },
  () => {
    // One run of the built launcher dispatches three labelled workers in
    // sequence: an unstripped control, a worker stripped of agents and
    // skills, and a second unstripped control.
    //
    // Oracle:
    // - Both controls are offered ListAgents, SendMessage and Skill. This
    //   shows the witness can see what the strip removes.
    // - The stripped worker is offered none of its record's denied names,
    //   either loaded or in the deferred listing, and is offered every
    //   tool the first control was offered apart from those names.
    // - The second control is offered the first control's whole surface,
    //   so the strip stayed with its own session.
    // - The stripped worker's record has a `config` route for both
    //   capabilities, and each detail names the same Claude Code version
    //   as the user agent on that worker's captured requests.
    // - The controls' records carry no strip, and a capture holds no probe
    //   request from either control, so an unstripped worker paid for no
    //   probe.
    assert.fail("not yet written: the Claude strip boundary leg");
  }
);

test(
  "a built-in agent tool nobody has classified is denied while unrelated tools stay available",
  { skip: !isLive, timeout: 300_000 },
  () => {
    // A ClaudeStripPreparer drives the real CLI control plane's probe in
    // the owned arrangement. Its classification is the shipped table
    // without ListAgents, so a real agent tool on the served surface
    // stands in for one a new release introduces.
    //
    // Oracle:
    // - The prepared deny rules include ListAgents as unclassified.
    // - The confirming probe, run by the real CLI under those rules, offers
    //   no ListAgents, either loaded or deferred.
    // - It still offers Read and Bash.
    // - The enforcement detail lists ListAgents under "unclassified and
    //   denied".
    assert.fail("not yet written: the unclassified agent tool leg");
  }
);
