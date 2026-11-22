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
| `lookupDispatch(options)` | Say where `agent()` given these options would run, without dispatching (see [Dispatch lookup](#dispatch-lookup)) |
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
`"claude"`, `"opencode"`, or `"agy"` (Google's Antigravity CLI) — or on the
engine a named target binds
(`options.target`, see [Named targets](#named-targets)). There is no default
engine. The prompt must be a non-empty string.

- With `options.schema`, it returns a value that validates against the
  schema, or `null` once its attempts are exhausted.
- Without a schema, it returns the worker's final text (trimmed, non-empty),
  or `null` on the same terms.

A worker failure returns `null`; pre-spawn rejections and run endings throw.
See [Failures](#failures). A Claude call with no `model` is flagged on stderr.

### Fallback chains

`fallback` declares an ordered chain of other targets for a call —
`[{ engine, model, effort? }, …]`, with each entry naming a Codex, Claude,
opencode or agy target, or `{ target, effort? }` naming a
[named target](#named-targets). A named entry
takes its binding's engine and model — never the binding's own chain — and a
binding without a model takes the script's `defaults` model for that engine,
else the engine's own default where it has one. An opencode entry must
resolve to a registered model, and its effort may name a variant that model
declares. Ensemble moves the call to the next target on an **availability**
failure: the allowance is exhausted, the provider is overloaded past
its own retries, the engine refused the call for want of a valid sign-in,
the engine's process died or never started, or the launch environment denied
a resource the engine needs. Output failures (empty, unparseable, or off-schema
answers) are retried on the same target. Only availability failures advance
the chain. The run-record reference lists every
[failure classification rule](run-records.md#failure-classification-rules)
and its class.

Ensemble uses the first declaration it finds in this order.

1. The call's `fallback`.
2. The script's `defaults` for the engine the call dispatches on, after any
   [dispatch remap](#dispatch-remap).
3. The named target's binding, if the call names a target.
4. The machine's [fallback map](configuration.md#fallback), checking
   `engine:model` for the pair after remapping, then `engine`. A
   dispatch that leaves the model to the engine checks the engine key.

Each declaration supplies the whole chain. Set `fallback: false` on a call or
in an engine's `defaults` block to stop the search and disable fallback. A
call's own chain still takes precedence over `fallback: false` in defaults.

- Each step re-dispatches the same prompt, schema, placement, strip and
  lean settings on the next target. Ensemble checks that each target
  offers the requested strip or lean route before the first dispatch.
  Opencode verifies its resolved configuration only when its entry is
  reached. If that verification refuses a strip or lean start, the call
  throws before launching that opencode worker, even if an earlier
  target already ran. An uncaught refusal fails the run.
- `maxAttempts` counts answered attempts across the whole chain; a refusal
  costs none.
- A step to the same engine keeps its concurrency slot; a step to another
  engine releases it and is admitted again under that engine's cap and
  budget.
- Codex targets share one app-server for the run. Ensemble does not restart
  it after it dies: a later Codex entry cannot answer that failure, even if
  it names another model or follows an intervening engine. A declaration
  that repeats Codex warns on stderr. Same-engine fallback can still recover
  from a model's allowance or provider refusal while the app-server lives;
  use another engine for recovery from its death.
- A chain whose every target refuses fails with the last target's own
  failure.
- An empty or malformed chain, or an engine the run does not have, throws
  `FallbackTargetRejectedError` before any worker spawns. A named entry the
  configuration does not bind, or one naming a `target` beside an `engine`
  or `model`, throws `NamedTargetRejectedError`. Static `defaults` chains
  are checked before the script body runs.
- An opencode entry can be used in a one-shot call. A held session's chain
  requires every entry to support `session()`.

Every step is a dispatch Ensemble makes and records itself. The run record
shows each attempt's target and which entry answered, and stderr says when a
fallback entry answered for a refused target.

### Named targets

`target` names a binding in the machine configuration's
[`targets`](configuration.md#targets) section in place of `engine` and
`model`:

```js
const review = await agent(prompt, { target: "reviewer", effort: "high" });
```

Ensemble resolves the name before any worker spawns. The call runs on the
binding's engine, with the binding's model where it names one; a binding
without a model takes the script's `defaults` model for that engine, else the
engine's own default. The `defaults` block for the bound engine supplies
`effort` and `fallback` where the call leaves them unset, exactly as for a
call naming that engine. See [Fallback chains](#fallback-chains) for the
full order.

These throw `NamedTargetRejectedError` before any worker spawns, naming the
name and the configuration file:

- a name the file does not bind (the error lists the names it does bind);
- a `target` beside an `engine` or `model` — a call names one or the other.

A `target` that is not a non-empty string throws
`InvalidAgentOptionValueError`. `session()` takes `target` on the same terms.

Ensemble ships no names, so a script meant for machines whose bindings you
cannot assume should name its engines and models directly. The run record
keeps the name beside what it resolved to (see
[Run records](run-records.md#agent-records)).

### Dispatch remap

Launch a workflow on different models with `--remap` before the script path.

```sh
ensemble --remap 'label:review-*=claude:sonnet' --remap codex=claude workflow.js
```

Repeat `--remap` to give multiple rules. The flags replace the entire
comma-separated list from `ENSEMBLE_DISPATCH_REMAP`. Remaps apply to one
launch and are configured through the flag or environment variable.

For each dispatch, the first matching rule in the highest-ranked category
wins:

1. `label:<glob>` matches the call's label.
2. `phase:<glob>` matches the call's explicit phase or the current workflow
   phase.
3. `engine:model` matches the engine and model after resolving any named
   target and filling in its model from the script's defaults.
4. `engine` matches the engine alone.

Globs match the whole label or phase. `*` matches any number of characters,
and `?` matches one character. Quote glob rules on the shell command line.

A rule's destination is an `engine:model` pair or an `engine` alone. A
destination without a model takes that engine's model from the script's
`defaults`, or uses the engine's own default if the script has none. The
requested canonical effort carries over and is resolved under the
destination's effort policy. A named target keeps its place in the fallback search order.

Ensemble applies the rules to the first dispatch and to each reached
fallback entry. A session uses its label and phase at `session()` creation.
Once established, its worker keeps the engine and model for subsequent
turns. Stderr names the winning key for each remapped dispatch and reports
rules that matched no dispatch at the end of the run.
[Run records](run-records.md#run-record-schema) preserve the effective
rules and the requested and dispatched targets.

### Dispatch lookup

`lookupDispatch(options)` answers where `agent()` given the same options would
send its first dispatch under the active [dispatch remap](#dispatch-remap),
without starting a worker or counting a rule as matched.

```js
const doer = lookupDispatch({ target: "doer" });
const reviewer = lookupDispatch({ target: "reviewer" });
if (!reviewer.bound) {
  throw new Error("this workflow needs a reviewer target");
}
if (doer.family !== null && doer.family === reviewer.family) {
  log(`doer and reviewer both run on ${doer.family}`);
}
```

It answers `{ target, bound, engine, model, family }`:

| Field | Value |
|---|---|
| `target` | The name the options asked for, or `null` for a literal `engine` |
| `bound` | `false` for a `target` the machine does not bind; the other fields are then `null` |
| `engine` | The engine the call would run on |
| `model` | The model the first dispatch requests, or `null` when the selected engine uses its default |
| `family` | The [model family](#model-families) of `model`, whatever engine runs it; `null` where Ensemble cannot place the model, including where `model` is `null` |

For a literal call, `lookupDispatch({ engine: "claude" })` reports the
model a Claude request would dispatch to. A lookup for an unbound `target`
answers `bound: false`. Any other option the call would refuse before spawning — a
`target` beside an `engine` or `model`, a missing or unknown engine, an
opencode call with no model, a fallback entry naming an unbound target, a
`strip` or `lean` a target cannot honour, a schema that cannot compile, or
a `cwd` that is not an existing directory — throws the same error from the
lookup, judged on the whole fallback chain in force as well as the first
target. Omitting the options is the same as passing `{}`: it throws the
missing-engine error. An explicit `cwd` is checked relative to the run
working directory; the lookup creates no worktree.

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

Pre-spawn validation errors and dispatch refusals propagate instead. These
include errors in how the script was written: a rejected `agent()` option, a
malformed schema, an unresolvable `workflow()` reference or non-JSON `workflow()`
arguments, a nesting violation, and a child workflow's load-time error (when
several of a call's options fail the option check, one error names them all).
They also include environmental dispatch refusals, such as
`ResourcePreflightRefusedError`, `WorktreePlacementRejectedError`, or an
engine substrate refusal; see [Failures](#failures).

Validation is per call. An invalid `agent()` option in `parallel()` can be
rejected after siblings have already started. If the error is uncaught, the
run fails and cuts those siblings short; their spend and side effects are
not undone.

A budget refusal (`BudgetExceededError`) also propagates when a dispatch or
session turn is not admitted. If uncaught, it fails the run; the manifest and
completion sentinel record the refusal as the run's error. The message names
the refused call, spend, ceiling and remaining amount (zero when exhausted).
A refused session turn also names its turn number, label when set, and
explicit phase or the run’s current phase when available.
When a fallback engine's budget refuses re-admission, the error also names every earlier
refused target, its classification rule and a bounded diagnostic. These
accounts reach the partial envelope and stderr, so the budget refusal stays
legible beside the failures that advanced the chain.

The run's own ending — an interrupt, the whole-run timeout, the launcher
closing the run under a leg still in flight — propagates through a leg that
rejects with it. An `agent()` call or session turn the ending cuts short,
whether queued or running, rejects with the ending, and so does any `agent()`
call or session turn made after the run began ending. `parallel()` and
`pipeline()` rethrow that rejection as a bare `await` would, rather than
collapsing it to `null`, so a body awaiting the combinator does not resume
past it to run further code (commit, push, write a results file).

The combinator rejects only through such a leg. One whose legs had all
resolved before the ending, or whose legs catch the ending themselves or do
no `agent()`, session or `hold()` work, resolves as usual and the body
resumes. A `hold()` raised after the run began ending is refused with
`HoldRejectedError`, which propagates through a combinator as the other
pre-spawn errors do. Only a worker's own failure is a value.

To tell a failed call from one that legitimately answered `null`, pass
`identity: true`. The call then resolves `{ label, phase, output, failure, answeredBy }`.
`phase` is the call's explicit phase, or the run's current `phase()` title
when the call enters the queue; it is `null` when neither was set.
`failure` is `null` exactly when the worker completed — so
`output: null` with `failure: null` is a genuine answer — and a `{ kind, message }`
account when it failed. `kind` is the recorded failure class, such as
`TurnTimeoutError` or `empty-output`; `message` is its account without a
class prefix. Inside `parallel()` and `pipeline()`, an identified
call that collapses resolves this shape too, never a bare `null`.

The envelope also carries `answeredBy`: `{ engine, model, family }` for the
target that answered — the chain entry, after a fallback step — or `null`
when the worker failed. `model` is the model the engine reported serving,
else the one the call asked for, else `null`; `family` is the
[model family](#model-families) of the model asked for and the model served.

### Model families

A model family is the group a model belongs to by the name it commonly goes
by. It belongs to the model, never to the engine: a Claude model is in the
`claude` family whether Claude Code, agy, opencode or a gateway behind Codex
runs it. The dispatch lookup, an identified call's `answeredBy` and the run's
[single-family notice](configuration.md#single_family_notice) all report the
same family.

Ensemble takes the last `/`-separated segment of the model name, ignores
case and discards any tag starting with `:`. It tries the bare name first,
then tries again after removing a single dotted vendor prefix, such as
`anthropic.` in `anthropic.claude-sonnet-5-5`. A listed name matches on its
own or before a hyphen. Qwen and Llama match by prefix, GLM also accepts
version digits immediately after `glm` (as in `glm4:9b`), and Claude names
and aliases also accept a bracketed context suffix such as `[1m]`.

| Family | Recognised names |
|---|---|
| `claude` | `claude`, and Claude Code's aliases `opus`, `sonnet`, `haiku` and `fable` |
| `gpt` | `gpt`, `chatgpt`, `codex`, and OpenAI's `o1` to `o9` series |
| `gemini` | `gemini` |
| `glm` | `glm` |
| `kimi` | `kimi` |
| `qwen` | `qwen` |
| `deepseek` | `deepseek` |
| `grok` | `grok` |
| `llama` | `llama` |
| `mistral` | `mistral`, `mixtral`, `codestral`, `devstral`, `magistral`, `ministral` |
| `minimax` | `minimax` |

The machine can assign a model its family in
[`model_families`](configuration.md#model_families), and an opencode entry's
own [`family`](configuration.md#opencode_models) outranks that; an assignment
can name any family, including one not in this table. A model neither places
has the family `null`: unknown.

The model judged is the one the call asked for and, once a worker has served
it, the model the engine reported serving. A call that names no model is
judged by the model its engine's default resolved to, which Ensemble learns
only when a worker reports it, so the dispatch lookup answers `null` for
such a call.

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
name or a non-finite value throws. A rejected value includes its type; strings
are quoted so `"3"` cannot be mistaken for the number `3`.

### `budget`, `worktrees`, and `args`

`budget.spent(engine)` and `budget.remaining(engine)` report per-engine token
spend; `remaining` is `Infinity` with no ceiling. Spend, and so a `--budget`
ceiling, counts every token class an engine reports, cached input included:

- **Codex** counts the app-server's own `totalTokens` for each usage update:
  input, which includes cached input, plus output, which includes reasoning.
- **Claude** counts uncached input, cache reads, cache writes and output,
  summed over the turn's API calls. Cache reads usually dominate: every call
  re-reads Claude Code's system prompt and tool definitions, so even a
  one-line answer from a fresh worker spends tens of thousands of budget
  tokens.
- **opencode** counts input, cache reads and writes, output and reasoning,
  plus any total a step reports without a breakdown.
- **agy** uses the `totalTokens` reported in each turn's
  `session/prompt` reply.

Set a Claude ceiling with that in mind. The run record's
[token usage](run-records.md#token-usage-and-cost) shows each class
separately. opencode spend is read from
the session export when one can be read, and otherwise from token-bearing step
events in the output stream. Across a multi-step turn it counts the final
input and cache-read figures once, plus every output and reasoning delta. A
stream with no usable token data records no spend.

`worktrees` lists the finished worktrees from `isolation: "worktree"` calls on
any engine. Each entry has the worktree's `path`, `branch`, and `baseCommit`,
and a `state` saying where its work is:

| `state` | Meaning |
|---|---|
| `"unchanged"` | No commit and no uncommitted file; the worktree and its branch were removed |
| `"uncommitted"` | The work is only in the worktree's files (staged, unstaged, or untracked); the branch still points at `baseCommit` |
| `"committed"` | `tipCommit` holds all of the work |
| `"committed-and-uncommitted"` | `tipCommit` holds commits, and the worktree also has uncommitted files |
| `"unknown"` | Clean-up failed, so nothing is claimed about the worktree's contents; it is kept |

`tipCommit` is the commit the worktree ended on, or `null` when the state is
`"unknown"`. `branch` names the branch checked out at finalisation, or is
`null` for detached HEAD; use `tipCommit` to recover detached commits. On
failed inspection (`"unknown"`), the branch is the original dispatch branch
and its current contents are unestablished. Every turn of a held session
receives this final worktree block when the session closes. `changed` is `true` for every state except `"unchanged"`, and
`removed` is `true` only for `"unchanged"`.

`args` is the array of positional string arguments from the command line, or
the parsed value of `--json-args` (a JSON `null` arrives as an empty array).

## `agent()` options

`engine` is required — `"codex"`, `"claude"`, `"opencode"`, or `"agy"` — unless
`target` names a binding instead. A call with neither, or with an unknown
engine, throws before any worker spawns.

| Option | Description |
|---|---|
| `engine` | Engine to run on |
| `target` | A named target the machine configuration binds, in place of `engine` and `model` (see [Named targets](#named-targets)) |
| `model` | Model to run (see per-engine notes below) |
| `effort` | Reasoning effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `schema` | JSON Schema the answer must satisfy |
| `fallback` | Ordered chain of `{ engine, model, effort? }` or `{ target, effort? }` targets, or `false` to disable fallback (see [Fallback chains](#fallback-chains)) |
| `cwd` | Worker working directory; must exist. Defaults to the run's working directory |
| `isolation` | `"worktree"` to run in a fresh git worktree (see [Worktree isolation](#worktree-isolation)) |
| `timeoutMs` | Per-attempt deadline, a positive integer up to 2147483647. Unbounded when omitted |
| `maxAttempts` | Attempt bound, a positive integer. Default 3 |
| `strip` | Capabilities to remove from the worker: `"skills"`, `"agents"` (see [Permissions](#permissions-and-strip)) |
| `lean` | `true` to start the worker without the operator's interactive context (see [Lean workers](#lean-workers)) |
| `identity` | `true` to resolve `{ label, phase, output, failure, answeredBy }` (see [`parallel()`](#parallel-and-pipeline)) |
| `label`, `phase` | Bookkeeping shown in progress output and the run record. An omitted `phase` takes the current `phase()` title when queued, or `null` if unset |

An unrecognised option, or an invalid value for `target`, `effort`, `isolation`,
`timeoutMs`, `maxAttempts`, `identity`, `strip`, or `lean`, throws before the
worker spawns. `model`, `label`, and `phase` pass through unchecked. A `timeoutMs`
above the maximum is rejected rather than silently shortened.

Schemas are JSON Schema draft-07 (the default when `$schema` is omitted) or
draft 2020-12 (declare `"$schema": "https://json-schema.org/draft/2020-12/schema"`).
Any other dialect is rejected before a worker spawns. A schema object that
refers to itself is refused with the cycle's location; recursive `$ref`
schemas that compile are accepted. Malformed schema keywords are refused before
dispatch with their JSON Pointer location and a correction: an invalid `type`
lists the accepted type names, and invalid `properties` asks for a JSON object.

### Per-engine behaviour

| | Codex | Claude | opencode | agy |
|---|---|---|---|---|
| `model` | Optional; without one the engine's default is used and noted on stderr | Optional; without one a warning is printed on stderr | **Required**: a key or route declared in [`opencode_models`](configuration.md#opencode_models) | Optional: a base name agy lists (`gemini-4-hydrogen`, not `gemini-4-hydrogen-low`); without one, agy's own default |
| `effort` | Resolved per model before thread creation | Resolved before session creation (`none` and `minimal` become `low`) | Canonical level resolved per model, or a declared raw `variant` | Resolved per model against the levels agy lists for it, then set as the session's thought level |
| `schema` | Enforced by the Codex backend and checked again by Ensemble | Sent in the prompt and checked by Ensemble | Sent in the prompt and checked by Ensemble | Sent in the prompt and checked by Ensemble |
| `timeoutMs` | Ends the turn | Ends the wait for the session | Kills the subprocess | Cancels the turn. A held session remains usable if agy answers within ten seconds. Otherwise Ensemble stops the worker |
| `strip` | Enforced through Codex's per-thread configuration | Enforced through permission deny rules | Enforced through permission deny rules | Not supported: throws before the worker spawns |
| `lean` | Not supported: throws before the worker spawns | Custom context disabled with safe mode at dispatch | Isolated configuration with provider settings and permissions | Not supported: throws before the worker spawns |
| `fallback` entry | Yes | Yes | Yes, for one-shot calls | Yes |
| `session()` | Yes | Yes | No: throws before the worker spawns | Yes |

Effort resolves for each dispatch target, including a fallback entry and a
held session's first turn. Capability discovery passes the engine's resource
preflight before it may start a substrate; a denial is an availability
refusal, so a remaining fallback entry can run without starting that engine.
The order is `none < minimal < low < medium < high < xhigh < max`; `ultra` is refused even when an engine advertises it.
Machine ceilings and floors apply before selection of the nearest served
level inside those bounds; equal-distance ties choose the lower level. No
served level inside the bounds means a pre-spawn refusal naming the model,
bound keys and machine file. [Machine effort policy](configuration.md#effort)
describes the settings and source precedence. A provider's explicit refusal
of a reasoning level settles the call after that attempt, with no retry or
fallback advance and no claim that the rejected level was served.

The run record shows what each engine actually served: `resolved_model` and
`resolved_effort` come from the engine's own report — Codex's answer when the
thread starts, Claude Code's transcript — and are `null` when it reports none.
opencode reports no served model, so its `resolved_model` is the configured
`provider_model`. agy reports the model and thought level its session is set
to; a model with a single level offers no level setting, and its
`resolved_effort` is that level where the model's name spells it
(`gpt-oss-120b-medium`) and `null` otherwise.

Codex supports only a subset of JSON Schema for backend enforcement. A schema
outside that subset is rejected before generation: the call returns `null`
after one thread start, without retrying or advancing a fallback chain, and
the error names `claude`, `opencode` and `agy` as engines that check the full
JSON Schema themselves.

On Claude, opencode and agy, the worker is asked for a conforming JSON value and
may surround it with prose or a Markdown fence. A candidate value is the whole
reply, any balanced `{…}` or `[…]` region in it, or a line holding nothing but
one JSON scalar (`null`, `false`, `0`, `""`, fenced or not); a scalar
mentioned mid-sentence is prose. When a reply offers more than one candidate,
the last one that validates is the answer.

### Permissions and `strip`

Every worker runs unrestricted: it can read and write anywhere the user
running Ensemble can, and can reach the network. Codex workers are given this
full-access mode explicitly on every turn, and Ensemble does not turn off
Codex's backend web search; Claude, opencode and agy workers run without any
containment from Ensemble.

Ensemble starts opencode with `--auto`, approving permissions that opencode
would otherwise ask about, including shell access outside the worker's cwd.
Explicit denies in the operator's opencode configuration still apply.

agy asks its client to approve every tool call, and Ensemble grants each one,
once where agy offers that, so no turn waits on an approval nobody will give.

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
  A `skills` strip denies the `Skill` tool, and a stripped worker's opening
  task always arrives inside boundary tags, so a leading `/skill` line in it
  does not expand. Follow-up slash-command expansion is not covered: a
  follow-up whose text begins with a `/skill` line can still load that skill
  through Claude Code's native command handling. Avoid forwarding such text
  verbatim when skill loading is unwanted.
  The agent record's enforcement detail names the deny rules and `env`
  variables, the Claude Code version that was probed, and which tools were
  denied or left in place. For `skills`, it also states this follow-up boundary.
- **opencode** denies `skill` for `skills` and `task` for `agents`.
  At the opencode target's dispatch, Ensemble checks the resolved global
  and agent permission rules before launching the worker. The dispatch
  refuses the strip if a rule overrides a deny or an active external
  plugin can change the permissions after configuration loads.
- **agy** rejects any strip before the worker spawns. Its `session/new`
  takes a `DisableBuiltInTools` setting, read from agy 1.5.14 and never
  driven, so no route that withholds its skills or subagent tools has been
  established.

Each agent record lists the requested strips and how each was enforced.

### Lean workers

`lean: true` on a call or session, or `--lean` for the whole run, starts a
worker without the operator's user-level rules and instructions, installed
skill listing, and configured MCP tools. It keeps filesystem and network
reach and the engine's built-in tool surface. Lean is opt-in: workers that
need the operator's conventions keep them unless explicitly started lean. A
call cannot lift a run-wide `--lean` by setting `lean: false`.

- **Claude** uses `claude --bg --safe-mode`. Safe mode disables custom
  instructions (project `CLAUDE.md` included), installed skills and plugins,
  hooks and configured MCP servers. Claude's built-in tools and skills,
  authentication, permissions and Ensemble's per-dispatch settings remain
  enabled. This route is measured on Claude Code 2.1.322. Capability strips
  prepare against the same context mode as their worker.
- **opencode** uses an isolated configuration with the resolved provider
  settings and permissions, the original data home and built-in tools.
  It disables external plugins and skips discovery of project configuration
  and instructions. At the opencode target's dispatch, Ensemble checks
  that the registered model is still listed and that the isolated
  configuration loads no instructions, skills or MCP servers. A provider
  supplied only by an external plugin may be unavailable to a lean worker.
- **Codex** and **agy** refuse lean requests before the first dispatch, whether it is
  the initial target or a fallback entry.

Each agent record carries `lean` naming the route the dispatching engine
used, or `null` when no lean start was requested.

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
The `git` executable must be on `PATH`; if it is missing, the request fails
before the worker spawns with advice to install git or put it on `PATH`.
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
and the branch is kept and recorded as changed with the state `"unknown"`,
since it was not proven unchanged. A linked worktree shares its repository's
objects and refs, so isolation separates checkouts; it does not contain the
worker.

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
  from and the error, with a direct remedy such as “set XDG_DATA_HOME to a
  writable directory”. Relative values appear as written alongside the
  directory they were resolved against. Defaults name the setting that
  moves the directory; fixed locations such as Claude daemon sockets ask
  for access to that directory because no setting moves them. Socket
  remedies require a directory that permits Unix socket binding. Evidence
  identifying a Codex sandbox adds its name and the `danger-full-access`
  mode that lifts it; otherwise the refusal mentions no sandbox. These checks
  exercise current access and cannot guarantee later writes will succeed. A probe
  that cannot finish its own cleanup raises a substrate refusal with the
  cause retained; that failed check is not cached as a resource verdict.
- The run's own ending — an interrupt or a whole-run timeout — which throws
  through any call or session turn it cut short or that starts after it, and
  through `parallel()` and `pipeline()` around a leg that rejects with it.

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
worker process itself. If the Claude executable cannot execute, the refusal
names its resolved path and suggests checking the installation or PATH before
the sandbox declaration. A PID-less roster seed is insufficient for registration.
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
A model context rejection after exact delivery retains its own diagnostic
under failure kind `claude-worker-diagnostic`. With API error evidence in
the transcript, its classification is `unclassified` with rule
`claude.api-refusal` unless the status or code matches an availability rule.
Without API error evidence, the rule is `claude.client-diagnostic`.
Claude client rejections, including rejected credentials and context limits,
end the request without a blocked-worker nudge, even when the roster reports
that the worker is awaiting input.

A Claude worker receives, in this order:

1. **System prompt:** Claude Code's default system prompt, with Ensemble's
   standing instructions appended at launch (`--append-system-prompt`, on
   lean starts too). They tell the worker that it is an automated worker
   dispatched by the Ensemble orchestration harness and must work fully
   autonomously, without asking for confirmation or pausing for questions.
   The session keeps them for every later turn.
2. **Opening message:** the task itself, first. A task that begins
   `/<skill> <arguments>` runs that skill, as a message typed into Claude Code
   would, user-invocable skills included. See
   [Commands at the head of a task](#commands-at-the-head-of-a-task) for
   which openings Claude Code takes as a command.
3. **After the task, when present:** a blank line, then the schema contract
   (the instruction to end with a JSON value and the schema itself), then a
   note naming the previous attempt's failure on a retry that relaunches.
   A task that ends in whitespace with neither to follow it is followed by a
   blank line and one closing line saying where the task ends, so Claude's
   trimming of the message's end leaves the task's own whitespace in place.

Claude trims a message at both ends, so the task goes inside boundary tags,
chosen to be absent from its text and introduced by a line saying they mark
its boundaries, when it is empty, begins with whitespace, or the worker is
stripped of `skills`.
The caller's text stays literal inside them, and a framed task does not
expand a leading `/skill` line. The complete opening still requires an exact
receipt, so any input transformation fails delivery explicitly. A message
Claude expands as a command is held to its command name and arguments byte
for byte; Claude does not record the whitespace between the two, so any run
of it there is accepted. Host memory,
storage and model context still bound prompt size.

#### Commands at the head of a task

Claude Code takes a message as a command when it opens with `/`, then a name
made of letters, digits, `_`, `:` and `-` that begins with a letter, digit or
`_`, then whitespace or the end of the message. Everything after the name is
the command's arguments. Any other opening reaches the worker as text: a path
such as `/etc/hostname is a file …` is not a command, because the name stops
at a character a command name cannot hold. The same rule applies to a
`session()` follow-up that opens with the task. A task framed in boundary
tags, and a correction or redelivery, which open with Ensemble's own text,
never begin with a command.

When the name is a skill, the skill runs. When it is not, no skill runs and
the task never reaches the model, so the call fails at once as
`claude-command-not-skill` (rule `claude.command-not-skill`) and is not
retried: every retry would send the same opening to the same Claude Code. The
failure names the command and says no skill by that name ran, for either of
two reasons:

- Claude Code knows no skill or command by that name where the worker runs.
  The usual cause is a skill that is not installed for the worker's Claude
  Code. A lean worker loads none of the operator's installed skills, so a
  skill a script names at the head of a lean worker's task does not run.
- The name is one of Claude Code's built-in commands, such as `/config` or
  `/resume`. Claude Code runs it in place of a model turn. A built-in command
  that opens an interactive panel, such as `/help` or `/login`, writes
  nothing to the transcript and leaves the worker waiting on the panel; the
  call fails once the worker has waited on it for five seconds (or the
  receipt deadline, when that is shorter). A built-in command that replaces
  the conversation, such as `/clear`, moves the worker to a new native
  session and records itself there; Ensemble reads that session's
  transcript for it. In a `session()`, the session that follows such a
  command is no longer the one Ensemble holds, so later turns fail too.

In a `session()`, only the turn that opened with the command fails; the
session stays open for its next turn. To send text that begins with a slash
as text, put something before it.

### Retries

Failed attempts are retried up to `maxAttempts`, with the failure fed back
to the worker. These failures settle the call immediately:

- Codex rejects the output schema.
- The provider rejects the reasoning level (`effort-rejected`).
- A held session loses its worker (`session-lost`).
- The whitespace bound stops a held Claude worker (`ClaudeHeldWhitespaceStreamError`).
- A Claude task opens with a command that runs no skill (`claude-command-not-skill`).

Claude corrects in the same session through the prompt editor while the
session and tmux are available. If a one-shot worker has stopped or tmux
is unavailable for an in-session correction, Ensemble dispatches a fresh
session. Opening delivery also requires tmux.
Codex, opencode and one-shot agy calls retry with the failure appended to
the prompt; a held agy session corrects in place while its worker lives (see
[agy workers](#agy-workers)).

An opencode model absent from the machine registry, a missing model, or an
unsupported registry variant is refused before worker admission: the call
throws, leaves no agent record, and adds nothing to the worker tally.

Missing or rejected credentials advance the chain if an entry remains. With
no entry left, the usual attempt bound applies. Codex, Claude and opencode
record `authentication-failure`, the engine's diagnostic and a sign-in
step (`codex login`, `claude auth login` or `opencode auth login`). agy
records a missing sign-in at session startup as `AgySubstrateRefusedError`
and a prompt refused for lack of sign-in as `agy-sign-in-required`. Both
carry agy's diagnostic and direct the operator to sign in through `agy`.
A malformed agy prompt reply is an output failure and stays on the current
chain entry. An explicit provider HTTP 401 identifies an authentication
failure even when Codex's retry-promise bound ends the turn. A dead or unstartable substrate retains its
own availability rule if its diagnostic merely quotes a credential error.
Codex `modelNotFound` errors record `model-not-found` with a hint to choose an
available model and retain the normal attempt bound.

Operational failures — a Claude session that never registered or died, a
transcript that could not be read, an opencode subprocess killed at its
deadline or exiting non-zero, a Codex turn deadline, first-output deadline, or
failed thread — are failed attempts like any other. They consume an attempt
and keep the worker's partial text, exit status, and the engine's diagnostic
on the attempt record. A call whose deadline should end it outright sets
`maxAttempts: 1`.

Opencode commands enter the run's containment before they can start
descendants. Cancellation, an attempt deadline, and the command's own exit
stop that command's process tree, including shell commands that start
another session or become reparented. Stop uses SIGTERM, a two-second grace,
then SIGKILL with three seconds to confirm the containment is empty. Output
pipes drain for at most one further second after the stop attempt; a descendant
holding a pipe cannot indefinitely delay the run's teardown report.

Without a reachable user manager, or when scope placement is refused, the
command runs in its own process group. An unreadable process-membership list
does not prevent escalation to SIGKILL after the grace period; if the group's
end still cannot be observed, the stop reports the observation error as
unconfirmed. A process that leaves that group is outside Ensemble's reach.
An attempt that stops a command there, including at its turn deadline, records that uncertainty in `diagnostics.unestablishedStops`
and reports it on stderr. Run and export commands share that attempt account,
including when an export fails or throws. The attempt still returns its answer
or consumes a retry as usual; a script that handles its null or a successful
retry and returns ends `complete` at exit 0.

A command cut short by the run ending is the run's teardown account instead:
stderr and the completion sentinel's `teardown_error` name an end the run could
not establish. A command an attempt left running within reach is stopped again
at run close; failure to confirm that second stop also fails teardown.

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
  worker. While the session and valve remain available, the retry sends the
  refused message again, unchanged, in the same session, within the call's
  `maxAttempts` limit: a follow-up turn, a correction or a nudge alike. A
  correction still describes the failure it was written for, not the valve
  error. A one-shot call redispatches
  its task if the old session is gone or the valve is unavailable; a held
  session is never restarted.
- `claude-delivery-error`: the message was submitted, but the transcript
  shows the worker received different text, or shows no trace of it within
  the receipt deadline. For different text, the message names the UTF-8 size
  and SHA-256 digest of what was sent and of what arrived; for no trace, of
  what was sent alone. A submission that turns up after its turn has
  settled fails the attempt with a message saying so: one that arrived as
  sent names neither text, and one that arrived as different text names the
  size and digest of both. In a session, once a turn's text has been
  submitted without a verified receipt, the retry sends it again behind a
  preface telling the worker that an earlier copy did not arrive as sent
  and is void. A one-shot call's retry dispatches its task afresh in a new
  session, with a note naming the failed attempt's kind and message. A
  reply to altered text is never returned as the turn's value.

Ensemble verifies the opening prompt's receipt before nudging a Claude worker.
For a worker awaiting native input, it cancels the input dialog and waits for
the daemon to clear its input request.
This exposes the normal prompt so Claude Code's external editor can load the
nudge. An ordinary empty prompt needs no cancellation. If the input request
does not clear, the valve refuses the message without submitting it.

In a `session()`, a turn the worker took on altered text runs to its end
before the attempt fails, with its text kept on the attempt record, so the
session is between turns when the retry begins. Work from an earlier turn
cannot be returned as a later turn's value: the later turn's prompt must
verify first. A recovery nudge's matching receipt never verifies altered task
or correction text. That delivery failure
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

### Whitespace streams

Once a turn streams whitespace, Ensemble ends the attempt if two minutes
have passed since the turn began or last produced non-whitespace text, tool
activity or reasoning. This fixed bound applies to Codex app-server events,
Claude transcript entries, opencode run events and agy session updates, where
a tool call, a tool call's update, a thought or a plan is activity. agy ends
a stuck stream by cancelling the turn. If agy answers within ten seconds,
a held session remains usable. Otherwise Ensemble stops the worker and
records a held session as lost. A whitespace failure spends one attempt
and retains its partial text. A turn that has emitted nothing does not
start a whitespace stream.

Ensemble stops a Claude worker to end a stuck stream. If the worker belonged
to a held session, that session is lost and the attempt settles immediately.
Later sends to that session return the usual `session-lost` failure.

### Failure classes

Every failed attempt is classified from its failure evidence, usually the
engine's own diagnostic:

- **availability** — the engine refused or lost the worker before it
  answered: Codex's `usageLimitExceeded`, `rateLimitExceeded`, or
  `serverOverloaded`, a refused connection, Codex running out of its own
  retries (`responseTooManyFailedAttempts`) on a 429 or 5xx, or an app-server
  that died or never started; a Claude API refusal carrying a 429, 503, or 529, a dispatch
  Claude Code refused, a dispatch the daemon never registered, or a session
  that never showed life, or a one-shot Claude worker that left the roster
  before answering (`claude.worker-lost`). A held worker's loss after it has
  shown life is `session-lost`, listed below. On any engine, availability
  includes missing or rejected
  credentials (`<engine>.authentication-failure`) and a directory the engine
  needs that the launching process cannot use (`preflight.resource-denied`).
  Only this class advances a fallback chain.
- **output** — the worker gave empty, unparseable or off-schema output, or
  streamed only whitespace past the bound.
- **unclassified** — anything else, including a deadline, a Codex schema
  rejection, a provider request rejection, and a client error about a bad
  model name. Codex forwards a provider JSON `invalid_request_error` as
  `other`; this is recognised by `codex.provider-request-rejected`, retried
  in place within `maxAttempts`, and never advances a chain. A recognised
  schema rejection instead keeps `codex.schema-rejected` and settles without
  retrying, including when forwarded in this envelope. A session turn whose
  engine found the session's worker gone records `session-lost` under
  `session.lost` on every engine: one attempt, no retry, and no chain step,
  since no other target holds the session's context. A diagnostic that no
  rule recognised is recorded with `rule: null`.

With a chain declared, a failure that matches no rule leaves the chain
unconsulted (the chain advances on availability failures only), and stderr
says so.

### Claude dispatch

Claude workers use `--dangerously-skip-permissions`. Before the first
dispatch, run `CLAUDE_CONFIG_DIR='/absolute/claude-home' claude
--dangerously-skip-permissions` interactively and accept the bypass-permissions
disclaimer. Use the resolved configuration home the workers will use:
`CLAUDE_CONFIG_DIR`, resolved from the launcher's working directory if relative,
or `$HOME/.claude` from the worker environment when unset or empty. This is a
one-time prerequisite for that home; a fresh or
isolated Claude configuration home needs its own acceptance. Ensemble does
not accept the disclaimer on your behalf. A dispatch refused for missing
consent names that resolved home and gives only an interactive repair command
scoped to it; the native unscoped suggestion stays in the launch diagnostics.

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

Claude Code may refuse long foreground commands, such as `sleep 240`. Ask the
worker to run long commands as background tasks; Ensemble waits for their
completion as described below.

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

### agy workers

Each agy worker is an `agy acp` process — Antigravity's Agent Client
Protocol server — holding one session, started in the worker's directory
inside the run's command containment. The model and thought level are set
on the session before the first prompt. agy runs on the account it is
signed in to, and the `agy` binary is found on the worker environment's
`PATH`.

- **Before any prompt:** a model agy does not list, or a level the model
  does not offer, throws `InvalidAgentOptionValueError` naming what agy
  offers. A server that will not start or initialise, a missing sign-in,
  or a session agy will not open throws `AgySubstrateRefusedError`, a
  substrate refusal recorded as `agy.substrate-refused` (availability),
  which advances a remaining chain entry without spending an attempt.
- **Effort:** to clamp a level, Ensemble reads every model's levels once
  per run from an agy session it never prompts.
- **The answer** is the message text after the turn's last tool call; the
  whole turn's text is kept as the attempt's delta text.
- **Retries:** a one-shot call's worker is stopped when each attempt
  ends, so what that stop could not establish rides the attempt's
  `unestablishedStops`; a retry opens a fresh worker whose opening prompt
  says what failed. A held session's retry corrects in the same session
  while its process lives, naming only the failure.
- **The deadline** cancels the turn (`agy.deadline`, unclassified); a turn
  still running ten seconds after the cancel has its worker stopped.
- **Failures agy returns:** a prompt refused for want of a sign-in
  (`agy-sign-in-required`, `agy.sign-in-required`) and a worker process
  that ended mid-turn (`agy-worker-lost`, `agy.worker-lost`) are
  availability; a turn agy itself ended other than normally — a refusal, a
  token or request limit (`agy-stop-reason`, `agy.stop-reason`) — is
  unclassified. Any other JSON-RPC error on a prompt (`agy-prompt-error`)
  is recorded with `rule: null`: what a reached usage limit looks like has
  not been observed. In a held session, a worker that is gone is
  `session-lost`.
- **What agy leaves behind:** each session leaves its conversation database
  under `~/.gemini/antigravity-cli/conversations/` and each process a
  presence lock, which agy itself never removes.

### Budgets

A call checks its engine's token ceiling (`--budget`) before it joins the
concurrency queue, and again when a fallback step moves it to another engine.
A session turn checks the ceiling at each `send()`, before queueing. Once
spend reaches the ceiling, admission throws a budget-exhausted error; a
ceiling of 0 admits no dispatch and says so.

The refusal names the dispatch, fallback dispatch (with its agent id), or
numbered session turn it blocked. An ordinary dispatch includes its label
and phase when available; the phase comes from the call's `phase` option or
the current `phase()` title. Calls with neither retain `refused dispatch`.
A session's first `send()` is `session turn 1`, even when admission refuses
it before the worker opens; a refused send does not advance the turn number.
Earlier targets or session turns may already have run and caused side effects.

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

`session(options)` creates a persistent worker on `"claude"`, `"codex"` or
`"agy"` and returns a handle whose `send(prompt, { schema? })` runs one turn
against the same worker each time. A follow-up turn reaches a worker that still holds the
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

- **Fixed at creation:** `engine` or `target`, `model`, `effort`, `fallback`, `cwd`,
  `isolation`, `timeoutMs`, `maxAttempts`, `label`, `phase`, `strip`, `lean`,
  `stalenessMark`, and `identity`. `session()` refuses any other key, `schema`
  included, before the worker spawns. The fallback chain applies to the first turn
  only: the target that answers it fixes the session's engine and model for its life
  (`handle.engine` reports it), and a later turn's availability failure fails
  that turn. Changing model or effort would invalidate the session's prompt
  cache, so a change of model means a new session.
- **Per turn:** only `schema`. Each turn has the same contract as a one-shot
  `agent()` call — a validated value, the reply text, or `null` — and a failed
  turn leaves the session usable unless its worker was lost. Creating a session spawns nothing; the
  worker starts at the first `send()`. opencode sessions throw before any
  worker spawns.
- **Identified turns:** `identity: true` at creation makes every `send()`
  resolve `{ label, phase, output, failure, answeredBy }`. `failure` is `null` for a
  successful answer, including a valid JSON `null`; a failed turn carries
  its recorded failure message. A budget refusal retains the explicit session
  phase, or the current `phase()` title at `send()` when no phase was set,
  without creating a queued worker or an agent record. The option cannot vary
  per turn.
- **Turns are sequential:** calling `send()` while a previous send is
  unsettled throws, as does `send()` after `close()` or after the run ends.
- **Concurrency and budget are per turn:** a turn holds its engine slot from
  dispatch to settlement, an idle session holds no execution slot, and each turn's
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
  Codex, five idle minutes on agy, the prompt-cache lifetime its operator
  reports — and `handle.idleMs` gives the idle time. It is advisory: a send to a
  stale session still runs, and the script decides whether to pay for the
  re-read or start a fresh worker. `stalenessMark: false` turns the mark off
  for that session. `handle.stalenessMark` reports whether the mark is enabled,
  including before the first turn. `handle.staleAfterMs` gives the active
  threshold, or `null` when marking is disabled. A Claude session below this
  idle threshold may still miss the prompt cache.
- **Claude idle lifetime:** Ensemble keeps a private, input-free attach
  client for the held worker's lifetime and repairs that attachment if the
  client exits. Repair failures are reported per session and do not stop
  observations or repairs for other held workers. It sends no keep-alive
  model turns. Claude Code 2.1.322
  retires eligible unattached, settled background sessions after a one-hour
  grace, checked once a minute; memory pressure can reduce the grace to one
  minute. Attached clients exempt the worker from that retirement. A daemon
  crash, external removal or another native failure can still lose the
  session; an attachment preserves the live conversation, not a backup of it.
- **Lost workers:** `handle.lost` becomes `true` once the session's engine
  has found its worker gone for good — not closed by the script or the run.
  The run says so on stderr when the engine observes it and records a
  `lost` entry in the manifest's `session_events`, whether or not a turn was
  running. A send to a lost session still dispatches, fails on one
  `session-lost` attempt without a retry, and resolves `null`; the context
  the worker held is gone, so start a fresh session and brief it again.
  `false` means only that no loss has been observed.
  On Claude, loss watching starts when the opening transcript appears. A worker
  that disappears before producing its opening transcript retains
  `claude-first-life-timeout`, so the creating send can retry or use its
  fallback chain.
  On Claude, the roster watch confirms loss after three consecutive
  successful reads without the worker, then reports it immediately,
  including between turns. A failed query is not absence, a returning
  worker resets the count, and intentional close is not loss. The same
  confirmation applies when a send discovers the missing worker first.
  On Codex, the transport observes app-server process exit or terminal pipe
  failure and immediately loses every open session with an established
  thread, including idle sessions. The app-server is shared, so one death
  can lose several sessions. A turn interrupted by that death, and each
  later send, fails under `session.lost` on one `session-lost` attempt,
  without retry or fallback. Failure before a thread is established remains
  a substrate availability refusal. Intentional close is not loss. If the
  script is left waiting on nothing live, the run ends failed with
  `WorkflowUnsettledError`; neither a lost session nor `--timeout` keeps it
  alive. The archive is settled and the completion sentinel is written.
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
  expands, including under a `skills` strip. The delivery pane runs
  `claude attach` directly with `VISUAL` and `EDITOR` set to Ensemble's
  copy helper, so login shell settings cannot change its editor. If the wait
  for a native input dialog to close or for the editor to copy the prompt
  expires, the failure includes a short excerpt of the visible pane or says
  why it could not be captured. Ensemble removes the delivery files and tmux
  server when the attempt ends. The separate, input-free lifetime attachment
  remains until the held session closes.
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
