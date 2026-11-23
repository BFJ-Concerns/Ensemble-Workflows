# Sessions and holds

`session()` keeps one worker across several turns. `hold()` pauses a run for
a decision from outside it. This file covers writing both into a script, and
listing and answering holds from the shell.

## Multi-turn sessions

```js
const builder = session({ engine: "claude", effort: "medium", label: "builder" });

const plan = await builder.send("Read docs/parser.md and propose a plan for the parser.");
if (plan === null) throw new Error("the builder produced no plan");

const report = await builder.send("Implement your plan, run the tests, and report any failures.", {
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["failures"],
    properties: { failures: { type: "array", items: { type: "string" } } },
  },
});
await builder.close();
```

`session(options)` returns a handle; `handle.send(prompt, { schema? })` runs
one turn on the same worker each time. A later turn reaches a worker that
still holds everything from its earlier turns, where a fresh `agent()` call
would have to be briefed again. Sessions run on `codex`, `claude`, `agy` and
`zcode`. `opencode` refuses them.

- **Fixed at creation:** `engine` or `target`, `model`, `effort`,
  `fallback`, `cwd`, `isolation`, `timeoutMs`, `maxAttempts`, `label`,
  `phase`, `strip`, `lean`, `identity` and `stalenessMark`. Any other key is
  refused. A change of model or effort means a new session.
- **Per turn:** only `schema`. Each turn has the contract of an `agent()`
  call: the reply text, a validated value, or `null`. With `identity: true`
  at creation, every turn resolves the identity envelope.
- **Turns run one at a time.** `send()` while the previous send is unsettled
  throws, as does `send()` after `close()`.
- **Nothing spawns until the first `send()`.** A turn holds its engine's
  concurrency slot only while it runs, and an idle session holds none. Each
  turn's budget check happens at its own `send()`.
- **A failed turn leaves the session usable**, unless its worker was lost.
- **A fallback chain applies to the first turn only.** The target that
  answers it is the session's engine and model for life; `handle.engine`
  reports it.
- **Every session closes when the run ends.** `await handle.close()` ends
  one earlier. A session cannot outlive its run or be picked up by a later
  one.

**Staleness.** `handle.stale` becomes `true` once the session has sat idle
long enough that its next turn will probably pay to re-read its whole
context: an hour on `claude` and `codex`, five minutes on `agy`, and on
`zcode` whatever the machine configuration declares for the model's
provider, with no mark where it declares nothing. `handle.idleMs` gives the
idle time and `handle.staleAfterMs` the threshold. The mark is advisory. A
send to a stale session still runs, and the script decides whether to pay
for the re-read or start a fresh worker with a new briefing.
`stalenessMark: false` turns the mark off.

**Lost workers.** `handle.lost` becomes `true` once the engine has found
the session's worker gone for good, and stderr says so. A send to a lost
session resolves `null` on a single `session-lost` attempt. The context the
worker held is gone, so start a new session and brief it again. On `codex`
one app-server serves every session of the run, and its death loses all of
them.

**On `claude`**, follow-up turns are delivered through `tmux` and fail
without it. A follow-up that begins with `/name` runs as a command, as an
opening prompt does.

**Keeping the check.** A session gives one worker a long memory, which is
also one family's view carried forward. Have a worker of another family
judge each turn's output with a one-shot `agent()` call.

## Raising a hold

```js
const { verdict, note } = await hold({
  content:
    "Three findings survived verification; findings.json in the working directory lists them. " +
    "approve opens a pull request with the fixes; reject ends the run and keeps the branch.",
  verdicts: ["approve", "reject"],
});
if (verdict === "reject") return { opened: false, note };
```

`hold({ content, verdicts, timeoutMs? })` publishes the hold and waits. It
resolves `{ verdict, note }` when someone answers with one of the listed
verdicts. An answer outside the list never reaches the script: it is
rejected, and the hold keeps waiting.

- **`content` is all the decider has.** State what is being decided, where
  the evidence is, and what each verdict will cause.
- **No worker is spent on the wait**, and a hold takes no concurrency slot.
  A session left idle across a long hold may be stale when the run resumes.
- **Without `timeoutMs` a hold waits for as long as the run lives.** With
  one, `hold()` rejects with `HoldTimeoutError` on expiry; catch it to turn
  an unanswered question into a defined outcome.
- **A run waiting on a hold has not exited.** Start a run that raises holds
  in the background, as [run-evidence.md](run-evidence.md) describes.

Use a hold where a judgement is not the script's to make: a sign-off before
something irreversible, spending past an agreed point, a choice between
directions. Do not use one for what a worker or plain code can decide.

## Scopes

A scope is a key that keeps separate sessions on one machine from seeing,
and answering, each other's holds. Set `ENSEMBLE_HOLD_SCOPE` once in the
environment a session launches its runs from, and every run and nested run
inherits it; `--hold-scope <scope>` overrides it for one launch. A value
unique to the launching session, such as its own session id, is a natural
scope.

A run with no scope raises its holds in a shared default scope. Scoped
listings never show that scope, and the machine-wide listing always does.

## Listing and answering

When a hold is raised, the run prints a `[hold]` line on stderr: JSON
carrying `hold_id`, `event: "raised"`, the accepted `verdicts`, and
`answer_commands`, one ready shell command for each verdict. Open holds also
appear in the run's live status file.

```sh
node <launcher> holds
node <launcher> holds --json
node <launcher> holds --scope <scope>
node <launcher> holds --all
```

With no option, `holds` lists the inherited scope's holds, or every scope's
when none is set. `--all` lists every scope, the shared default included.
Each entry shows the hold's id, state, scope, verdicts and content, with the
raising run's workflow name and phase. A hold is `open`, or `bounced` when a
rejected answer is waiting to be corrected.

```sh
node <launcher> holds answer <hold-id> --verdict approve --note 'Looks right; go ahead.'
```

`holds answer` prints one JSON object and exits:

| Exit code | Meaning |
|---|---|
| 0 | The answer was consumed and the hold is gone: normally, the run accepted it and resumed |
| 3 | The answer bounced. The output gives the reason, the allowed verdicts and ready answer commands; the hold keeps waiting |
| 4 | The run has not read the answer yet; it stays in place |
| 5 | No open hold has that id |
| 6 | The hold settled without judging this answer |

Any process can also answer by hand. The hold is a JSON file under
`$XDG_DATA_HOME/ensemble/holds/` (normally `~/.local/share/ensemble/holds/`)
that names a `nonce` and a `decision_path`. Write
`{ "nonce": "<the hold's nonce>", "verdict": "<one of the verdicts>", "note": "<optional>" }`
to a temporary file beside `decision_path`, then rename it into place.

**Whose answer it is.** A hold exists because the decision is not the
script's. Answer on your own account only a hold the user has delegated to
you. For one that asks for the user's judgement, put its content to the
user and answer with the verdict they give.
