# Run records and live status

A run can leave three kinds of file behind or alongside it:

| Artefact | Lifetime | Purpose |
|---|---|---|
| Live status file (`ensemble.<run-uuid>.local.json`) | While the run is active; removed when it ends | Watch what a run is doing right now |
| Completion sentinel (`completion-sentinel.json`) | Permanent | Learn that a run has ended, and how |
| Durable run record (the archive) | Permanent; on by default | Audit or evaluate a run after the fact |

The live status file defaults to an automatically created status directory
in the Ensemble data home. The CLI announces the exact file path on stderr
before workflow execution.

Where these files live, and how to turn them off, is covered in
[Configuration](configuration.md).

## Live status

While a run is active it publishes a JSON snapshot of what it is doing —
current phase, per-engine counts of live workers and of finished workers by
disposition, per-engine token spend, and every queued, running and finished worker — to its own
file in the status directory. By default it creates
`$XDG_DATA_HOME/ensemble/status` (`~/.local/share/ensemble/status` by default)
and writes there, independently of the working directory and any `.claude`
entry. Explicit status directories must already exist. Writes
are atomic, so a reader never sees a half-written file.

After the first successful write and before workflow execution, the CLI prints
`[status-file] {"run_id":…, "status_path":…}` on stderr. A supervisor can
follow that path without knowing the working directory's layout or searching
the archive. Its `run_id` is the public `cwd:<namespace-hash>:<run-uuid>`
identity, identical to the archive announcement and manifest when recording is
on, and namespaced the same way when recording is off. The snapshot's `runId`
and the filename use only `<run-uuid>`.

Disable publication with `ENSEMBLE_STATUS=off`; directory
overrides and machine settings are described in [Configuration](configuration.md).

Each run has its own file, so concurrent runs sharing a status directory are each
visible for their whole lifetime: a later run never overwrites an earlier
run's view, and a run that ends removes only its own file. A file left by a
killed run stays until the next run publishing to the same status directory
starts; its startup sweep removes any file whose writer is provably dead (below).
Atomic-write temp files carry the writer's pid and process start ticks as
`<status file>.<pid>.<start-ticks>.<sequence>.tmp`, so the sweep also removes
leftovers when a pid has been reused. If start ticks cannot be read, the name
uses `unknown` and the sweep retains the file. Legacy temp names without start
ticks are removed only when their pid is absent and proc evidence is readable.

Consumers list the directory for `ensemble.*.local.json` and parse each file
directly; Ensemble provides no rendering command. A reader decides liveness by
evidence, in this order:

1. A file whose `owner` is **refuted** — same host, `start_ticks` recorded, and
   the pid either gone or running with different start ticks — is a killed
   run's leftover, not a run. The library export `snapshotOwnerGone` implements
   this rule, and the writer's startup sweep applies it too.
2. A file whose owner cannot be judged (another host, or `start_ticks: null`)
   falls back to age: treat a snapshot whose `updatedAt` is more than 30
   seconds old as stale. The writer refreshes a quiet live run every 10
   seconds.
3. Everything else is a run in flight.

A consumer with no proc filesystem to judge from applies rule 2 alone.
Per-engine spend is never summed: the engines count tokens under different
rules, and a token on one engine does not cost the same as on another.
Spend advances when usage evidence arrives, including while a worker is
running: Codex emits usage notifications, Claude is measured by transcript
polls, and opencode is measured from its streamed step events. These are
usage updates, not a token-by-token meter. Engines start at `spent: 0`, and a
worker's `spent` stays `null` until its own usage is observed. On opencode,
engine spend advances during execution while worker spend appears at
settlement. Neither an engine's zero nor a worker's `null` proves that an
active worker has consumed no tokens. Final attempt usage updates the
worker's subtotal at settlement.

### `ensemble.<run-uuid>.local.json` schema

Schema 4 finishes every worker with one of four dispositions and counts each.
Schema 3 finished workers as `done` or `failed` only, so a worker the run's
ending tore down read as failed; schema 2 contains only live workers. Consumers
must check the schema before interpreting the worker list or the counts.

Each status file contains one JSON object with these fields:

- `schema`: `4`.
- `runId`: string.
- `pid`: number, the process id of the publishing run.
- `archiveDir`: string or `null`, the run archive directory when published.
- `workflow`: string or `null`, from `meta.name` when present.
- `state`: `"running"` or `"finished"`. A finished snapshot may exist briefly
  while the writer closes; `close()` then removes the file. Readers should treat
  absence as no active run and tolerate `"finished"` during that close window.
- `startedAt`: number, Unix epoch milliseconds.
- `updatedAt`: number, Unix epoch milliseconds.
- `finishedAt`: number or `null`, Unix epoch milliseconds when the run has
  finished.
- `currentPhase`: string or `null`.
- `totals`: object with numeric `active`, `queued`, `done`, `failed`,
  `cutShort`, and `unsettled` counts.
- `engines`: object keyed by registered engine name (`codex`, `claude`, and
  `opencode`). Each entry has numeric `active`, `queued`, `done`, `failed`,
  `cutShort`, `unsettled`, and `spent`; `cap`, `ceiling`, and `remaining` are
  numbers or `null`. Spend and ceilings are per-engine and are never summed.
- `agents`: array of every worker: running first, then queued (oldest
  first within each), then finished (newest registered first). Each object has
  `id`, `attempt`, `engine` (codex, claude or opencode), `state` (queued,
  running, done, failed, cut-short or unsettled), nullable strings `label`,
  `phase`, `requestedModel`, `requestedEffort`, `resolvedModel`,
  `resolvedEffort`, `transcript`, and `worktree`; nullable numeric `spent`, `startedAtMs`, `firstEvidenceAtMs`,
  `lastEvidenceAtMs`, and `finishedAtMs`; and nullable `failure` and `waitingOn`.

Worker spend is cumulative across attempts and fallback targets; null means
unobserved, not zero. Identity and paths are producer-supplied evidence, never
inferred. Requested identity describes the original call; resolved identity
names what was served. Transcript paths match the running agent record's
current attempt: archive-relative for Codex, absolute native paths for
Claude. Resolve relative paths against archiveDir. A settled Claude record
archives a copy of the native transcript; the status entry retains its
live path.

A finished worker's state is its disposition, and each disposition has the
count of the same name (`cut-short` counts under `cutShort`):

- `done` — the worker settled on its own account, successfully.
- `failed` — the worker settled on its own account, with a failure.
- `cut-short` — the run's ending tore the worker down, whether its turn was at
  an engine or still waiting for admission. Its agent record carries the
  `run-<status>` termination cause naming the run's shutdown status.
- `unsettled` — the run ended before any outcome was observed; its agent
  record reads `abandoned`.

A worker that settles on its own account while the run is shutting down keeps
that account, `done` or `failed`. Each worker's state is published when it
settles and never changes afterwards, so the finished snapshot's counts match
the completion sentinel's worker tally (`cut_short` there, `cutShort` here).
The library export `workerDisposition` maps an agent record's status and
termination cause to its disposition.

Failure is the `{ kind, message }` account the worker's record carries, or
null when unavailable or successful. A `cut-short` or `unsettled` worker's
failure is the run's own cause, never a failure of the worker.

Finished time is the settlement observation time. All timestamps are epoch
milliseconds. First evidence stays fixed across same-target retries, while last
evidence advances on each output observation. A fallback clears both evidence
stamps, start time, served identity and transcript; spend and original requested
identity persist. Same-target retries preserve the evidence stamps and spend
and clear waitingOn. Each attempt clears its transcript reference until
publication, and a fresh worker's served identity is unknown until observed.
Queued and settled workers ignore output observations. waitingOn is null or the
background-task object described by the engine (taskId, description, sinceMs).
Every worker remains listed until the run ends; neither live nor finished
entries are evicted or omitted from the snapshot. Finished entries have
a disposition state and no outstanding wait. Repeated settlement is inert.

- `holds`: array of open decision holds, empty when the run is not waiting.
  Each object has string `id`, string `content` (cut to 500 characters plus
  an ellipsis when longer; the hold file carries the full text), string-array
  `verdicts`, and numeric `raisedAtMs` (Unix epoch milliseconds).

The published file also carries an `owner` object (`host`, `pid`,
`start_ticks`): the writer's liveness evidence, which a reader uses to refute
a snapshot that a killed run left behind.

Example:

```json
{
  "schema": 4,
  "runId": "run-01HZY7V4Q8P2",
  "pid": 43122,
  "archiveDir": null,
  "workflow": "verify-findings",
  "state": "running",
  "startedAt": 1766491200000,
  "updatedAt": 1766491214500,
  "finishedAt": null,
  "currentPhase": "Verify",
  "totals": { "active": 1, "queued": 0, "done": 12, "failed": 1, "cutShort": 0, "unsettled": 0 },
  "engines": {
    "codex": {
      "cap": 12,
      "active": 1,
      "queued": 0,
      "done": 8,
      "failed": 0,
      "cutShort": 0,
      "unsettled": 0,
      "spent": 48000,
      "ceiling": 100000,
      "remaining": 52000
    },
    "claude": {
      "cap": 12,
      "active": 0,
      "queued": 0,
      "done": 4,
      "failed": 1,
      "cutShort": 0,
      "unsettled": 0,
      "spent": 6500,
      "ceiling": null,
      "remaining": null
    },
    "opencode": {
      "cap": 2,
      "active": 0,
      "queued": 0,
      "done": 0,
      "failed": 0,
      "cutShort": 0,
      "unsettled": 0,
      "spent": 0,
      "ceiling": 20000,
      "remaining": 20000
    }
  },
  "agents": [
    {
      "id": 17,
      "engine": "codex",
      "label": "scan",
      "phase": "Verify",
      "state": "running",
      "attempt": 1,
      "startedAtMs": 1766491209000,
      "firstEvidenceAtMs": 1766491211200,
      "lastEvidenceAtMs": 1766491211200,
      "finishedAtMs": null,
      "requestedModel": null,
      "requestedEffort": null,
      "resolvedModel": null,
      "resolvedEffort": null,
      "transcript": null,
      "worktree": null,
      "spent": null,
      "failure": null,
      "waitingOn": null
    }
  ],
  "holds": [],
  "owner": {
    "host": "build-host",
    "pid": 43122,
    "start_ticks": "98765432100"
  }
}
```

## Completion sentinel

At startup the launcher prints on stderr the path of `completion-sentinel.json`
in the run's directory in the record store, and writes that file itself when
the run ends:

```text
[sentinel] will write /home/user/.local/share/ensemble/runs/cwd/<namespace>/<run-uuid>/completion-sentinel.json when the run ends
```

A supervising process can watch for that file instead of polling the run. The
path is announced only once its directory exists. With recording enabled, a
store the launching process cannot create entries in (a regular file where the
store should be, a read-only parent) rejects the invocation before the run
begins: one line naming the store, the setting it came from and the error, exit
2, nothing on stdout and no sentinel. With recording off the launcher instead
prints one `[sentinel] no sentinel will be written for this run — …` line
naming the cause and runs on without a sentinel, so a supervisor never waits on
a path that cannot be written. A store that becomes unusable after that check
fails the run with a one-line `the durable run record could not start under …`
diagnosis. A write that fails later is reported as one `[sentinel]` line.

The sentinel is written on every ending the launcher can handle — success,
failure, timeout, interruption, a partial result, a script's `process.exit`,
an uncaught exception. It is written even when durable recording is disabled:
the run directory is then created for the sentinel alone. A kill the launcher
cannot handle (SIGKILL) leaves no sentinel, so a supervisor should keep a
fallback timer behind its file watch.

The sentinel has `kind: "completion_sentinel"` and its own `schema_version`
(currently `3`), and carries:

- `outcome`, `exit_code`, and `ended_at`.
- `error`: the `{ kind, message }` that ended the run, or `null`.
- `workers`: `{ done, failed, cut_short, unsettled }`, or `null` when the
  launcher never got far enough to count any. The tally partitions the run's
  workers: `done` and `failed` count workers that settled on their own,
  including any that finished while the run was shutting down; `cut_short`
  counts the workers the run's end terminated; `unsettled` counts workers
  that were dispatched but never produced an observable outcome. With recording enabled, each worker's agent
  record says the same thing as the tally. With recording disabled, the tally
  is the run's only record of worker outcomes.
- `manifest`: the sealed manifest's digest (`{ sha256 }`), or
  `{ unavailable }` naming why there is none — `recording-disabled`,
  `recording-start-failed`, or `manifest-unsealed` (the archive could not be
  finished). The sentinel never vouches for a manifest that a failed seal
  might still rewrite.
- `integrity.sentinel_sha256`: the sentinel's own digest, computed by the same
  recipe as the manifest's (below).

A teardown that fails after a clean script body is a failed ending — workers
may be left alive or the archive unsealed — so the sentinel reports
`outcome: "failed"` with the teardown error, and the process exits non-zero.

## Durable run record

By default every run writes a permanent archive of what happened. It is
separate from the live status file: the status file is removed when the run
ends, while the archive is kept for audit and for tools that evaluate runs
afterwards.

Archives are stored under:

```text
$STORE/runs/cwd/<namespace-hash>/<run-uuid>/
```

`<namespace-hash>` is the first 24 hex characters of the namespace's SHA-256
(below). `$STORE` is the data home: `$XDG_DATA_HOME/ensemble/`, or
`~/.local/share/ensemble/` when `XDG_DATA_HOME` is unset. See
[Configuration](configuration.md#run-record-and-status-locations) to relocate
or disable it.

When recording is enabled, startup prints one line that a tracker can parse to
find the archive the process has just created:

```text
[run-record-archive] {"run_id":"cwd:…","archive_path":"…"}
```

A failure to print the announcement does not fail the run.

### Run identity

The public `run_id` is `cwd:<namespace-hash>:<run-uuid>`, matching the
archive path. The
namespace is derived from `realpath(git root)` when the run's working
directory is inside a git repository, and from `realpath(cwd)` otherwise, so
one machine-level store can hold runs from many projects. The namespace is
distinct from `meta.task`: the namespace says where a run came from, while
`meta.task` is an opaque grouping key copied verbatim from the workflow's
`meta` block, for grouping benchmark runs.

### How the archive is written

The archive is written incrementally. `manifest.json` starts as
`status: "in-progress"`, each finished agent writes its own directory with
atomic temp-then-rename writes, and the final manifest records `complete`,
`failed`, `timed-out`, `interrupted`, or `incomplete`. A stopped run therefore
leaves a usable partial archive.

When the archive is sealed, the writer checks that every file in its
integrity table still exists with the size that was hashed. A file that has
gone missing, or whose size no longer matches, is listed in
`integrity.files_lost`, and a run that would otherwise
have sealed `complete` seals `incomplete` instead. The run's own outcome is
unaffected: `result.json` still says how the run ended, because how the run
ended and whether its archive survived are separate questions.

### Integrity

Every manifest write ends with a self-digest: `integrity.manifest_sha256` is
the SHA-256 of the manifest's canonical form with that field set to `null`.
The canonical form is ECMA-262 `JSON.stringify` with a two-space indent and no
trailing newline, and keys sorted recursively by UTF-16 code unit
(locale-independent; integer-index keys come first in numeric order, as
ECMA-262 property enumeration places them). The rule itself is stored in the
archive as `integrity.recipe`, so a reader can verify the archive without this
codebase.

The completion sentinel carries the same kind of self-digest and, being written
after the seal, also the sealed manifest's digest, so the manifest can be
checked against a second file. Both are self-attestations, not signatures: no
key material is involved, so they catch an edited field or a truncated write,
not a forger who rewrites the digest too.

Treat the `files` table as untrusted input when walking it: refuse absolute
paths, `..` traversal, and symlinked entries. The archive attests its own
bytes, never bytes that a crafted entry points to elsewhere.

### Runs that die

A run killed by a signal it cannot handle never writes its own terminal
status, so the manifest carries liveness evidence instead of relying on age:
an `owner` block (`pid`, `/proc` start ticks, and hostname) written once at
start. A reader decides liveness from it, in this order:

1. A terminal `status` is settled.
2. An `in-progress` manifest whose `owner.host` is this host, whose
   `owner.start_ticks` is recorded, and whose `owner.pid` is either absent from
   the process table or running with different start ticks (field 22 of
   `/proc/<pid>/stat`) is a **dead run**: read it as abandoned, whatever its
   status says.
3. One whose pid is running with matching start ticks is live.
4. Everything else — another host, `start_ticks: null`, no readable proc
   filesystem on the reader's side — is undecidable, never assumed live or
   dead.

The next run that starts in the same namespace applies the same rule and
rewrites a provably dead run's manifest to `status: "abandoned"`, with an
`abandonment` block saying what was observed, when, and by which run. It also
flips that run's agent records that are still `in-progress` to `"abandoned"`
with the same block, and reconciles each from what its writer persisted
before the death:

- The attempt the writer died with, read from `current_attempt`, joins
  `attempts` as an entry with status `"abandoned"` (see
  [Agent records](#agent-records)), and `current_attempt` is removed.
- The record's `resolved_model` and `resolved_effort` take that attempt's
  served identity where the engine had reported one.
- That attempt's partial transcript is linked in `transcripts` with
  `partial: true`. A Codex transcript is already in the archive and its
  files-table entry is re-measured; a Claude transcript is copied into the
  archive when it is still readable. `transcripts_unavailable` names a reason
  only when no transcript is linked.
- `cost_rollup` is recomputed from the reconciled records, so the abandoned
  attempt is booked under the model that served it and marks its leaf
  incomplete.

Nothing else is inferred. `usage` keeps the account recorded before the
death — `record-unsettled` where no attempt had recorded usage, because the
attempt in flight and its spend are unobserved, never zero — and so do
`termination_cause` and the timings. An agent record that the run's own close
abandons (one still being dispatched when the run ended) says
`no-attempt-ran` instead, because its writer knows no attempt began. Settled
agent records are never rewritten. A dead run whose records carry an earlier
`schema_version` keeps that version's sweep: its records' status is flipped,
`current_attempt` is removed, and its roll-up stands as written.

## Run record schema

Every record document — the JSON files described below, as opposed to the
archived workflow source, canonical arguments, transcripts, and diffs —
carries:

- `schema_version`: currently `5`. A reader built for an earlier version should not read a version-5 record as one: version 5 lists an abandoned attempt in `attempts` and marks each `cost_rollup` leaf complete or not.
- `kind`: one of `run_manifest`, `run_args`, `workflow_args`, `run_result`, or
  `agent_record`.

The completion sentinel and the live status file are separate artefact
families with their own schema versions (`3` and `3`), described above.

### Manifest

`manifest.json` has these top-level fields:

- `schema_version`: `5`.
- `kind`: `"run_manifest"`.
- `run_id`: namespaced run id.
- `run_uuid`: the runtime UUID before namespacing.
- `caller_identity`: opaque identity of the invoking session, or `null`.
- `namespace`: namespace strategy, id, hash, and local material.
- `status`: `"in-progress"`, `"complete"`, `"failed"`, `"timed-out"`,
  `"interrupted"`, `"incomplete"` (the run ended but files it archived were
  gone at the seal), or `"abandoned"` (written only by another run's sweep).
- `owner`: the writing process's liveness evidence — `pid`, `start_ticks`
  (`null` where no readable proc filesystem exists), and `host`.
- `abandonment`: present only on abandoned manifests — `observed_at`, `reason`
  (`"owner-process-gone"`, or `"manifest-predates-owner-recording"` for a
  manifest with no `owner` block), and `observed_by`.
- `started_at` / `ended_at`: ISO timestamps; `ended_at` is `null` until final.
- `workflow`: original path, archived `workflow.js`, and SHA-256.
- `args`: the descriptive `args.json` envelope, the separately archived
  `canonical_archive_path` containing the exact canonical args JSON text, and
  its SHA-256. Recompute `args.sha256` from that canonical file; it is not the
  hash of the envelope.
- `meta`: `{ raw, task }` — the workflow's `meta` export and its `task`,
  copied verbatim; each is `null` when absent.
- `cli_flags`: parsed run-tuning flags.
- `worker_scope`: effective systemd grouping as `{ value, layer }`, where value is
  `worker` or `run` and layer is `flag`, `env`, `config-file` or `default`.
  `cli_flags.workerScope` records an explicitly supplied grouping flag. Earlier
  version-4 manifests may omit `worker_scope`; its absence carries no grouping
  provenance.
- `concurrency`: the effective agent ceiling and per-engine caps —
  `agent_ceiling` as `Resolved<number | null>`, `engines` as a partial map of
  engine name to `Resolved<number>` — each recording the value and the layer
  that supplied it (`flag`, `env`, `config-file`, or `default`). There is no
  separate top-level agent ceiling.
- `budget_ceilings` / `run_timeout_ms`: the effective per-engine token
  ceilings and whole-run timeout, each as `{ value, layer }`. Both are set by
  flag only, so their layers are `flag` or `default`.
- `workflow_invocations`: the root workflow and every child it invoked through
  `workflow()`, in the order they were recorded — call order, except that
  concurrent `workflow()` calls are recorded as each one resolves. Each entry carries an ordinal (0 for the root),
  a parent link (`null` for the root, the invoking entry's ordinal for a
  child), the original path, the archived source with its SHA-256, and the
  archived args with their canonical path and SHA-256. Each entry is recorded
  before the child runs, so a partial archive still knows what was invoked.
- `hold_events`: the run's hold lifecycle — raise, accepted answer, rejected
  answer, timeout, and retirements of dead raisers this run observed — in
  event order. Each entry carries `hold_id`, `event`, `verdict` or `reason`
  where applicable, and a timestamp. Both `answered` and `answer-rejected`
  entries carry `answered_by` (the answerer the decision file named, or
  `null` when absent or unreadable). An `answered` entry also carries the
  decider's `note` (or `null`).
- `tallies`: `name -> number`, the counts the script recorded with `tally()`,
  stored verbatim (last write per name wins) and written as each is recorded,
  so a count recorded before the run ended is in the archive whether or not
  the run finished cleanly. `tallies_unavailable` is `"none-recorded"` while
  the map is empty and `null` once the script records a count, including zero.
- `git`: start and end HEAD, dirty flag, and the archived diff's path when
  tracked files differ (`null` when only untracked files do); all `null`
  outside a git repository.
- `environment`: OS architecture, platform and release, Node version, and the
  versions of `claude`, `codex`, `git`, and `opencode` where available.
- `harness`: package name, version, and the git commit of the Ensemble
  checkout. `commit_unavailable` is `null` when the commit is known; a
  launcher copied outside an Ensemble checkout carries
  `"bundle-has-no-embedded-commit"`, and a checkout whose HEAD cannot be read
  carries `"git-head-unavailable"`. The
  workflow's own repository is never substituted for the Ensemble checkout.
- `result`: archived `result.json` path and exit code once final.
- `error`: the `{ kind, message }` of whatever ended the run — a script fault,
  an unknown engine, a budget refusal, a whole-run timeout — or `null` when the
  run ended cleanly. Present on both the manifest and `result.json`. A budget
  refusal at a ceiling of 0 reads `Token budget for <engine> is 0, which admits
  no dispatch; refused <admission>`; a spent ceiling reads `Token budget
  exhausted for <engine>: spent N of M tokens; refused <admission>`. The
  admission names a dispatch, a fallback dispatch with its agent id, or a
  numbered session turn, starting at `session turn 1` for the first `send()`
  even before the worker opens. A refused send does not advance that number;
  refusing it does not imply earlier work never ran.
- `cost_rollup`: `engine -> model -> usage`, never a cross-engine total. See
  [Token usage and cost](#token-usage-and-cost).
- `files`: integrity table for archived artefacts, each with `path`, `size`,
  and `sha256`. `manifest.json` is excluded; it carries its own digest instead.
- `integrity`: `algorithm` (`"sha256"`), `recipe` (the digest rule, stated in
  the archive itself), `manifest_sha256` (the manifest's own digest), and
  `files_lost` — one `{ path, reason }` entry, sorted by path, for each
  declared file that was `missing` or a `size-mismatch` at the seal. Empty on
  a whole archive.

### Argument records

The root's `args.json` and each composed child's
`workflows/<zero-padded-ordinal>/args.json` are descriptive envelopes:

| Field | Root (`run_args`) | Child (`workflow_args`) |
|---|---|---|
| `schema_version` | `4` | `4` |
| `kind` | `"run_args"` | `"workflow_args"` |
| `value` | For a workflow, a positional string array or the JSON value supplied with `--json-args`; for a direct `agent` invocation, `{ prompt, options }` with the prompt string and parsed agent options | The JSON value passed as the child's arguments to `workflow()` |

Each envelope has a separate `args.canonical.json` alongside it. Hash that
file's exact UTF-8 bytes to check the corresponding manifest entry's
`args.sha256`; hashing the envelope includes its metadata and gives a
different digest. The canonical file contains the arguments alone, using the
canonical JSON recipe under [Integrity](#integrity), with no trailing newline.

### Result record

`result.json` is written when the run ends through a path the launcher can
handle. A run killed before it seals can have no result file. Its fields are:

| Field | Meaning |
|---|---|
| `schema_version` | `4` |
| `kind` | `"run_result"` |
| `status` | `"complete"`, `"failed"`, `"timed-out"`, or `"interrupted"`: the run's outcome, independent of the archive's integrity |
| `exit_code` | Numeric process exit code: normally `0` on success, `1` on failure or timeout, `130` on SIGINT, or `143` on SIGTERM |
| `error` | `{ kind, message }` naming the terminal error, or `null` when the run ended cleanly |
| `value` | The serialised workflow return value (or direct agent result) on success; a partial-result envelope when the body fails, times out or is interrupted |

A partial-result envelope has `partial: true`, `reason` (`"failed"`,
`"timed-out"`, or `"interrupted"`), `error` (`{ kind, message }`), and
`completed`: an array of `{ id, engine, label, phase, output }` for workers
that finished successfully, in completion order. `label` and `phase` can be
`null`; `output` is the worker's validated value or text. The script's
unfinished return value cannot be recovered from this envelope. A teardown
failure after a successful body can leave that body's value in `value` while
`status`, `exit_code` and `error` report the teardown failure. Use those
fields to determine the outcome.

### Agent records

Each agent's record is at `agents/<zero-padded-id>/agent.json`:

While an attempt executes, on any engine, the record also has
`current_attempt`, an object with:

- `attempt`: its number.
- `started_at`: the ISO start time, written before the engine is invoked.
- `target`: `{ engine, model }`, the target dispatched to, as on a settled
  attempt.
- `transcript`: a path once a readable file exists, otherwise `null`.
  opencode has no live transcript, so its value stays `null`.
- `resolved_model` and `resolved_effort`: the served identity the engine has
  reported for this attempt so far, written as it is reported, and `null`
  until then. A held session's attempts start with the identity its worker
  already served, including retries of its first turn. A fresh worker or
  fallback target starts at `null`.

A worker waiting for admission has no `current_attempt`, including while a
fallback target waits for a slot. The field remains present between retries
and while the outcome is being archived, until the next attempt replaces it
or the settled record removes it. It is cleared when a fallback target
re-enters the admission queue. While a record is `in-progress`, `attempts`
lists settled attempts only. The running attempt is `current_attempt`.

Claude's live path is absolute and points to the session's own JSONL file
under `~/.claude/projects/`. A held session uses that same file across its
turns, so the live file includes the conversation. Codex's live path is
relative to the run's archive directory and belongs to that agent and
attempt. Each captured app-server event is appended as it arrives. The
same path appears in `transcripts` at settlement, with its final size and
digest in the manifest's files table. A failed live write is reported as
`runRecord/writeFailed`; settlement repairs an incomplete Codex file from
the engine's captured transcript when that capture is available.

Readers should reopen the atomically replaced `agent.json` as they poll.
Live transcripts grow independently of the record and can end with a
partially written JSONL line during a read. File sizes and hashes in a
live manifest describe the writer's last published snapshot, so read the
settled manifest to verify final transcript integrity.

The fields present throughout a record's lifetime are:

- `schema_version`: `5`.
- `kind`: `"agent_record"`.
- `id`, `creation_order`, and `concurrency_group` (the engine group of the
  last target admitted: initially the requested engine, and the answering
  engine's group when a fallback answers).
- `header_identity`: `"original_request"`, stating that the top-level
  `engine`, `model`, and `effort` fields describe the request. The field
  joined the record within schema version 4, so a version-4 agent record
  from an older Ensemble checkout can lack it; read a missing
  `header_identity` as `"original_request"`, because those fields describe
  the request in such records too.
- `engine`, `model`, `effort`: what was asked for (`effort` as the canonical
  level).
- `resolved_model` / `resolved_effort`: what was actually served, as the
  engine reported it — Codex's `thread/start` answer, or the `model` and
  `effort` fields Claude Code writes on each assistant transcript entry —
  and `null` when the engine reported none, never an echo of the request.
  opencode reports no served identity, so its `resolved_model` is the
  configured `provider_model` the worker was launched with.
- `fallback`: the fallback chain in force for this record
  (`[{ engine, model, effort? }]`), or `null` when none applies.
- `fallback_source`: where `fallback` came from, as an object whose `kind`
  names the source:
  - `{ "kind": "call" }`: the call's own `fallback` option.
  - `{ "kind": "defaults", "engine": "<engine>" }`: the script's `defaults`
    block for that engine, which the call left to supply the chain.
  - `{ "kind": "none" }`: neither the call nor its `defaults` block declared
    a chain. A direct library call has no `defaults`, so its chain reads
    `call` or `none`.
  - `{ "kind": "later-turn" }`: the second or later turn of a multi-turn
    session. A session's chain applies to its creating turn alone, so
    `fallback` is `null` here; the creating turn's record (the same
    `session.id`, `turn` 1) carries the session's chain and its source.

  `none` and `later-turn` both pair with a `null` chain and are not
  interchangeable: one says nothing was declared, the other that the
  session's chain no longer applies. A reader that meets an unknown `kind`
  should treat the chain's source as unrecorded. The field joined the agent
  record within its schema version, so an agent record from an older
  Ensemble checkout can lack it; read a missing `fallback_source` as
  unrecorded, never as `none`.
- `answered_by`: which target answered — `{ entry, engine, model }`, where
  `entry` is `-1` for the call's own target and the chain index after that,
  and `model` is the answering attempt's served model (`null` if unreported) —
  or `null` while no attempt has completed. Read with each attempt's `target`,
  it shows when a call meant for one engine was answered by another.
- `prompt`: the agent's prompt text.
- `options`: `{ timeout_ms, max_attempts }`.
- `resolved_cwd`, `isolation` (`null` when unused).
- `worktree`: the isolated worktree's `branch`, `base_commit`, `tip_commit`,
  `changed`, and `removed` — or `null`.
- `phase`: the explicit agent/session option, or the current run phase set by
  `phase(title)` when the agent or session turn queues; `null` if neither is
  set. Later phase changes do not alter an existing agent record.
- `label` and `status`. Status is `"in-progress"`, `"complete"`,
  `"failed"`, `"timed-out"`, `"interrupted"`, or `"abandoned"`. `"abandoned"`
  means no outcome was observed: either the run's own close ended while the
  dispatch record was still being written, or another run's sweep found the
  record left `"in-progress"` by a killed run (with an `abandonment` block).
- `termination_cause`: the `{ kind, message }` that settled the agent at that
  status when the runtime decided it — a run that ended under the worker, or a
  deadline the runtime enforced — and `null` when the attempts already name the
  cause. An unsettled dispatch record carries `"record-unsettled"`: the writer has not yet observed an outcome, and a reaped record retains that account. A close failure after a completed attempt carries the close error here. Two deadline kinds are distinguished: `"turn-timeout"` (the per-agent
  turn deadline expired while the worker was still going) and
  `"request-timeout"` (a transport request deadline expired because the engine
  never answered a request). The first means a slow worker; the second, an
  unresponsive engine.
- `schema`: the requested JSON Schema, or `null`.
- `strip`: requested capability names and how each was enforced.
- `session`: the held session's run-scoped id and this record's turn number,
  or `null` for a one-shot call.
- `transcript_capture`: what the engine's capture path observed for this turn —
  `"retained"`, `"lost"`, or `null` when the engine does not report capture.
- `parse_route`: how a schema agent's value was found — `"direct"`,
  `"object-fallback"`, `"array-fallback"`, `"scalar-line"` (a line holding
  nothing but one JSON scalar, the shape a fenced or prose-wrapped `null`,
  `false`, `0`, or `""` takes), or `null` until a valid value is selected.
- `decode_failure`: `{ byte_length, line_prefix }` or `null`.
- `raw_output`: final raw model text, or the latest raw failed output. `null`
  means no output was produced; `""` means the worker answered with empty
  text. Attempt records use the same convention.
- `validated_output`: the validated object or text, or `null` on failure.
- `usage`: `{ summary }` holding a usage summary (see below), or
  `{ unavailable }` with a reason: `"record-unsettled"` (the writer never settled the record — it is
  `in-progress`, or was abandoned after its run was killed — so the attempt
  in flight and its spend are unobserved), `"no-attempt-ran"`,
  `"substrate-never-started"` (every attempt was refused before a worker
  existed), `"worker-interrupted"` or `"worker-timed-out"` (the run cut the
  worker short before usage was reported), or `"engine-reported-no-usage"`
  (a settled worker supplied no usage). Any usage the engine did report,
  including zero tokens, is retained as a summary instead of an absence reason.
- `queued_ms`, `execution_ms`: time spent waiting for admission and time
  spent executing. `null` on an unsettled record means the interval has not
  been measured; it does not claim zero time. Runtime abandonment and a reap
  preserve those unknown intervals.
- `attempts`: the attempts that have settled and, on an `abandoned` record
  reaped by the sweep, the attempt its writer died with. The attempt running
  on an `in-progress` record is `current_attempt`, not an entry here. An empty
  array on an `in-progress` record, or on an `abandoned` record whose writer
  died before any attempt started, means none was observed, not "none ran".
  Each entry has:
  - `attempt`: 1-based, numbering every dispatch the call made, refused ones
    included.
  - `status`: `"complete"`, `"failed"`, or `"abandoned"`. An abandoned entry
    is one whose outcome was never observed. It keeps the evidence persisted
    while it ran: `attempt`, `target`, `started_at`, `resolved_model` and
    `resolved_effort`. Every outcome field — `ended_at`, `duration_ms`,
    `first_delta_ms`, `raw_output`, `validated_output`, `failure`,
    `classification`, `chain_decision`, `observed_failure`, `worker_exit`,
    `app_server_diagnostic` — is `null`, which here means unobserved, not
    "no output" or "no failure". `token_usage_events` and `background_waits`
    are empty, and `diagnostics` is `{}`, because nothing from the running
    attempt is persisted beyond the evidence above. Its partial transcript,
    where one was captured, is in `transcripts`.
  - `target` (`{ engine, model }`: the engine and requested model this
    attempt was dispatched to — the call's own until a fallback chain
    advances).
  - `started_at`, `ended_at`, `duration_ms` (the engine's own measurement
    where it reports one, otherwise the attempt's recorded endpoints, so a
    settled attempt never has a `null` duration), and `first_delta_ms`.
  - `raw_output`, `validated_output`, `resolved_model` (including a held
    session's observed model on later turns), and `resolved_effort`.
  - `failure`: `{ kind, message }` or `null`.
  - `classification` and `chain_decision` (below).
  - `observed_failure`: when the run's own ending ended the turn, `failure`
    names that ending (`run-interrupted`, `run-timed-out`) and
    `observed_failure` keeps the symptom the turn saw (a closed app-server, an
    aborted poll); `null` when the engine's own failure is the cause.
  - `diagnostics` and `token_usage_events` (the engine-native usage events).
    Claude's `diagnostics.worktrees` lists `{ path, branch }` for each native
    worktree its transcript proves the session entered, including trees it
    later left; `branch` is `null` when unreported (for example, a hook-created
    tree). An empty list means no native worktree entry was observed in the
    available transcript. These are separate from the top-level `worktree`,
    which describes Ensemble's `isolation: "worktree"` placement.
    When pending Claude work spans attempts, each attempt accounts only for
    growth since the previous attempt's session total, even if its transcript
    reference repeats earlier API calls. Summing attempts never charges that
    earlier work twice.
    A failed Claude launch supplies `diagnostics.claudeLaunch`: `failure`
    keeps the launch's account, and `cleanupConfirmed` says whether it was
    safe to reject after teardown. `command` contains the dispatch command's `ok`, `exitCode`, `signal`, `stdout` and
    `stderr`; `roster` is the last observed native row; `logs` contains the
    same command-result fields for `claude logs`. Unavailable observations
    are `null`. Any transcript is retained in the attempt's transcript
    references. The dispatch command's exit is separate from `worker_exit`,
    which describes the worker process itself.
  - `app_server_diagnostic`: Codex's own account of the failure,
    `{ code, http_status_code, message, payload }`. `code` is the condition
    Codex named; `http_status_code` is the provider status Codex forwarded
    with it (such as the last status after its own retries ran out), or
    `null`. The whole field is `null` when Codex supplied no diagnostic.
  - `worker_exit`: `{ exit_code, signal }` when the worker process died
    rather than returned; `null` otherwise.
  - `background_waits`: the background tasks the worker started and Ensemble
    waited on (including Claude native `Workflow` tasks), each
    `{ task_id, description, observed_at, ended_at }`
    (`ended_at` is `null` where the attempt ended before the task woke the
    session); empty for engines without background tasks.
- `classification` on a failed attempt: `{ class, rule }`. `class` is
  `"availability"` (the engine refused or lost the worker before it answered:
  allowance exhausted, provider overload past its own retry, an engine process
  that died or never started — the one class that advances a fallback chain,
  consuming no attempt when it does), `"output"` (the worker answered badly: empty,
  unparseable, off-schema — retried in place), or `"unclassified"` (including
  rejected credentials and a Codex rejection of the authored schema before
  generation). Codex provider request rejections forwarded as `other` with
  a JSON `invalid_request_error` cause use rule
  `codex.provider-request-rejected`: recognised, retried in place, and never
  an availability failure. A recognised schema rejection retains
  `codex.schema-rejected` even in this envelope and settles immediately
  without retrying. Other unrecognised `other` diagnostics keep a
  null rule. Credential failures use kind `authentication-failure` and rule
  `<engine>.authentication-failure`; Codex unknown-model failures use kind
  `model-not-found` and rule `codex.model-not-found`. Both keep the engine's
  diagnostic and add a recovery step to `failure.message`. An explicit
  provider HTTP 401 remains `authentication-failure` when Codex's
  retry-promise bound wraps that diagnostic. `rule` names
  the classifier rule that matched (`codex.usage-limit`, `claude.rate-limit`,
  `codex.substrate-dead`, `engine-shutdown`, `run-settlement`, …) and is `null`
  only when no rule recognised the diagnostic — a sign that an engine's error wording is not
  recognised. The raw diagnostic stays in `failure`, `app_server_diagnostic`,
  and `diagnostics`. `engine-shutdown` describes a local engine or session
  close; `run-settlement` describes the run ending under the worker.
  `null` on a complete attempt.
- `chain_decision` on a failed attempt of a call that declared a `fallback`
  chain: what Ensemble did next — `"advanced"` (an availability failure with
  a later entry remaining: the call moved to that entry, spending none of its
  attempt bound), `"retried-in-place"`, `"exhausted"` (nothing left to try:
  the call settles on this failure), or `"chain-not-consulted"` (the failure
  matched no rule while a later entry remained, so the chain, which advances
  on availability failures only, was not used). `null` on a complete attempt,
  on every attempt of a call with no chain, and on an attempt cut short by the
  run's own ending.
- `transcripts`: array; each entry has `attempt`, `path`, `format`, `source`,
  `session_id`, `thread_id`, and `partial` (`true` when the turn ended before
  completion, and always on an abandoned attempt's transcript). Empty when
  none were archived.
- `transcripts_unavailable`: `null` when `transcripts` has entries, otherwise
  why it is empty: `"record-unsettled"`, `"no-attempt-ran"`,
  `"worker-interrupted"`, `"worker-timed-out"`, `"substrate-never-started"`
  (every recorded attempt was refused before its worker existed),
  `"session-client-capture-gap"` (only when `transcript_capture` is
  `"lost"`), or `"engine-produced-no-transcript"`.

Transcripts are captured per engine. Codex threads are ephemeral, so the
archive records the prompt-bearing `turn/start` request and every app-server
notification for the turn through completion. Claude transcripts are copied
from the background session's JSONL before the session is removed. opencode
transcripts keep the `opencode run --format json` event stream plus the
session export when available.

The record holds run and audit data only. It does not score outputs, infer
which agent verified which, or record evaluation concepts; those belong to the
tools that consume it.

### Token usage and cost

Usage summaries — an agent record's `usage` and each `cost_rollup` bucket's
`tokens` — use one vocabulary of disjoint classes that sum to `totalTokens`:

| Field | Meaning |
|---|---|
| `freshInputTokens` | Uncached input |
| `cachedInputTokens` | Combined cache figure, used for admission and total reconciliation. Not a single pricing class when it includes both reads and writes |
| `cacheReadTokens`, `cacheCreationTokens` | Optional split of `cachedInputTokens` where the engine separates them; an absent field means that part is not separable, not zero |
| `outputTokens` | Output, excluding reasoning where separable |
| `reasoningOutputTokens` | Reasoning output, or `null` when the engine does not separate reasoning (not zero) |
| `unclassifiedTokens` | Spend the engine's total covers but no other class does — for example opencode steps that report only a total |

Each engine's native fields are mapped under one rule. Codex reports cached
tokens within input and reasoning within output, so both are subtracted out.
Claude and opencode report them separately; Claude's reasoning is not
separable, so its `reasoningOutputTokens` is `null` and the whole generation is
in `outputTokens`. On Claude, usage is read from the session transcript once
per API call: Claude Code writes one call's reply across several rows that
repeat the call's usage, so rows sharing a message id are counted once, and
every figure is summed across the turn's calls. A held session's later turn
counts only the calls it made. The engine-native usage events stay on each
attempt, unmodified.

Each attempt's `token_usage_events` is an array of objects with `threadId`
and `turnId` (strings), `last` and `total` (token breakdowns), and `raw` (the
engine payload, or the adapter's derived payload). A breakdown has numeric
`inputTokens`, `cachedInputTokens`, `outputTokens` and `totalTokens`, plus
optional numeric `reasoningOutputTokens` and `cacheCreationInputTokens`.
An absent optional field means the engine did not separate that class.
These native breakdowns retain each engine's inclusion rules; they are not
the disjoint summary vocabulary above.

| Engine | `last` and `total` in the archived event | `raw` shape and native mapping |
|---|---|---|
| Codex | `last` is the usage increment reported by the notification; `total` is cumulative across the thread, including earlier turns of a held session. There can be several notifications in one attempt. | The `thread/tokenUsage/updated` parameters: `{ threadId, turnId, tokenUsage: { last, total, … }, … }`. Breakdown names match the fields above; input includes cached input, and output includes reasoning when reported. |
| Claude | A settled attempt normally has one derived event with `last` equal to `total`: usage across that attempt's API calls, excluding usage already accounted for by earlier attempts or held-session turns. If only live observations survive a failed attempt, there can instead be several incremental `last` values with attempt-cumulative `total`. | `{ threadId, turnId, tokenUsage: { last, total } }`. `threadId` is the Claude session id; `turnId` is synthetic (`<session-id>:claude-<counter>`). The transcript's `input_tokens` and `output_tokens` become `inputTokens` and `outputTokens`; `cache_read_input_tokens + cache_creation_input_tokens` becomes `cachedInputTokens`, with creation also in `cacheCreationInputTokens`. `totalTokens` sums input, combined cache and output. No reasoning split is reported. |
| opencode | At most one derived event, with `last` equal to `total`, aggregated for that attempt. These are attempt totals, not cumulative session totals. | `{ threadId, turnId, model, providerModel, tokenUsage: { last, total }, cost }`. `model` is the configured registry key; `providerModel` is its provider route; `cost` is the reported figure or `null`. `threadId` is the session id (a synthetic id if missing); `turnId` is synthetic (`<session-id>:opencode-<counter>`). Native `input`, `output`, `reasoning` and `cache.read`/`cache.write` map to the corresponding breakdown fields, with cache reads and writes combined. Input, cache, output and reasoning are disjoint. |

To reproduce an attempt's summary, sum its events' `last` breakdowns and
apply the engine's inclusion rule. For Codex, never sum `total` across
notifications or agent records: a held thread's later turn includes earlier
turns in that figure. Alternatively, subtract the previous total for the
same thread from its latest total, using the thread's total before the turn
as the baseline. For example, consecutive turns with cumulative totals of
13,980 and 29,368 tokens account for 13,980 and 15,388 tokens, not 13,980 and
29,368. Keep thread identities separate when retrying or falling back.

The Claude adapter deduplicates transcript rows by assistant message id
before aggregating API calls. When a session export is available, the
opencode adapter uses its assistant-message token snapshots, falling back
to `info.tokens` if those contain no usable usage. Only when no export is
available does it use streamed `step_finish` events' `part.tokens`. Across
those snapshots it takes input/cache once from the last usable snapshot
and sums output/reasoning increments. A
snapshot carrying only `total` contributes that figure as unclassified
spend. In an opencode breakdown, `cacheCreationInputTokens` is the write
share when reported, and `totalTokens` sums the disjoint classes plus any
unclassified spend. The opencode adapter fills an omitted native reasoning
count with `0`.

`cost_rollup` keys spend per engine and per *served* model. An agent whose
fallback chain crossed engines books each attempt under the engine that ran
it. The literal `"unresolved"` is used when no served model was ever learned,
never the requested model; for opencode the served model is the configured
`provider_model`. A run that dispatched no worker has an empty roll-up.
Figures are never summed across engines.

A live or abandoned attempt with no served identity of its own books under
its engine's `"unresolved"` leaf, even when an earlier attempt reported a
model. A held turn keeps its session's known identity, including on retries.

Each leaf has four fields:

- `tokens`: a usage summary, or `{ "unavailable": "no-usage-reported" }` when
  nothing booked under the leaf reported usage. It is never a zero summary.
- `cost`: `{ amount, currency, source: "provider-reported" }` — Ensemble never
  estimates money — or a reason instead of an amount:
  `{ "unavailable": "no-provider-cost-reported" }`, or
  `{ "unavailable": "unlike-currencies" }` when attempts under one served model
  reported different currencies.
- `complete`: `true` only when the figures contain all the spend of every
  attempt booked under the leaf. Read `tokens` and `cost` as totals only when
  it is `true`; otherwise they are a lower bound.
- `unobserved`: one entry for each attempt whose spend the figures leave out,
  ordered by agent and then attempt. It is empty exactly when `complete` is
  `true`. Each entry is `{ agent, attempt, reason, measured }`. `agent` is the
  agent record's `id` and `attempt` the attempt's number in its `attempts`,
  or `null` for an attempt the record does not list (see below). `measured`
  is `"partial"` when the figures include usage the attempt reported before
  it ended, and `"none"` when they include nothing of it. `reason` uses the
  words of the agent record's `usage.unavailable`:

  | `reason` | The attempt |
  |---|---|
  | `record-unsettled` | had no observed outcome: still running in a live manifest, or running when its writer died (SIGKILL), so the sweep listed it as `abandoned`; or it is an attempt the record does not list |
  | `worker-interrupted` | was cut short by the run ending with it in flight: the run's interrupt (SIGINT or SIGTERM), or a script body that returned or failed |
  | `worker-timed-out` | was cut short by a run or turn deadline the runtime enforced, including a timed-out attempt the runtime then retried, so an agent whose record reads `complete` can still name one here |
  | `engine-reported-no-usage` | settled on its engine's own account, which carried no usage |

Each attempt is judged by its own entry, never by the agent's status. The run
cut an attempt short only when that attempt's `failure.kind` says so:
`run-interrupted`, `run-failed` or `run-timed-out`, which the run's close
writes on the attempt it tears down, or a deadline's kind. An agent that reads
`interrupted` because the run ended while it waited between attempts — queued
for its next fallback target, say — has no attempt cut short, and the spend of
the attempts it settled is booked as complete.

An attempt refused before any worker existed spent nothing. It books its leaf
without an `unobserved` entry, so a leaf holding only such attempts reads
`tokens.unavailable` with `complete: true`. Several workers on one served model
share a leaf. When one reported its usage and another was cut short, the leaf
carries the first's figures, `complete: false`, and an `unobserved` entry for
the second.

An agent that lists no attempt books under its engine's `"unresolved"` leaf.
That leaf stays complete when the record shows no worker started: the agent
settled without one, or the run's own close abandoned it while it was still
being dispatched. A record's attempt start is written on a best-effort basis,
and the worker runs even when that write fails, so a record whose writer
never settled it — the sweep's `abandoned` records, which carry an
`abandonment` block — may have had an attempt running that it does not list.
When such a record lists no unsettled attempt, the roll-up the sweep
recomputes books that possible attempt under the requested engine's
`"unresolved"` leaf, as `{ agent, attempt: null, reason: "record-unsettled",
measured: "none" }`, and the leaf is not complete. The record may only have
been waiting for its next attempt when the run died, but the archive cannot
show that. A live manifest never carries such an entry: its writer holds every
attempt start in memory.
