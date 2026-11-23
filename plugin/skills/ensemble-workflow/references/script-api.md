# The script API

Every hook a workflow script can call and every `agent()` option, with the
rules for schemas and for writing a worker's prompt. Sessions and holds are
in [sessions-and-holds.md](sessions-and-holds.md); fallback chains, named
targets and the dispatch remap are in [rerouting.md](rerouting.md).

Contents: script shape · `agent()` options · what a call returns · writing
the prompt · schemas · `defaults` · `parallel()` and `pipeline()` ·
`lookupDispatch()` · `workflow()` and saved workflows · `phase()`, `log()`
and `tally()` · `budget` · `worktrees` · `args`

## Script shape

```js
export const meta = {
  name: "summarise-changes",
  description: "Summarise each changed file, then write one overview",
};

export const defaults = {
  codex: { effort: "low" },
  claude: { effort: "medium" },
};

const summaries = await parallel(
  args.map((file) => () =>
    agent(`Summarise the purpose of ${file} in two sentences.`, {
      engine: "codex",
      label: file,
    }),
  ),
);
const usable = summaries.filter((summary) => summary !== null);
log(`${summaries.length - usable.length} of ${summaries.length} summaries failed`);

return agent(`Write a one-paragraph overview from these summaries:\n\n${usable.join("\n\n")}`, {
  engine: "claude",
});
```

- The file begins with `export const meta = { … }`, an object literal.
  Anything before it, a comment included, is rejected before any worker
  spawns. `meta` normally carries `name` and `description`. It may also
  carry `task`, an identity copied verbatim into the run record as the key
  that tools comparing runs group by; keep it the same across runs of the
  same job. `meta` is read-only inside the body.
- `export const defaults = { … }` is optional and comes straight after
  `meta`, with only blank lines and comments between them. Declared later in
  the file, it is rejected.
- Everything else is the body of a single async function, so `return` gives
  the run's result and top-level `await` works. It runs as ordinary,
  unsandboxed Node: every Node global (`process`, `Buffer`, `fetch`,
  timers), the filesystem and network, `require(…)` and dynamic `import()`
  resolving from the script's own path, and `import.meta`. Static `import`
  statements do not work, because the body is not a module's top level.
- A free identifier that is neither a Node global, a hook, nor a binding in
  the script fails at load, and the error names it. A `typeof X` probe is
  fine. A syntax error is reported with the script's own line and column.
- The return value, and any arguments passed to `workflow()`, must be JSON
  values. A function, a symbol, a cycle or a BigInt fails the run and the
  error names the offending path. `undefined` properties vanish and
  `Infinity` prints as `null`, as in any JSON.

## `agent()` options

`agent(prompt, options)` runs one worker. The prompt is a non-empty string.

| Option | Description |
|---|---|
| `engine` | `"codex"`, `"claude"`, `"opencode"`, `"agy"` or `"zcode"`. Required unless `target` is given |
| `target` | A named target the machine configuration binds, in place of `engine` and `model`. Giving both is refused |
| `model` | The model to run. Required on `opencode` and `zcode`; see [engines.md](engines.md) for how each engine names models |
| `effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `schema` | A JSON Schema the answer must satisfy |
| `fallback` | An ordered chain of `{ engine, model, effort? }` or `{ target, effort? }` entries, or `false` to switch fallback off |
| `cwd` | The worker's working directory, which must exist. Defaults to the run's working directory |
| `isolation` | `"worktree"` runs the worker in a fresh git worktree; see [engines.md](engines.md) |
| `timeoutMs` | A deadline for each attempt, a positive integer up to 2147483647. No deadline when omitted |
| `maxAttempts` | The attempt bound, a positive integer. Default 3 |
| `strip` | An array of tool capabilities to remove from the worker: `"skills"`, `"agents"`, or both |
| `lean` | `true` starts the worker without the operator's own rules, skill listing and MCP tools |
| `identity` | `true` resolves `{ label, phase, output, failure, answeredBy }` in place of the bare answer |
| `label`, `phase` | Names shown in the log, the live status and the run record. An omitted `phase` takes the current `phase()` title |

An unrecognised option, or an invalid value for any option but `model`,
`label` and `phase`, throws before the worker spawns. So does an option the
named engine cannot honour. Nothing is silently ignored.

Give every call a `label`. Labels are what failure lines on stderr name,
what a dispatch remap's `label:` keys match, and how a reader of the run
record tells one worker from another.

## What a call returns

- Without a `schema`: the worker's final text, trimmed and non-empty.
- With a `schema`: a value that validates against it.
- `null` when the worker failed and its attempts are spent.

With `identity: true` the call resolves an envelope instead:

| Field | Value |
|---|---|
| `label`, `phase` | The call's label and phase, or `null` |
| `output` | The answer, or `null` |
| `failure` | `null` when the worker answered, otherwise `{ kind, message }` |
| `answeredBy` | `{ engine, model, family }` for the target that answered, after any fallback step; `null` when the worker failed |

`output: null` with `failure: null` is a genuine answer of JSON `null` under
a schema that allows it. Give a fan-in schema an object at its top level
and a bare `null` can only mean failure.

`answeredBy.model` is the model the engine reported serving, else the one
the call asked for, else `null`. `answeredBy.family` is that model's family,
or `null` where the runtime cannot place it.

## Writing the prompt

A worker starts with the prompt and whatever its engine loads in its working
directory: the project's instruction files, and the operator's own rules and
skills unless the call is `lean`. It has seen none of your conversation.

- State the task, what done looks like, what is out of scope, and what to
  hand back. Give paths for the worker to read in preference to pasted
  content.
- The runtime already tells every worker that it is an automated worker,
  that nobody is there to answer a question, and that it should decide and
  finish. The prompt need not repeat it.
- With a `schema`, the runtime delivers the schema itself and asks for a
  conforming value. Use the prompt to say what each field should hold, not
  to describe JSON.
- A worker's edits land in its working directory, and a worker can write
  anywhere the launching user can. Say where it may write.
- On `claude`, a prompt that begins with `/name` runs a skill of that name
  in place of a model turn; see [engines.md](engines.md).

## Schemas

Schemas are JSON Schema draft-07, the default when `$schema` is omitted, or
draft 2020-12 when the schema declares
`"$schema": "https://json-schema.org/draft/2020-12/schema"`. Another
dialect, a schema that does not compile, or a schema object that contains
itself throws before the worker spawns.

`codex` enforces the schema in its backend and checks the answer again
afterwards. The other four engines ask the worker for a conforming JSON
value and check it. There the worker may surround the value with prose or a
Markdown fence, and when a reply holds several candidate values the last one
that validates is the answer.

Codex's backend accepts only a subset of JSON Schema. A schema outside it is
rejected before generation, and the call returns `null` after a single
start, with no retry and no fallback step. A schema written this way is
accepted on every engine:

- `type: "object"` at the top level;
- `additionalProperties: false` on every object;
- every key in `required` also present in `properties`;
- plain types, arrays, enums and nested objects of the same form.

The copy of the schema Codex receives lists every property as required, so
a Codex worker always emits every property, while a worker on another engine
may omit an optional one. Read nothing into whether an optional field is
present, and tell the worker what to put in an optional text field when it
has nothing to say.

## `defaults`

```js
export const defaults = {
  codex: { model: "<a Codex model>", effort: "low" },
  claude: { effort: "medium", fallback: [{ engine: "codex", model: "<a Codex model>" }] },
  opencode: { model: "<a declared opencode model>" },
};
```

Each block sets `model`, `effort` and `fallback` for every `agent()` call
and `session()` on that engine; an option given at the call wins. A chain in
one engine's block may name targets on another engine. A call that names a
`target` takes the block of the engine the name is bound to. `defaults`
cannot set `engine`. An invalid block fails before the body runs.

## `parallel()` and `pipeline()`

`parallel(thunks)` starts every thunk and returns their results in input
order. A thunk is a function, `() => agent(…)`; passing the promise itself
starts the call before `parallel()` sees it.

`pipeline(items, ...stages)` runs each item through each stage, calling
`stage(previous, originalItem, index)`. No barrier separates the stages, so
a fast item moves on without waiting for slow ones. Prefer it to two
`parallel()` calls in a row unless the second step needs every result of
the first.

- A failed worker is its call's `null`, so that is what its slot holds, and
  what the next pipeline stage receives as `previous`. A stage that cannot
  work from `null` returns it straight on.
- A thunk or stage that throws for some other reason also becomes `null`,
  and is logged. With `identity: true` a failed leg resolves the envelope,
  never a bare `null`.
- A rejection raised before a worker spawns, a budget refusal, and the
  run's own ending all pass through the combinator. Validation happens at
  each call, so an invalid option in one leg can be rejected after its
  siblings have started; if nothing catches it, the run fails and cuts
  them short.
- Results arrive in input order, but workers finish in any order. Do not
  depend on which finishes first.

## `lookupDispatch()`

`lookupDispatch(options)` answers where `agent()` given the same options
would send its first dispatch, under any dispatch remap in force, without
starting a worker.

```js
const doer = lookupDispatch({ target: "doer" });
const reviewer = lookupDispatch({ target: "reviewer" });
if (!reviewer.bound) throw new Error("this workflow needs a reviewer target");
if (doer.family !== null && doer.family === reviewer.family) {
  log(`doer and reviewer both run on ${doer.family}`);
}
```

| Field | Value |
|---|---|
| `target` | The name asked for, or `null` for a literal `engine` |
| `bound` | `false` for a `target` the machine does not bind; the other fields are then `null` |
| `engine` | The engine the call would run on |
| `model` | The model the dispatch would request, or `null` when the engine's default would run |
| `family` | The model's family, or `null` where the runtime cannot place it, which includes a `null` model |

Any option `agent()` would refuse before spawning throws the same error
from the lookup, except an unbound `target`, which answers `bound: false`.

## `workflow()` and saved workflows

`workflow(nameOrRef, args)` runs another workflow inline and returns its
result. `nameOrRef` is a saved workflow's name or `{ scriptPath }`.

- A name is looked up in the project registry,
  `.claude/ensemble/workflows/` under the run's working directory, then in
  the user registry, `$XDG_DATA_HOME/ensemble/workflows/` (normally
  `~/.local/share/ensemble/workflows/`). Lookup goes by each file's
  `meta.name`; the filename is only storage.
- `{ scriptPath }` resolves like a script path on the command line:
  relative to the run's working directory unless absolute.
- The child shares the parent's concurrency caps, budgets, worktrees and
  run record, and uses its own `defaults`. Nesting goes one level: a child
  cannot call `workflow()`.
- A literal `workflow("name")` is checked when the script loads, and a
  missing name fails before any worker spawns.

Saving a workflow is an ordinary file write into a registry directory; both
start empty, and the project registry's files can be committed.
`node <launcher> workflows` lists what is saved, by `meta.name` and
`meta.description`. Run it before composing by name or saving another.

## `phase()`, `log()` and `tally()`

`phase(title)` and `log(message)` write to the run log on stderr.
`phase()` also sets the run's current phase, which each later call takes as
its own unless it gives a `phase` option. There is no other progress
display. When a script bounds its own coverage (a top-N cut, a sample, a
round limit), `log()` what was dropped.

`await tally(name, value)` records a named number in the run record: how
many findings a check accepted, how many fix rounds ran. The runtime
records which workers ran, never which checked which; a tally is how the
script records its own judgement. Values are finite numbers, and recording a
name again replaces its value.

## `budget`

`budget.spent(engine)` and `budget.remaining(engine)` report one engine's
token spend against the ceiling `--budget engine=N` set; `remaining` is
`Infinity` when no ceiling is set. There is no total across engines.

Spend counts every token class an engine reports, cached input included. On
`claude` cache reads dominate: even a one-line answer from a fresh worker
spends tens of thousands of budget tokens, so set a Claude ceiling with
that in mind.

A ceiling is checked when a call is dispatched, not while it runs. Calls
admitted below it complete, and can overshoot it; a call dispatched once
spend has reached it throws `BudgetExceededError`. See
[failures.md](failures.md) for how to handle the refusal.

## `worktrees`

`worktrees` lists the finished worktrees of `isolation: "worktree"` calls.
Each entry has `path`, `branch`, `baseCommit`, `tipCommit`, and a `state`:

| `state` | Where the work is |
|---|---|
| `"unchanged"` | Nowhere: the worktree and its branch were removed |
| `"uncommitted"` | Only in the worktree's files; the branch still points at `baseCommit` |
| `"committed"` | In `tipCommit`, on `branch` |
| `"committed-and-uncommitted"` | Partly in `tipCommit`, partly in the worktree's files |
| `"unknown"` | Unestablished: clean-up failed, and the worktree was kept |

`branch` is `null` when the worktree ended on a detached `HEAD`; use
`tipCommit` then. A script that fans out isolated workers returns this list,
or what it did with each entry, so the caller can collect the work.

## `args`

`args` is the array of positional strings that followed the script path, or
the parsed value of `--json-args` when that option is given (a JSON `null`
arrives as an empty array). Strings stay strings: `"false"` and `"001"` are
not converted. Use `--json-args` for structured input:

```sh
node <launcher> --json-args '{"files":["a.ts","b.ts"],"depth":2}' review.js
node <launcher> --json-args @input.json review.js
```
