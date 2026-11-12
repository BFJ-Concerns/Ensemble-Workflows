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
with a source excerpt and a caret. Line positions recognise LF, CRLF, CR
and the JavaScript Unicode line separators. An extra closing brace points to
the brace even when more body code follows; an unfinished body points to its
end after its last non-whitespace character.

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

A worker failure returns `null`; pre-spawn rejections and run endings throw.
See [Failures](#failures). A Claude call with no `model` is flagged on stderr.

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

Three kinds of error propagate instead. One is errors in how the script was
written, raised before any worker spawns: a rejected `agent()` option, a
malformed schema, an unresolvable `workflow()` reference or non-JSON `workflow()`
arguments, a nesting violation, and a child workflow's load-time error (when
several of a call's options fail the option check, one error names them all).

A budget refusal (`BudgetExceededError`) also propagates when a dispatch or
session turn is not admitted. If uncaught, it fails the run; the manifest and
completion sentinel record the refusal as the run's error. When a fallback
engine's budget refuses re-admission, the error also names every earlier
refused target, its classification rule and a bounded diagnostic. These
accounts reach the partial envelope and stderr, so the budget refusal stays
legible beside the failures that advanced the chain.

The third is the run's own ending — an interrupt, the whole-run timeout, the
launcher closing the run under a leg still in flight — which throws through
`parallel()` and `pipeline()` as it does through a bare `await`, so a body
never resumes past the combinator to run further code (commit, push, write a
results file) on a run that has already begun ending. Only a worker's own
failure is a value.

To tell a failed call from one that legitimately answered `null`, pass
`identity: true`. The call then resolves `{ label, phase, output, failure }`.
`phase` is the call's explicit phase, or the run's current `phase()` title
when the call enters the queue; it is `null` when neither was set.
`failure` is `null` exactly when the worker completed — so
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

A literal `workflow("name")` is checked against the saved registries when the
script loads, including calls in branches and callbacks. A missing name
reports the script's line and column before the body can dispatch a worker.
Names computed at runtime and `{ scriptPath }` references are resolved when
their calls execute. A call through a local binding named `workflow`, such as
a nested function parameter or a block-local variable, is an ordinary
JavaScript call.

The child shares the parent's runtime: the same concurrency caps, budgets,
worktrees, and run record. Nesting is one level only; calling `workflow()`
inside a child throws. Both registries start empty; saved workflows in the
project registry are ordinary source files you can commit. `ensemble
workflows` lists them.

### `phase()`, `log()`, and `tally()`

`phase(title)` and `log(message)` write to the run log on stderr; `phase()`
also sets the current run phase. Each agent or session turn captures it when
it queues, for both the live status file and the archived agent record, unless
the agent/session has an explicit `phase` option.

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
| `identity` | `true` to resolve `{ label, phase, output, failure }` (see [`parallel()`](#parallel-and-pipeline)) |
| `label`, `phase` | Bookkeeping shown in progress output and the run record. An omitted `phase` takes the current `phase()` title when queued, or `null` if unset |

An unrecognised option, or an invalid value for `effort`, `isolation`,
`timeoutMs`, `maxAttempts`, `identity`, or `strip`, throws before the worker
spawns. `model`, `label`, and `phase` pass through unchecked. A `timeoutMs`
above the maximum is rejected rather than silently shortened.

Schemas are JSON Schema draft-07 (the default when `$schema` is omitted) or
draft 2020-12 (declare `"$schema": "https://json-schema.org/draft/2020-12/schema"`).
Any other dialect is rejected before a worker spawns. A schema object that
refers to itself is refused with the cycle's location; recursive `$ref`
schemas that compile are accepted. Malformed schema keywords are refused before
dispatch with their JSON Pointer location and a correction: an invalid `type`
lists the accepted type names, and invalid `properties` asks for a JSON object.

### Per-engine behaviour

| | Codex | Claude | opencode |
|---|---|---|---|
| `model` | Optional; without one the engine's default is used and noted on stderr | Optional; without one a warning is printed on stderr | **Required**: a key or route declared in [`opencode_models`](configuration.md#opencode_models) |
| `effort` | Sent to the engine as the thread's effort | Mapped to the nearest level Claude Code supports (`minimal` becomes `low`) | Must name one of the model's declared `variants` |
| `schema` | Enforced by the Codex backend and checked again by Ensemble | Sent in the prompt and checked by Ensemble | Sent in the prompt and checked by Ensemble |
| `timeoutMs` | Ends the turn | Ends the wait for the session | Kills the subprocess |
| `strip` | Enforced through Codex's per-thread configuration | Enforced through permission deny rules | Not supported: throws before the worker spawns |
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

Ensemble starts opencode with `--auto`, approving permissions that opencode
would otherwise ask about, including shell access outside the worker's cwd.
Explicit denies in the operator's opencode configuration still apply.

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
- **Claude** applies deny rules through the per-dispatch settings file, and
  derives them from the tools the served Claude Code actually offers. Before
  the first stripped worker in a working directory dispatches, Ensemble
  starts a probe session through the same route as a worker. That session's
  model provider is a local stand-in that answers every request with an
  error, so no model is called. Ensemble reads the session's tools from the
  requests it sends. `agents` denies `Agent`, `Task`, `ListAgents`,
  `SendMessage` and `Workflow` (whose scripts can spawn agents), and
  `advisor`, a tool the model provider runs by handing the conversation to
  another model; `skills` denies `Skill`. Either strip also denies every
  built-in tool that Ensemble has not classified, so a new agent tool is
  denied as soon as a Claude Code release adds it. MCP tools from the
  operator's configuration are left in place. Deny rules do not reach
  `advisor`, so the settings file's `env` block also sets
  `CLAUDE_CODE_DISABLE_ADVISOR_TOOL`, over any value the machine declares
  for workers. A second probe under the derived settings must show none of
  the denied tools, no unclassified tool, and every unrelated one. If either
  surface cannot be read or the confirmation fails, the call refuses before
  the worker spawns. A probe substrate that cannot start or answer within
  the 90-second preparation deadline is recorded as an availability failure:
  a remaining fallback target is tried, otherwise the refusal propagates.
  Opening delivery and polling share that deadline. Each cleanup phase has
  a separate reclamation deadline (30 seconds by default), plus the
  command's cancellation grace. Unconfirmed probe-session cleanup is
  [reported with the session name](configuration.md#worker_environment).
  A provider-side tool that remains available under its removal settings
  also refuses the call. The result is reused for the rest of the run, for
  each working directory,
  model and strip, until a worker reports serving a different Claude Code
  version. Unstripped workers are never probed.
  A `skills` strip denies the `Skill` tool; follow-up slash-command expansion
  is not covered. A follow-up whose text begins with a `/skill` line can
  still load that skill through Claude Code's native command handling. Avoid
  forwarding such text verbatim when skill loading is unwanted.
  The agent record's enforcement detail names the deny rules and `env`
  variables, the Claude Code version that was probed, and which tools were
  denied or left in place. For `skills`, it also states this follow-up boundary.
- **opencode** rejects any strip before the worker spawns.

Each agent record lists the requested strips and how each was enforced.

### Worktree isolation

`cwd` places edits in the requested directory on every engine. Claude
background sessions receive a per-session `worktree.bgIsolation: "none"`
setting, so Claude Code does not require a second worktree before editing.
This leaves the operator's project and user settings unchanged. If a Claude
session explicitly enters a worktree, its agent record retains the observed
paths and branches in each attempt's `diagnostics.worktrees`; Ensemble does
not manage or remove those native worktrees.

With `isolation: "worktree"` the worker runs in a fresh linked git worktree on
a temporary branch. With `cwd` as well, `cwd` selects the source repository; a
`cwd` that is not in a git repository fails before the worker spawns.
The branch starts at the source checkout's `HEAD`. All checkouts of one
repository share a `<repo>.ensemble-workflows-worktrees/` container. Its
location comes from shared Git metadata, independently of the dispatch
checkout:

- A recorded `core.worktree` places the container beside that main checkout.
- Otherwise, a common Git directory named `.git` places it beside that
  directory's parent, as in a conventional repository.
- Any other common Git directory places it beside that directory. For example,
  a bare repository at `/code/repo.git` uses
  `/code/repo.git.ensemble-workflows-worktrees/`; a separate Git directory at
  `/code/meta` uses `/code/meta.ensemble-workflows-worktrees/`.

Separate Git directories need no `core.worktree` setting for shared placement.
An external directory named `.git` follows the same parent rule from every
checkout, including the original one.
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
  be enforced, or a budget refusal (`BudgetExceededError`). A budget refusal
  propagates through `parallel()` and `pipeline()` too, including a refused
  session turn; if uncaught, the run fails and the manifest and completion
  sentinel record it as the run's error. Before an engine's first attempt in a
  run, the runtime also checks that it can use the directories that engine
  needs, resolved from the environment that engine is launched with:
  Codex's `CODEX_HOME` (else `$HOME/.codex`); Claude's `CLAUDE_CONFIG_DIR`
  (else `$HOME/.claude`), global configuration and daemon sockets; and
  opencode's data, configuration, state and cache homes under the matching
  `XDG_*_HOME` variables, plus its temporary directory. Claude's dispatch
  settings scratch files use the launcher's `TMPDIR` (then `TMP`, `TEMP`,
  `/tmp`), and reply valve sockets use its `TMUX_TMPDIR` (else `/tmp`),
  independently of worker overrides. Claude's own scratch files use
  `CLAUDE_CODE_TMPDIR` or its temporary directory, under `claude-<uid>`.
  Relative `CLAUDE_CONFIG_DIR` values resolve from the launcher's working
  directory so dispatch and roster commands share one home.
  Claude's daemon sockets use `/tmp/cc-daemon-<uid>/<config hash>` on Linux,
  independently of `TMPDIR`. Other relative worker paths resolve from the
  worker's actual directory, including a per-agent `cwd` or isolated
  worktree; Codex homes resolve from the shared app-server's run base.
  Each distinct resolved resource set is checked once per run, before its
  first attempt, so a new placement with different relative homes is checked
  separately. Unused engines are not checked. A denied
  resource refuses dispatches needing that resource with
  `ResourcePreflightRefusedError`, naming the directory, the setting it came
  from and the error. Evidence identifying a Codex sandbox adds its name and
  the `danger-full-access` mode that lifts it; without such evidence the
  refusal says that no caller sandbox was identified. These checks exercise
  current access and cannot guarantee later writes will succeed. A probe
  that cannot finish its own cleanup raises a substrate refusal with the
  cause retained; that failed check is not cached as a resource verdict.
- The run's own ending — an interrupt or a whole-run timeout — which throws
  through any call it cut short, and through `parallel()` and `pipeline()`
  around it.

A schema value of JSON `null` that validates is a successful answer, not a
failure.

### Claude opening delivery

Claude dispatch requires tmux. Ensemble starts an empty native `claude --bg`
session, waits for the dispatch command to finish and the roster to name its
process, then loads the complete UTF-8 opening through Claude Code's external
prompt editor. The first native user turn must equal the text sent. The prompt
stays in a private file rather than Claude's launch arguments or dispatch
payload; no bootstrap model turn is added. The same background session serves
follow-ups and corrections.

A launch failure retains the command's exit code, signal, stdout and stderr,
the last observed session identity and PID, native logs and any transcript in
the attempt's `diagnostics.claudeLaunch` and transcript references. The
dispatch command's status is separate from `worker_exit`, which names the
worker process itself. A PID-less roster seed is insufficient for registration.
A refused launch, or one that never acquires a process, is an availability
failure and advances a declared fallback after its session and tagged
processes have been removed. If cleanup cannot be confirmed, dispatch keeps
the session owned rather than rejecting it, with the original failure under
`diagnostics.claudeLaunch` when the engine reports its outcome.

Once the opening has been submitted, the engine checks its receipt at the
session's first transcript. A missing or differing receipt is
`claude-delivery-error`, so it retries on the same target and never advances
fallback. One-shot retries stop the old session before relaunching. A held
session follows an altered turn to its end before resending the complete
opening through the valve; it is never relaunched. A worker that never writes
a transcript normally fails as `claude-first-life-timeout`, an availability
failure. A retained launch whose cleanup is unconfirmed remains an
unclassified delivery failure even without a transcript, so it cannot advance
fallback.
A model context rejection after exact delivery retains its own diagnostic.
Claude client rejections, including rejected credentials and context limits,
end the request without a blocked-worker nudge, even when the roster reports
that the worker is awaiting input.

Ensemble encloses the opening task in boundary tags chosen to be absent from
its text. The caller's text stays literal, including leading and trailing
whitespace; the closing tag keeps it inside the message when Claude trims
the message boundary. The complete opening still requires an exact receipt,
so any input transformation fails delivery explicitly. Host memory, storage
and model context still bound prompt size.

### Retries

Except for Codex output-schema rejections, each
attempt that fails is retried, up to `maxAttempts`, with the failure fed
back to the worker. Claude corrects in the same session through the prompt
editor. If tmux becomes unavailable, a one-shot correction starts a fresh session, whose
opening delivery also requires tmux.
Codex and opencode retry with the failure appended to the prompt.

An opencode model absent from the machine registry, a missing model, or an
unsupported registry variant is refused before worker admission: the call
throws, leaves no agent record, and adds nothing to the worker tally.

Rejected credentials on a started worker consume an attempt and retry within
the same bound. A dead or unstartable substrate retains its availability
classification even when its diagnostic mentions credentials.
An explicit provider HTTP 401 on a started turn records authentication
failure even when Codex's retry-promise bound ends the turn.
The attempt records `authentication-failure`, the engine's
diagnostic, and a sign-in step: `codex login`, `claude auth login`, or
`opencode auth login`. These failures are `unclassified`, with a named
engine-specific authentication rule. Codex `modelNotFound` errors record
`model-not-found` with a hint to choose an available model, and retain the
normal attempt bound.

Operational failures — a Claude session that never registered or died, a
transcript that could not be read, an opencode subprocess killed at its
deadline or exiting non-zero, a Codex turn deadline, first-output deadline, or
failed thread — are failed attempts like any other. They consume an attempt
and keep the worker's partial text, exit status, and the engine's diagnostic
on the attempt record. A call whose deadline should end it outright sets
`maxAttempts: 1`.

An opencode subprocess stopped by its per-attempt deadline records a turn
timeout, retaining its engine diagnostic, streamed usage, transcript, and
subprocess exit signal on the attempt. The execution deadline stops when the
subprocess exits, even if its output streams are still draining. A subprocess
that exits non-zero for another reason records an opencode run error.
An engine error reported with exit status zero also records an opencode run
error. If a worker ends empty after a failed tool call, the failure names
the tool and its diagnostic instead of reporting only `empty-output`.
A tool error followed by a recovered answer does not fail the attempt.

A message Ensemble sends into a live Claude session — a follow-up turn, a
correction, a nudge to a blocked worker — counts as delivered only when the
session's transcript shows it received exactly the text sent. Each receipt
is read from the transcript boundary before its own submission; an earlier
opening, follow-up or nudge cannot acknowledge a later message. Two failures
are told apart:

- `claude-valve-error`: the message was never submitted. Nothing reached the
  worker, and the retry sends the same message again.
- `claude-delivery-error`: the message was submitted, but the transcript
  shows the worker received different text, or shows no trace of it within
  the receipt deadline. The message names the sizes and SHA-256 digests of
  what was sent and what arrived. A reply to altered text is never returned
  as the turn's value.

In a `session()`, a turn the worker took on altered text runs to its end
before the attempt fails, with its text kept on the attempt record, so the
session is between turns when the retry begins. A recovery nudge's matching
receipt never verifies altered task or correction text. That delivery failure
survives nudges; a fresh task or correction submission must verify before
its reply can succeed. Resuming a nudge still waits for the
task's outstanding background work; an interim reply is not a final answer.
The retry never sends the follow-up a second time as though it were new: a
submission that turns out to have landed late is collected as the answer, and otherwise the follow-up goes
again with a preface telling the worker it replaces the earlier copy. Because
of that preface a leading `/skill` line is not expanded on the retry.

The prompt a Claude worker is launched with is held to the same rule: the
worker holds it only when the first message its transcript records is exactly
the prompt sent. Otherwise the attempt fails as a `claude-delivery-error`.
One-shot retries stop the old session and launch a fresh one on the same
target; held-session retries stay in the session and resend the whole opening
through the valve after the altered turn ends. A
delivery failure is never an availability failure, so it does not move the
call down its fallback chain: the worker took something and may have begun
work, and launching the prompt on another target would start that work a
second time. A failed launch moves down the chain only when no worker held
the prompt: the launch was refused, no session registered, or the session
never wrote a transcript.

When a single `ensemble agent` run times out, the error says which deadline
expired, because the remedies differ: the call's own `timeoutMs` (raise it or
narrow the work), or the Codex transport's request deadline (where raising
`timeoutMs` will not help).

### Failure classes

Every failed attempt is classified from its failure evidence, usually the
engine's own diagnostic:

- **availability** — the engine refused or lost the worker before it
  answered: Codex's `usageLimitExceeded`, `rateLimitExceeded`, or
  `serverOverloaded`, a refused connection, Codex running out of its own
  retries (`responseTooManyFailedAttempts`) on a 429 or 5xx, or an app-server
  that died or never started; a Claude API refusal carrying a 429, 503, or 529, a dispatch
  Claude Code refused, a dispatch the daemon never registered, or a session
  that never showed life; on any engine, a directory the engine needs that
  the launching process cannot use (`preflight.resource-denied`). Only this
  class advances a fallback chain.
- **output** — the worker answered badly: empty, unparseable, or off-schema.
- **unclassified** — anything else, including a deadline, a Codex schema
  rejection, a provider request rejection, and a client error about a bad
  model name. Codex forwards a provider JSON `invalid_request_error` as
  `other`; this is recognised by `codex.provider-request-rejected`, retried
  in place within `maxAttempts`, and never advances a chain. A recognised
  schema rejection instead keeps `codex.schema-rejected` and settles without
  retrying, including when forwarded in this envelope. A diagnostic that no
  rule recognised is recorded with `rule: null`.

With a chain declared, a failure that matches no rule leaves the chain
unconsulted (the chain advances on availability failures only), and stderr
says so.

### Claude dispatch

Claude workers use `--dangerously-skip-permissions`. Before the first
dispatch, run `claude --dangerously-skip-permissions` interactively and accept
the bypass-permissions disclaimer in the Claude configuration home the
workers will use. This is a one-time prerequisite for that home; a fresh or
isolated Claude configuration home needs its own acceptance. Ensemble does
not accept the disclaimer on your behalf.

Every Claude worker is launched with `CLAUDE_CODE_SANDBOXED` set, which tells
Claude Code to skip its per-directory trust prompt. Once the bypass disclaimer
is accepted, workers placed in a fresh directory, a sibling checkout, or a
new worktree need no further directory-trust prompt or configuration change.
The variable does not bypass the one-time disclaimer.

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
can run a long command, a Monitor or a native `Workflow` task in the
background and let the model end its turn with a "waiting" message, then wake
the session when the task ends. Ensemble does not collect that interim reply:
it waits for the reply that follows the task's delivered notification. A Monitor stays outstanding
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

A call checks its engine's token ceiling (`--budget`) before it joins the
concurrency queue, and again when a fallback step moves it to another engine.
A session turn checks the ceiling at each `send()`, before queueing. Once
spend reaches the ceiling, admission throws a budget-exhausted error; a
ceiling of 0 admits no dispatch and says so.

The refusal names the dispatch, fallback dispatch (with its agent id), or
numbered session turn it blocked. A session's first `send()` is `session
turn 1`, even when admission refuses it before the worker opens; a refused
send does not advance the turn number. Earlier targets or session turns may
already have run and caused side effects.

Every call admitted below the ceiling still runs, including calls waiting
in the concurrency queue when spend reaches the ceiling. Admission is not
checked again when a queued call starts or retries on the same engine, so
the whole admitted backlog can overshoot the ceiling, with each call
running up to its retry bound.

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
  `isolation`, `timeoutMs`, `maxAttempts`, `label`, `phase`, `strip`,
  `stalenessMark`, and `identity`. The fallback chain applies to the first turn
  only: the target that answers it fixes the session's engine and model for its life
  (`handle.engine` reports it), and a later turn's availability failure fails
  that turn. Changing model or effort would invalidate the session's prompt
  cache, so a change of model means a new session.
- **Per turn:** only `schema`. Each turn has the same contract as a one-shot
  `agent()` call — a validated value, the reply text, or `null` — and a failed
  turn leaves the session usable. Creating a session spawns nothing; the
  worker starts at the first `send()`. opencode sessions throw before any
  worker spawns.
- **Identified turns:** `identity: true` at creation makes every `send()`
  resolve `{ label, phase, output, failure }`. `failure` is `null` for a
  successful answer, including a valid JSON `null`; a failed turn carries
  its recorded failure message. A budget refusal retains the explicit session
  phase, or the current `phase()` title at `send()` when no phase was set,
  without creating a queued worker or an agent record. The option cannot vary
  per turn.
- **Turns are sequential:** calling `send()` while a previous send is
  unsettled throws, as does `send()` after `close()` or after the run ends.
- **Concurrency and budget are per turn:** a turn holds its engine slot from
  dispatch to settlement, an idle session holds nothing, and each turn's
  budget check happens at its own dispatch.
- **Prompt caching:** Claude Code fixes the subscription prompt-cache TTL at
  one hour. Ensemble does not request a TTL for Claude workers. That lifetime
  does not guarantee a cache read on the next turn. Claude Code places cache
  breakpoints in the continued request; observed follow-ups with different
  breakpoint placements have re-created different amounts of the prefix,
  even when sent to the same held session immediately. The request records
  do not expose the provider's cache decisions. Judge a held worker's cost
  from the run record's per-turn `cacheReadTokens` and `cacheCreationTokens`
  figures, which reflect the engine's reported reads and writes.
- **Staleness:** `handle.stale` becomes `true` once the idle time since the
  last turn reaches the threshold — one idle hour on Claude, 60 idle minutes on
  Codex — and `handle.idleMs` gives the idle time. It is advisory: a send to a
  stale session still runs, and the script decides whether to pay for the
  re-read or start a fresh worker. `stalenessMark: false` turns the mark off
  for that session. `handle.stalenessMark` reports whether the mark is enabled,
  including before the first turn. `handle.staleAfterMs` gives the active
  threshold, or `null` when marking is disabled. A Claude session below this
  idle threshold may still miss the prompt cache.
- **Lifetime:** `await handle.close()` ends a session early, once any turn in
  flight has settled, and every session is closed when the run ends. A session cannot outlive its run or be reattached
  by a later run.
- **Records:** each turn is its own agent record with a
  `session: { id, turn }` field. A session using `isolation: "worktree"` works
  in one worktree for its whole life, finalised when the session closes.
- **Claude follow-ups need tmux:** a private attach client loads the complete
  UTF-8 message through Claude Code's external prompt editor, then submits it
  once. The payload stays in a private file, avoiding command-line size and
  per-character input limits. Tasks with leading or trailing whitespace use
  the opening's collision-free task tags, preserving the caller's text inside
  the message boundary. Redelivery repeats that framed copy. Tasks without
  edge whitespace arrive as ordinary typed text, so a leading `/skill` line
  expands, including under a `skills` strip. Ensemble overrides `VISUAL` and
  `EDITOR` only for that attach client and removes its files and tmux server after delivery.
  It loads no tmux configuration and does not appear among your own sessions.
  Delivery requires a new native user row equal to the message sent (or the
  matching command name and arguments for a slash command). Roster activity
  and model output do not prove delivery. Missing or differing text fails with
  `claude-delivery-error`, including UTF-8 lengths and SHA-256 digests for a
  mismatch. Ensemble applies no whitespace conversion to the caller's task;
  delivery compares the complete framed message where tags are needed. Any
  other transformation by native submission still fails equality.
  Model context limits still apply after successful delivery; a subsequent
  context rejection retains the model's diagnostic on the failed attempt.
  Without tmux, follow-ups and corrections fail rather than starting a fresh worker.

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

The raising CLI announces each hold on stderr as a `[hold]` JSON line with
`hold_id`, `event: "raised"`, the accepted `verdicts`, and `answer_commands`
(one shell command per verdict). Each rejected answer produces another
`[hold]` line with `event: "answer-rejected"`, the hold id, rejection reason,
attempted verdict and its availability state, and `answered_by` (or `null`
when the decision file does not name an answerer). Stdout remains the run's
result envelope. Read command strings as JSON before executing them.

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
run's `hold_events`, including who answered; accepted answers also carry their note. A retirement is
recorded by the run whose startup sweep observed it; one observed by a
listing is not recorded.
