# Run records and live status

A run can leave three kinds of file behind or alongside it:

| Artefact | Lifetime | Purpose |
|---|---|---|
| Live status file (`ensemble.<run-uuid>.local.json`) | While the run is active; removed when it ends | Watch what a run is doing right now |
| Completion sentinel (`completion-sentinel.json`) | Permanent | Learn that a run has ended, and how |
| Durable run record (the archive) | Permanent; on by default | Audit or evaluate a run after the fact |

The live status file is written only where a status directory exists (by
default, `.claude/` in the run's working directory).

Where these files live, and how to turn them off, is covered in
[Configuration](configuration.md).

## Live status

While a run is active it publishes a small JSON snapshot of what it is doing —
current phase, per-engine active/queued/done/failed counts, per-engine token
spend, and the live worker list — to its own file in the status directory:
`.claude/ensemble.<run-uuid>.local.json` under the run's working directory by
default. Ensemble writes there only when `.claude/` already exists and never
creates it. Writes are atomic, so a reader never sees a half-written file.

Each run has its own file, so concurrent runs in one directory are each
visible for their whole lifetime: a later run never overwrites an earlier
run's view, and a run that ends removes only its own file. A file left by a
killed run stays until the next run starts in that directory, whose startup
sweep removes any file whose writer is provably dead (below).

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

### `ensemble.<run-uuid>.local.json` schema

Each status file contains one JSON object with these fields:

- `schema`: `2`.
- `runId`: string.
- `pid`: number, the process id of the publishing run.
- `workflow`: string or `null`, from `meta.name` when present.
- `state`: `"running"` or `"finished"`. A finished snapshot may exist briefly
  while the writer closes; `close()` then removes the file. Readers should treat
  absence as no active run and tolerate `"finished"` during that close window.
- `startedAt`: number, Unix epoch milliseconds.
- `updatedAt`: number, Unix epoch milliseconds.
- `finishedAt`: number or `null`, Unix epoch milliseconds when the run has
  finished.
- `currentPhase`: string or `null`.
- `totals`: object with numeric `active`, `queued`, `done`, and `failed` counts.
- `engines`: object keyed by registered engine name (`codex`, `claude`, and
  `opencode`). Each entry has numeric `active`, `queued`, `done`, `failed`, and
  `spent`; `cap`, `ceiling`, and `remaining` are numbers or `null`. Spend and
  ceilings are per-engine and are never summed.
- `agents`: array of live worker objects, capped for file size. Each object has
  numeric `id` and `attempt`, `engine` (`"codex"`, `"claude"`, or
  `"opencode"`), `state` (`"queued"` or `"running"`), nullable string
  `label` and `phase`, and two liveness stamps (numbers or `null`, Unix epoch
  milliseconds): `startedAtMs`, when the worker left the queue and began
  executing, and `firstEvidenceAtMs`, when the engine first saw the worker
  produce output. The evidence stamp is set once per target and never
  updated; a fallback to another engine starts both stamps afresh. A worker
  running long with no evidence stamp has not produced output on its current
  target and is suspect, while one with a stamp has produced output at least
  once; the stamps cannot tell a worker streaming now from one that stalled
  after its first output. `waitingOn` is `null`, or an object while Ensemble is holding
  a Claude worker for a background task it started (a long command or a
  Monitor): its kind is background-task, and it carries the task's id, Claude
  Code's description of the task, and the epoch-millisecond time the wait was
  first observed. That distinguishes a stuck background task from a worker
  that is still generating.
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
  "schema": 2,
  "runId": "run-01HZY7V4Q8P2",
  "pid": 43122,
  "workflow": "verify-findings",
  "state": "running",
  "startedAt": 1766491200000,
  "updatedAt": 1766491214500,
  "finishedAt": null,
  "currentPhase": "Verify",
  "totals": { "active": 1, "queued": 0, "done": 12, "failed": 1 },
  "engines": {
    "codex": {
      "cap": 12,
      "active": 1,
      "queued": 0,
      "done": 8,
      "failed": 0,
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
path is announced only once its directory exists. If the launcher cannot create
the directory (a regular file where the store should be, a read-only parent),
it prints one `[sentinel] no sentinel will be written for this run — …` line
naming the cause instead, so a supervisor never waits on a path that cannot be
written. With recording enabled the run then fails to start, with a one-line
`the durable run record could not start under …` diagnosis; with recording off
it runs on without a sentinel. A write that fails later is reported as one
`[sentinel]` line.

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
with the same block. An abandoned agent record keeps exactly what was recorded
before the death: `attempts` lists settled attempts only, and `usage` and
`transcripts` cover only those attempts. Where none had recorded usage or a
transcript, `usage` and `transcripts_unavailable` read `record-unsettled` —
the attempt in flight and its spend are unobserved, never zero. An agent record that the run's own close
abandons (one still being dispatched when the run ended) says
`no-attempt-ran` instead, because its writer knows no attempt began. Settled
agent records are never rewritten.

## Run record schema

Every record document — the JSON files described below, as opposed to the
archived workflow source, canonical arguments, transcripts, and diffs —
carries:

- `schema_version`: currently `4`.
- `kind`: one of `run_manifest`, `run_args`, `workflow_args`, `run_result`, or
  `agent_record`.

The completion sentinel and the live status file are separate artefact
families with their own schema versions (`3` and `2`), described above.

### Manifest

`manifest.json` has these top-level fields:

- `schema_version`: `4`.
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
  where applicable, and a timestamp. An `answered` entry also carries
  `answered_by` (the answerer the decision file named, or `null`) and the
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
  refusal at a budget of 0 reads `Token budget for <engine> is 0, which admits
  no agent: this agent was not started`; a spent budget reads `Token budget for
  <engine> reached: N tokens spent against a threshold of M, checked before
  each dispatch — this agent was not started (a running agent can carry
  spending past the threshold)`.
- `cost_rollup`: `engine -> model -> usage`, never a cross-engine total. See
  [Token usage and cost](#token-usage-and-cost).
- `files`: integrity table for archived artefacts, each with `path`, `size`,
  and `sha256`. `manifest.json` is excluded; it carries its own digest instead.
- `integrity`: `algorithm` (`"sha256"`), `recipe` (the digest rule, stated in
  the archive itself), `manifest_sha256` (the manifest's own digest), and
  `files_lost` — one `{ path, reason }` entry, sorted by path, for each
  declared file that was `missing` or a `size-mismatch` at the seal. Empty on
  a whole archive.

### Agent records

Each agent's record is at `agents/<zero-padded-id>/agent.json`:

- `schema_version`: `4`.
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
- `fallback`: the declared fallback chain (`[{ engine, model, effort? }]`, as
  the call or its engine defaults declared it), or `null`.
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
- `label`, `phase`, and `status`. Status is `"in-progress"`, `"complete"`,
  `"failed"`, `"timed-out"`, `"interrupted"`, or `"abandoned"`. `"abandoned"`
  means no outcome was observed: either the run's own close ended while the
  dispatch record was still being written, or another run's sweep found the
  record left `"in-progress"` by a killed run (with an `abandonment` block).
- `termination_cause`: the `{ kind, message }` that settled the agent at that
  status when the runtime decided it — a run that ended under the worker, or a
  deadline the runtime enforced — and `null` when the attempts already name the
  cause. Two deadline kinds are distinguished: `"turn-timeout"` (the per-agent
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
  in flight and its spend are unobserved), `"no-attempt-ran"`, or
  `"engine-reported-no-usage"`.
- `queued_ms`, `execution_ms`: time spent waiting for admission and time
  spent executing.
- `attempts`: the attempts that have settled. An attempt still running when
  the record was written is not listed, so an empty array on an `in-progress`
  or `abandoned` record means unobserved, not "none ran". Each entry has:
  - `attempt`: 1-based, numbering every dispatch the call made, refused ones
    included.
  - `status` and `target` (`{ engine, model }`: the engine and requested
    model this attempt was dispatched to — the call's own until a fallback
    chain advances).
  - `started_at`, `ended_at`, `duration_ms` (the engine's own measurement
    where it reports one, otherwise the attempt's recorded endpoints, so an
    attempt that ran never has a `null` duration), and `first_delta_ms`.
  - `raw_output`, `validated_output`, `resolved_model` (including a held
    session's observed model on later turns), and `resolved_effort`.
  - `failure`: `{ kind, message }` or `null`.
  - `classification` and `chain_decision` (below).
  - `observed_failure`: when the run's own ending ended the turn, `failure`
    names that ending (`run-interrupted`, `run-timed-out`) and
    `observed_failure` keeps the symptom the turn saw (a closed app-server, an
    aborted poll); `null` when the engine's own failure is the cause.
  - `diagnostics`, `app_server_diagnostic`, and `token_usage_events` (the
    engine-native usage events).
  - `worker_exit`: `{ exit_code, signal }` when the worker process died
    rather than returned; `null` otherwise.
  - `background_waits`: the background tasks the worker started and Ensemble
    waited on, each `{ task_id, description, observed_at, ended_at }`
    (`ended_at` is `null` where the attempt ended before the task woke the
    session); empty for engines without background tasks.
- `classification` on a failed attempt: `{ class, rule }`. `class` is
  `"availability"` (the engine refused or lost the worker before it answered:
  allowance exhausted, provider overload past its own retry, an engine process
  that died or never started — the one class that advances a fallback chain,
  consuming no attempt when it does), `"output"` (the worker answered badly: empty,
  unparseable, off-schema — retried in place), or `"unclassified"` (including
  a Codex rejection of the authored schema before generation). `rule` names
  the classifier rule that matched (`codex.usage-limit`, `claude.rate-limit`,
  `codex.substrate-dead`, `run-settlement`, …) and is `null` only when no rule
  recognised the diagnostic — a sign that an engine's error wording is not
  recognised. The raw diagnostic stays in `failure`, `app_server_diagnostic`,
  and `diagnostics`. `null` on a complete attempt.
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
  completion). Empty when none were archived.
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

`cost_rollup` keys spend per engine and per *served* model. An agent whose
fallback chain crossed engines books each attempt under the engine that ran
it. The literal `"unresolved"` is used when no served model was ever learned,
never the requested model; for opencode the served model is the configured
`provider_model`. Cost entries carry `amount`, `currency`, and
`source: "provider-reported"`; Ensemble never estimates money. A bucket with no
provider figure carries a reason instead of an amount:
`{ "unavailable": "no-provider-cost-reported" }`, or
`{ "unavailable": "unlike-currencies" }` when attempts under one served model
reported different currencies. An engine and model that were dispatched but
reported no usage at all read `{ "unavailable": "no-usage-reported" }` rather
than a zero summary. A run that dispatched no worker has an empty roll-up.
Figures are never summed across engines.
