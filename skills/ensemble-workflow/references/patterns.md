# Workflow Patterns

Worked shapes for common orchestration jobs, and the headline cross-engine verification example in full. Read this when designing a new script and wanting a starting shape rather than a blank page.

## Patterns

These are the recurring shapes; compose them freely, and invent new ones when
the task calls for it — a tournament bracket, a staged escalation, a
self-repair loop are all just JavaScript around `agent()`.

**Pipeline over barrier — the default for multi-stage work.** Reach for
`pipeline()` whenever stages are per-item independent; reserve a barrier
(`parallel` then a second `parallel`) for when stage N genuinely needs
**cross-item context** from all of stage N−1 — deduplicating across the full
result set before expensive downstream work, early-exiting when the total
count is zero, or a prompt that references "the other findings". A barrier is
*not* justified by "I need to flatten/filter first" (do it inside a stage), by
"the stages are conceptually separate" (that is what `pipeline` models), or by
tidier-looking code: with a barrier, every fast item idles for the slowest item
of the previous stage. The smell: `await parallel(...)`, a plain
transform, then another `await parallel(...)` — if the transform has no
cross-item dependency, rewrite it as a pipeline with the transform inside a
stage. The canonical multi-stage shape — find per dimension, verify each
finding with the opposite engine as soon as its dimension's review completes:

```js
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { engine: "codex", schema: findingsSchema, label: `review:${d.key}` }),
  (review, d) =>
    parallel((review?.findings ?? []).map((f) => () =>
      agent(`Try to refute this ${d.key} finding: ${JSON.stringify(f)}. Reply {"real":boolean,"reason":"…"}.`,
        { engine: "claude", schema: verdictSchema, label: `verify:${d.key}` })
        .then((v) => ({ ...f, verdict: v }))
    ))
);
// Filter nulls at BOTH depths: failed stages null the outer slot, failed
// verifier thunks null inner slots — flatten first, then filter.
const confirmed = results.filter(Boolean).flat().filter(Boolean).filter((f) => f.verdict?.real);
```

**Verifier panels.** Scale a single cross-engine check to a panel by fanning
the verifier across several workers of the *other* family. Two kinds, with
different aggregation. **Identical refuters** answer the same question, so a
majority is meaningful:

```js
const votes = (await parallel(
  Array.from({ length: 3 }, () => () =>
    agent(`Independently verify: ${JSON.stringify(finding)}. Reply {real:boolean}.`, { engine: "claude", schema: verdictSchema })
  )
)).filter(Boolean);
const confirmed = votes.filter((v) => v.real).length >= 2;
```

A **perspective-diverse panel** gives each verifier a distinct lens —
correctness, security, does-it-reproduce — because three identical sceptics
share one blind spot and three lenses have three. Lenses answer *different*
questions, so a majority is not meaningful: treat each lens's refutation as a
veto on its own axis (any lens finding a real defect sinks the finding), and
read every `outOfScopeConcerns` field before trusting the verdicts around it:

```js
const lenses = ["correctness", "security", "does it actually reproduce"];
const votes = (await parallel(
  lenses.map((lens) => () =>
    agent(
      `Judge this finding through the ${lens} lens only — is it real? ` +
        `Finding: ${JSON.stringify(finding)}. Evidence: read ${evidencePath} yourself. ` +
        'Reply {"real":boolean,"reason":"…","outOfScopeConcerns":"…"}.',
      { engine: "claude", schema: lensVerdictSchema }
    )
  )
)).filter(Boolean);
const sunk = votes.some((v) => v.real === false);
```

**Fan-out then compile** — parallel structured workers, filter `null`, then one
compiler agent over the collected results. Mind the fan-in: the compile prompt is
the **sum** of the upstream outputs, so it has an input ceiling the fan-out does
not. Feed one worker many large results and it degrades to retries, then `null`
(the documented empty/invalid path). When the concatenated input grows large —
many items, or large per-item outputs, think tens of KB — don't dump the raw
fan-out into a single worker. Instead, in rough order: project each item down to
only the fields the reduce needs before concatenating; **tree-reduce** (compile in
batches, then compile the batch summaries); or feed the reduce a distilled view
rather than the raw results.

**Build, then refine in place** — when later turns profit from the worker's
accumulated context (propose-then-implement, review-then-fix, iterate on a
draft), hold one worker open with `session()` instead of re-briefing a cold
dispatch through a pasted summary. Turns are sequential on one handle, each
with the full schema/retry contract; keep the cross-engine check by having
the *other* family judge each turn's output one-shot. Check `handle.stale`
after a long gap — a stale session may cost the re-read a fresh dispatch
would avoid:

```js
const builder = session({ engine: "codex", model: "<a Codex model>", effort: "medium" });
const plan = await builder.send(`Read ${dir} and propose a fix plan.`, { schema: planSchema });
const impl = await builder.send("Implement step 1 of your plan; return the diff.");
const verdict = await agent(`Refute this diff as a fix for the plan: ${impl}`, { engine: "claude", schema: verdictSchema });
await builder.close();
```

**Decision gate** — when the next stage needs a judgement the script cannot
make (a user sign-off, spending past an agreed point), raise
`await hold({ content, verdicts })` and branch on the resolved verdict. The
run idles without burning a worker; whoever decides answers the hold
(`ensemble holds` lists what is open, `ensemble holds answer` answers it), and
a `timeoutMs` with `HoldTimeoutError` caught turns an unanswered gate into a
bounded outcome rather than a hung run.

**Judge panel** — when the option space is wide (a design, an approach, a
naming), generate N independent attempts from deliberately different angles
(and split them across engines so neither family dominates the pool), score
them, then synthesise from the winner while grafting the best ideas from the
runners-up. With a mixed-family pool there is no single "opposite" family, so
assign each candidate's judge from the *other* family per candidate — the
point is that no attempt is graded only by its own family. This beats
iterating on one attempt because the first attempt anchors everything
downstream of it.

**Multi-modal sweep** — when one search angle won't find everything, fan out
agents that each hunt a *different way* (by file, by symbol, by history, by
naming convention), blind to what the others surface, then merge. The value is
the disjoint coverage, not the worker count.

**Loop until dry** — for unknown-size discovery (bugs, edge cases, stale
references), a fixed count misses the tail. Keep spawning finders until K
consecutive rounds surface nothing new, deduplicating against everything
*seen* — not merely everything confirmed, or judge-rejected findings reappear
every round and the loop never converges. A round is "dry" only when workers
**succeeded and found nothing new** — a round where every worker failed to
`null` is evidence of a failing engine, not of exhaustion, and must not
advance the dry counter:

```js
const seen = new Set(), confirmed = [];
let dry = 0;
while (dry < 2) {
  const rounds = (await parallel(FINDERS.map((f) => () =>
    agent(f.prompt, { engine: "codex", schema: bugsSchema })
  ))).filter(Boolean);
  if (rounds.length === 0) throw new Error("all finders failed — not dryness");
  const fresh = rounds.flatMap((r) => r.bugs).filter((b) => !seen.has(b.key));
  if (fresh.length === 0) { dry += 1; continue; }
  dry = 0;
  fresh.forEach((b) => seen.add(b.key));
  const judged = await parallel(fresh.map((b) => () =>
    agent(`Try to refute: ${JSON.stringify(b)}. Reply {"real":boolean}.`,
      { engine: "claude", schema: verdictSchema })
      .then((v) => ({ b, real: v?.real === true }))
  ));
  confirmed.push(...judged.filter(Boolean).filter((j) => j.real).map((j) => j.b));
  log(`${confirmed.length} confirmed, ${seen.size} seen`);
}
```

**Completeness critic** — end a comprehensive run with one agent asking
"what's missing — an angle not swept, a claim unverified, a source unread?",
handed the task brief and *pointers to* the run's outputs (per the briefing
discipline in `SKILL.md` — a critic reading your summary can only audit the
summary). In-scope omissions become the next round of work; out-of-scope
discoveries are reported to the caller, never silently absorbed into a
bounded commission.

**No silent caps** — when a workflow bounds its coverage (top-N, sampling, a
single retry), `log()` what was dropped. A truncated sweep that doesn't say so
reads downstream as "covered everything".

**Loop until a count is reached** — accumulate across rounds, and bound the
rounds: a worker that keeps failing returns `null` forever, and nothing else in
the default configuration stops the loop. Deduplicate on a stable key so
repeats don't count toward the target:

```js
const found = new Map();
for (let round = 0; found.size < 10 && round < 25; round++) {
  const r = await agent("Find one more distinct item.", { engine: "codex", schema: itemSchema });
  if (r && !found.has(r.key)) found.set(r.key, r);
  log(`${found.size}/10 after round ${round + 1}`);
}
if (found.size < 10) log(`stopped at ${found.size}/10 — round bound hit`);
```

**Loop until a budget runs out** — set a Codex ceiling with `--budget
codex=200000` and gate on `remaining()`. Without a `--budget` for that engine,
`remaining()` is `Infinity` and this loop never ends, so only use it when you
have set a ceiling. The ceiling is checked once, when each call dispatches: a
call already started completes its retries, and a later call throws
`BudgetExceededError` once spend has reached the ceiling — catch it to keep
the accumulated results:

```js
const found = [];
while (budget.remaining("codex") > 0) {
  try {
    const r = await agent("Find one more distinct item.", { engine: "codex", schema: itemSchema });
    if (r) found.push(r);
  } catch (e) {
    log(`stopping on budget: ${e}`);
    break;
  }
  log(`${found.length} found, ${budget.remaining("codex")} Codex tokens left`);
}
```

**Scale to what matters.** Worker count is a dial, not a constant — set it
from the stakes and the uncertainty, with the request's wording as a tiebreak.
"Find any bugs" wants a few finders and a single-vote verify; "thoroughly
audit this" wants a larger finder pool, a multi-vote adversarial pass, and a
synthesis stage. Spend panels where a wrong answer is costly or verifiers
disagree; a low-stakes decision keeps a small fleet however grand the phrasing.

**Compose a saved verifier** — keep a reusable verifier panel in the project
registry, then call it from task-specific parent workflows.

Saved file, for example
`.claude/ensemble/workflows/claim-verifier.js`:

```js
export const meta = {
  name: "claim-verifier",
  description: "Verify a claim with a Claude panel and return the majority verdict"
};

const verdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["real", "reason"],
  properties: {
    real: { type: "boolean" },
    reason: { type: "string" }
  }
};

const votes = (await parallel(
  Array.from({ length: 3 }, () => () =>
    agent(
      `Independently verify this claim. Reply {"real":boolean,"reason":"..."}: ${args.claim}`,
      { engine: "claude", schema: verdictSchema }
    )
  )
)).filter(Boolean);

return {
  votes,
  real: votes.filter((vote) => vote.real).length >= 2
};
```

Parent workflow:

```js
export const meta = {
  name: "claim-check-parent",
  description: "Produce a claim, then compose the saved verifier workflow"
};

const finding = await agent("State one specific, checkable claim about DNS.", { engine: "codex" });
const verdict = await workflow("claim-verifier", { claim: finding });

return { finding, verdict };
```

Use `{ scriptPath }` when you want a specific saved file rather than registry
name lookup:

```js
const verdict = await workflow({ scriptPath: ".claude/ensemble/workflows/claim-verifier.js" }, { claim: finding });
```

**Name roles, not engines, where the machine binds them.** A script whose
calls say `{ target: "doer" }` and `{ target: "reviewer" }` can be moved
between families by one edit to the machine configuration, and a run of it
can be moved for one launch with `--remap`. The trade is portability: the
names must be bound on every machine that runs the script (`rerouting.md`).


## Headline example — cross-engine verification (live-requiring)

Codex proposes a checkable claim; Claude **independently verifies** it — one
model family checking the other within a single run. This script runs through
the launcher exactly as written; it dispatches real workers, so the *Live
requirement* section of `SKILL.md` applies, and the expected output is shown
below so the workflow reads correctly even where it cannot run.

```js
export const meta = {
  name: "cross-engine-verify",
  description: "Codex proposes a factual claim; Claude independently verifies it"
};

// Stay inside Codex's accepted schema subset (object, additionalProperties:false,
// required ⊆ properties) — these schemas validate on all engines.
const claimSchema = {
  type: "object",
  additionalProperties: false,
  required: ["claim"],
  properties: { claim: { type: "string" } }
};

const verdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verified", "reason"],
  properties: {
    verified: { type: "boolean" },
    reason: { type: "string" }
  }
};

// 1. Codex FINDS: propose one specific, checkable claim.
phase("find");
const finding = await agent(
  'State one specific, verifiable factual claim about the TCP protocol. Reply as JSON {"claim":"…"}.',
  { engine: "codex", schema: claimSchema }
);
if (finding === null) {
  throw new Error("Codex produced no valid finding after retries");
}

// 2. Claude VERIFIES: a different model family judges Codex's claim, so neither
//    model checks only its own work.
phase("verify");
const verdict = await agent(
  `Independently verify this claim — is it true? Claim: "${finding.claim}". ` +
    'Reply as JSON {"verified":boolean,"reason":"…"}.',
  { engine: "claude", schema: verdictSchema }
);

log(`claim ${verdict?.verified ? "survived" : "failed"} cross-engine verification`);
return { finding, verdict, crossEngineConfirmed: verdict?.verified === true };
```

Run it (`ensemble` is the shorthand from *The launcher* in `SKILL.md`):

```bash
ensemble cross-engine-verify.js
```

stdout is one line of JSON — `{"finding":{"claim":"…"},"verdict":{"verified":true,"reason":"…"},"crossEngineConfirmed":true}`;
stderr carries `[phase] find`, `[phase] verify`, the `runs unpinned` notes for
the two unpinned calls (pin `model` in a `defaults` export to silence them), and
the `claim survived cross-engine verification` log line.
