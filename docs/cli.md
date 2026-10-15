# Command-line interface

The launcher is a single self-contained file,
`skills/ensemble-workflow/Base/scripts/ensemble.mjs`. Run it with Node.js
24.14.0 or later; an older Node exits 1 with a version error. This page writes
it as `ensemble`, as if a shell alias or a symlink on `PATH` gave it that name:

```sh
alias ensemble='node /path/to/Ensemble-Workflows/skills/ensemble-workflow/Base/scripts/ensemble.mjs'
```

## Synopsis

Running the launcher with no arguments prints this usage text on stderr. It
names the program as you invoked it:

```text
Usage: node ensemble.mjs [run options] <script.js> [args...]
       node ensemble.mjs agent --engine <engine> [agent options] [prompt]
       node ensemble.mjs workflows
       node ensemble.mjs holds [--json] [--scope <scope> | --all]
       node ensemble.mjs holds answer <hold-id> --verdict <verdict>
                         [--note <note>]

Run options (before the script path):
  --json-args '<json>|@file'  --budget engine=N  --concurrency engine=N
  --agent-ceiling N|null  --timeout ms  --strip capability
  --caller-identity <identity>  --hold-scope <scope>  --lean
Agent options (after agent, before the prompt):
  --model <model>  --effort <effort>  --label <label>  --phase <phase>
  --cwd <path>  --isolation worktree  --identity  --schema '<json>|@file'
  --max-attempts N  --task <identity>  --strip capability  --budget engine=N
  --agent-ceiling N|null  --concurrency engine=N  --timeout ms
  --caller-identity <identity>  --hold-scope <scope>  --lean
The prompt is the one positional argument, or stdin when omitted.
Run `node ensemble.mjs --help` for orientation; each subcommand answers --help.
```

`--help` and `--version` print text on stdout, and each subcommand answers its
own `--help`.

## Running a workflow

```sh
ensemble [run options] <script.js> [args...]
```

Runs a workflow script (see [Workflow scripts](workflow-scripts.md)). The
script's arguments reach it as
[`args`](workflow-scripts.md#budget-worktrees-and-args): the positional
strings, or the parsed value of `--json-args`. Run options must come before the script path. To pass
a script argument spelled like a run option, put `--` before the script path:
`ensemble -- script.js --json-args`.

| Option | Description |
|---|---|
| `--json-args '<json>'`, `--json-args @file` | Replace the positional arguments with a parsed JSON value, inline or read from a file. At most 256 levels of nested arrays or objects |
| `--budget engine=N` | Token-spend ceiling for one engine, checked when each worker is dispatched. Repeatable, one engine each |
| `--concurrency engine=N` | Maximum parallel workers on one engine. Repeatable, one engine each |
| `--agent-ceiling N` | Maximum parallel workers across every engine. `--agent-ceiling null` lifts a ceiling set in the environment or configuration file for this run |
| `--timeout ms` | Whole-run deadline, at most 2147483647. Distinct from an `agent()` call's own `timeoutMs` |
| `--strip capability` | Remove a tool-surface capability (`skills` or `agents`) from every worker in the run; an opencode worker refuses any strip (see [Permissions](workflow-scripts.md#permissions-and-strip)). Repeatable |
| `--caller-identity <identity>` | Opaque identity of the invoking session, recorded in the run record. Overrides `ENSEMBLE_CALLER_IDENTITY` |
| `--hold-scope <scope>` | Scope for decision holds raised during the run. Overrides `ENSEMBLE_HOLD_SCOPE` |
| `--lean` | Start every worker in the run without the operator's interactive context; an engine that cannot arrange it refuses the dispatch before the worker spawns (see [Lean workers](workflow-scripts.md#lean-workers)) |

Only `--budget`, `--concurrency`, and `--strip` may be repeated; every other
option may appear once. `--concurrency` and `--agent-ceiling` sit on top of the
environment and configuration-file layers described in
[Configuration](configuration.md).

## Running a single agent

```sh
ensemble agent --engine <engine> [agent options] [prompt]
```

Dispatches one worker without a script. Give the prompt as the final argument,
or omit it and pipe the prompt on stdin; options go after `agent` and before
the prompt.

| Option | Description |
|---|---|
| `--engine <engine>` | Required. `codex`, `claude`, or `opencode` |
| `--model <model>` | Model to run. Required for opencode |
| `--effort <effort>` | Reasoning effort: `minimal`, `low`, `medium`, `high`, or `xhigh`; on opencode, one of the model's declared variants |
| `--schema '<json>'`, `--schema @file` | JSON Schema the answer must satisfy; the validated value is printed |
| `--identity` | Print the identified result `{ label, phase, output, failure }` instead of the bare output |
| `--max-attempts N` | Attempt bound (default 3), as `maxAttempts` in a script |
| `--cwd <path>` | Working directory for the worker; must be an existing directory |
| `--isolation worktree` | Run the worker in a fresh git worktree |
| `--label <label>`, `--phase <phase>` | Annotate the worker in progress output and its run record |
| `--task <identity>` | Grouping identity copied into the run record |

The run options `--budget`, `--concurrency`, `--agent-ceiling`, `--timeout`,
`--strip`, `--caller-identity`, and `--hold-scope` apply here too.

The option semantics match `agent()` in a script; see
[`agent()` options](workflow-scripts.md#agent-options). There is no fallback
flag: a fallback chain is declared in a script. With `--isolation worktree`
the worker's branch is reported on stderr, and a branch containing changed
work is kept.

A worker that exhausts its attempts exits 1 with the partial-result envelope
(below) rather than printing a bare `null`. If the schema accepts JSON `null`
and the worker returns it, the command exits 0 and prints `null`.

## Listing saved workflows

```sh
ensemble workflows
```

Lists the saved workflows in the project registry
(`.claude/ensemble/workflows/`) and the user registry
(`$XDG_DATA_HOME/ensemble/workflows/`, normally
`~/.local/share/ensemble/workflows/`), printing each workflow's `meta.name`
and `meta.description` as prose on stdout. Files whose metadata cannot be
parsed are noted on stderr and skipped, so one bad file does not hide the
rest. A user workflow whose name is also used by a project workflow is
labelled `user (shadowed by project)`, because name resolution selects the
project entry.

## Decision holds

```sh
ensemble holds [--json] [--scope <scope> | --all]
ensemble holds answer <hold-id> --verdict <verdict> [--note <note>]
```

`ensemble holds` lists open decision holds as prose on stdout; `--json` prints
the full records as JSON instead. Without options it shows the inherited
scope's holds (`ENSEMBLE_HOLD_SCOPE`), or every scope when none is set.
`--scope` names a scope explicitly, and `--all` shows every scope, including
the default shared one.

`ensemble holds answer` answers one open hold: it copies the hold's nonce,
writes the decision file safely, records the answerer
(`ENSEMBLE_CALLER_IDENTITY`, or `host:pid`), and watches the hold for a few of
the raiser's poll intervals. It prints one JSON object on stdout and exits:

| Exit code | Meaning |
|---|---|
| 0 | The answer was consumed: the answer file and the hold both disappeared, which normally means the run accepted the answer and resumed |
| 3 | The answer bounced; the output includes the rejection reason, and the hold keeps waiting |
| 4 | The raiser has not read the answer yet; the answer file stays in place |
| 5 | No open hold has that id |
| 6 | The hold settled without judging this answer; the stale decision file is removed |

See [Holds](workflow-scripts.md#holds) for how holds are raised, scoped, and
answered by hand.

## Output

Workflow and single-agent runs print their result as JSON on stdout, whatever
its type. A schema agent's object prints as a JSON object. A plain-text answer
prints as a JSON string with enclosing double quotes, so `jq -r .` recovers the
original text:

```sh
$ ensemble agent --engine codex --model gpt-6-luna 'Say hello in one sentence.'
"Hello!"
```

A script with no `return` prints `null`. The return value, and any arguments
passed to `workflow()`, must be JSON values: a function, a symbol, a cycle, or
a BigInt fails the run with the offending path named (one line, exit 1). JSON's
own mappings still apply — `undefined` properties vanish, and `Infinity` (from
`budget.remaining()` on an unbounded engine) prints as `null`. A `toJSON`
method is honoured, but a return value that can be structured-cloned is cloned
first, which drops a `toJSON` defined on a class prototype; return plain
data.

Logs and diagnostics go to stderr. These lines are written there:

- `[sentinel] will write <path> when the run ends` — where the completion
  sentinel will appear (see [Run records](run-records.md#completion-sentinel)).
- `[run-record-archive] {"run_id":…,"archive_path":…}` — the run's archive,
  when recording is enabled.
- `[<engine>] agent <id> (<label>) failed after N attempts — <cause>` — a
  workflow worker that failed, with its cause. A single `ensemble agent` run
  reports its failure in its own final diagnostic instead. When a fallback chain was used, the line
  reads `failed after N attempts across M chain targets — the last target's
  failure: <cause>`.
- `[<engine>] agent <id> (<label>) answered by fallback entry <n> …` — a
  fallback entry answered for a refused target.
- `[<engine>] agent <id> (<label>) fallback chain not consulted — …` — a
  failure the classifier did not recognise, so the declared chain was not used.
- `[teardown] …` — the script returned while a worker it started was still
  running, or tried to end the process after returning.

### Partial results

A run that ends without its script returning — the script threw, the
`--timeout` expired, or SIGINT or SIGTERM stopped it — prints a partial-result
envelope instead:

```json
{"partial":true,"reason":"failed","error":{"kind":"…","message":"…"},"completed":[…]}
```

`reason` is `failed`, `timed-out`, or `interrupted`. `completed` holds the
output of every worker that finished successfully, and `error` is the same
`{ kind, message }` the run record and sentinel carry for what ended the run.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success: the script returned or the single agent answered (the result is on stdout), or a listing, `--help`, or `--version` completed |
| 1 | The run failed or timed out, or Node is too old. stdout carries the partial-result envelope — or the already printed result, when the failure came after the script returned |
| 2 | Rejected invocation: a usage error, an unreadable script path, or an `agent --cwd` that is not an existing directory |
| 130 | Interrupted by SIGINT (partial-result envelope on stdout) |
| 143 | Interrupted by SIGTERM (partial-result envelope on stdout) |

An invocation is rejected before any run begins, so exit 2 leaves nothing
behind: a one-line diagnostic (or the usage text) on stderr, nothing on stdout,
no sentinel, and no archive. Every later ending is a run ending, reported
through stdout, the sentinel, and the archive when recording is on. The exit
code is recorded in the manifest, `result.json`, and the sentinel; an uncaught
exception that lands while the archive is being sealed is reflected only in
the sentinel and the process's exit code.

## How a run ends

The launcher exits once its own work is done — the result or envelope printed,
the record sealed, the sentinel written, the workers stopped — even if the
script left timers or handles pending. A forgotten `setTimeout` does not hold
your shell open.

- **Signals.** The first SIGINT or SIGTERM while the script is running (or
  about to start) marks the run interrupted, and the launcher then ends it
  once, fully recorded. A second signal during that shutdown is absorbed;
  SIGKILL remains the way to end the process sooner, at the cost of the
  sentinel. A signal that arrives after the script has returned changes
  nothing: the printed result stands and the run ends `complete`.
- **`process.exit` in a script.** The script runs in the launcher's own
  process, so a `process.exit` call — direct, or from a timer or callback — is
  intercepted: the run ends `failed` with `WorkflowProcessExitError` naming the
  requested code, and exits 1. A script that catches the interception keeps
  running into a closing runtime; its later calls fail and its return value is
  discarded.
- **Uncaught exceptions.** An exception nothing catches while the run is live
  ends it as `failed` with `WorkflowUncaughtExceptionError`.
- **After `return`.** The script is finished the moment its own promise
  settles. A `process.exit` after that is ignored, with a `[teardown]` line
  saying the result stands. An uncaught exception after that means the run did
  not end cleanly: the printed result stands, but the sentinel and the exit
  code report `failed`. An exception that lands while the sentinel itself is
  being written is not reported.
- **Unawaited workers.** A script that returns while a worker it started is
  still running has ended its run. A worker already dispatched is stopped
  unless it finishes first; a stopped worker's record reads `interrupted` with
  a `run-interrupted` cause (counted `cut_short` in the sentinel), and one
  whose dispatch was still being recorded is `abandoned` (counted
  `unsettled`). Both records say the script returned
  without awaiting the worker, and the launcher prints one `[teardown]` line
  per such worker.
- **`--timeout`.** The whole-run deadline fires from a timer, so it can only
  end the run while the script is waiting on the event loop. It cannot
  interrupt synchronous code: a script spinning in a synchronous loop can only
  be stopped by killing the process.
