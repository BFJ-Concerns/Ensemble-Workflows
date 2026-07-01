# Ensemble

A deterministic multi-agent orchestration harness for multiple LLM engines,
mirroring Claude Code's `Workflow` tool. An LLM (most often Claude) authors a
JavaScript workflow and runs it through a CLI that fans many agents out over a
task — each on a chosen engine, **Codex, Claude, or opencode** — and fans their structured
results back in, with schema-validated output, retry/verify, per-engine token
budgets, and worktree isolation. Its distinctive capability is **cross-engine verification**:
one model family checks another within a single run, so an answer that survives
both is stronger than either family could vouch for alone.

**Status:** feature-complete v1, landed and tested. The harness runs
`agent()` calls on any registered engine — Codex over a `codex app-server`, Claude as
`claude --bg` background sessions, and opencode through `opencode run` with
curated models — with schema-validated structured output and
bounded retry, schedules concurrent workers under a per-engine self-imposed cap,
accounts for tokens against independent per-engine budget ceilings, and offers the full script
surface — `parallel()`, `pipeline()`, a `node:vm` restricted-globals sandbox, and
`workflow()` composition over saved workflows, and `isolation:'worktree'` for writable parallel Codex agents — driven by the
`ensemble <script.js> [args]` CLI (result JSON on stdout, logs on stderr,
non-zero exit on a thrown script). `agent()` requires an `engine` (`'codex'`,
`'claude'`, or `'opencode'`): there is no default and no engine is privileged.
opencode also requires a curated `model`; v1 ships `model: "glm-5.2"`, resolved
to `openrouter/z-ai/glm-5.2` with `vision:false` and pay-as-you-go billing.

```bash
ensemble my-workflow.js > result.json 2> run.log
```

## Script surface

Workflow scripts begin with an `export const meta = { name, description, ... }`
object literal, then run ordinary async JavaScript inside a restricted-globals
sandbox. The sandbox has no filesystem, shell, network, `process`, `require`, or
Node module access; the host-provided hooks are the way out.

- `agent(prompt, opts)` runs one worker on `opts.engine` (`"codex"`, `"claude"`,
  or `"opencode"`). With `opts.schema`, it returns a schema-validated object or
  `null` after bounded retry; without a schema, it returns final text. Unsupported
  engine options throw rather than silently doing less than requested. A Claude
  call with no `model` pin is flagged on stderr, and `fallbackModel` (Claude
  only) declares degradation when a pinned tier is unavailable.
- `export const defaults = { … }` — an optional second export after `meta` —
  sets per-engine `model`/`effort`/`fallbackModel` that every `agent()` call
  inherits and call-site options override.
- `parallel(thunks)` runs all thunks concurrently and returns all results. A
  failed thunk becomes `null` in the returned array and is still logged.
- `pipeline(items, ...stages)` runs each item through each stage independently,
  with no cross-item barrier between stages.
- `workflow(nameOrRef, args)` runs a saved workflow inline and returns the
  child's result. `nameOrRef` is either a workflow name string or
  `{ scriptPath }`. Names resolve project-first from
  `.claude/ensemble/workflows/`, then from
  `${XDG_DATA_HOME:-~/.local/share}/ensemble/workflows/`; resolution reads the
  saved workflow's `meta.name`, so filenames are just storage. `{ scriptPath }`
  resolves like the top-level CLI script path, relative to the run cwd unless
  absolute. Child workflows share the parent's `EnsembleRuntime`: the same
  per-engine concurrency caps, budget ledgers, worktrees, and durable run record.
  Nesting is one level only; `workflow()` called inside a child throws. The
  registry ships empty, and project-level saved workflows are durable,
  committable source files, not live-status artefacts.
- `phase(title)` and `log(message)` write to the run log; `phase()` also updates
  the live progress snapshot when enabled.
- `budget.spent(engine)` / `budget.remaining(engine)` expose per-engine token
  accounting, matching the names used by `agent()`.
- `worktrees` exposes changed Codex worktrees left by `isolation: "worktree"`.
- `args` is the raw CLI string arguments, or the parsed JSON value from
  `--json-args`.

`ensemble workflows` lists saved workflows in the project and user registries,
printing each workflow's `meta.name` and `meta.description`. Files whose metadata
cannot be parsed are noted on stderr and skipped, so one bad saved workflow does
not hide the rest.

The agent skill teaching the hooks API and the invoke pattern is maintained
outside this repository; any shell-capable orchestrator runs the same CLI
directly.

## Live status

A run continuously publishes a small JSON snapshot of what it is doing — current
phase, per-engine active/queued/done/failed counts, per-engine token spend, and
the live worker list — to `.claude/ensemble.local.json` in the run's working
directory, written atomically so a reader never sees a half-written file. The
default is present-only: Ensemble writes the file only when that `.claude/`
directory already exists, and never creates it. The file is live-only and is
removed when the run finishes, so an absent file means nothing is in flight. It
is the producer half of a faithful one-line compression of Claude Code's
`/workflows` view; it is *not* the live tree, and it adds no script-facing API
(`phase()`/`log()` are unchanged).

The side-channel is an ambient, environment-level concern, so it is configured by
environment variable rather than a run-tuning flag:

- `ENSEMBLE_STATUS=off` (or `0`/`false`/`no`) disables it.
- `ENSEMBLE_STATUS_DIR` overrides the directory unconditionally.

`ensemble --statusline` reads that snapshot and prints one compact line — meant
for Claude Code's `statusLine`, so a run kicked off through the Bash tool shows
its progress where you are already looking:

```
ensemble · ▸ Verify · codex ⚡3⏳2 48k/100k · claude ⚡1 · opencode 2.4k/20k · ✓12 ✗1 · 2m14s
```

```json
// .claude/settings.json — point statusLine at the same binary
{ "statusLine": { "type": "command", "command": "ensemble --statusline" } }
```

It prints nothing when no run is active (or one has finished or gone stale), so
the statusline falls back cleanly. Per-engine spend is shown separately, never
summed — the engines denominate different, non-comparable cost models. The run
and `ensemble --statusline` resolve the same cwd-local path; set
`ENSEMBLE_STATUS_DIR` consistently for both commands if you move it off the
default.

### `ensemble.local.json` schema

The status file is a published interface for status-line authors. It contains one
JSON object with these fields:

- `schema`: `1`.
- `runId`: string.
- `pid`: number, the process id of the publishing run.
- `workflow`: string or `null`, from `meta.name` when present.
- `state`: `"running"` or `"finished"`. Normal completion removes the file
  instead of leaving a finished snapshot; readers should still tolerate
  `"finished"` from older or interrupted publishers.
- `startedAt`: number, Unix epoch milliseconds.
- `updatedAt`: number, Unix epoch milliseconds.
- `finishedAt`: number or `null`, Unix epoch milliseconds when the run has
  finished.
- `currentPhase`: string or `null`.
- `totals`: object with numeric `active`, `queued`, `done`, and `failed` counts.
- `engines`: object keyed by registered engine name (`codex`, `claude`, and
  `opencode` in v1). Each entry has numeric `active`, `queued`, `done`,
  `failed`, and `spent`; `cap`, `ceiling`, and `remaining` are numbers or
  `null`. Spend and ceilings are per-engine and are never summed.
- `agents`: array of live worker objects, capped for file size. Each object has
  numeric `id` and `attempt`, `engine` (`"codex"`, `"claude"`, or
  `"opencode"`), `state` (`"queued"` or `"running"`), and nullable string
  `label` and `phase`.

Example:

```json
{
  "schema": 1,
  "runId": "run-01HZY7V4Q8P2",
  "pid": 43122,
  "workflow": "verify-findings",
  "state": "running",
  "startedAt": 1766491200000,
  "updatedAt": 1766491214500,
  "finishedAt": null,
  "currentPhase": "Verify",
  "totals": { "active": 3, "queued": 2, "done": 12, "failed": 1 },
  "engines": {
    "codex": {
      "cap": 16,
      "active": 2,
      "queued": 2,
      "done": 8,
      "failed": 0,
      "spent": 48000,
      "ceiling": 100000,
      "remaining": 52000
    },
    "claude": {
      "cap": 8,
      "active": 1,
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
      "spent": 2400,
      "ceiling": 20000,
      "remaining": 17600
    }
  },
  "agents": [
    {
      "id": 17,
      "engine": "codex",
      "label": "scan",
      "phase": "Verify",
      "state": "running",
      "attempt": 1
    }
  ]
}
```

## Durable run record

Every run also writes a permanent archive of what happened. This is separate
from `.claude/ensemble.local.json`: the status file is live-only and removed at
the end; the run record is archival and kept for audit and for tools that
evaluate runs after the fact.

The archive is an ambient, machine-level data store, configured by environment:

- Default: `$XDG_DATA_HOME/ensemble/`, or `~/.local/share/ensemble/` when
  `XDG_DATA_HOME` is unset.
- `ENSEMBLE_RUN_RECORD=off` (or `0`/`false`/`no`) disables recording.
- `ENSEMBLE_RUN_RECORD_DIR` relocates the store. If this variable is unset, the
  default data-home path is still used; unset never means disabled.

Runs are stored under:

```text
$STORE/runs/cwd/<namespace-sha256>/<run-uuid>/
```

The public `run_id` is `cwd:<namespace-sha256-prefix>:<run-uuid>`. The namespace
material is `realpath(git root)` when the run cwd is inside a git repository,
otherwise `realpath(cwd)`. This keeps one machine-level store safe across
projects. It is distinct from `meta.task`: namespace identifies where the run
came from, while `meta.task` is an opaque benchmark grouping key copied verbatim
from the workflow meta block when present.

The archive is written incrementally. `manifest.json` starts as
`status: "in-progress"`, each completed agent flushes its own directory with
atomic temp-then-rename writes, and the final manifest records `complete`,
`failed`, `timed-out`, or `interrupted`. A stopped run therefore leaves a usable
partial archive.

### Run record schema

Every JSON artefact carries:

- `schema_version`: currently `1`.
- `kind`: one of `run_manifest`, `run_args`, `run_result`, or `agent_record`.

The manifest is `manifest.json`. Its top-level fields are:

- `schema_version`: `1`.
- `kind`: `"run_manifest"`.
- `run_id`: namespaced run id.
- `run_uuid`: the runtime UUID before namespacing.
- `namespace`: namespace strategy, id, hash, and local material.
- `status`: `"in-progress"`, `"complete"`, `"failed"`, `"timed-out"`, or
  `"interrupted"`.
- `started_at` / `ended_at`: ISO timestamps; `ended_at` is `null` until final.
- `workflow`: original path, archived `workflow.js`, and SHA-256.
- `args`: archived `args.json` and SHA-256 of canonical args JSON.
- `meta`: raw workflow meta and `task` copied verbatim, or `null`.
- `cli_flags`: parsed run-tuning flags.
- `git`: start/end HEAD, dirty flag, and archived diff path when dirty.
- `environment`: OS, Node, and available tool versions.
- `harness`: package name/version and git commit of the harness checkout.
- `result`: archived `result.json` path and exit code once final.
- `cost_rollup`: `engine -> model -> usage`, never a cross-engine total. Models
  omitted by a worker are grouped as `"default"`. Cost entries carry
  `amount`, `currency`, and source (`provider-reported` or `estimated`); when the
  runtime only has token data, amount/currency are `null` and source is
  `estimated`.
- `files`: integrity table for archived artefacts, each with `path`, `size`, and
  `sha256`. `manifest.json` is excluded to avoid self-hashing recursion.

Agent records live at `agents/<zero-padded-id>/agent.json`:

- `schema_version`: `1`.
- `kind`: `"agent_record"`.
- `id`, `creation_order`, `concurrency_group`.
- `engine`, `model`, `effort`, and `resolved_model` (`null` when unknown).
- `label`, `phase`, and `status`.
- `schema`: requested JSON Schema for schema agents, otherwise `null`.
- `raw_output`: final raw model text, or the latest raw failed output.
- `validated_output`: validated object/text result, or `null` on failure.
- `attempts`: per-attempt status, structured failure, raw/validated output,
  timing, and token usage events.
- `transcripts`: archived transcript files for the attempts.

Codex transcripts are captured from the app-server stream because threads are
ephemeral: the archive records the prompt-bearing `turn/start` request and every
scoped app-server notification through completion. Claude transcripts are copied
from the background session JSONL before the session is removed. opencode
transcripts preserve the `opencode run --format json` event stream plus the
session export when available. The prompt lives in the transcript, not in a
duplicated field.

The record contains only run and audit data. It does not score outputs, infer
verifier relationships, or record evaluation concepts; those belong to the
tools that consume it.
