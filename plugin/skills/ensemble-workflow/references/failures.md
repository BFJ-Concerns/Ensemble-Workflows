# Failures, deadlines, budgets, and how a run ends

What a failed call gives the script, what throws instead, how failures are
classed and retried, and every way a run can end.

## A failed call is a value

Once a worker has spawned, its call cannot throw on the worker's account. It
resolves the answer, or `null` when the attempts are spent. This covers bad
output on every attempt, an availability failure no fallback entry answered,
a transport error, a deadline, and a schema Codex rejected. Stderr carries
one line for each failed worker:

```text
[codex] agent 3 (scan) failed after 3 attempts — <cause>
```

A call that had a fallback chain reports its answered attempts, its refused
targets, and the last target's failure.

To read the failure inside the script, pass `identity: true`: the call then
resolves an envelope whose `failure` is `{ kind, message }`, where `kind` is
the recorded failure class or error name, such as `TurnTimeoutError` or
`empty-output`. Outside the script, the run record's agent record holds
every attempt; see [run-evidence.md](run-evidence.md).

A script that handles its `null`s and returns ends `complete` with exit
code 0, however many workers failed. Report the count in the return value.

## What throws

**A rejection raised before the worker exists.** These are faults in how
the script was written or in the machine it runs on, and they throw so that
neither can pass unnoticed:

- an unrecognised option, an invalid option value, or an option the named
  engine cannot honour (`strip` on `agy`, `lean` on `codex`, `session()` on
  `opencode`);
- no `engine` and no `target`, an unknown engine, a `target` the machine
  does not bind, or a `target` beside an `engine` or `model`;
- an `opencode` or `zcode` call with no model, or an `opencode` model the
  machine does not declare;
- a schema that does not compile, an empty or malformed fallback chain;
- a `cwd` that does not exist, or a worktree that could not be created;
- an effort level that the machine's bounds leave no served level for;
- a token budget that refuses the dispatch (`BudgetExceededError`);
- an engine that refused the dispatch itself, when no fallback entry
  remained to take it (`ClaudeDispatchError`, `CodexSubstrateRefusedError`,
  `AgySubstrateRefusedError`, `ZCodeSubstrateRefusedError`), or a directory
  the engine needs that the launching process cannot use
  (`ResourcePreflightRefusedError`).

They pass through `parallel()` and `pipeline()`. Uncaught, one fails the
run: exit code 1, with the partial-result envelope on stdout. A script may
catch one where it has a real alternative, such as stopping a loop when the
budget refuses.

**The run's own ending.** An interrupt or the whole-run deadline throws
through every call and session turn it cut short, and through any started
after it. Let it propagate. Code that catches it and carries on is acting
on a run that has already ended: its later calls are rejected too, and the
run still ends as interrupted or timed out.

`hold()` rejects with `HoldTimeoutError` when its own `timeoutMs` expires,
which a script may catch, and with `HoldRejectedError` when raised after the
run began ending.

## Failure classes

Every failed attempt is classified from the engine's own diagnostic.

| Class | Covers | What the runtime does |
|---|---|---|
| availability | The engine refused or lost the worker before it answered: an exhausted allowance, a rate limit or overload that outlasted the engine's own retries, missing or rejected credentials, a process that died or never started, a directory the engine could not use | Moves to the next fallback entry without spending an attempt. With no entry left, the failure spends an attempt, or throws when no worker ever existed |
| output | An empty, unparseable or off-schema answer, or a turn that streamed only whitespace for two minutes | Retries on the same target, telling the worker what was wrong |
| unclassified | Everything else: a deadline, a schema Codex rejected, a request the provider rejected, a bad model name, a diagnostic no rule recognised | Retries on the same target, and leaves any fallback chain unconsulted |

Only an availability failure moves a call down its fallback chain. A bad
answer is evidence about the prompt as much as about the model, so it is
never passed down the chain.

These settle a call at once, with no retry:

- Codex rejected the output schema.
- The provider rejected the reasoning level (`effort-rejected`).
- A session's worker is gone (`session-lost`).
- A Claude prompt opened with a `/name` command that runs no skill
  (`claude-command-not-skill`).

## Retries

A call makes up to `maxAttempts` attempts, three by default. The bound
counts answered attempts across the call's whole fallback chain; a refusal
that moves the chain on costs none.

A retried worker's side effects are not undone. A worker that edited files
or ran a command on a failed attempt has still done so when the retry
starts. Where repeating the task would do harm, set `maxAttempts: 1` and
handle the `null`.

## Deadlines

Nothing has a deadline unless one is set.

- `timeoutMs` on a call bounds each attempt. An expired attempt is a failed
  attempt like any other, and is retried. A call whose deadline should end
  it outright also sets `maxAttempts: 1`.
- `--timeout ms` bounds the whole run. When it expires the run ends
  `timed-out`: exit code 1, with the partial-result envelope. It fires from
  a timer, so it cannot interrupt a script spinning in synchronous code.

Set a deadline when the task has one. A deadline added for safety cuts off
legitimate long work. A wedged worker shows up as a run that does not end;
[run-evidence.md](run-evidence.md) says how to tell and what to do.

## Budgets

`--budget engine=N` sets a token ceiling for one engine. The ceiling is
checked when a call is dispatched, at each `send()` of a session, and again
when a fallback step moves a call to another engine.

- Once spend has reached the ceiling, the next dispatch on that engine
  throws `BudgetExceededError`. The message names the refused call, the
  spend and the ceiling.
- Every call admitted below the ceiling still runs to its retry bound,
  including calls waiting in the queue, so a wide fan-out can overshoot.
- Spend counts cached input too. See `budget` in
  [script-api.md](script-api.md).

A loop that works until a budget runs out catches the refusal to keep what
it has gathered:

```js
const found = [];
while (budget.remaining("codex") > 0) {
  try {
    const item = await agent("Find one more distinct item.", {
      engine: "codex",
      schema: itemSchema,
    });
    if (item !== null) found.push(item);
  } catch (error) {
    if (error?.name !== "BudgetExceededError") throw error;
    log("stopping: the Codex budget is spent");
    break;
  }
}
return found;
```

Without a `--budget` for that engine, `remaining()` is `Infinity` and this
loop never ends. Bound such a loop by rounds as well.

## How a run ends

| Ending | Exit code | stdout |
|---|---|---|
| The script returned | 0 | The return value |
| The script threw, or a rejection went uncaught | 1 | Partial-result envelope, `reason: "failed"` |
| `--timeout` expired | 1 | Partial-result envelope, `reason: "timed-out"` |
| SIGINT or SIGTERM | 130 or 143 | Partial-result envelope, `reason: "interrupted"` |
| The invocation was rejected before a run began | 2 | Nothing; one diagnostic line on stderr, no sentinel, no archive |

The partial-result envelope is

```json
{"partial":true,"reason":"failed","error":{"kind":"…","message":"…"},"completed":[…]}
```

where each `completed` entry is `{ id, engine, label, phase, output }` for a
worker that finished successfully. The script's own unfinished result
cannot be recovered from it. A single `agent` run whose worker failed ends
the same way, with the worker's failure in `error`.

On any of these endings the runtime cancels the run's workers on every
engine, held sessions included, so a stopped run stops spending.

- **Stopping a run:** send the launcher SIGINT. It ends the run once, fully
  recorded, and prints what finished. SIGKILL ends it sooner and leaves no
  completion sentinel.
- **`process.exit` in a script** is intercepted: the run ends `failed` with
  `WorkflowProcessExitError`.
- **Returning with a worker still running** ends the run. The worker is
  stopped, and stderr carries a `[teardown]` line for it. The result still
  stands and the exit code is still 0, so an unawaited call loses its work
  without failing anything.
- **Awaiting something nothing will settle** ends the run `failed` with
  `WorkflowUnsettledError`.
- **A run that could not confirm its own processes had ended** says so in a
  `[teardown] the run failed to end cleanly` line naming what may still be
  running, and exits 1 even after a clean script. Pass that line to the
  user.
