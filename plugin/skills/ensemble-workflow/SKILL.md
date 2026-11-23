---
name: ensemble-workflow
description: Write and run multi-agent workflows on the Ensemble runtime, where a JavaScript script fans work out to AI coding agents, each on a named engine (Codex, Claude Code, opencode, ZCode or Google's Antigravity CLI), and fans their answers back in, so that one model family can check another's work within a single run. Also dispatches a single worker on a chosen engine or model with no script. Use when deciding how to split a job across agents, when writing, editing, running or debugging an Ensemble workflow script, when handing one task to a worker on another engine (a cross-family second opinion, a one-shot structured extraction), when a model family is refusing, out of allowance or answering badly and a run has to move to another family without the script being rewritten, when recovering a stopped run's partial output or kept worktrees, and when listing or answering a run's open decision holds.
---

# Ensemble workflows

Ensemble runs a JavaScript workflow script over AI coding agents. The script
is ordinary code: its loops, conditions, fan-out and fan-in run exactly as
written, and only the workers it dispatches are non-deterministic. Every
worker runs on an engine its call names, so one model family can check
another's work inside a single run. The same runtime dispatches one worker
with no script at all.

Reach for it when a job is wider than one context can hold (a sweep, an
audit, a migration), when an answer should survive an independent check
before anyone acts on it, or when one task belongs on a different engine or
model from the one you are running on. Scout in your own session first (list
the files, scope the diff), then write the script over the work-list you
found.

## The launcher

The runtime is one self-contained file, `scripts/ensemble.mjs`, in this
skill's directory: the directory that holds this `SKILL.md`, which your tool
named when it loaded the skill. Run it with Node.js 24.14.0 or later, by its
absolute path. The skill installs nothing on `PATH`, so a bare `ensemble`
command exists only where the user has made one themselves.

Commands throughout this skill write that absolute path as `<launcher>`:

```sh
node <launcher> [run options] <script.js> [args...]
node <launcher> agent --engine <engine> [agent options] [prompt]
node <launcher> agent --target <name> [agent options] [prompt]
node <launcher> workflows
node <launcher> holds [--json] [--scope <scope> | --all]
node <launcher> holds answer <hold-id> --verdict <verdict> [--note <note>]
```

The first form runs a workflow script and the `agent` forms run a single
worker; `workflows` lists saved workflows, and the `holds` forms list and
answer open decision holds. There is no `run` subcommand: the script path
follows the run options directly. `--help` on the launcher or on any
subcommand prints its usage, and `--version` the runtime's version.

A workflow's return value, or a single worker's answer, is printed on stdout
as JSON. Logs and diagnostics go to stderr, so keep the two apart:

```sh
node <launcher> review.js src/parser.ts > result.json 2> run.log
```

A plain-text answer prints as a JSON string, quotes included; `jq -r .`
recovers the text. A script with no `return` prints `null`.

| Exit code | Meaning |
|---|---|
| 0 | The script returned, or the single worker answered; the result is on stdout |
| 1 | The run failed or timed out. stdout carries a partial-result envelope holding every finished worker's output, or the result already printed when the failure came after the script returned |
| 2 | The invocation was rejected before any run began, for a usage error or an unreadable script path, say. Nothing was recorded |
| 130, 143 | SIGINT or SIGTERM stopped the run; the partial-result envelope is on stdout |

Exit 0 says the script returned, not that its workers succeeded: a script
that receives a failed worker's `null` and carries on still exits 0. Count
the failures in what the script returns (see *When a call fails*).

Run options go before the script path; everything after the script path
reaches the script as `args`.

| Run option | Effect |
|---|---|
| `--json-args '<json>'`, `--json-args @file` | Give the script a parsed JSON value as `args` in place of the positional strings |
| `--remap key=engine[:model]` | Move matching dispatches to another engine or model for this launch (see *When a model family misbehaves*). Repeatable |
| `--budget engine=N` | Token ceiling for one engine. Repeatable |
| `--concurrency engine=N` | Most workers running at once on one engine. Repeatable |
| `--agent-ceiling N` | Most workers running at once across all engines; `null` lifts a ceiling set elsewhere |
| `--timeout ms` | Deadline for the whole run |
| `--strip capability` | Remove a tool capability, `skills` or `agents`, from every worker. Repeatable |
| `--lean` | Start every worker without the operator's own rules, skills and MCP tools |
| `--hold-scope <scope>` | Scope under which the run raises decision holds |
| `--caller-identity <identity>` | An identity for the invoking session, kept in the run record |
| `--worker-scope worker` or `run` | How worker processes are grouped under systemd |

A run has no token budget, no agent ceiling and no deadline unless one is
set. Set one when the user asks for it or the job needs the bound: a limit
nobody asked for ends a run that would have finished.

### One worker, no script

`agent` dispatches a single worker with the same contract as an `agent()`
call in a script. Its options go after the word `agent` and before the
prompt; the prompt is the one positional argument, or stdin when omitted.

```sh
node <launcher> agent --engine codex --effort low \
  --schema '{"type":"object","additionalProperties":false,"required":["answer"],"properties":{"answer":{"type":"string"}}}' \
  'What does the Makefile in this directory build?'
```

The agent options mirror the `agent()` options: `--model`, `--effort`,
`--schema` (inline JSON or `@file`), `--fallback` (inline JSON, `@file`, or
`false`), `--cwd`, `--isolation worktree`, `--timeout-ms`, `--max-attempts`,
`--identity`, `--label`, `--phase`, and `--task` (a grouping identity for
the run record). The run options above apply too, except `--json-args`. A
worker that fails exits 1 with the partial-result envelope in place of a
bare `null`.

## Before the first dispatch

- **Workers run unrestricted.** Each one can read and write wherever the
  user running the launcher can, and can reach the network. A prompt limits
  what a worker does, never what it is able to do. Dispatch only where that
  is acceptable.
- **Each engine a script names must be usable**: its CLI installed and
  signed in, as the table under *Engines* lists. Engines start on first use,
  so a run needs only the ones its script names.
- **Claude workers need a one-time consent.** They run with Claude Code's
  permission prompts bypassed, which Claude Code allows only after its
  disclaimer has been accepted interactively, once per Claude configuration
  home. That consent is the user's to give. When a dispatch is refused for
  want of it, stop and give the user the command the refusal names.
- **The launching session must be able to write** the Ensemble data home
  (`$XDG_DATA_HOME/ensemble/`, normally `~/.local/share/ensemble/`) and each
  engine's own home. A session inside a sandbox that forbids this is refused
  with an error naming the directory and the setting behind it. A session
  cannot lift its own sandbox, so report the refusal to the user.

## Writing a workflow script

This script has one family find likely bugs and another try to refute each
one:

```js
export const meta = {
  name: "find-and-verify",
  description: "One model family finds likely bugs in a file; another tries to refute each",
};

export const defaults = {
  codex: { effort: "medium", fallback: false },
  claude: { effort: "medium", fallback: false },
};

const file = args[0];

const findings = {
  type: "object",
  additionalProperties: false,
  required: ["bugs"],
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["line", "claim"],
        properties: { line: { type: "integer" }, claim: { type: "string" } },
      },
    },
  },
};
const verdict = {
  type: "object",
  additionalProperties: false,
  required: ["real", "reason"],
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
};

phase("Find");
const found = await agent(`Read ${file} and list the likely bugs in it.`, {
  engine: "codex",
  schema: findings,
  label: "finder",
});
if (found === null) throw new Error("the finder failed");

phase("Verify");
const checks = await parallel(
  found.bugs.map((bug, i) => () =>
    agent(
      `Someone claims ${file} has a bug at line ${bug.line}: "${bug.claim}". ` +
        `Read the code and try to refute the claim. Call it real only if it survives.`,
      { engine: "claude", schema: verdict, label: `verify-${i + 1}`, identity: true },
    ),
  ),
);

const unchecked = checks.filter((check) => check.failure !== null).length;
await tally("findings", found.bugs.length);
await tally("unchecked", unchecked);
return {
  confirmed: found.bugs.filter((_, i) => checks[i].output?.real === true),
  unchecked,
};
```

The example names no model, because model names belong to the machine it
runs on; *Models and effort* says where to take them from. It switches
fallback off on both engines, because a chain the machine supplies could
otherwise carry either worker onto the other's family and leave one family
checking itself.

What the format requires:

- `export const meta = { … }`, an object literal with the workflow's `name`
  and `description`, is the first thing in the file. Anything before it, a
  comment included, is rejected. An optional `export const defaults = { … }`
  follows it and sets per-engine `model`, `effort` and `fallback` for every
  call on that engine.
- The rest of the file is the body of one async function running as
  ordinary, unsandboxed Node: `return` gives the run's result, top-level
  `await` works, and Node's globals, `require()` and dynamic `import()` are
  available. Static `import` statements are not. Wait, read files and call
  the network in plain code; a worker is for work that needs a model.
- A name the body uses that is neither a Node global, a hook, nor a binding
  of its own fails at load, before any worker spawns.
- Return plain JSON data. Await every call the script starts: a script that
  returns while a worker is still running ends the run, and that worker is
  stopped. End with `return`, never `process.exit`, which is intercepted and
  fails the run.

The hooks a body can call:

| Hook | Purpose |
|---|---|
| `agent(prompt, options)` | Run one worker and return its answer |
| `parallel(thunks)` | Run calls concurrently; results come back in input order |
| `pipeline(items, ...stages)` | Run each item through a series of stages independently |
| `session(options)` | Create a worker that keeps its context across several turns |
| `hold(options)` | Pause the run until someone outside it makes a decision |
| `workflow(nameOrRef, args)` | Run a saved workflow inline and return its result |
| `lookupDispatch(options)` | Say where a call would run, without dispatching |
| `phase(title)`, `log(message)` | Write to the run log |
| `tally(name, value)` | Record a named count in the run record |
| `budget`, `worktrees`, `args` | Per-engine token accounting, kept worktrees, the script's arguments |

Read [references/script-api.md](references/script-api.md) whenever you write
or edit a script: it has every hook, every `agent()` option, the schema
rules, and how to write a worker's prompt. Read
[references/patterns.md](references/patterns.md) when you are choosing a
script's shape: staged pipelines, checker panels, loops, and fan-in.

## Engines

Every call names its engine through `engine`, or through `target` (see
*Fallback chains and named targets*). No engine is the default: a call with
neither throws before any worker spawns.

| `engine` | Runs on | Needs | `model` | `session()` | `strip` | `lean` |
|---|---|---|---|---|---|---|
| `codex` | The Codex CLI | `codex`, signed in | Optional | Yes | Yes | No |
| `claude` | Claude Code background sessions | `claude`, signed in; `tmux`; the one-time consent above | Optional | Yes | Yes | Yes |
| `opencode` | The opencode CLI | `opencode`; the model declared in the machine configuration | Required: a declared model | No | Yes | Yes |
| `agy` | Google's Antigravity CLI | `agy`, signed in | Optional | Yes | No | No |
| `zcode` | The ZCode CLI | A `zcode` that accepts a run's provider, model and reasoning level and prints its model listing | Required: `provider/model` as `zcode models` lists it | Yes | Yes | No |

All five honour the same contract: the answer text, or with a `schema` a
value that validates against it, or `null` when the worker failed. An option
an engine cannot honour, a "No" in the table, throws before that worker
spawns; it is never silently ignored.

Read [references/engines.md](references/engines.md) when a dispatch is
refused or a worker behaves unexpectedly on one engine, when deciding which
engine can take a leg, and when placing workers in directories or isolated
git worktrees.

## Models and effort

Take a model name from the user's request, the project's own guidance, or a
named target the machine binds. Where nothing gives one, leave `model` off on
`codex`, `claude` and `agy` and the engine's own default runs; a Codex or
Claude call says so on stderr. Once a model is chosen, pin it in `defaults`,
so the script records what it ran on.

A model's family belongs to the model, not to the engine that runs it: a
Claude model reached through `opencode` or `zcode` is still the `claude`
family. Cross-family checking is judged on families.

`effort` is one vocabulary on every engine: `none`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`, in rising order. Each dispatch converts the
level to what its model serves and takes the nearest served level when the
model lacks the one asked for, so a script moves between engines unchanged.
The machine configuration can set a floor and a ceiling, and the level is
held within them first. State `effort` on every call or in `defaults`: on a
machine that sets bounds a call with no effort is refused before it spawns,
and elsewhere it falls to the engine's default. The run record shows the
level requested and the level served.

Effort buys search. Set it by how much the prompt leaves the worker to
decide, not by how important or long the task is: a low level for work whose
route the prompt has settled, more for a real decision or an open approach.

## When a call fails

Once a worker has spawned, a failed call is a value, not an exception. After
its attempts are spent (three by default, each retry told what was wrong
with the last) the call resolves `null`, and stderr reports
`[<engine>] agent <id> (<label>) failed after N attempts` with the cause.

- Check every result for `null` before using it, and decide at each stage
  whether a failed worker stops the run (`throw`) or is counted and reported
  in the return value. A fan-in that filters out `null` without counting it
  reports partial coverage as complete.
- `parallel()` and `pipeline()` put `null` in a failed leg's slot.
- With `identity: true` a call resolves
  `{ label, phase, output, failure, answeredBy }`, where `failure` is `null`
  exactly when the worker answered. Use it when a fan-in has to know which
  worker failed and why, or which engine and model answered.

Two things still throw, through `parallel()` and `pipeline()` too. A call
rejected before its worker exists fails the run unless the script catches
it: an invalid option, an unknown engine, an unbound target, a schema that
does not compile, a budget refusal, an engine that refused the dispatch
outright. The run's own ending, an interrupt or the whole-run deadline,
throws through every call it cut short.

A run that ends without its script returning prints a partial-result
envelope on stdout, `{ partial: true, reason, error, completed }`, where
`completed` holds the output of every worker that finished. That is salvage:
the script's own result is lost.

Read [references/failures.md](references/failures.md) when a call returned
`null` or a run failed and you need the cause, when setting deadlines, retry
bounds or token budgets, and when a run ended some way other than its script
returning.

## Fallback chains and named targets

A **fallback chain** is an ordered list of other targets for a call:
`fallback: [{ engine, model, effort? }, …]` on the call or in `defaults`,
where an entry may be `{ target, effort? }` to name a named target. The
runtime moves the call to the next entry only on an availability failure,
meaning the engine refused or lost the worker before it answered: an
exhausted allowance, an overloaded provider, a missing sign-in, a dead
process. A bad answer is retried where it is. `fallback: false` switches a
chain off, including one the machine configuration would supply.

A **named target** is a name the machine configuration binds to an engine,
with or without a model. A call gives `target: "<name>"` in place of
`engine` and `model`, so one edit to the binding moves every workflow that
uses the name. Ensemble ships no names, and a name the machine does not bind
is refused before any worker spawns. Use names only where you know the
machine binds them: `lookupDispatch({ target: "<name>" })` answers
`bound: false` for one it does not. A script meant to travel names its
engines directly.

### When a model family misbehaves

A family that is refusing dispatches, out of allowance, or answering badly
is a routing problem, not a script problem. Leave the script as written and
move its dispatches:

- **For one launch**, add a dispatch remap. `--remap claude=codex` moves
  every dispatch on the `claude` engine to Codex. A key can instead be a
  label or phase glob, which moves one role and its whole fallback chain,
  or an `engine:model` pair, which moves that one model. The destination
  can carry a model: `--remap 'label:verify-*=codex:<model>'`. Nothing on
  disk changes, and stderr names each dispatch the remap moved.
- **For every run from now on**, rebind the named target in the machine
  configuration's `targets` section. This reaches every workflow on the
  machine that uses the name, from its next run. The file is the
  operator's: edit it when the user wants the move to stand, and otherwise
  remap the run in hand and tell the user which binding to change.
- **So that later runs recover unattended**, declare a fallback chain.

After any move, look at what is left of the cross-family check. A finder and
a checker that landed on one family did not check each other. When every
worker in a run was dispatched to one family, the run says so on stderr in a
`[single-family]` line; say it in your report too. That notice does not see
a fallback step, and stays silent when a worker's family is unknown, so its
absence proves nothing.

Read [references/rerouting.md](references/rerouting.md) before using any of
the three: it has the remap's keys, their precedence and how far each kind
reaches along a fallback chain, how names resolve, and
the order in which a chain is found and followed. Read
[references/machine-configuration.md](references/machine-configuration.md)
when reading or editing the machine configuration file, or setting an
Ensemble environment variable.

## Checking one family's work with another

Two workers of one family share blind spots, so a finding that a different
family has tried and failed to refute is worth more than one either could
vouch for alone. The runtime dispatches and records the workers; whether the
check is real is the script's doing.

- Put the doer and the checker on different families, and confirm that it
  held: `lookupDispatch()` gives each call's family before anything is
  dispatched, and an identified call's `answeredBy.family` gives the family
  that answered. A fallback chain can carry either one onto the other's
  family, so switch fallback off for both, or read `answeredBy`.
- Ask the checker to refute, and to treat unproven as failing. A worker
  asked whether something is right agrees more often than it should.
- Give the checker the evidence, not your account of it: paths to read,
  output quoted verbatim, the claim under test. Leave out the answer you
  expect. A checker handed a summary can only check the reasoning built on
  that summary.
- The check covers what the workers derive, never what the prompt asserts.
  A mistake in your own framing comes back confirmed.
- When a family the check needs cannot be reached, either stop, or run on
  one family and report that the cross-family check was not performed. Do
  not present a single-family run as a cross-family one.

## Sessions and holds

`session(options)` creates a worker that keeps its context across turns:
each `send(prompt)` runs one turn on the same worker, under the same
contract as an `agent()` call. Use one when later turns build on earlier
ones (plan, then implement, then fix). opencode has no sessions.

`await hold({ content, verdicts })` pauses the run until someone outside it
answers with one of the listed verdicts, and resolves `{ verdict, note }`.
Use one where a decision is not the script's to make. No worker is spent on
the wait. `node <launcher> holds` lists open holds, and
`node <launcher> holds answer <hold-id> --verdict <verdict>` answers one.

Read [references/sessions-and-holds.md](references/sessions-and-holds.md)
before writing a script that uses `session()` or `hold()`, and before
listing or answering holds.

## Long runs, and what a run leaves behind

A worker has no deadline unless its call sets one, so a run takes as long as
its workers do. Start a run that may outlast your tool's command deadline in
the background, with stdout and stderr redirected to files, and let its exit
be what wakes you. A healthy run needs nothing from you before then: do not
poll its log.

At startup the launcher names on stderr the completion sentinel it will
write, the live status file it publishes while running, and the run's
archive. It writes the sentinel on every ending it can handle, carrying the
run's outcome, exit code and a tally of its workers, so the sentinel is the
run's own account of how it ended. An uncatchable kill leaves no sentinel,
so keep one fallback check behind the wait.

A worker dispatched with `isolation: "worktree"` works in a git worktree of
its own. Changed worktrees are kept and reported, never merged: collecting
that work is the caller's job.

Read [references/run-evidence.md](references/run-evidence.md) when starting
or watching a long run, when a run looks stuck, when recovering what a
stopped run finished, and when reading a run's archive to explain what
happened.
