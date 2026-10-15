# Workflow scripts

A workflow script is a JavaScript file that dispatches agents and combines
their results. Run it with `ensemble <script.js> [args...]` (see
[CLI](cli.md)); its return value is printed on stdout as JSON.

```js
export const meta = {
  name: "summarise-changes",
  description: "Summarise each changed file, then write one overview",
};

const files = args;

phase("Summarise");
const summaries = await parallel(
  files.map((file) => () =>
    agent(`Summarise the purpose of ${file} in two sentences.`, {
      engine: "codex",
      model: "gpt-6-luna",
      label: file,
    }),
  ),
);

phase("Overview");
return agent(
  `Write a one-paragraph overview from these summaries:\n\n${summaries
    .filter((summary) => summary !== null)
    .join("\n\n")}`,
  { engine: "claude", model: "opus" },
);
```

## Script shape

A script must begin with an `export const meta = { … }` object literal,
normally carrying the workflow's `name` and `description`. Anything before it, a comment included, is rejected before any
worker spawns. It may be followed by an optional `defaults` export (see
[Script defaults](#script-defaults)). Blank lines, `//` comments, and
`/* … */` comments may separate the two exports; a `defaults` export declared
later in the body is rejected with a placement error.

The rest of the file is the workflow body. It runs as the body of a single
async function, so `return` produces the run's result and top-level `await`
works. The body is ordinary, unsandboxed Node: every Node global (`process`,
`Buffer`, `fetch`, timers), the filesystem and network, `require(...)` and
dynamic `import()` resolving from the script's own path, and `import.meta`
are all available alongside the hooks below. Static `import` statements do
not work, because the body is a function body rather than a module's top
level. `meta` is bound read-only.

A free identifier that is neither a Node global, a hook, nor a binding in the
script fails at load, before any worker spawns, and the error names it. A
`typeof X` probe is fine. Syntax errors name the script's own line and column
with a source excerpt and a caret.

The script is a trusted program run by the user who launched it. Ensemble
dispatches and records workers only through `agent()` and `session()`; prompts
constrain what a worker does, not what it can do.

## Hooks

| Hook | Purpose |
|---|---|
| `agent(prompt, options)` | Run one worker and return its answer |
| `session(options)` | Create a multi-turn worker that keeps its context between turns |
| `parallel(thunks)` | Run calls concurrently and collect the results |
| `pipeline(items, ...stages)` | Run each item through a series of stages independently |
| `workflow(nameOrRef, args?)` | Run a saved workflow inline and return its result |
| `hold(options)` | Pause for an outside decision |
| `phase(title)`, `log(message)` | Write to the run log; `phase` also updates the live status |
| `tally(name, value)` | Record a named count in the run record |
| `budget.spent(engine)`, `budget.remaining(engine)` | Per-engine token accounting |
| `worktrees` | Worktrees left by `isolation: "worktree"` calls |
| `args` | The script's arguments |

### `agent()`

`agent(prompt, options)` runs one worker on `options.engine` — `"codex"`,
`"claude"`, or `"opencode"`. There is no default engine. The prompt must be a
non-empty string.

- With `options.schema`, it returns a value that validates against the
  schema, or `null` once its attempts are exhausted.
- Without a schema, it returns the worker's final text (trimmed, non-empty),
  or `null` on the same terms.

A failed call returns `null` rather than throwing; see
[Failures](#failures). A Claude call with no `model` is flagged on stderr.

### Fallback chains

`fallback` declares an ordered chain of other targets for a call —
`[{ engine, model, effort? }, …]`, each a Codex or Claude target. Ensemble
moves the call to the next target when the current one fails for
**availability**: the allowance is exhausted, the provider is overloaded past
its own retries, or the engine's process died or never started. Output
failures (empty, unparseable, or off-schema answers) are retried on the same
target and never advance the chain.

- Each step re-dispatches the same prompt, schema, placement, and strip
  settings on the next target, fresh.
- `maxAttempts` counts answered attempts across the whole chain; a refusal
  costs none.
- A step to the same engine keeps its concurrency slot; a step to another
  engine releases it and is admitted again under that engine's cap and
  budget.
- A chain whose every target refuses fails with the last target's own
  failure.
- An empty or malformed chain, an opencode entry, or an engine the run does
  not have throws `FallbackTargetRejectedError` before any worker spawns. An
  opencode call may declare a chain of Codex and Claude targets.

Every step is a dispatch Ensemble makes and records itself. The run record
shows each attempt's target and which entry answered, and stderr says when a
fallback entry answered for a refused target.

### Script defaults

```js
export const defaults = {
  codex: { model: "gpt-6.1-sol", effort: "low" },
  claude: { model: "opus", fallback: [{ engine: "codex", model: "gpt-6.1-sol" }] },
};
```

The optional second export sets per-engine `model`, `effort`, and `fallback`
values that every `agent()` call and `session()` on that engine inherits;
options given at the call win. A chain in one engine's block may name targets on another engine.

### `parallel()` and `pipeline()`

`parallel(thunks)` runs every thunk concurrently and returns all the results
in order. `pipeline(items, ...stages)` runs each item through each stage —
`stage(previous, originalItem, index)` — with no barrier between stages, so a
fast item moves on without waiting for slow ones.

A failed worker is already its call's `null`. A thunk or stage that throws for
any other reason also becomes `null` in the results, and is logged. Check
fan-in results for `null`.

One family of errors propagates instead and fails the run: errors in how the
script was written, raised before any worker spawns. These are a rejected
`agent()` option, a malformed schema, an unresolvable `workflow()` reference
or non-JSON `workflow()` arguments, a nesting violation, and a child
workflow's load-time error. When several of a call's options fail the
option check, one error names them all.

To tell a failed call from one that legitimately answered `null`, pass
`identity: true`. The call then resolves `{ label, phase, output, failure }`,
where `failure` is `null` exactly when the worker completed — so
`output: null` with `failure: null` is a genuine answer — and a `{ message }`
account when it failed. Inside `parallel()` and `pipeline()`, an identified
call that collapses resolves this shape too, never a bare `null`.

### `workflow()` and saved workflows

`workflow(nameOrRef, args)` runs another workflow inline and returns its
result. `nameOrRef` is a workflow name or `{ scriptPath }`:

- A name is looked up first in the project registry,
  `.claude/ensemble/workflows/` under the run's working directory, then in the
  user registry, `${XDG_DATA_HOME:-~/.local/share}/ensemble/workflows/`.
  Lookup reads each file's `meta.name`, so filenames are only storage.
- `{ scriptPath }` resolves like the script path on the command line:
  relative to the run's working directory unless absolute.

The child shares the parent's runtime: the same concurrency caps, budgets,
worktrees, and run record. Nesting is one level only; calling `workflow()`
inside a child throws. Both registries start empty; saved workflows in the
project registry are ordinary source files you can commit. `ensemble
workflows` lists them.

### `phase()`, `log()`, and `tally()`

`phase(title)` and `log(message)` write to the run log on stderr; `phase()`
also sets the current phase in the live status file.

`tally(name, value)` records a named number in the run record's manifest,
beside the usage totals — how many findings a check accepted, or how many fix
rounds ran: `await tally("fix rounds", 3)`. Ensemble cannot know which worker
checked which, but the script can, and a tally is how it records that. Values
must be finite numbers; recording a name again replaces its value; a blank
name or a non-finite value throws.

### `budget`, `worktrees`, and `args`

`budget.spent(engine)` and `budget.remaining(engine)` report per-engine token
spend; `remaining` is `Infinity` with no ceiling. opencode spend is read from
the session export when one can be read, and otherwise from token-bearing step
events in the output stream. Across a multi-step turn it counts the final
input and cache-read figures once, plus every output and reasoning delta. A
stream with no usable token data records no spend.

`worktrees` lists the finished worktrees from `isolation: "worktree"` calls on
any engine, with each one's final tip commit, whether it changed, and whether
an unchanged worktree was removed.

`args` is the array of positional string arguments from the command line, or
the parsed value of `--json-args` (a JSON `null` arrives as an empty array).

## `agent()` options

`engine` is required: `"codex"`, `"claude"`, or `"opencode"`. An omitted or
unknown engine throws before any worker spawns.

| Option | Description |
|---|---|
| `engine` | Engine to run on |
| `model` | Model to run (see per-engine notes below) |
| `effort` | Reasoning effort: `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `schema` | JSON Schema the answer must satisfy |
| `fallback` | Ordered chain of `{ engine, model, effort? }` targets (see [Fallback chains](#fallback-chains)) |
| `cwd` | Worker working directory; must exist. Defaults to the run's working directory |
| `isolation` | `"worktree"` to run in a fresh git worktree (see [Worktree isolation](#worktree-isolation)) |
| `timeoutMs` | Per-attempt deadline, a positive integer up to 2147483647. Unbounded when omitted |
| `maxAttempts` | Attempt bound, a positive integer. Default 3 |
| `strip` | Capabilities to remove from the worker: `"skills"`, `"agents"` (see [Permissions](#permissions-and-strip)) |
| `lean` | `true` to start the worker without the operator's interactive context (see [Lean workers](#lean-workers)) |
| `identity` | `true` to resolve `{ label, phase, output, failure }` (see [`parallel()`](#parallel-and-pipeline)) |
| `label`, `phase` | Bookkeeping shown in progress output and the run record |

An unrecognised option, or an invalid value for `effort`, `isolation`,
`timeoutMs`, `maxAttempts`, `identity`, `strip`, or `lean`, throws before the
worker spawns. `model`, `label`, and `phase` pass through unchecked. A `timeoutMs`
above the maximum is rejected rather than silently shortened.

Schemas are JSON Schema draft-07 (the default when `$schema` is omitted) or
draft 2020-12 (declare `"$schema": "https://json-schema.org/draft/2020-12/schema"`).
Any other dialect is rejected before a worker spawns. A schema object that
refers to itself is refused with the cycle's location; recursive `$ref`
schemas that compile are accepted.

### Per-engine behaviour

| | Codex | Claude | opencode |
|---|---|---|---|
| `model` | Optional; without one the engine's default is used and noted on stderr | Optional; without one a warning is printed on stderr | **Required**: a key or route declared in [`opencode_models`](configuration.md#opencode_models) |
| `effort` | Sent to the engine as the thread's effort | Mapped to the nearest level Claude Code supports (`minimal` becomes `low`) | Must name one of the model's declared `variants` |
| `schema` | Enforced by the Codex backend and checked again by Ensemble | Sent in the prompt and checked by Ensemble | Sent in the prompt and checked by Ensemble |
| `timeoutMs` | Ends the turn | Ends the wait for the session | Kills the subprocess |
| `strip` | Enforced through Codex's per-thread configuration | Enforced through permission deny rules | Not supported: throws before the worker spawns |
| `lean` | Not supported: throws before the worker spawns | The user settings layer and every MCP server withheld at dispatch | Not supported: throws before the worker spawns |
| `fallback` entry | Yes | Yes | No |
| `session()` | Yes | Yes | No: throws before the worker spawns |

The run record shows what each engine actually served: `resolved_model` and
`resolved_effort` come from the engine's own report — Codex's answer when the
thread starts, Claude Code's transcript — and are `null` when it reports none.
opencode reports no served model, so its `resolved_model` is the configured
`provider_model`.

Codex supports only a subset of JSON Schema for backend enforcement. A schema
outside that subset is rejected before generation: the call returns `null`
after one thread start, without retrying or advancing a fallback chain, and
the error names `claude` and `opencode` as engines that check the full JSON
Schema themselves.

On Claude and opencode, the worker is asked for a conforming JSON value and
may surround it with prose or a Markdown fence. A candidate value is the whole
reply, any balanced `{…}` or `[…]` region in it, or a line holding nothing but
one JSON scalar (`null`, `false`, `0`, `""`, fenced or not); a scalar
mentioned mid-sentence is prose. When a reply offers more than one candidate,
the last one that validates is the answer.

### Permissions and `strip`

Every worker runs unrestricted: it can read and write anywhere the user
running Ensemble can, and can reach the network. Codex workers are given this
full-access mode explicitly on every turn, and Ensemble does not turn off
Codex's backend web search; Claude and opencode workers run without any
containment from Ensemble.

`strip` is the one opt-in restriction. It removes a named tool-surface
capability — `"skills"` (the skill tool) or `"agents"` (subagent and
agent-messaging tools) — and nothing else: stripping `agents` does not stop a
worker running processes from a shell. A run-wide `--strip` and a call's own
`strip` combine; a call can add strips but never lift a run-wide one.

- **Codex** applies both through a per-thread configuration overlay when the
  thread starts. For `skills`, Ensemble first discovers the installed skills,
  sampling up to ten times one second apart until the set stops changing, and
  then disables bundled skills and denies each discovered skill by name. The
  result is cached per working directory for the run. If discovery errors or
  never settles, the call fails before the worker spawns rather than run
  unstripped.
- **Claude** applies deny rules for `Skill`, and for `Task`, `Agent`,
  `ListAgents`, and `SendMessage`, through the per-dispatch settings file.
- **opencode** rejects any strip before the worker spawns.

Each agent record lists the requested strips and how each was enforced.

### Lean workers

By default a worker loads the operator's whole interactive context — the
user-level rules and instructions, the skill listing, every MCP server an
interactive session of that engine would connect — which is most of a trivial
worker's input spend and gives it the operator's reach over live sessions and
desktop. `lean: true` on a call or session, or `--lean` for the whole run,
starts the worker without that context. Its reach and its engine's built-in
tool surface are untouched (`strip` is the lever for those), the project's own
settings and `CLAUDE.md` still apply, and a worker nobody asked to be lean is
unchanged. Like a strip, the lean start is opt-in only: a call cannot lift a
run-wide `--lean`.

- **Claude** dispatches the session with `--setting-sources project,local`
  and `--strict-mcp-config`, withholding the user settings layer — the
  operator's rules files, skill listing, plugins and their MCP servers, and
  user-level permission mode — and every MCP server outside an explicit
  configuration. Measured on Claude Code 2.1.300: a trivial background
  worker's first message fell from 44,601 to 591 characters and its first
  request's cached input from 36,706 to 30,206 tokens; the remainder is the
  engine's own tool schemas, which Claude Code inlines whole once the user
  layer's deny rules and tool deferral no longer apply, so a lean worker can
  see built-in tools the operator's own sessions deny.
- **Codex** and **opencode** have no measured route yet: a lean request on
  either fails before the worker spawns, naming the engine, rather than
  dispatching an ordinary worker silently.

Each agent record carries `lean` naming the route the dispatching engine
arranged it through, or `null` where nobody asked.

### Worktree isolation

With `isolation: "worktree"` the worker runs in a fresh linked git worktree on
a temporary branch. With `cwd` as well, `cwd` selects the source repository; a
`cwd` that is not in a git repository fails before the worker spawns.
Placement is decided once per target and kept across that target's retries; a
fallback step to another target opens its own.

When the worker finishes, an unchanged worktree and its branch are removed.
Changed work is kept and reported, never merged automatically: committed work
is on the reported branch, while uncommitted changes remain only in the kept
worktree. If clean-up itself fails, the call fails, the error is reported,
and the branch is recorded as changed and kept, since it was not proven
unchanged. A linked worktree shares its repository's objects and refs, so
isolation separates checkouts; it does not contain the worker.

## Failures

### What a call returns

Once a worker has spawned, every failure is a value: the call resolves `null`
(or an identified result with `failure` set). This covers bad output that
exhausts the attempt bound, an availability failure no fallback entry answers,
a transport error during an attempt, a deadline, and a Codex schema
rejection. The failure's class and details are on the agent's run record, and
stderr shows a line for each failed worker:

```text
[codex] agent 3 (scan) failed after 3 attempts — <cause>
```

A script that wants a failed call to stop the run checks for `null`.

Two kinds of failure still throw, so that a broken script or a stopped run
cannot pass silently:

- Errors raised before a worker exists: an invalid option, a placement that
  could not be opened, an engine refusing the dispatch itself
  (`ClaudeDispatchError`, `CodexSubstrateRefusedError`), a strip that cannot
  be enforced, or a budget refusal.
- The run's own ending — an interrupt or a whole-run timeout — which throws
  through any call it cut short.

A schema value of JSON `null` that validates is a successful answer, not a
failure.

### Retries

Each attempt that fails is retried, up to `maxAttempts`, with the failure fed
back to the worker. Claude corrects in the same session when tmux is
available, and otherwise starts a fresh session with the failure appended.
Codex and opencode retry with the failure appended to the prompt.

Operational failures — a Claude session that never registered or died, a
transcript that could not be read, an opencode subprocess killed at its
deadline or exiting non-zero, a Codex turn deadline, first-output deadline, or
failed thread — are failed attempts like any other. They consume an attempt
and keep the worker's partial text, exit status, and the engine's diagnostic
on the attempt record. A call whose deadline should end it outright sets
`maxAttempts: 1`.

When a single `ensemble agent` run times out, the error says which deadline
expired, because the remedies differ: the call's own `timeoutMs` (raise it or
narrow the work), or the Codex transport's request deadline (where raising
`timeoutMs` will not help).

### Failure classes

Every failed attempt is classified from its failure evidence, usually the
engine's own diagnostic:

- **availability** — the engine refused or lost the worker before it
  answered: Codex's `usageLimitExceeded`, `rateLimitExceeded`, or
  `serverOverloaded`, a refused connection, or an app-server that died or
  never started; a Claude API refusal carrying a 429, 503, or 529, a dispatch
  Claude Code refused, a dispatch the daemon never registered, or a session
  that never showed life. Only this class advances a fallback chain.
- **output** — the worker answered badly: empty, unparseable, or off-schema.
- **unclassified** — anything else, including a deadline, a Codex schema
  rejection, and a client error about a bad model name. A diagnostic that no
  rule recognised is recorded with `rule: null`.

With a chain declared, a failure that matches no rule leaves the chain
unconsulted (the chain advances on availability failures only), and stderr
says so.

### Claude dispatch

Every Claude worker is launched with `CLAUDE_CODE_SANDBOXED` set, which tells
Claude Code to skip its per-directory trust prompt. Workers placed in a fresh
directory, a sibling checkout, or a new worktree therefore start without any
prompt and without changes to your Claude configuration.

If Claude Code still refuses a dispatch before the session exists — a daemon
that will not start, a directory it cannot resolve, a version that ignores the
setting — the refusal is an availability failure that spends no attempt. It
advances a fallback chain where one remains; otherwise `agent()` throws
`ClaudeDispatchError` with Claude Code's own refusal text, which fails the run
unless the script catches it.

Codex has the same rule: an app-server that never started, or is already gone
when a thread is opened, refuses the dispatch with
`CodexSubstrateRefusedError`. A `thread/start` that the running server
rejects, such as for an unknown model, is the attempt's own failure.

### Claude background tasks

A Claude worker's answer is its final reply, never an interim one. Claude Code
can move a long command or a Monitor into the background and let the model
end its turn with a "waiting" message, then wake the session when the task
ends. Ensemble does not collect that interim reply: it waits for the reply
that follows the task's delivered notification. A Monitor stays outstanding
until its own ending (expired, timed out, or stopped) or the end of its
watched source is delivered and answered. For a task the model stops with
`TaskStop`, the successful `TaskStop` result stands in for the notification.
While it waits, the live status shows the worker's `waitingOn` task, and the
attempt records the wait in `background_waits`. The call's `timeoutMs` bounds
the wait, so a task that never wakes the session times the attempt out;
without a `timeoutMs`, the wait lasts until the session itself ends.

### Codex retry promises

The Codex app-server can report an error with `willRetry: true`, promising to
retry the turn itself; Ensemble then leaves the turn open. Turn progress
(`turn/started`, a turn diff or plan update, or an `item/*` notification other
than `item/mcpToolCall/progress`) resets the count of such promises. A sixth
consecutive promise without progress ends the turn as a retryable failure,
keeping the last error's diagnostic. A server that promises a retry and then goes silent is ended after
`retryPromiseSilenceTimeoutMs` (15 minutes by default; see
[Library runtime options](configuration.md#library-runtime-options)).
Backpressure while starting a turn, and a terminal `serverOverloaded` error,
are retried within the attempt bound. A `thread/status/changed` notification
with `status.type: "systemError"` ends the turn as an app-server failure,
retried within the attempt bound like other failures. That notification
carries no diagnostic; Ensemble uses an error notification that follows it
closely, and otherwise says that none was supplied.

### Budgets

A call checks its engine's token ceiling (`--budget`) when it is dispatched,
before it joins the concurrency queue, and again when a fallback step moves it
to another engine. Once spend reaches the
ceiling, a call that has not yet been dispatched throws a budget-exhausted
error; a ceiling of 0 admits no call and says so. A call that started under
the ceiling runs its full retry bound even if concurrent spend crosses the
ceiling, so turns already running can together overshoot it.

### Whole-run timeout and interrupts

When `--timeout` expires or SIGINT or SIGTERM arrives, the run exits non-zero
(1, 130, or 143) and prints the partial-result envelope with every completed
worker's output. See [How a run ends](cli.md#how-a-run-ends).

## Multi-turn sessions

`session(options)` creates a persistent worker on `"claude"` or `"codex"` and
returns a handle whose `send(prompt, { schema? })` runs one turn against the
same worker each time. A follow-up turn reaches a worker that still holds the
context of its earlier turns, rather than a fresh worker that has to be
briefed again.

```js
const builder = session({ engine: "claude", model: "opus", label: "builder" });
await builder.send("Implement the parser described in docs/parser.md.");
const report = await builder.send("Run the tests and report any failures.", {
  schema: { type: "object", properties: { failures: { type: "array" } } },
});
await builder.close();
```

- **Fixed at creation:** `engine`, `model`, `effort`, `fallback`, `cwd`,
  `isolation`, `timeoutMs`, `maxAttempts`, `label`, `phase`, `strip`, and
  `stalenessMark`. The fallback chain applies to the first turn only: the
  target that answers it fixes the session's engine and model for its life
  (`handle.engine` reports it), and a later turn's availability failure fails
  that turn. Changing model or effort would invalidate the session's prompt
  cache, so a change of model means a new session.
- **Per turn:** only `schema`. Each turn has the same contract as a one-shot
  `agent()` call — a validated value, the reply text, or `null` — and a failed
  turn leaves the session usable. Creating a session spawns nothing; the
  worker starts at the first `send()`. opencode sessions throw before any
  worker spawns.
- **Turns are sequential:** calling `send()` while a previous send is
  unsettled throws, as does `send()` after `close()` or after the run ends.
- **Concurrency and budget are per turn:** a turn holds its engine slot from
  dispatch to settlement, an idle session holds nothing, and each turn's
  budget check happens at its own dispatch.
- **Prompt caching:** a Claude session's worker is dispatched with the
  one-hour prompt-cache TTL (`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h`; a
  value declared in `worker_environment` wins). Ensemble sets no TTL for
  one-shot Claude workers, which keep Claude Code's default. Codex has no TTL
  setting.
- **Staleness:** `handle.stale` becomes `true` once the idle time since the
  last turn outlasts the cache — the TTL on Claude, 60 idle minutes on
  Codex — and `handle.idleMs` gives the idle time. It is advisory: a send to a
  stale session still runs, and the script decides whether to pay for the
  re-read or start a fresh worker. `stalenessMark: false` turns the mark off
  for that session, and `handle.staleAfterMs` gives the threshold in use.
- **Lifetime:** `await handle.close()` ends a session early, once any turn in
  flight has settled, and every session is closed when the run ends. A session cannot outlive its run or be reattached
  by a later run.
- **Records:** each turn is its own agent record with a
  `session: { id, turn }` field. A session using `isolation: "worktree"` works
  in one worktree for its whole life, finalised when the session closes.
- **Claude follow-ups need tmux:** follow-up turns are typed into the held
  session through tmux, in bounded slices so that a follow-up of any size
  arrives intact. Each injection uses a private tmux server that loads no
  tmux configuration and does not appear among your own sessions. Without
  tmux, a follow-up or correction fails with a `claude-valve-error` naming
  the tmux step that failed, rather than silently starting a fresh worker.

## Holds

`await hold({ content, verdicts, timeoutMs? })` pauses the script until
someone outside the run makes a decision, and resolves `{ verdict, note }`.

```js
const { verdict, note } = await hold({
  content: "Three findings survived verification. Open a PR with the fixes?",
  verdicts: ["approve", "reject"],
});
```

### Raising a hold

`content` is what the decider reads (a non-empty string), and `verdicts` the
non-empty list of accepted answers. The hold is published as a JSON file in
its scope's directory under the shared holds root,
`$XDG_DATA_HOME/ensemble/holds/` (normally `~/.local/share/ensemble/holds/`). The file carries everything a
decider needs: the content, the verdicts, a fresh nonce, the path to write the
decision to, and the raiser's liveness evidence. Open holds also appear in the
run's live status file. An optional `timeoutMs` bounds the wait; when it
expires, `hold()` rejects with `HoldTimeoutError`, which the script can catch.

### Scopes

A scope is an opaque key that keeps cooperating sessions on one machine from
seeing, and accidentally answering, each other's holds. Set it once with
`ENSEMBLE_HOLD_SCOPE` and every nested invocation inherits it; the
`--hold-scope` flag or the `holdScope` library option overrides it for one
run. An orchestrating session's own id is a natural value. A run with no scope
raises holds in the default shared scope, which scoped listings never show and
the machine-wide listing always does. The scope is never inferred from the
working directory or process ancestry, and the nonce, not the scope, is what
makes an answer valid.

### Answering a hold

`ensemble holds answer <hold-id> --verdict <verdict> [--note <note>]` is the
simplest way; see [CLI](cli.md#decision-holds) for its exit codes.

Any process can also answer by hand. Write this JSON to a temporary file
beside the hold's `decision_path`, then rename it into place:

```json
{ "nonce": "<the hold's nonce>", "verdict": "<one of the verdicts>", "note": "optional", "answered_by": "optional" }
```

A stale nonce, an unlisted verdict, or a malformed file is rejected: the file
is consumed, the hold record gains the rejection reason (and the verdict, if
one could be read), and the hold keeps waiting. An invalid answer never
reaches the script. Feedback appears only after the raiser's next poll, so an
open hold with no rejection fields means the answer has not been judged yet,
not that it was accepted. An accepted answer removes the hold. A hold can
also vanish because its raiser was found dead and the hold retired; where the
difference matters, check the run's archive or live status file.

### Listing holds

`ensemble holds` lists the holds in the inherited scope (or every scope when
none is set), `--scope <scope>` names a scope, and `--all` lists every scope.
Each entry shows the hold's id, state, scope, verdicts, decision path, content,
any rejection feedback, and the raising run's workflow name, phase, archive
path, and agent counts as of the raise. A listed hold is `open` or `bounced`
(a rejected answer is waiting to be corrected). A hold whose raiser is
provably dead is retired by whichever listing or run observes it and reported
as `retired`, so the listing only shows holds that can still be answered.

Every raise, answer, rejected answer, and timeout is recorded in the raising
run's `hold_events`, including who answered and their note. A retirement is
recorded by the run whose startup sweep observed it; one observed by a
listing is not recorded.
