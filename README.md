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
surface — `parallel()`, `pipeline()`, full-Node workflow scripts, and
`workflow()` composition over saved workflows, and `isolation:'worktree'` for writable parallel agents on any engine — driven by the
`ensemble <script.js> [args]` CLI (result as JSON on stdout — structured
objects as JSON objects, plain-text answers as JSON strings with enclosing
quotes — logs on stderr, non-zero exit on a thrown script). `agent()` requires an `engine` (`'codex'`,
`'claude'`, or `'opencode'`): there is no default and no engine is privileged.
opencode also requires a curated `model`; v1 ships `model: "glm-5.2"`, resolved
to `openrouter/z-ai/glm-5.2` with `vision:false` and pay-as-you-go billing.

```bash
ensemble my-workflow.js > result.json 2> run.log
```

## Script surface

Workflow scripts begin with an `export const meta = { name, description, ... }`
object literal, then run as the body of a single async function in **ordinary,
unsandboxed Node**: the full platform — filesystem, network, `process`,
timers, `require(...)` and dynamic `import()` resolving from the script's own
path, `import.meta` — is available alongside the host-provided hooks. Workers
are dispatched only through `agent()`; a free identifier that is neither a
Node global, a bound hook, nor a module-scope binding fails at load, before
any worker spawns. Body syntax errors name the script's own line and column,
showing a source excerpt with a caret; an unfinished body points just after its
last non-whitespace character, and long lines show a short excerpt around the
error.

- `agent(prompt, opts)` runs one worker on `opts.engine` (`"codex"`, `"claude"`,
  or `"opencode"`). With `opts.schema`, it returns a schema-validated object or
  `null` after bounded retry; without a schema, it returns final text or
  `null` on the same terms. Once a worker has spawned, every failure is a
  value — `null`, with the class and account on the agent record and on an
  identified call's `failure` field, announced on stderr under the engine's
  tag — never a throw; only a rejection raised before a worker exists, and
  the run's own ending, throw. Every
  worker runs unrestricted with filesystem and network access. Unrecognised
  option keys throw before that call's worker spawns; the removed `sandbox`,
  `network`, `webSearch`, and `fallbackModel` keys name their removal. A
  Claude call with no `model` pin is flagged on stderr. `fallback` declares an
  ordered chain of full targets — `[{ engine, model, effort? }, …]`, Codex or
  Claude in any position — that the harness re-dispatches the call on when a
  target fails for **availability** (allowance exhausted, provider overload
  past its own retry, a dead or unstartable substrate); output failures retry
  in place and never advance it. A Codex rejection of the authored schema
  before generation is `unclassified`: it returns `null` after one thread
  start without retrying or advancing the chain. An empty chain or opencode
  entry throws before any worker spawns, and every step is the harness's own
  recorded dispatch — the engine never swaps models behind the record's back.
  The launcher says on stderr when a chain entry answered for a refused target,
  when a declared chain was not consulted because the failure went unrecognised,
  and how many chain targets an exhausted call tried; each attempt records the
  decision the harness took after it.
- `export const defaults = { … }` — an optional second export after `meta` —
  sets per-engine `model`/`effort`/`fallback` that every `agent()` call
  inherits and call-site options override; the chain is engine-agnostic, so
  a Codex block may name a Claude target.
- `session(opts)` creates a multi-turn worker on `"claude"` or `"codex"`
  (`"opencode"` throws before spawn): engine, model, and effort are fixed at
  creation, and the returned handle's `send(prompt, { schema? })` runs
  successive turns against the same held worker — schema is the only per-turn
  variation, each turn under the one-shot call's validated-return,
  bounded-retry, and failure-as-value contract (a failed turn resolves `null`
  and the session stays usable), holding an engine-cap/ceiling slot only
  while it executes. Claude sessions are dispatched with the 1-hour prompt-cache TTL;
  `handle.stale` is the advisory staleness mark (TTL cliff on Claude, 60 idle
  minutes on Codex; `stalenessMark: false` disables it) and never blocks a
  send. Each turn is its own agent record carrying `session: { id, turn }`,
  and every held session is closed when the run ends.
- `hold({ content, verdicts, timeoutMs? })` raises a decision hold: the
  request is published under the run's **scope** in the shared
  `$XDG_DATA_HOME/ensemble/holds/` root and the call resolves
  `{ verdict, note }` when any process — the launcher or not — writes the
  nonce-correlated decision file the record names (hand-writable plain
  JSON). The scope is an opaque key the launcher supplies — the `holdScope`
  library option or `--hold-scope` flag, outranking the inherited
  `ENSEMBLE_HOLD_SCOPE` variable a lead sets once — and a keyless run's
  holds land in the default shared scope. Stale nonces, unlisted verdicts,
  and malformed answers are rejected and the hold keeps waiting; an
  optional timeout rejects with `HoldTimeoutError`. Open holds appear in
  the live status snapshot and the `ensemble holds [--json]
  [--scope <scope> | --all]` listing — one scope's view, or machine-wide
  across every scope — a hold whose raiser is provably dead is retired by
  the machinery that observes it, and every raise, answer, rejection,
  timeout, and retirement lands in the archive manifest's `hold_events`.
  `ensemble holds answer <hold-id> --verdict <v> [--note <n>]` writes that
  same decision file and reports whether the raiser consumed it, bounced it
  (with the reason), has not read it yet, or settled without judging it
  (`retired`, exit 6; the stale decision file is removed).
- `parallel(thunks)` runs all thunks concurrently and returns all results. A
  dispatched worker's failure is already the leg's own `null` (it never
  reaches the combinator as a throw); a thunk that throws for any other
  reason becomes `null` in the returned array and is still logged, except
  that a pre-spawn author error — a rejected `agent()` option, a malformed
  schema, an unresolvable `workflow()` reference, non-JSON `workflow()`
  arguments, a nesting violation — propagates and fails the run. The
  option check names every invalid option found on one call. A schema object
  that refers to itself is refused with the cycle's location before dispatch;
  recursive JSON Schema `$ref` values that compile remain accepted, while a
  ref-only cycle that overflows compilation is named as a cycle. The documented route for
  telling a failed leg from one that legitimately
  answered `null` is `identity: true`: an identified call resolves
  `{ label, phase, output, failure }`, and `failure` is `null` exactly when
  the worker's own settlement completed — a collapse (a dispatched worker's
  failure on either shape, or a thunk collapsed in the combinators) carries a
  `{ message }` account there instead.
- `pipeline(items, ...stages)` runs each item through each stage independently,
  with no cross-item barrier between stages. Ordinary stage failures drop that
  item to `null`; the same pre-spawn author errors propagate.
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
- `tally(name, value)` records a named numeric count from the script body
  into the run record's manifest (`tallies`), beside the usage rollup: how
  many of a gate's inputs it accepted, how many fix rounds ran. Numbers
  only; a name recorded again replaces its value; a blank name or a
  non-finite value throws before anything is recorded.
- `budget.spent(engine)` / `budget.remaining(engine)` expose per-engine token
  accounting, matching the names used by `agent()`. opencode accounts from the
  session export when available and from token-bearing step events on the stream
  fallback. Across multi-step turns it charges the final input and cache-read
  snapshot once, plus every output and reasoning delta; cache reads count on
  both paths. An older or truncated fallback stream without usable token data
  remains unmeasured and does not advance spend towards its ceiling.
- `worktrees` exposes changed worktrees left by `isolation: "worktree"` on any engine.
- `args` is the raw CLI string arguments, or the parsed JSON value from
  `--json-args '<json>'` or `--json-args @file`.

`ensemble workflows` lists saved workflows in the project and user registries,
printing prose on stdout with each workflow's `meta.name` and `meta.description`.
`ensemble holds` likewise lists open holds as prose on stdout; `ensemble holds
--json` emits JSON there. Workflow and direct-agent runs return JSON on stdout,
while help and version print text there. Diagnostics and rejected-invocation
guidance go to stderr. Files whose metadata
cannot be parsed are noted on stderr and skipped, so one bad saved workflow does
not hide the rest. A user-scope entry whose name is taken by a project-scope
entry is labelled `user (shadowed by project)` because name resolution will
select the project entry.

The agent skill teaching the hooks API and the invoke pattern is maintained
outside this repository, which keeps no copy of its guidance.
[`skills/ensemble-workflow/`](skills/ensemble-workflow/README.md) holds only the
built runtime bundle (`Base/scripts/ensemble.mjs`) and a usage brief for running
it directly. Any shell-capable orchestrator runs the same CLI that way.

## Live status

A run continuously publishes a small JSON snapshot of what it is doing — current
phase, per-engine active/queued/done/failed counts, per-engine token spend, and
the live worker list — to its **own file** in the status directory,
`.claude/ensemble.<run-uuid>.local.json` under the run's working directory,
written atomically so a reader never sees a half-written file. One file per run
is what keeps concurrent runs in one directory each observable for their own
lifetime: a later run never overwrites an earlier run's view, and a run ending
removes only its own file, so a watcher of one run is never told "nothing in
flight" because another finished. The default is present-only: Ensemble writes
into `.claude/` only when that directory already exists, and never creates it.
Each file is live-only and removed when its run finishes; the next run's
startup sweep removes any file whose writer is provably dead (below), so on an
idle machine the directory holds no status files. It is the producer half of a
faithful one-line compression of Claude Code's `/workflows` view; it is *not*
the live tree, and it adds no script-facing API (`phase()`/`log()` are
unchanged).

The side-channel is an ambient, environment-level concern, so it is configured by
environment variable rather than a run-tuning flag:

- `ENSEMBLE_STATUS=off` (or `0`/`false`/`no`) disables it.
- `ENSEMBLE_STATUS_DIR` overrides the directory; as with the default, it is
  honoured only when the path is an existing directory.

Consumers list the directory for `ensemble.*.local.json` and parse each file
directly; Ensemble deliberately provides no rendering command. A reader
decides liveness by evidence, in this order: (1) a file whose `owner` is
**refuted** — same host, `start_ticks` recorded, and the pid either gone or
running with different start ticks — is a killed run's leftover, not a run
(`snapshotOwnerGone` implements the rule; the writer's own startup sweep
applies it too); (2) a file whose owner cannot be judged (another host,
`start_ticks: null`) falls back to age — treat a snapshot whose `updatedAt` is
more than 30 seconds old as stale, since the writer refreshes a quiet live run
every 10 seconds; (3) everything else is a run in flight. A consumer with no
proc filesystem to judge from applies rule (2) alone. Per-engine spend must
remain separate because the engines denominate different, non-comparable cost
models. A runtime older than schema 2 published one shared `ensemble.local.json`
for every run; readers that still meet one may parse it under the same rules,
and the sweep retires it on the same evidence.

### `ensemble.<run-uuid>.local.json` schema

Each status file is a published interface for status consumers. It contains one
JSON object with these fields:

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
  `opencode` in v1). Each entry has numeric `active`, `queued`, `done`,
  `failed`, and `spent`; `cap`, `ceiling`, and `remaining` are numbers or
  `null`. Spend and ceilings are per-engine and are never summed.
- `agents`: array of live worker objects, capped for file size. Each object has
  numeric `id` and `attempt`, `engine` (`"codex"`, `"claude"`, or
  `"opencode"`), `state` (`"queued"` or `"running"`), nullable string
  `label` and `phase`, and two liveness stamps (numbers or `null`, Unix epoch
  milliseconds): `startedAtMs`, when the worker left the queue and began
  executing, and `firstEvidenceAtMs`, when the engine first observed the
  worker produce output. The stamp is earliest-wins and never updated, so
  the supported reading is: a leg running long with **no** evidence at all
  has never produced output and is suspect; a leg with evidence has
  produced output at least once. The fields do not distinguish a leg
  streaming now from one that stalled after its first output.
- `holds`: array of open decision holds, empty when the run is not waiting.
  Each object has string `id`, string `content` (bounded to 500 characters;
  the hold file carries the full text), string-array `verdicts`, and numeric
  `raisedAtMs` (Unix epoch milliseconds).

The published file also carries an `owner` object (`host`, `pid`,
`start_ticks`) — the writer's own liveness evidence, added at publication
rather than being part of the in-memory snapshot — so a poller can refute a
snapshot a killed run left behind by the rule above (`snapshotOwnerGone`
implements the judgement).

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
      "attempt": 1,
      "startedAtMs": 1766491209000,
      "firstEvidenceAtMs": 1766491211200
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

## Durable run record

By default, a run writes a permanent archive of what happened. This is separate
from the run's `.claude/ensemble.<run-uuid>.local.json`: the status file is
live-only and removed at the end; the run record is archival and kept for audit
and for tools that evaluate runs after the fact.

The archive is an ambient, machine-level data store, configured by environment:

- Default: `$XDG_DATA_HOME/ensemble/`, or `~/.local/share/ensemble/` when
  `XDG_DATA_HOME` is unset.
- `ENSEMBLE_RUN_RECORD=off` (or `0`/`false`/`no`) disables recording.
- `ENSEMBLE_RUN_RECORD_DIR` names the **data home** (the store root, `$STORE`
  below), not the `runs/` subtree — archives land under `$STORE/runs/cwd/…`,
  so a value ending in `runs` produces a `runs/runs/` path by design. If
  this variable is unset, the default data-home path is still used; unset
  never means disabled.

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
`failed`, `timed-out`, `interrupted`, or `incomplete`. A stopped run therefore
leaves a usable partial archive.

At the seal the writer re-reads every file its integrity table declares. A
file that has gone missing, or whose size no longer matches what was hashed,
is recorded in `integrity.files_lost` rather than passed over, and a run that
would otherwise have sealed `complete` seals `incomplete` instead: the
manifest may not assert a whole archive over files a reader cannot read. The
run's own outcome is unaffected — `result.json` still says how the run ended,
because how the run ended and whether its archive survived are two different
questions.

Every manifest write ends by attesting itself: `integrity.manifest_sha256` is
the SHA-256 of the manifest's own canonical form — ECMA-262 `JSON.stringify`
with two-space indent and no trailing newline, keys sorted recursively by
UTF-16 code unit (locale-independent by construction, never a collator's
ordering; integer-index keys come first in numeric order, as ECMA-262
property enumeration places them) — with that field set to
`null`. The rule itself rides the archive as `integrity.recipe`, the same
self-description discipline as the args' canonical artefact, so a cold
consumer needs nothing from this codebase to verify. (Archives written before
the `recipe` field sorted with the writer's locale collation; for these
documents' ASCII keys the orders agree under common locales, but only the
recipe-bearing form guarantees it.) `completion-sentinel.json`
carries the same self-attestation and recipe and, being written after the
seal, also
carries the sealed manifest's digest — the sentinel publishes that digest
only when the archive genuinely sealed, and otherwise says
`manifest-unsealed`, so it never vouches for a manifest a failed seal was
still going to rewrite. So the manifest is checkable against a
second file rather than only against itself. Both are self-attestations, not
signatures: no key material lives in the archive, so they catch an edited
field or a truncated write, not a forger who rewrites the digest too. A
reader walking the `files` table should treat it as untrusted input, as the
reference consumer does: refuse absolute or `..`-traversing paths and
symlinked entries — the archive attests its own bytes, never bytes a crafted
entry points at elsewhere.

A run that dies with its launcher — a kill the process cannot handle — never
writes its own terminal status, so the manifest records liveness evidence
instead of relying on age: an `owner` block (`pid`, `/proc` start ticks, and
hostname) written once at start. The next writer starting in the same
namespace reaps siblings whose recorded owner is provably gone — pid absent
from the process table, or start ticks that no longer match (pid reuse) —
rewriting `status` to the terminal `"abandoned"` with an `abandonment` block
naming what was observed, when, and by which run. Judgement is same-host and
evidence-only: an owner on another machine, or one recorded without a
readable proc filesystem, is left as written. A consumer need not wait for a
reap: the `owner` block is the evidence, so a cold reader applies the same
check itself — a terminal manifest is settled; an owner on this host whose pid
is absent, or whose start ticks no longer match, is dead; one present with
matching start ticks is live; and everything else, including a pid the reader
has no readable proc filesystem to check, is undecidable. That reading is a
consumer's to make, not an API the harness exports, and it lets a supervisor
tell a killed run from a running one at read time, on an archive nobody has
rewritten. A reap also resolves the run's own stranded agent records: every
`agent.json` still `in-progress` flips to `"abandoned"` carrying the same
`abandonment` block, because a dispatch-time record frozen at `in-progress`
would otherwise read as "no attempt ran, nothing spent" — a claim the death
made undecidable, not false. An abandoned agent record's attempts and usage
are exactly what was recorded before the death: their absence means
unobserved, never zero. Settled agent records are evidence and are never
rewritten.

### Run record schema

Every durable record artefact carries:

- `schema_version`: currently `4`. Version 4 replaces the agent record's
  `fallback_model` with the declared `fallback` chain and the `answered_by`
  target, gives every attempt its `target` and (when failed) its
  `classification`, and adds the manifest's script-recorded `tallies`;
  every attempt's `chain_decision` arrived later as an additive version-4
  field.
  Version 3 rewrote usage rollups in the declared summary vocabulary keyed
  per served model; `strip`, `owner`, and `transcript_capture` arrived
  later as additive version-3 fields. Version 2 added worktree provenance
  and cross-engine token derivations over version 1.
- `kind`: one of `run_manifest`, `run_args`, `workflow_args`, `run_result`, or `agent_record`.

The completion sentinel (`completion-sentinel.json`) is a separate artefact
with `kind: "completion_sentinel"` and its own `schema_version` (currently
`3`); it is supervision surface, not a record member, and is written even
when durable recording is disabled. The live status snapshot
(`ensemble.<run-uuid>.local.json`, schema `2`) is a third artefact family —
live-only and removed when its run finishes — documented under *Live status*
above.

The manifest is `manifest.json`. Its top-level fields are:

- `schema_version`: `4`.
- `kind`: `"run_manifest"`.
- `run_id`: namespaced run id.
- `run_uuid`: the runtime UUID before namespacing.
- `caller_identity`: opaque identity of the invoking session, or `null`.
- `namespace`: namespace strategy, id, hash, and local material.
- `status`: `"in-progress"`, `"complete"`, `"failed"`, `"timed-out"`,
  `"interrupted"`, `"incomplete"` (the run ended but files it archived were
  gone at the seal, see above), or `"abandoned"` (reaper-written only).
- `owner`: the writing process's liveness evidence — `pid`, `start_ticks`
  (`null` where no readable proc filesystem exists), and `host`.
- `abandonment`: present only on reaped manifests — `observed_at`, `reason`
  (`"owner-process-gone"`, or `"manifest-predates-owner-recording"` for
  archives written before owner evidence existed), and `observed_by`.
- `started_at` / `ended_at`: ISO timestamps; `ended_at` is `null` until final.
- `workflow`: original path, archived `workflow.js`, and SHA-256.
- `args`: the descriptive `args.json` envelope, the separately archived
  `canonical_archive_path` containing the exact canonical args JSON text, and
  its SHA-256. Consumers recompute `args.sha256` from that canonical artefact;
  it is not the hash of the envelope bytes.
- `meta`: raw workflow meta and `task` copied verbatim, or `null`.
- `cli_flags`: parsed run-tuning flags.
- `concurrency`: the effective agent ceiling and per-engine caps —
  `agent_ceiling` as `Resolved<number | null>`, `engines` as a partial map of
  engine name to `Resolved<number>` — each recording the value and the layer
  that supplied it (`flag`, `env`, `config-file`, or `default`). The manifest
  has no separate top-level agent ceiling.
- `budget_ceilings` / `run_timeout_ms`: the effective per-engine token
  ceilings and whole-run timeout, each as `{ value, layer }` naming the
  layer that won — the same auditable shape as `concurrency` (both settings
  resolve from the flag alone today, so their layers are `flag` or
  `default`).
- `workflow_invocations`: the root workflow and every composed child it
  invoked, in call order. Each entry carries an ordinal (0 for the root),
  a parent link (`null` for the root, the invoking entry's ordinal for a
  child), the original path, the archived source with its SHA-256, and the
  archived args with their canonical path and SHA-256 — recorded before the
  child runs, so a partial archive still knows what was invoked.
- `hold_events`: the run's hold lifecycle (raise, accepted answer, rejected
  answer, timeout, and dead-raiser retirements this run's sweep observed)
  in event order, each entry carrying `hold_id`, `event`,
  `verdict`/`reason` where applicable, and a timestamp. An `answered`
  entry also carries `answered_by` (the answerer the decision file named,
  or null when it named none) and the decider's `note` (or null).
- `tallies`: `name -> number`, the counts the script recorded through the
  `tally` hook, stored verbatim (last write per name wins) and present in
  the manifest from the moment each is recorded — a count recorded before
  the run ended is in the archive whether or not the run finished cleanly.
  `tallies_unavailable` is `"none-recorded"` while the map is empty and
  `null` once the script records a count, including zero.
- `git`: start/end HEAD, dirty flag, and archived diff path when dirty;
  all-`null` outside a git repository.
- `environment`: OS, Node, and available tool versions.
- `harness`: package name/version and git commit of the harness checkout.
  `commit_unavailable` is `null` when the commit is known; a standalone
  bundle carries `"bundle-has-no-embedded-commit"`, and a checkout whose
  HEAD cannot be read carries `"git-head-unavailable"`. The workflow's
  checkout is never substituted for the harness checkout.
- `result`: archived `result.json` path and exit code once final.
- `error`: the `{ kind, message }` of whatever ended the run — a script fault,
  an unknown engine, a budget refusal, a whole-run timeout — or `null` when the
  run ended cleanly. Present on both the manifest and `result.json`. A budget
  refusal at a ceiling of 0 reads `Token budget for <engine> is 0, which admits
  no agent: this agent was not started`; a spent ceiling reads `Token budget
  exhausted for <engine>: spent N of M tokens`. A Codex schema rejection
  recorded on an agent attempt's `failure.message` names `claude` and
  `opencode` as the engines to move to and carries the app-server diagnostic
  once — the payload's echo of the message reads `"(the diagnostic above)"`.
- `cost_rollup`: `engine -> model -> usage`, never a cross-engine total. Spend
  keys under each attempt's *own target engine* and *served* model — an agent
  whose fallback chain advanced across engines books each attempt under the
  engine that ran it — the literal `"unresolved"` when no served model was
  ever learned, never the requested pin. Cost entries carry
  `amount`, `currency`, and `source: "provider-reported"` — the only source
  there is, because the harness never estimates money. A bucket with no
  provider figure carries no amount at all: it reads
  `{ "unavailable": "no-provider-cost-reported" }`, or
  `{ "unavailable": "unlike-currencies" }` where the attempts under one served
  model reported spend in currencies that cannot be added. The reason is stated
  rather than an amount-less entry a consumer cannot tell from zero. Each
  dispatched engine/model with no usage observation has
  `{ "unavailable": "no-usage-reported" }` instead of a zero-token summary;
  a run with no dispatched worker keeps an empty roll-up. Each
  `tokens` object uses one declared vocabulary: `freshInputTokens` (uncached
  input), `cachedInputTokens` (the combined cache figure for admission and
  total reconciliation, not a pricing class when it combines reads and writes;
  use the optional `cacheReadTokens` / `cacheCreationTokens` split where the
  engine separates them), `outputTokens` (excluding reasoning where separable),
  `reasoningOutputTokens` (`null` when the engine does not separate reasoning,
  never zero — `null` means "not knowable", zero means "no reasoning spend"),
  and `unclassifiedTokens` (spend the engine's total covers but no declared
  class does) — disjoint classes summing to `totalTokens` by construction. Each
  engine's native fields are mapped under one inclusion rule: Codex reports
  cached within input and reasoning within output, so both are subtracted out;
  Claude and opencode report them separately, with Claude's reasoning not
  separable (`null`). The engine-native usage events remain per attempt beneath
  the summaries, untouched. Figures are never summed across engines.
- `files`: integrity table for archived artefacts, each with `path`, `size`, and
  `sha256`. `manifest.json` is excluded to avoid self-hashing recursion; it
  attests itself instead (see above).
- `integrity`: `algorithm` (`"sha256"`), `recipe` (the digest verification
  rule, stated in the archive itself), `manifest_sha256` (the manifest's own
  self-digest), and `files_lost` — one `{ path, reason }` entry, sorted by
  path, for each declared file that was `missing` or a `size-mismatch` at the
  seal. Empty on a whole archive.

Agent records live at `agents/<zero-padded-id>/agent.json`:

- `schema_version`: `4`.
- `kind`: `"agent_record"`.
- `id`, `creation_order`, `concurrency_group` (the last target's admitted
  engine group; initially the requested engine, and the answering engine's
  group when a fallback answers).
- `header_identity`: `"original_request"` identifies what the top-level
  `engine`, `model`, and `effort` fields describe.
- `engine`, `model`, `effort` (what was asked for — the canonical level),
  and `resolved_model` / `resolved_effort` — what was actually served, as
  the engine itself reported it: Codex's `thread/start` answer (the pin is
  sent as thread config, so the answer confirms it), or the `model` and
  `effort` fields Claude Code writes on each assistant transcript entry;
  `null` when the engine reported none — never an echo of the request.
  Attempts carry `resolved_effort` too, since a retry may be served
  differently from the attempt before it.
- `fallback`: the declared fallback chain — the `[{ engine, model, effort? }]`
  list as the call or its engine defaults declared it — or `null`.
- `answered_by`: which target answered — `{ entry, engine, model }`, `entry`
  being `-1` for the call's own target and the chain index thereafter, and
  `model` being the answering attempt's observed served model (`null` if the
  engine did not report one) — or `null` while no attempt has completed (a
  failed agent names none). Read beside each attempt's `target`, this is how
  a run that silently ran its "Codex" legs on Claude is legible after the fact.
- `prompt`: the agent's prompt text.
- `options`: `{ timeout_ms, max_attempts }`.
- `resolved_cwd`, `isolation` (`null` when unused).
- `worktree`: isolated worktree `branch`, `base_commit`, `tip_commit`,
  `changed`, and `removed` — or `null`.
- `label`, `phase`, and `status`. Agent status is `"in-progress"`,
  `"complete"`, `"failed"`, `"timed-out"`, `"interrupted"`, or `"abandoned"`;
  `"abandoned"` means no agent outcome was observed: written by the run's own
  close when it ended while the dispatch record was still being persisted,
  and by the reaper — with an `abandonment` block naming what was observed,
  when, and by which run — for a record a killed run left `"in-progress"`.
- `termination_cause`: the `{ kind, message }` that settled this agent at that
  status when the runtime decided it — a run that ended under the worker, or a
  deadline the runtime enforced — and `null` when the attempts already name the
  cause. Two deadline kinds are distinguished, because they fail for different
  reasons: `"turn-timeout"` is the per-agent turn deadline expiring, meaning the
  worker was still going when its own time ran out; `"request-timeout"` is a
  transport request deadline expiring, meaning the engine never answered a
  request the client had sent. A consumer telling one from the other is telling
  a slow worker from an unresponsive engine.
- `schema`: requested JSON Schema for schema agents, otherwise `null`.
- `strip`: requested capability names and resolved enforcement routes.
- `session`: the run-scoped held-worker ordinal and this record's turn number,
  or `null` for a one-shot call.
- `transcript_capture`: what an engine's capture path observed for this turn:
  `"retained"`, `"lost"`, or `null` when the engine does not report capture
  state. An observed `"lost"` capture is the only route to
  `"session-client-capture-gap"` when no transcript was archived.
- `parse_route`: `"direct"`, `"object-fallback"`, `"array-fallback"`,
  `"scalar-line"` (a line holding nothing but one JSON scalar — the shape a
  fenced or prose-wrapped `null`, `false`, `0`, or `""` takes), or `null`.
- `decode_failure`: `{ byte_length, line_prefix }` or `null`.
- `raw_output`: final raw model text, or the latest raw failed output;
  `null` means no output was produced, while `""` means the worker answered
  with empty text.
- `validated_output`: validated object/text result, or `null` on failure.
- `usage`: summary in the declared vocabulary, or `"unavailable"` with reason
  (`"no-attempt-ran"`, `"engine-reported-no-usage"`).
- `queued_ms`, `execution_ms`.
- `attempts`: array. Each entry: `attempt` (1-based, numbering every
  dispatch the call made — refused ones included), `status`, `target`
  (`{ engine, model }` — the engine and requested pin this attempt was
  dispatched to; the call's own until the chain advances), `started_at`,
  `ended_at`, `duration_ms`, `first_delta_ms`, `raw_output`, `validated_output`,
  `resolved_model` (including the observed model of a held worker on later
  turns), `resolved_effort`, `failure` (`{ kind, message }` or
  `null`), `classification`, `chain_decision`, `observed_failure`, `diagnostics`,
  `app_server_diagnostic`, `token_usage_events`, `worker_exit`. Where the
  run's own settlement ended the turn, the attempt's `failure` names that
  settlement and `observed_failure` keeps the transport symptom the turn saw
  (a closed app-server, an aborted poll); `observed_failure` is `null` when
  the engine's own failure is the cause.
- `classification` on a failed attempt: `{ class, rule }` — `class` is
  `"availability"` (the engine refused or lost the worker before it
  answered: allowance exhausted, provider overload past its own retry, a
  dead or unstartable substrate — the one class that advances a fallback
  chain and consumes no attempt), `"output"` (the worker answered badly:
  empty, unparseable, off-schema — retried in place), or `"unclassified"`
  (including a Codex rejection of the authored schema before generation);
  `rule` names the classifier rule that matched (`codex.usage-limit`,
  `claude.rate-limit`, `codex.substrate-dead`, `run-settlement`, …) and is
  `null` only when no rule recognised the diagnostic — the archive's tell
  that the table has gone stale as an engine reworded its errors. The raw
  diagnostic stays in `failure`, `app_server_diagnostic`, and `diagnostics`
  beside it, never folded into a class. `null` on a complete attempt.
- `chain_decision` on a failed attempt of a call that declared a `fallback`
  chain: the decision the harness took after it — `"advanced"` (an
  availability failure with a later entry remaining: the call moved to that
  entry, spending none of the bound), `"retried-in-place"` (another attempt
  on the same target), `"exhausted"` (nothing left to try: the call settles
  on this failure), or `"chain-not-consulted"` (the classifier recognised
  nothing — `classification.rule` is `null` — while a later entry remained,
  so the chain, which advances on availability alone, was not asked; any
  further attempt stays in place). `null` on a complete attempt, on every
  attempt of a call with no chain, and on an attempt the run's own ending
  cut short.
- `transcripts`: array. Each entry: `attempt`, `path`, `format`, `source`,
  `session_id`, `thread_id`, and `partial` (`true` when the turn ended before
  completion, otherwise `false`); empty when none were archived.
- `transcripts_unavailable`: `null` when `transcripts` has entries, otherwise
  the absence reason: `"no-attempt-ran"`, `"worker-interrupted"`,
  `"worker-timed-out"`, `"substrate-never-started"`, `"session-client-capture-gap"`, or
  `"engine-produced-no-transcript"`. The reason names an observed capture
  loss only when `transcript_capture` is `"lost"`; it does not infer one from
  a held session's turn number.

Codex transcripts are captured from the app-server stream because threads are
ephemeral: the archive records the prompt-bearing `turn/start` request and every
scoped app-server notification through completion. Claude transcripts are copied
from the background session JSONL before the session is removed. opencode
transcripts preserve the `opencode run --format json` event stream plus the
session export when available.

The record contains only run and audit data. It does not score outputs, infer
verifier relationships, or record evaluation concepts; those belong to the
tools that consume it.
