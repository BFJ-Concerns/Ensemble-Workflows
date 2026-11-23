# Workflow shapes

Shapes that recur when work is spread over agents, each with the mistake it
is prone to. They are starting points: a workflow is ordinary JavaScript
around `agent()`, and the right shape for a job is often a mix of these or
none of them.

The fragments assume schemas and `defaults` declared earlier in the script,
as in the example in `SKILL.md`.

## Stages per item: a pipeline, not two barriers

When each item goes through several stages on its own, use `pipeline()`.
Two `parallel()` calls in a row make every fast item wait for the slowest
item of the first stage. Keep the barrier for a second stage that needs all
of the first stage's results at once: removing duplicates across the whole
set, or stopping early when the total is zero.

```js
const results = await pipeline(
  AREAS,
  (area) =>
    agent(`Review ${area.path} for ${area.concern}. List each defect you find.`, {
      engine: "codex",
      schema: findingsSchema,
      label: `review-${area.key}`,
    }),
  (review, area) =>
    review === null
      ? null
      : parallel(
          review.findings.map((finding, i) => () =>
            agent(
              `A reviewer reports this defect in ${area.path}: ${JSON.stringify(finding)}. ` +
                `Read the code and try to refute it.`,
              { engine: "claude", schema: verdictSchema, label: `verify-${area.key}-${i + 1}` },
            ).then((verdict) => ({ finding, verdict })),
          ),
        ),
);

const reviewed = results.filter((result) => result !== null);
const entries = reviewed.flat().filter((entry) => entry !== null);
const checked = entries.filter((entry) => entry.verdict !== null);
return {
  confirmed: checked.filter((entry) => entry.verdict.real),
  areasNotReviewed: results.length - reviewed.length,
  findingsNotChecked: entries.length - checked.length,
};
```

Failures sit at two depths here: a failed review leaves `null` in the outer
slot, and a failed check leaves a `null` verdict inside. The result counts
both.

## A panel of checkers

One checker's verdict is one sample. Where a wrong answer is costly, fan the
check out over several workers of the family that did not produce the
finding.

- **Identical checkers** all answer one question, so a majority means
  something: keep a finding that at least two of three failed to refute.
- **Checkers with different lenses** (is it correct, is it exploitable, does
  it reproduce) answer different questions, so a majority means nothing.
  Treat each lens's refutation as a veto on its own ground.

```js
const votes = (
  await parallel(
    [1, 2, 3].map((n) => () =>
      agent(`Try to refute this claim, reading the code yourself: ${JSON.stringify(finding)}`, {
        engine: "claude",
        schema: verdictSchema,
        label: `refute-${n}`,
        fallback: false,
      }),
    ),
  )
).filter((vote) => vote !== null);
const confirmed = votes.length >= 2 && votes.filter((vote) => vote.real).length >= 2;
```

Three checkers given the same prompt share one blind spot. Lenses spread
it.

## Fan out, then combine

Many workers each return a structured piece, and one worker combines them.
The combining prompt is the sum of everything upstream, so it has a size
limit the fan-out does not: fed too much, the combiner degrades into
retries and then `null`.

- Pass the combiner only the fields it needs from each piece.
- When the pieces are many or large, combine in batches and then combine
  the batch results.
- Say in the result how many pieces were missing.

## Build, then refine, in one session

When later steps build on earlier ones (propose, implement, fix what the
tests show), hold one worker with `session()` so each step starts from
everything before it. Put a worker of another family between turns to judge
what the session produced, and feed its objections into the next turn.
See [sessions-and-holds.md](sessions-and-holds.md).

## A gate for someone else's decision

Before a step the script should not take on its own authority, raise
`hold()` and branch on the verdict. Give it a `timeoutMs` and catch
`HoldTimeoutError` where an unanswered question should become a defined
outcome and not an open-ended wait.

## Search until nothing new turns up

For discovery of unknown size (defects, stale references, edge cases) a
fixed number of finders misses the tail. Run rounds until some number in a
row find nothing new.

```js
const seen = new Set();
const confirmed = [];
let dryRounds = 0;
for (let round = 1; dryRounds < 2 && round <= 10; round += 1) {
  const reports = (
    await parallel(
      ANGLES.map((angle) => () =>
        agent(angle.prompt, { engine: "codex", schema: findingsSchema, label: `find-${angle.key}-${round}` }),
      ),
    )
  ).filter((report) => report !== null);
  if (reports.length === 0) throw new Error(`every finder failed in round ${round}`);

  const fresh = reports.flatMap((report) => report.findings).filter((finding) => !seen.has(finding.key));
  if (fresh.length === 0) {
    dryRounds += 1;
    continue;
  }
  dryRounds = 0;
  fresh.forEach((finding) => seen.add(finding.key));
  // … check each fresh finding with another family, and push the survivors onto `confirmed`
}
await tally("rounds without a new finding", dryRounds);
```

- Remove duplicates against everything seen, not only what was confirmed, or
  refuted findings return every round and the loop never settles.
- A round in which every finder failed says an engine is failing, not that
  the search is exhausted. Do not count it as dry.
- Give finders different angles (by file, by symbol, by history). The value
  is the coverage that does not overlap.

## Bound every loop, and say what was cut

A worker that keeps failing returns `null` for ever, and nothing in a
default run stops a loop that waits on it. Give every loop a round limit.
When a workflow limits its own coverage (a round limit reached, a top-N
cut, a sample), `log()` it and return it: a truncated sweep that does not
say so reads as a complete one.

## Roles through named targets

Where the machine binds names for roles, a script that names roles moves
between families with one edit to the machine configuration. Check at the
top that the roles exist and sit on different families:

```js
const doer = lookupDispatch({ target: "doer" });
const reviewer = lookupDispatch({ target: "reviewer" });
if (!doer.bound || !reviewer.bound) {
  throw new Error("this workflow needs the doer and reviewer targets bound");
}
if (doer.family !== null && doer.family === reviewer.family) {
  log(`doer and reviewer both resolve to ${doer.family}: no cross-family check in this run`);
}
```

The trade is portability: the names have to be bound wherever the script
runs. See [rerouting.md](rerouting.md).

## A stage worth keeping

A stage rewritten in script after script (a checker panel, a triage pass, a
combiner) can be saved once and called with `workflow("name", args)`. Give
it a clear `meta.name` and `meta.description`, take everything it needs
through `args`, and return everything it found. See `workflow()` in
[script-api.md](script-api.md).

## How many workers

Worker count follows the stakes and the uncertainty, not the size of the
request's adjectives. A quick look takes a few finders and one check each.
A thorough audit takes a wider finder pool, a panel on each finding, and a
last worker asked what the run missed: an angle not searched, a claim not
checked. Spend panels where a wrong answer is costly or checkers disagree.
