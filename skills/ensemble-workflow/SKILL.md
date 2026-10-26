---
name: ensemble-workflow
description: Orchestrate AI coding agents on the Ensemble runtime — write and run a JavaScript workflow script that fans work out over Codex, Claude and opencode workers and has one model family check another's, or dispatch a single worker on a chosen engine with no script at all. Use when deciding how to spread a job across agents and no ready-made workflow fits, when writing, editing or running an ensemble workflow script, when delegating one task to a worker on a named engine (a cross-engine second opinion, a one-shot structured extraction), when an engine family is refusing or degrading and the run must be moved onto another without rewriting the script, when recovering a stopped run's partial output or kept worktrees, and when listing or answering a run's open decision holds.
---

# Ensemble workflows

A workflow structures work across many agents — to be **comprehensive**
(decompose a job and cover it in parallel), to be **confident** (independent
perspectives and adversarial checks before committing), or to take on **scale
one context cannot hold** (migrations, audits, broad sweeps). The script
encodes that structure: what fans out, what verifies, what synthesises. Fan-out
is one shape among several — a careful sequence of single agents, each owning
a stage of one task, is as much a workflow as a hundred parallel workers.

You write a JavaScript file; the runtime runs it over that fleet. The control
flow is ordinary code. The workers are non-deterministic; the orchestration
around them is not.

Reach for a workflow at the point of deciding *how* to orchestrate, not after
the orchestration is already under way by hand. When no saved workflow fits,
write a new script rather than grinding the stages through serially. The right
move is often **hybrid**: scout inline first — list the files, scope the
diff — to discover the work-list, then write the workflow that pipelines over it.

## Engine selection is mandatory and symmetric

Every worker runs on an **engine** named per call — `'codex'` (the Codex CLI's
app-server), `'claude'` (a Claude Code background session), or `'opencode'`
(the opencode CLI, running a model the machine configuration declares); the
orchestrator is whichever agent you are. `agent()` **requires** an `engine`
(or a `target`, below). There is no default, and no engine is privileged —
Codex is not "the real one" with Claude or opencode bolted on, nor the reverse:

```js
await agent("…", { engine: "codex" });
await agent("…", { engine: "claude" });
await agent("…", { engine: "opencode", model: "glm-5.2" }); // a model the machine configuration declares
```

Omit `engine` and the call throws `MissingEngineError` before any worker
spawns; any other value throws `UnknownEngineError`. A default engine would
quietly bias every script toward one family; the explicit choice at every call
site keeps them equal, which is what cross-engine verification depends on. All
engines return the **identical contract** — bare final text without a schema,
a validated JSON value with one, and `null` on either shape when the worker's
attempts are exhausted — but reach it through different machinery
([references/engines.md](references/engines.md)).

## The launcher

The runtime is one self-contained file, `scripts/ensemble.mjs`, in this
skill's own directory beside this `SKILL.md`; only Node (24.14.0 or later) is
assumed present. Run it by absolute path:

```bash
node <absolute path to this skill's directory>/scripts/ensemble.mjs <script.js> [args...]
```

On Claude Code the skill text itself carries the path:
`${CLAUDE_PLUGIN_ROOT}/skills/ensemble-workflow/scripts/ensemble.mjs` (Claude
Code fills in the plugin root when it loads this file, so what you read here
is already the absolute path). Codex and opencode list each skill with the
directory it was loaded from; the launcher is `scripts/ensemble.mjs` under
that directory. The examples below write `ensemble` for brevity: read it as
that full `node …/scripts/ensemble.mjs` command, because **there is no `ensemble`
on `PATH`** unless the user has put one there themselves.

## The loop: write a script, run it

```bash
ensemble [run options] <script.js> [args...]
ensemble agent --engine <engine> [agent options] [prompt]
ensemble workflows
ensemble holds [--json] [--scope <scope> | --all]
ensemble holds answer <hold-id> --verdict <verdict> [--note <note>]
```

`--help` on the launcher or any subcommand prints usage on stdout.
The CLI runs the script, prints its **return value as JSON on stdout** (one
line — a plain-text answer prints as a JSON *string*, quotes included, so
`jq -r .` recovers it), streams **logs to stderr**, and **exits non-zero** if
the script throws. Capture the result by redirecting stdout:

```bash
ensemble brief.js > result.json 2> run.log
```

A run you expect to finish well inside your tool's command deadline runs in
the foreground like that; one that may outlast it is launched as
*Backstopping a long or stuck run* says.

Exit codes: `0` success · `1` the run failed — the script threw, the whole-run
`--timeout` expired, or a direct-agent worker exhausted its attempts
(partial-result envelope on stdout) · `130` / `143` SIGINT / SIGTERM stopped
the run (same envelope) · `2` the invocation was **rejected before a run
began** (a usage error, an unreadable script), leaving nothing behind: one
line on stderr, no sentinel, no archive. Return plain JSON-serialisable data —
a function, symbol, cycle or BigInt in the return value fails the run with the
offending path named — and a script with no `return` prints `null`.

**Run options go before `<script.js>`**; tokens after it are the script's raw
`args`, and one spelled like a run option is rejected (exit `2`) unless `--`
precedes the script path. All are optional:

| Flag | Effect |
| --- | --- |
| `--json-args '<json>\|@file'` | Hand the script a parsed JSON value as `args` instead of the positional `string[]` (nesting capped at 256 levels). |
| `--budget engine=N` | Token ceiling for one engine (repeatable). See `budget` in [references/script-api.md](references/script-api.md). |
| `--concurrency engine=N` | Override one engine's concurrency cap (repeatable). |
| `--agent-ceiling N\|null` | Cap concurrent workers across **all** engines; `null` lifts a ceiling the environment or configuration file set. |
| `--timeout ms` | Whole-run deadline in milliseconds (at most `2147483647`); off by default. Distinct from `agent()`'s per-turn `timeoutMs`. |
| `--strip capability` | Remove a tool-surface capability (`skills` or `agents`) from every worker; repeatable. |
| `--caller-identity <identity>` | Record the invoking session's opaque identity in the run record. Outranks `ENSEMBLE_CALLER_IDENTITY`. |
| `--hold-scope <scope>` | Publish this run's decision holds under the named scope. Outranks `ENSEMBLE_HOLD_SCOPE`. |
| `--remap key=engine[:model]` | Move every dispatch the key matches onto another engine without editing the script (repeatable). See *When an engine family misbehaves*. |

`engine` is `codex`, `claude`, or `opencode`. Only `--budget`,
`--concurrency`, `--strip` and `--remap` repeat; a flag given twice otherwise,
or any malformed flag, exits `2`. The ceiling and the caps also resolve from
an environment variable (`ENSEMBLE_AGENT_CEILING`, `ENSEMBLE_CONCURRENCY_CODEX`
/ `_CLAUDE` / `_OPENCODE`), then the optional machine configuration file
`$XDG_CONFIG_HOME/ensemble/config.json` (`~/.config/ensemble/config.json` when
unset), then the built-in default. That strict file is also where
`worker_environment` (variables injected into workers — where a gateway or
credential lives), `opencode_models` (the catalogue opencode workers may name)
and `targets` (your names bound to an engine and model) live; its keys are in
[references/rerouting.md](references/rerouting.md). Because
`worker_environment` can hold a credential, inspect the file by key — `jq
'del(.worker_environment)'` — never by printing it whole into a transcript.

> **Leave run-tuning unset unless the user asks for it.** By default there is
> no token budget, no agent ceiling, no whole-run timeout and no per-turn
> `timeoutMs`; concurrency and `maxAttempts` carry sensible defaults. A
> ceiling the user never requested silently truncates runs that would have
> finished. Two sanctioned exceptions: the hang-catcher in *Backstopping a
> long or stuck run*, and a lowered `--concurrency engine=N` for a worktree
> fan-out whose workers each compile the project (*Placement* in
> [references/engines.md](references/engines.md)).

**Where the runtime writes.** Every run is archived by default under the data
home `$XDG_DATA_HOME/ensemble/` (`~/.local/share/ensemble/` when unset), at
`runs/cwd/<namespace>/<run-uuid>/`, beside the `holds/` directory and the user
workflow registry `workflows/`. With recording on, startup prints one
`[run-record-archive] ` line on stderr followed by JSON carrying `run_id` and
`archive_path` — parse it to find the run you just launched. A live status
file is also written under the run cwd's `.claude/` while that directory
exists. The switches that move or disable each, and what the files contain,
are in [references/run-evidence.md](references/run-evidence.md); read it when
a run needs auditing or relocating, or a failed leg needs explaining.

## Script essentials

The full authoring surface — every hook and option, saved workflows, the
schema subset Codex accepts — is in
[references/script-api.md](references/script-api.md); read it whenever you
write or edit a script. The contracts below cause silent damage when missed:

- **`export const meta = { name, description }` is the very first thing in
  the file** — nothing may precede it, not even a comment. An optional
  `export const defaults = { … }` between `meta` and the body states
  per-engine `model`, `effort` and `fallback` once. Pin model and effort on
  every engine a script uses, even when they match today's defaults: defaults
  shift, and a pinned pair makes the policy auditable in the script; an
  unpinned call is announced on stderr as `runs unpinned`. A kept script —
  one other sessions will dispatch — also carries `// INPUT`, `// OUTPUT`
  and `// RUN` blocks after its exports, in the shape fixed in
  [references/script-api.md](references/script-api.md).
- **The script body is ordinary, unsandboxed Node** — `process`, `fetch`,
  timers, the filesystem and network, `require(...)` and dynamic `import()`
  from the script's own path; static `import` syntax is not available. Sleep,
  watch a file, read the world in plain code rather than spending a worker on
  it. An unknown free identifier **fails at load, before any worker spawns**.
- **`agent(prompt, {engine, …})` returns text without a `schema`, a validated
  JSON value with one — and `null` on either shape once the worker's attempts
  are exhausted.** Once a worker has spawned, **every failure is a value,
  never a throw**: bad output outlasting `maxAttempts`, an availability
  refusal no fallback entry answers, a transport error, a turn deadline — the
  call resolves `null`, the launcher prints `[<engine>] agent <id> (<label>)
  failed after N attempts — <cause>` on stderr, and the account is on the
  agent record. A script that wants a failed call to stop it checks for
  `null`. Only a rejection raised **before** a worker exists still throws (a
  bad option, a placement that never opened, an engine refusing the dispatch
  itself), as does the run's own ending through a leg it tore down. Give
  fan-in schemas an object top level (Codex requires one anyway) so `null`
  can only mean failure and `.filter(Boolean)` is safe; when a fan-in must
  know *which* worker failed, add `identity: true` and read the envelope's
  `failure`. A reply may carry prose around its JSON and the last schema-valid
  value wins, so tell a worker to put its final value last.
- **`parallel(thunks)` and `pipeline(items, ...stages)` collapse a thrown
  slot to `null` rather than rejecting** — except the pre-spawn author-error
  family (a rejected option, schema or target, an unresolvable `workflow()`
  reference, an engine refusing the dispatch), which fails the run. Thunks
  are functions: `() => agent(...)`.
- **Only an `availability` failure advances a declared `fallback` chain**,
  fresh and without spending an attempt; empty or off-schema output retries
  on the same target. `answered_by` on the agent record names who answered.
- **Workers are unrestricted by default** — full filesystem and network as
  the invoking user, on every engine. The one opt-in restriction, `strip:
  ['skills' | 'agents']` (CLI `--strip`), removes the named *tool-surface*
  capability — the subagent tool, not the worker's shell. A prompt constrains
  behaviour, not capability — state the task, success and the exact return,
  and route genuinely untrusted work elsewhere.
- **Two further hooks change what a script can be shaped around.**
  `session(options)` creates a **multi-turn worker** on Claude or Codex whose
  `send()` turns share one worker and its accumulated context. `await hold({
  content, verdicts })` **pauses the run on a decision** until any process
  writes an accepted verdict — sign-offs and go/no-go gates without burning a
  worker on the wait, listed with `ensemble holds` and answered with
  `ensemble holds answer`. Both are in
  [references/script-api.md](references/script-api.md), with `tally()`.

## Choosing an effort level

Effort buys search: a worker's reasoning is spent deciding what the brief left
open — which files, which approach, how to read an ambiguity. Set the level
by that residue, not by how important or long the task is: a dispatch whose
path the brief has already decided (a mechanical edit, run-and-report,
applying a named fix) takes the lowest level that holds quality; a named local
decision buys one step up; a genuinely open approach or an adversarial brief
buys more. Climb from the floor and name the decision each step buys. The
vocabulary is `minimal | low | medium | high | xhigh` on Codex and Claude; on
opencode `effort` names one of the model's declared `variants` (the `effort`
row in [references/script-api.md](references/script-api.md)).

## Single workers without a script

`ensemble agent` dispatches **one worker** straight from the shell — no
workflow file — with the same return contract as `agent()`:

```bash
ensemble agent --engine codex --model <model> --effort low \
  --schema '{"type":"object","additionalProperties":false,"required":["answer"],"properties":{"answer":{"type":"string"}}}' \
  "What does this repo's Makefile build? Reply as JSON."
```

The prompt is the final argument, or piped on stdin when omitted. Pin
`--model` and `--effort` on every direct dispatch, as a script's `defaults`
would; without them the engine's own configuration decides, and the launcher
says so on stderr. The agent options mirror `agent()`: `--schema` (inline JSON
or `@file`; the validated value is printed), `--cwd`, `--isolation worktree`,
`--max-attempts N` (default 3), `--label`, `--phase`, `--identity` (prints the
`{ label, phase, output, failure }` envelope), `--strip`, and `--task
<identity>` (a grouping identity for the run record). The run options apply
here too, `--remap` included, and go **after `agent` and before the prompt**.
There is no fallback flag and no per-turn `timeoutMs` flag — a job needing
either wants a one-call script. A worker that exhausts its
attempts exits `1` with the partial-result envelope. Reach for this when the
job is one delegated worker — a single cross-engine review, a one-shot
structured extraction — and a script would be ceremony; the run is still
archived like any other.

## Cross-engine verification

This is the pattern the whole runtime is built for: have **one engine find and
the other verify**, so neither model checks only its own work. The families
have different blind spots, so a finding that survives both is stronger than
one either could vouch for alone. One boundary to hold: the mechanism checks
what the workers **derive**, never what you **supply** — a fact you assert in
the prompt passes every verifier trivially, so an error in your own framing
comes back confirmed in the other family's voice. With opencode the family is
chosen by `model`, from whatever the machine declares under `opencode_models`
with the `family` each declaration states; choose different families for a
genuine cross-family check. The runtime records the pairing but does not
enforce it.

The minimal shape — Codex proposes, Claude judges:

```js
const finding = await agent("Find one candidate bug in this code.", { engine: "codex", schema: bugSchema });
const verdict = await agent(
  `Independently verify this bug, then reply {real:boolean,reason}. Bug: ${JSON.stringify(finding)}`,
  { engine: "claude", schema: verdictSchema }
);
const confirmed = finding !== null && verdict?.real === true;
```

It is **symmetric** — swap the two `engine` values and Claude finds while
Codex verifies. Scale it to a panel by fanning the verifier across several
workers of the *other* family and keeping the finding only on a majority
confirm; when a finding can fail in more than one way, give each verifier a
distinct lens — correctness, security, does-it-reproduce — since three
identical sceptics share one blind spot. Identical refuters answer one
question, so a majority is meaningful; lenses answer *different* questions, so
each lens's refutation is a veto on its own axis. Both panels are worked in
[references/patterns.md](references/patterns.md). Frame verifiers to
**refute**, not to confirm: a worker asked "is this right?" agrees more often
than it should, and one asked to hunt for disconfirming evidence and treat
"unproven" as failing lets through only what survives a genuine attack.

### Briefing verifiers — point at evidence, don't summarise it

How much context a verifier gets decides whether the check is real, and the
answer is counter-intuitive: **less of your account, more of the raw
evidence**. Hand over pointers, not narration — file paths, transcripts,
artefacts the worker reads itself; a worker handed your *summary* can only
check the reasoning built on it, never find the summary wrong, so where
evidence must be inlined, quote it verbatim and apart from your
interpretation. Do not name the expected answer — ask what the evidence shows,
never "the README says X; confirm it". And leave a field for what you didn't
ask, an `outOfScopeConcerns` in the schema, so a worker that spots your
premise is wrong has somewhere to say so; read it first. Where the reply
shape is fixed for you, keep it and ask for that concern inside the field you
have. When workers must be
confined to supplied evidence, what they are confined *to* must be raw
sources, or every worker reasons from your account and none can check it.

## Live requirement — reach the families your move uses, or stop

A cross-engine move needs **every model family it uses** reachable in one run.
Each family is a CLI plus the auth and allowance behind it:

- **Codex** — the `codex` CLI installed and signed in.
- **Claude** — the `claude` CLI with its allowance, and **`tmux`** for
  in-session schema corrections and `session()` follow-ups. Workers run as
  `claude --bg --dangerously-skip-permissions`, which Claude Code allows only
  once its disclaimer has been accepted on the machine by a one-time
  interactive `claude --dangerously-skip-permissions`. That consent is the
  user's to give, never the session's: when a dispatch fails for want of it,
  stop and give the user that command.
- **opencode** — the `opencode` CLI, with the model the script names declared
  in `opencode_models` and reachable through its provider.

**Verify quietly; speak up only when something is missing.** Confirm the
families a script actually uses are reachable before relying on the result —
silently, and only for the engines it names: each CLI on `PATH` (`command
-v`), `tmux` for Claude, the model declared for opencode (read the
configuration file by key); the allowance behind a CLI, and whether Claude
Code's disclaimer has been accepted, are learned only from a dispatch — its
refusal says which. When a move *cannot* reach a family it needs,
**stop and tell the user** which piece is missing. Missing `tmux` is one notch
softer for one-shot Claude calls — schema correction degrades to fresh
re-dispatch, so say so rather than stopping — but Claude `session()` workers
harden it back to a requirement. Run a single family anyway only when labelled
explicitly as a single-family substitute with the cross-engine check recorded
as *not performed*: a reported degraded run beats a result that looks
cross-engine but is not.

**The dispatching session itself must be able to write.** A worker is never
sandboxed, but the session that launches it may be: the launcher writes run
records under the data home, Codex writes its own home, and the Claude control
plane keeps its per-dispatch settings and tmux sockets under the system
temporary directory. A Codex session in its default read-only sandbox cannot
reach these, so one that is going to delegate starts with
`codex --sandbox danger-full-access` — a session already running sandboxed
cannot change this itself, so it says so and the user relaunches it; Claude
Code and opencode sessions impose no such sandbox. Engine substrates start lazily, so a
Claude-only script runs without the `codex` CLI installed; a substrate refusing
a dispatch outright is a **pre-spawn rejection that throws**
(`CodexSubstrateRefusedError`, `ClaudeDispatchError`) after advancing any
declared `fallback` chain — never a `null` a fan-in would silently filter
(*Substrate refusals* in [references/script-api.md](references/script-api.md)).

## When an engine family misbehaves

An engine family refusing dispatches, exhausting its allowance, or serving a
model that has regressed is a routing problem, not a script problem: move the
dispatches, re-run, and leave the workflow as written. Three mechanisms, each
specified in full in [references/rerouting.md](references/rerouting.md):

- **Rebind a named target.** Where scripts name roles — `{ target: "doer" }`
  in place of `engine` and `model` — the machine configuration's `targets`
  map binds each name to an engine and optional model. One edit to that file
  moves every workflow on the machine that uses the name; bindings are read
  when a run starts, so the rebinding reaches the next run, never one in
  flight. A name the machine does not bind throws `NamedTargetRejectedError`
  before any worker spawns, so a script written to travel keeps literal
  engines.
- **Set a dispatch remap at launch.** `--remap key=engine[:model]` (before the
  script path, repeatable) moves every dispatch the key matches — a
  `label:<glob>`, a `phase:<glob>`, an `engine:model` pair, or a bare engine —
  onto another engine without touching the script:

  ```bash
  ensemble --remap 'claude=codex' review.js                # every Claude dispatch runs on Codex
  ensemble --remap 'phase:verify=claude:<model>' audit.js  # one phase onto a named model
  ```

  `ENSEMBLE_DISPATCH_REMAP` carries the same rules comma-separated and is
  replaced whole by any `--remap` flag; there is deliberately no
  configuration-file layer. Every move is announced on stderr and recorded, and
  a rule that matched nothing is reported.
- **Declare a fallback chain** so the next run advances on its own: `fallback:
  [{ engine, model, effort? }, …]` or `[{ target, effort? }, …]` on a call or
  in `defaults`. Only an availability failure advances it.

The record keeps every move visible: a run whose finder and verifier both
landed on one family bought throughput, not the cross-engine check — say so.

## Engines, placement, and patterns

[references/engines.md](references/engines.md) carries how each engine reaches
the shared contract, per-engine concurrency defaults and failure modes, and
worker placement (`cwd`, worktree isolation, harvesting kept worktrees, the
memory caution for compile-heavy fan-outs): read it when debugging a worker,
tuning concurrency, or isolating or closing a fan-out.
[references/patterns.md](references/patterns.md) carries worked shapes (map,
fan-out with verification, staged pipelines, panels, loops) and the headline
cross-engine example in full: read it when designing a new script.

## Backstopping a long or stuck run

By default no per-turn `timeoutMs` is set, so a worker runs until it finishes:
a long task is never cut off, but a genuinely wedged one will not fail on its
own. You do not need a per-turn timeout to stay safe, because the run's end
reaches you on its own. Launch the workflow with whatever your tool offers for
a command that must not block the turn, stdout and stderr redirected to files,
its deadline set past the run's expected scale where that is known, and let
the launcher's exit be the single wake: it coincides with the completion
sentinel write, and on waking you read the sentinel for the run's own account
of how it ended. A run that can outlive any deadline the tool allows — one
that holds for decisions, or runs for hours — is launched detached instead
(`setsid nohup … > out.json 2> run.log &` from a shell that returns at once)
and watched for its sentinel. Do **not** poll the progress output or arm
recurring wake-ups: a healthy run gives you nothing to do before its terminal
wake, and the stderr log and live status file are for reading once you are
awake with a reason to look. A wedged worker therefore shows up only as a
completion that never comes: one generous fallback check set well past the
run's known scale (single, never recurring) is the sanctioned check — a worker
whose `firstEvidenceAtMs` is never set, or `waitingOn` a background task that
never ends, is wedged; stop the run with `kill -INT <pid>` and completed
workers' outputs are still emitted. Reserve an explicit `timeoutMs` for the
rare case where a worker should fail at a hard deadline.

## The completion sentinel says a run has ended

At startup the CLI prints on stderr `[sentinel] will write <path> when the run
ends`, naming a `completion-sentinel.json` the launcher itself writes on every
ending it can handle — success, failure, timeout, interruption, a body's
`process.exit`, an uncaught exception — even with recording disabled. The path
is announced only once its directory exists; a store the launcher cannot
create yields one `[sentinel] no sentinel will be written for this run — …`
line instead, so never arm a watch on a path that was not announced. The file
carries `outcome`, `exit_code`, `ended_at`, `error` (what ended the run, or
`null`), `workers` — `{ done, failed, cut_short, unsettled }` — and the sealed
manifest's digest. It appears exactly once and is the run's own account rather
than an inference from silence. **Back the watch with a signal that fires when
the launcher itself dies**: a SIGKILL leaves no sentinel, so only a
process-exit notification, or the single fallback check above, tells "still
running" from "died without reporting".

## Stopped and failed runs leave salvage

Whenever a run ends without its script returning — stopped by SIGINT/SIGTERM,
killed by `--timeout`, or failed because the script threw (a pre-spawn
rejection escaping a bare `await agent(...)` counts) — the run exits non-zero,
but completed work is **not** discarded. Every worker that finished is emitted
to stdout as a partial result:

`{ partial: true, reason: "interrupted" | "timed-out" | "failed", error: { kind, message }, completed: [{ id, engine, label, phase, output }, …] }`

The script's own return value is lost because the body did not complete; treat
the envelope as salvage, not a substitute for finishing. Kept worktrees from
isolated workers survive too — harvest them as *Placement* in
[references/engines.md](references/engines.md) describes. The body runs in the
launcher's own process, so **`return` your result; never call `process.exit`**
(it is intercepted and the run ends `failed` with `WorkflowProcessExitError`).
Returning with workers still in flight ends the run `complete` but tears them
down, each recorded `interrupted` with one `[teardown]` line. Await every call
you start.
