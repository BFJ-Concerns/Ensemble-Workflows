# Running, watching and reading a run

How to start a run that takes a long time, how to tell whether it is stuck,
what a stopped run leaves to recover, and which files and fields explain
what happened.

A run leaves three kinds of file:

| File | Lifetime | Use |
|---|---|---|
| Live status file | While the run is active | See what the run is doing now |
| Completion sentinel | Permanent | Learn that the run ended, and how |
| Archive (the durable run record) | Permanent; on by default | Explain or audit the run afterwards |

## Starting a long run

A run you expect to finish inside your tool's command deadline runs in the
foreground:

```sh
node <launcher> review.js src/parser.ts > result.json 2> run.log
```

One that may outlast that deadline is started in the background, with the
same two redirections. Use whatever your tool offers for a command that
keeps running and reports when it exits, and let the exit be what wakes
you. Where the tool offers nothing of the kind, detach the command from the
shell and watch for the completion sentinel instead.

The run's stderr file opens with three lines that locate everything else:

```text
[sentinel] will write <path> when the run ends
[status-file] {"run_id":"…","status_path":"…"}
[run-record-archive] {"run_id":"…","archive_path":"…"}
```

A healthy run needs nothing from you until it ends. Do not poll its log or
set recurring wake-ups. Keep one fallback check, set well past the run's
expected length, for the case the exit never reports: a worker that is
wedged, or a launcher that was killed outright.

## The completion sentinel

`completion-sentinel.json`, at the path the `[sentinel]` line named. The
launcher writes it on every ending it can handle: success, failure, the
whole-run deadline, an interrupt, an uncaught exception. It is written even
with archiving turned off.

| Field | Holds |
|---|---|
| `outcome`, `exit_code`, `ended_at` | How and when the run ended |
| `error` | The `{ kind, message }` that ended the run, or `null` |
| `teardown_error` | Why the run could not end cleanly, or `null` |
| `workers` | `{ done, failed, cut_short, unsettled }`: workers that succeeded, that failed on their own account, that the run's ending stopped, and that left no observed outcome |
| `manifest` | The sealed archive manifest's digest, or the reason there is none |

`outcome: "complete"` with `workers.failed` above zero is a script that
handled its failures and returned. Whether the result is whole is then for
the result's own counts to say.

A kill the launcher cannot handle (SIGKILL) leaves no sentinel. Where the
launcher cannot create the sentinel's directory, it either rejects the
invocation or prints `[sentinel] no sentinel will be written for this run`
in place of the path, so wait only on a path that was announced.

## Is the run stuck?

Look only when the fallback check fires or something else gives a reason.
Read the live status file at `status_path`: one JSON object, rewritten as
the run advances and removed when it ends. Read its `schema` number first;
a different number from the one a tool was written for means a different
shape.

| Field | Holds |
|---|---|
| `state`, `currentPhase`, `updatedAt` | Whether the run is running, the current phase, and when the file was last written (epoch milliseconds) |
| `totals`, `engines.<engine>` | Counts of workers that are active, queued, done, failed, cut short and unsettled; per engine, also `spent`, `cap`, `ceiling` and `remaining` |
| `agents[]` | Every worker: `id`, `label`, `phase`, `engine`, `state`, `attempt`, the requested and served model and effort, `spent`, `startedAtMs`, `firstEvidenceAtMs`, `lastEvidenceAtMs`, `waitingOn`, `failure`, `transcript`, `worktree` |
| `holds[]` | Open decision holds, with their `id`, `content` and `verdicts` |
| `owner` | The publishing process's host, pid and start time |

What the worker entries show:

- **`state: "queued"` with `waitingOn.kind: "admission"`:** waiting for a
  slot under its engine's cap or the agent ceiling. Not stuck.
- **A non-empty `holds`:** the run is waiting for a decision. Answer the
  hold or put it to whoever should
  ([sessions-and-holds.md](sessions-and-holds.md)).
- **`waitingOn.kind: "background-task"`:** the worker's session started a
  long task and is waiting for it; the entry carries the task's description
  and when the wait began. A build or test run looks like this for as long
  as it takes.
- **`state: "running"` with `firstEvidenceAtMs` still `null` long after
  `startedAtMs`:** the worker has produced nothing at all.
- **An old `lastEvidenceAtMs`:** no output for that long. On `claude` this
  alone proves little, because evidence there advances once per completed
  message, not as text streams.

The file itself can be a leftover. If its `owner` process is gone, the run
was killed and the file describes nothing live. Where the owner cannot be
judged, a file whose `updatedAt` is more than 30 seconds old is stale: a
quiet live run refreshes it every 10 seconds. A missing file does not prove
that nothing is running, since publication can be turned off.

To stop a stuck run, send the launcher SIGINT. Every worker is cancelled,
the partial-result envelope is printed, and the sentinel and archive are
written.

## Recovering what a stopped run finished

- **The stdout file** holds the partial-result envelope. Its `completed`
  array carries the output of each worker that finished, with its `label`
  and `phase`. The script's own result was never produced.
- **Kept worktrees** survive the run. Each is reported on stderr in a
  `[worktree]` line with its path and branch, and sits in the
  `<repo>.ensemble-workflows-worktrees/` directory beside the repository;
  see *Placement* in [engines.md](engines.md).
- **The archive** has every dispatched worker's prompt, attempts and
  output, the unfinished ones included.

A run is never resumed. To continue, write the next run to start from what
the first one finished, and pass that in as `args`.

## The archive

Every run is archived by default, at the `archive_path` announced at
startup: `runs/cwd/<namespace>/<run-uuid>/` under the data home,
`$XDG_DATA_HOME/ensemble/` (normally `~/.local/share/ensemble/`). It is
written as the run goes, so a run that died still leaves a usable partial
archive.

| File | Holds |
|---|---|
| `manifest.json` | The run: status, error, settings in force, tallies, events, cost roll-up, integrity table |
| `result.json` | The outcome: `status`, `exit_code`, `error`, and `value`, which is the return value or the partial-result envelope |
| `workflow.js`, `args.json` | The script as it ran, and its arguments |
| `agents/<id>/agent.json` | One record for each worker, written at dispatch and completed as it finishes |
| `agents/<id>/` transcripts | Each attempt's full transcript, copied in |

In `manifest.json`, to answer questions about the run as a whole:

| Question | Fields |
|---|---|
| How did it end? | `status`, `error`. `status` is `in-progress`, `complete`, `failed`, `timed-out`, `interrupted`, `incomplete` (archived files were missing at the end) or `abandoned` (a later run found this one's process dead) |
| What did the script count? | `tallies` |
| Where did dispatches go? | `dispatch_remap`, `dispatch_remap_unmatched`, `named_targets`, `machine_fallback`, `single_family` |
| What limits applied? | `concurrency`, `budget_ceilings` and `run_timeout_ms`, each with the layer that set it; `effort`, the machine's bounds |
| What was decided, and by whom? | `hold_events` |
| Was a session lost? | `session_events` |
| What did it cost? | `cost_rollup`: usage per engine and per served model, never summed across engines |

A manifest still reading `in-progress` may belong to a dead run. Its
`owner` block names the writing process; when that process is gone, read
the run as abandoned.

In an agent record, to explain one worker:

| Question | Fields |
|---|---|
| What was it asked? | `prompt`, `schema`, `label`, `phase`, `resolved_cwd` |
| Where was it meant to run, and where did it? | `engine`, `model`, `effort`; `named_target`, `remap`; `resolved_model`, `resolved_effort`; `answered_by` |
| How did it end? | `status`, `termination_cause` |
| What happened on each attempt? | `attempts[]`: each has its `target`, `failure` (`{ kind, message }`), `classification` (`{ class, rule }`), `chain_decision`, and `raw_output` |
| Why did the fallback chain move, or not? | `fallback`, `fallback_source`, and each attempt's `chain_decision`: `advanced`, `retried-in-place`, `exhausted` or `chain-not-consulted` |
| What did it say? | `raw_output`, `validated_output`, `transcripts` |
| What did it use? | `usage` |
| Where is its work? | `worktree` |
| Which turn of which session? | `session` |

A `classification` whose `rule` is `null` is a diagnostic that the runtime
did not recognise. The raw text is in `failure`.

The archive is unredacted. It is also self-attesting and unsigned: its
digests catch a truncated or edited file, not a deliberate forgery, and a
tool that walks its `files` table should refuse absolute paths and `..`
entries.
