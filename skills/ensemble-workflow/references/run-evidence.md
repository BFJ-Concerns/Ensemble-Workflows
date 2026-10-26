# Run Evidence: Where the Runtime Writes and What It Records

The files a run leaves behind or alongside it, the knob that moves each, and
the fields to read when auditing a run or explaining a failed leg. Read this
when locating or relocating a run's records, watching a long run, or reading
an archive after the fact.

| Artefact | Lifetime | Purpose |
|---|---|---|
| Live status file (`ensemble.<run-uuid>.local.json`) | While the run is active; removed when it ends | Watch what a run is doing right now |
| Completion sentinel (`completion-sentinel.json`) | Permanent | Learn that a run has ended, and how |
| Durable run record (the archive) | Permanent; on by default | Audit or evaluate a run after the fact |

## Where each file goes

- **The data home** is `$XDG_DATA_HOME/ensemble/` (`~/.local/share/ensemble/`
  when unset). Archives land under `runs/cwd/<namespace-hash>/<run-uuid>/`
  beneath it, hold files under `holds/<scope>/`, and the user workflow
  registry under `workflows/`. `ENSEMBLE_RUN_RECORD_DIR`, or `run_record.dir`
  in the machine configuration, names another data home — the store root,
  not the `runs/` directory, so a value ending in `runs` produces
  `runs/runs/`. Relocate with that variable, never by pointing
  `XDG_DATA_HOME` elsewhere: Claude Code keeps its own data there too, and a
  dispatch that starts its daemon under a changed value leaves every later
  Claude session carrying it. The archive is the run's durable audit record,
  so never point it into a directory the task will delete; to keep one beside
  a repository, name a directory that outlives the task and say where it is.
- **Recording** is on by default; `ENSEMBLE_RUN_RECORD=off` or
  `run_record.enabled: false` disables it. The on/off switches accept
  `on`/`off`, `true`/`false`, `yes`/`no`, or `1`/`0`. With recording on,
  startup prints `[run-record-archive] {"run_id":…,"archive_path":…}` on
  stderr; a store the launcher cannot create fails the run to start its
  record, with a one-line `the durable run record could not start under …`
  diagnosis.
- **The live status file** goes to the run cwd's `.claude/` directory — only
  when it already exists; the runtime never creates it, and a missing
  directory means no status file, silently. `ENSEMBLE_STATUS_DIR` or
  `status.dir` names another directory, which must already exist (the run
  stops with an error otherwise); `ENSEMBLE_STATUS=off` or `status.enabled:
  false` turns it off.
- **Per-dispatch worker settings** go under the system temporary directory
  and are removed when the dispatch ends.
- **Kept worktrees** sit beside the repository in
  `<repo>.ensemble-workflows-worktrees/` (*Placement* in `engines.md`).

A malformed value for any setting the run would use is refused before the run
starts, naming the variable, the accepted form, and the value received.

## The live status file

One JSON object per run, written atomically, refreshed at least every 10
seconds while the run is quiet, removed when the run ends: `state`,
`currentPhase`, `totals` and per-engine `active`/`queued`/`done`/`failed`
counts with `spent`, `cap`, `ceiling` and `remaining`; `agents`, the live
workers with `label`, `phase`, `attempt`, and two liveness stamps —
`startedAtMs` (left the queue) and `firstEvidenceAtMs` (first output on the
current target; never set on a worker that has produced nothing) — plus
`waitingOn`: `null`, or the background task a Claude worker started that the
runtime is holding for (its id, Claude Code's description, when the wait
began), which tells a stuck task from a worker still generating; and `holds`,
the open decision holds. Spend is per engine and never summed.

Judge liveness by the `owner` block (`host`, `pid`, `start_ticks`) first: a
file whose owner is refuted — same host, `start_ticks` recorded, the pid gone
or running with different start ticks — is a killed run's leftover. Where the
owner cannot be judged, a snapshot whose `updatedAt` is more than 30 seconds
old is stale. Absence means no run in flight.

## The completion sentinel

`completion-sentinel.json` in the run's record directory, announced at startup
as `[sentinel] will write <path> when the run ends` and written by the
launcher on every ending it can handle, recording disabled or not (the run
directory is then created for the sentinel alone). It carries `outcome`,
`exit_code`, `ended_at`, `error` (`{ kind, message }` or `null`), `workers`
(`{ done, failed, cut_short, unsettled }`: settled on their own account,
terminated by the run's end, dispatched with no outcome observed — or `null`
when the launcher never got far enough to count), `manifest` (the sealed
manifest's `{ sha256 }`, or `{ unavailable }` naming `recording-disabled`,
`recording-start-failed`, or `manifest-unsealed`), and its own
`integrity.sentinel_sha256`. A teardown that fails after a clean script body
is reported as `outcome: "failed"` with the teardown error. A SIGKILL leaves
no sentinel, so a supervisor keeps a fallback behind its file watch.

## The archive

Written incrementally, so a stopped run leaves a usable partial archive.
`manifest.json` starts `in-progress` and seals as `complete`, `failed`,
`timed-out`, `interrupted`, or `incomplete` (files it archived were gone at
the seal); a run killed by a signal it cannot handle is rewritten
`abandoned` by the next run in the same namespace, judged from the manifest's
`owner` evidence, never guessed from age. The manifest carries the workflow
source and args with hashes, the git state, `cli_flags`, the effective
`concurrency` and `budget_ceilings` with the layer that supplied each,
`dispatch_remap` and `dispatch_remap_unmatched`, `named_targets`,
`workflow_invocations` (the root and every `workflow()` child), `hold_events`,
`tallies`, `error`, `cost_rollup` (engine → served model → usage, never a
cross-engine total; cost figures are provider-reported only, never
estimated), an integrity table of per-file SHA-256 digests and a self-digest.
`meta.task`, when the workflow's `meta` carries one, is copied verbatim as an
opaque grouping key for tools that evaluate archives; the runtime does not
score runs.

Each agent's record (`agents/<id>/agent.json`) is written at dispatch with its
prompt and resolved options, so a worker that dies mid-run still leaves
evidence. Read, for a failed or surprising leg:

- `status` and `termination_cause` — the `{ kind, message }` that settled the
  agent when the runtime decided it (`turn-timeout` for a slow worker,
  `request-timeout` for an engine that never answered a request, a run ending
  under the worker), `null` when the attempts name the cause.
- `attempts[]` — each with `target`, `named_target`, `failure`,
  `classification` (`availability`, `output`, or `unclassified`, with the
  classifier `rule` that matched; `rule: null` means the engine's wording was
  not recognised), `chain_decision`, `observed_failure` (the symptom a
  run-ending teardown produced, kept apart from the ending that caused it),
  `resolved_model` and `resolved_effort` (what the engine reported serving,
  never an echo of the request), `worker_exit`, and `background_waits`.
- `answered_by`, `remap`, and `named_targets` — which target answered, what
  the remap moved, and what each name resolved to (`rerouting.md`).
- `parse_route` — how a schema value was found (`direct`,
  `object-fallback`, `array-fallback`, `scalar-line`).
- `usage` — a summary, or `{ unavailable }` with a reason: `record-unsettled`
  (the attempt in flight and its spend are unobserved, never zero),
  `no-attempt-ran`, or `engine-reported-no-usage`.
- `transcripts` and `transcripts_unavailable` — archived transcripts per
  attempt, or why there are none (`worker-interrupted`,
  `substrate-never-started`, `session-client-capture-gap`, …).
- `strip` — the requested capability names and how each was enforced.

Treat the manifest's `files` table as untrusted input when walking it: refuse
absolute paths, `..` traversal, and symlinked entries. The digests are
self-attestations, not signatures.
