# Ensemble runtime bundle — usage

This directory ships one artefact: `Base/scripts/ensemble.mjs`, the
self-contained launcher for the Ensemble CLI, built from `src/` by
`npm run build:skill`. The skill that teaches workflow authoring and
orchestration is maintained separately and is not mirrored here; this file
covers only what the runtime itself does, derived from `src/`.

All invocation paths below are relative to the repository root — the parent
of `skills/`. A cold consumer given the bundle beside this file can resolve
the launcher as `Base/scripts/ensemble.mjs` from within this directory, or
as `skills/ensemble-workflow/Base/scripts/ensemble.mjs` from the repository
root.

## Quick start

The simplest invocation dispatches one worker without a script:

```sh
node skills/ensemble-workflow/Base/scripts/ensemble.mjs agent \
  --engine codex --model gpt-6-luna 'Say hello in one sentence.'
```

> [!WARNING]
> Every worker is unrestricted by default — it can read and write wherever
> the user running the harness can and can reach the network. `strip` is the
> opt-in exception (see the options table below).

Stdout is the result as JSON — here, a JSON-encoded string:

```
"Hello!"
```

Stderr carries the completion-sentinel path and, when recording is enabled,
the archive announcement (the second line is elided — it is a single JSON
object with `run_id` and `archive_path`):

```
[sentinel] will write /home/user/.local/share/ensemble/runs/cwd/0123456789abcdef01234567/00000000-0000-4000-8000-000000000000/completion-sentinel.json when the run ends
…
```

A workflow script dispatches multiple workers with coordination. The script
must begin with the `export const meta` statement — anything before it, a
comment included, is rejected before any worker spawns:

```js
export const meta = { name: "hello", description: "one-worker demo" };
const answer = await agent("Say hello in one sentence.", {
  engine: "codex",
  model: "gpt-6-luna",
});
return answer;
```

```sh
node skills/ensemble-workflow/Base/scripts/ensemble.mjs hello.js
```

## Invocation

There is no `ensemble` binary on `PATH`. Run the bundle with Node (>= 24.14.0;
older Nodes exit 1 with a version error):

The synopsis below is the product's own usage output, printed on stderr when the
bundle is invoked with no arguments. It names the program as you invoked it —
`node ensemble.mjs` here; a `bin` shim or symlink is named as itself:

```
Usage: node ensemble.mjs [run options] <script.js> [args...]
       node ensemble.mjs agent --engine <engine> [agent options] [prompt]
       node ensemble.mjs workflows
       node ensemble.mjs holds [--json] [--scope <scope> | --all]
       node ensemble.mjs holds answer <hold-id> --verdict <verdict>
                         [--note <note>]

Run options (before the script path):
  --json-args '<json>|@file'  --budget engine=N  --concurrency engine=N
  --agent-ceiling N|null  --timeout ms  --strip capability
  --caller-identity <identity>  --hold-scope <scope>
Agent options (after agent, before the prompt):
  --model <model>  --effort <effort>  --label <label>  --phase <phase>
  --cwd <path>  --isolation worktree  --identity  --schema '<json>|@file'
  --max-attempts N  --task <identity>  --strip capability  --budget engine=N
  --agent-ceiling N|null  --concurrency engine=N  --timeout ms
  --caller-identity <identity>  --hold-scope <scope>
The prompt is the one positional argument, or stdin when omitted.
Run `node ensemble.mjs --help` for orientation; each subcommand answers --help.
```

- `--json-args` replaces the positional string args with a parsed JSON value
  (`@file` reads the JSON from a file).
- Workflow tuning flags must precede the script path. To pass a script argument
  that has the same spelling as a tuning flag, put `--` before the script path:
  `-- <script.js> --json-args`.
- `--budget engine=N` sets a per-engine token-spend threshold checked at
  dispatch; `--concurrency engine=N`
  caps that engine's parallel workers. Both repeatable, one engine each.
- `--agent-ceiling N` caps all workers in the run across every engine. It is
  unset and unbounded by default; `--agent-ceiling null` explicitly lifts a
  lower-layer machine ceiling for one run. Scalar flags may be supplied once;
  repeat only `--budget`, `--concurrency`, and `--strip`.
- `--timeout ms` is the whole-workflow deadline, distinct from a per-call
  `timeoutMs` inside the script. At most 2147483647 (the 32-bit timer bound);
  a larger value is a usage error.
- `--caller-identity <identity>` records the opaque identity of the invoking
  session. It applies to both workflow and direct-agent runs and outranks
  `ENSEMBLE_CALLER_IDENTITY` when both are supplied.
- `--hold-scope <scope>` sets the scope key for holds raised during the run,
  on both workflow and direct-agent forms. See the *Holds* section below.
- `agent` runs one worker without a script. Supply its non-empty prompt as the final
  argument, or omit the argument and pipe the prompt on stdin; put run-tuning
  flags after `agent` and before that prompt. `--schema`
  accepts inline JSON or `@file` and prints the same validated value that
  `agent()` returns in a workflow. `--max-attempts` overrides the per-call
  retry bound (default 3), as `maxAttempts` does in a script. `--label` and
  `--phase` annotate the worker in progress output and its durable run record.
  There is no direct-agent fallback flag: a fallback chain is a script-side
  declaration (`fallback` in `agent()` or `defaults`), and the retired
  `--fallback-model` exits 2 with a one-line retirement message pointing to
  that declaration. `--task` copies an optional identity into the run record
  for benchmark grouping.
- `--strip capability` (repeatable) strips a named tool-surface capability —
  `skills` or `agents` — from workers. Before a workflow script it applies
  run-wide to every `agent()` call; on the `agent` subcommand it applies to
  that worker. Enforcement and failure semantics are the `strip` option's
  (see the options table).
- Direct-agent `--cwd` must name an existing directory (a missing one is a
  rejected invocation: exit 2, nothing written), and `--isolation worktree` uses the same placement
  lifecycle as a scripted call. An isolated run reports its branch on stderr;
  a branch containing changed work is retained for recovery.
- `workflows` lists saved workflows from `.claude/ensemble/workflows/`
  (project) and `$XDG_DATA_HOME/ensemble/workflows/` (user); unparseable
  entries are noted on stderr and skipped. Its listing is prose on stdout.
- `holds` lists open decision holds as prose on stdout; `holds --json` prints
  the full records as JSON on stdout. `holds answer` answers an open hold from
  the CLI — see the *Holds* section below. Help and version print text on
  stdout. Diagnostics go to stderr.

Exit 0 prints the script's return value, or the direct agent's return value, as
JSON on stdout — always JSON, every return type. A schema agent's structured
object prints as a JSON object; a schema-less worker's plain-text answer prints
as a JSON string (with the enclosing double quotes that `JSON.stringify`
produces), so a shell caller consuming the output with `jq -r .` or similar
recovers the original text. The return value and any `workflow()` arguments must
be JSON values: a function, a symbol, a cycle, or a BigInt fails the run at
settlement with the offending path named (one clean line, exit 1), never a lossy
approximation. A `toJSON` method is honoured as `JSON.stringify` would, but the
return value crosses a structured-clone boundary first, so a `toJSON` on a
class prototype does not survive to settlement — return plain data instead.
A script with no top-level return prints `null`, and JSON's own mappings
(`undefined` properties vanish; `Infinity` from `budget.remaining` on an
unbounded engine prints as `null`) remain permitted. A run that ends without
its script returning — the script threw, the whole-workflow `--timeout`
expired, SIGINT or SIGTERM stopped it — prints a partial-result envelope
instead:
`{"partial":true,"reason":"failed"|"timed-out"|"interrupted","error":{"kind","message"},"completed":[...]}`
with every successfully finished worker's output and, in `error`, the same
`{ kind, message }` the manifest and the sentinel carry for what ended the
run — so a consumer capturing stdout learns why without scraping stderr. Its
exit code is 1 for a failure or timeout and the shell convention for a
signal — 130 for SIGINT, 143 for SIGTERM — recorded identically in the
manifest, `result.json`, and the sentinel. A direct agent (either shape) that
exhausts its attempts also exits 1 with this envelope rather than printing
bare `null` — with no script to receive the value, the collapsed worker is
the run's failure. If the schema accepts JSON `null` and the worker
returns it successfully, the direct command instead exits 0 and prints
`null`.

On every ending, returned or salvaged, the launcher exits once its own
terminal work is done — the result or envelope printed, the record sealed,
the sentinel written, the workers torn down — whatever timers or handles the
script body left pending: the body is ordinary Node, and a forgotten
`setTimeout` neither holds the caller's shell for its remaining duration nor
lets `--timeout` announce a deadline it does not enforce.

Exit 2 is a rejected invocation: a usage error in the flags, a workflow
script path that cannot be read, or a direct agent's `--cwd` that is not an
existing directory. A rejection is decided before a run begins, so it leaves
nothing behind — a named one-line diagnostic on stderr, or usage on stderr
for an invocation that named no work or surplus arguments to `workflows`;
nothing on stdout, no sentinel announced or written, no archive. Every ending
after that point is a run ending, with the envelope, archive, and sentinel above.

## Ambient settings

The agent ceiling, each engine's concurrency cap, the durable archive, and the
live status snapshot resolve independently through these layers:

1. CLI flag, for the ceiling and concurrency caps only.
2. `ENSEMBLE_` environment variable.
3. `$XDG_CONFIG_HOME/ensemble/config.json` (normally
   `~/.config/ensemble/config.json`).
4. Built-in default.

The optional machine file uses schema version 1:

```json
{
  "schema_version": 1,
  "agent_ceiling": 2,
  "concurrency": {
    "codex": 4,
    "claude": 2,
    "opencode": 1
  },
  "run_record": {
    "enabled": true,
    "dir": "/path/to/records"
  },
  "status": {
    "enabled": true,
    "dir": "/path/to/existing/status-directory"
  },
  "worker_environment": {
    "claude": { "ANTHROPIC_BASE_URL": "https://gateway.example" },
    "codex": { "OPENAI_BASE_URL": "https://codex-gateway.example" }
  }
}
```

`worker_environment` declares environment variables the harness injects into
the workers it dispatches, scoped per engine — a variable declared for
`claude` reaches Claude workers only. Injected values override inherited ones
for that engine's workers; everything undeclared still inherits from the
launching process. This section lives in the config file alone — there is
deliberately no `ENSEMBLE_` variable or CLI flag for it, because its purpose
is to hold for runs whose parent environment cannot be relied on. Values must
be strings; unknown engines and non-string values fail the run loudly.
Claude workers are served by Claude Code's per-user daemon, whose environment
predates the run, so the harness delivers their declarations through a
private per-dispatch settings file (`claude --bg --settings`) whose `env`
block Claude Code layers additively over the operator's own settings —
declared keys win collisions, nothing else is touched, and the file is
removed when the session stops.

Every numeric value must be an integer of at least 1. The file is strict: an
unsupported `schema_version`, unknown key, invalid value, unreadable file, or
invalid JSON stops the run before a worker starts and names the file and key
where applicable. An absent file is normal and silent.

Environment variables are `ENSEMBLE_AGENT_CEILING`,
`ENSEMBLE_CONCURRENCY_CODEX`, `ENSEMBLE_CONCURRENCY_CLAUDE`,
`ENSEMBLE_CONCURRENCY_OPENCODE`, `ENSEMBLE_RUN_RECORD`,
`ENSEMBLE_RUN_RECORD_DIR`, `ENSEMBLE_STATUS`, and `ENSEMBLE_STATUS_DIR`.
A malformed value is refused before the run starts, naming the variable, the
accepted form, and the value it got.
`ENSEMBLE_CALLER_IDENTITY` is separate from those runtime settings: when
present, it records the invoking session's opaque identity in the manifest;
an explicit `--caller-identity` wins. With neither, `caller_identity` is
`null`, and this does not change the manifest's `meta.task` grouping key.
`ENSEMBLE_AGENT_CEILING=null` explicitly restores an unbounded run over a
machine-file value. Other values that are not positive integers, including `0`,
fail loudly.
The record and status switches accept `on`/`off`, `true`/`false`, `yes`/`no`,
or `1`/`0`; malformed values fail rather than falling back.
`ENSEMBLE_RUN_RECORD_DIR` names the **data home** (the store root, `$STORE`
below), not the `runs/` subtree — archives land under `$STORE/runs/cwd/…`,
so a value ending in `runs` produces a `runs/runs/` path by design. The
default data home is `$XDG_DATA_HOME/ensemble` (normally
`~/.local/share/ensemble`). A composed run stays one run: the manifest's
`workflow_invocations` lists the root and every `workflow()` child in call
order — each with its archived source and arguments, their hashes, and a
parent link — recorded before the child runs. Each args entry names a
`canonical_archive_path` whose exact canonical JSON text is what
`args.sha256` covers, so an archive consumer can verify it without the
writer. The root's `meta.task` remains the single grouping identity.

Summary usage in the record (schema version 3) uses one declared vocabulary:
`freshInputTokens`, `cachedInputTokens`, `outputTokens`,
`reasoningOutputTokens`, and `unclassifiedTokens` — disjoint classes summing
to `totalTokens`, each
engine's native fields mapped under one inclusion rule (Codex reports cached
within input and reasoning within output; the summary subtracts both out).
`cachedInputTokens` remains the combined cache figure used for admission and
total reconciliation; it is not a single pricing class when it includes both
cache reads and writes. Where the engine separates those costs,
`cacheReadTokens` and `cacheCreationTokens` partition it; either optional
field being absent means that part is not separable, never zero.
`reasoningOutputTokens: null` means the engine does not separate reasoning —
not zero; Claude's transcript-derived events do not separate it, so their
summary is `null` and carries the whole generation in `outputTokens`.
`unclassifiedTokens` is spend the engine's total covers but no declared class
does — opencode steps carrying only a `total` are the known case; naming it
keeps the summary honest, so no class absorbs tokens by lying about what they
were and no reported spend is erased into an all-zero summary. The
manifest's `cost_rollup` keys spend per engine and per *served* model (the
literal `unresolved` when no served model was ever learned, never the
requested pin); its cost entries are `provider-reported` figures only, and a
bucket with no provider figure reads `unavailable` with the reason
(`no-provider-cost-reported`, `unlike-currencies`) rather than an amount-less
estimate. Agent records record `resolved_effort` beside `resolved_model`, at
record and attempt level. Each agent record carries its own `usage` — the
summary, or `unavailable` with the reason
(`no-attempt-ran`, `engine-reported-no-usage`) so an agent with no usage data
is never indistinguishable from a zero-spend one. The engine-native usage
events remain per attempt beneath the summaries, untouched. On Claude, the
budget charges a per-component high-water mark on each compacted turn's
input snapshot, so budget spend can only grow even when the input side
shrinks between turns; the archived usage event carries the last assistant
entry's actual snapshot instead. Budget and archive can therefore disagree
on fresh input by design — the budget is conservative, the archive is
faithful. Status
defaults to the run's `.claude` directory only when that directory already
exists; an explicit status directory must also
already exist.

## Live status snapshot

While a run is active, Ensemble writes `ensemble.<run-uuid>.local.json` — a
small JSON object describing that run's current state — atomically to the
status directory. One file per run: concurrent runs in one directory are each
visible for their own lifetime, a later run never overwrites an earlier one's
view, and a run ending removes only its own file. A consumer lists the
directory for `ensemble.*.local.json`. The full schema and a worked example
are in the source repository's root README (outside this bundle); the fields
are:

- `schema`: `2`.
- `runId`: string.
- `pid`: number, the launcher process id.
- `workflow`: string or `null` (from `meta.name`).
- `state`: `"running"` or `"finished"`.
- `startedAt`, `updatedAt`, `finishedAt`: Unix epoch milliseconds; `finishedAt`
  is `null` until the run ends.
- `currentPhase`: string or `null`.
- `totals`: `{ active, queued, done, failed }` — numeric counts across all
  engines.
- `engines`: object keyed by engine name (`codex`, `claude`, `opencode`). Each
  entry carries numeric `active`, `queued`, `done`, `failed`, and `spent`;
  `cap`, `ceiling`, and `remaining` are numbers or `null`. Spend and ceilings
  are per-engine and never summed.
- `agents`: array of live worker objects, each with numeric `id` and `attempt`,
  string `engine`, `state` (`"queued"` or `"running"`), nullable string `label`
  and `phase`, and two liveness stamps (`startedAtMs`, `firstEvidenceAtMs`) as
  Unix epoch milliseconds or `null`. `firstEvidenceAtMs` is earliest-wins: a
  worker with no evidence stamp has never produced output.
- `holds`: array of open decision holds, empty when the run is not waiting.
  Each object has string `id`, string `content` (bounded to 500 characters;
  the hold file carries the full text), string-array `verdicts`, and numeric
  `raisedAtMs` (Unix epoch milliseconds).
- `owner`: object (`host`, `pid`, `start_ticks`) — the writer's liveness
  evidence, so a poller can refute a snapshot a killed run left behind.

A reader judges liveness by evidence first: a file whose `owner` is refuted —
same host, `start_ticks` present, and the pid gone or running with different
start ticks — is a killed run's leftover, not a run (the next run's startup
sweep removes such files on the same evidence). Where the owner cannot be
judged (another host, `start_ticks: null`), treat a snapshot whose
`updatedAt` is more than 30 seconds old as stale; the writer refreshes a quiet
run every 10 seconds. Everything else is a run in flight. Runtimes before
schema 2 published one shared `ensemble.local.json`; the same rules read it.

## Durable run record

By default, every run writes a permanent archive (recording is disabled by
`ENSEMBLE_RUN_RECORD=off` or a null run-record directory). Archives are stored
under `$STORE/runs/cwd/<namespace-sha256>/<run-uuid>/`, where `$STORE`
defaults to `$XDG_DATA_HOME/ensemble/` (normally `~/.local/share/ensemble/`).
The full schema is in the source repository's root README under
*Run record schema* (outside this bundle); the key structures are summarised
here for quick reference.

Each durable record artefact carries `schema_version` (currently `4`) and
`kind` (`run_manifest`, `run_args`, `workflow_args`, `run_result`, or
`agent_record`). The completion sentinel (`completion-sentinel.json`) is a
separate artefact with `kind: "completion_sentinel"` and its own
`schema_version` (currently `3`); it is supervision surface, not a record
member, and is written even when durable recording is disabled. The live
status snapshot (`ensemble.<run-uuid>.local.json`, schema `2`) is a third
artefact family — live-only and removed when its run finishes — documented in
the *Live status snapshot* section above.

### Manifest (`manifest.json`)

An `in-progress` status is a claim that its writer was alive when it wrote,
and a launcher killed with an uncatchable signal can never amend it — so
every manifest carries the writer's `owner` evidence, and a reader with no
knowledge of how the run ended decides liveness by that evidence, in this
order: a terminal `status` is settled; an `in-progress` manifest whose
`owner.host` is this host, whose `owner.start_ticks` is recorded, and whose
`owner.pid` is either absent from the process table or running with
different start ticks (field 22 of `/proc/<pid>/stat`) is a **dead run** —
read it as abandoned, whatever the status says; one whose pid runs with
matching start ticks is live; and everything else (another host,
`start_ticks: null`, no readable proc filesystem on the reader's side) is
undecidable — never assumed live or dead. The next run's startup sweep in the
namespace applies the same rule and rewrites a provably-dead run's manifest
and stranded agent records to `"abandoned"`, so a cold reader arriving
after that sweep meets the verdict already written. The `files` table
(path, size, SHA-256 per artefact) and the canonical-form hashes of the
workflow source and arguments are present in every record and each
verifiable from the artefact alone.

Top-level fields: `run_id`, `run_uuid`, `caller_identity` (opaque invoker
identity or `null`), `namespace` (strategy, id, hash,
material), `status` (`"in-progress"`, `"complete"`, `"failed"`, `"timed-out"`,
`"interrupted"`, `"incomplete"`, `"abandoned"`), `owner` (`pid`, `start_ticks`, `host`),
`abandonment` (present on reaped manifests only), `tallies` (`name -> number`,
the counts the script recorded through `tally()`, last write per name
winning), `tallies_unavailable` (`"none-recorded"` while empty, otherwise
`null`), `started_at`/`ended_at` (ISO;
`ended_at` `null` until final), `workflow` (path, archived file, SHA-256),
`args` (envelope, canonical archive path, SHA-256), `meta` (raw workflow meta
and `task`, or `null`), `cli_flags` (parsed run-tuning flags),
`budget_ceilings` / `run_timeout_ms` (the effective per-engine token
ceilings and whole-run timeout, each as `{ value, layer }` — the same
auditable shape as `concurrency`),
`git` (start/end HEAD, dirty flag, diff path; all-`null` outside a git
repository), `environment` (OS arch/platform/
release, Node version, tool versions for claude/codex/git/opencode), `harness`
(package name, version, git commit, and `commit_unavailable` when a bundle
has no embedded commit or a checkout HEAD cannot be read), `result` (archive
path, exit code),
`error` (`{ kind, message }` or `null` — what ended the run; the source
repository's root README under *Run record schema* has the full description),
`cost_rollup`, `workflow_invocations`, `concurrency`, `files` (integrity table:
path, size, SHA-256 for each archived artefact; the manifest itself is excluded),
`integrity` (`manifest_sha256` self-digest, `files_lost` entries; the source
repository's root README under *Run record schema* has the canonical
semantics).

The effective agent ceiling is `concurrency.agent_ceiling`; no top-level
`agent_ceiling` appears in the manifest. A dispatched worker with no usage
observation gets a reason-bearing `cost_rollup` bucket under its engine and
served model, or `unresolved` when no served model was learned. A run that
dispatched no worker keeps an empty roll-up.

### Agent record (`agents/<id>/agent.json`)

Top-level fields: `id`, `creation_order`, `concurrency_group` (the latest
admitted target's engine group; the answering engine's group when complete),
`engine`, `model`, `effort` (the original request),
`header_identity: "original_request"` (labels those three fields),
`fallback` (the declared chain or `null`), `answered_by`
(`{ entry, engine, model }` naming the target that answered — `entry` is
`-1` for the call's own, and `model` is the observed served model or `null`
when unknown — or `null` on a failed agent), `resolved_model`
(`null` when unknown),
`label`, `phase`, `status` (`"in-progress"`, `"complete"`, `"failed"`,
`"timed-out"`, `"interrupted"`, `"abandoned"`), `prompt`, `schema` (requested
JSON Schema or `null`), `options` (max attempts, timeout), `resolved_cwd`,
`isolation`, `worktree` (branch, base commit, tip commit, changed, removed — or
`null`), `strip` (requested names and resolved enforcement routes),
`raw_output`, `validated_output`, `parse_route` (`"direct"`,
`"object-fallback"`, `"array-fallback"`, or `null`), `decode_failure`,
`usage` (summary or `"unavailable"` with reason), `queued_ms`, `execution_ms`.
For `raw_output`, `null` means no output was produced; `""` means the worker
answered with empty text. The same meaning applies to attempt records.

`attempts` is an array; each entry carries: `attempt` (1-based index over
every dispatch the call made), `status`, `target` (`{ engine, model }` the
attempt was dispatched to), `started_at`, `ended_at`, `duration_ms`,
`first_delta_ms`, `raw_output`, `validated_output`, `resolved_model`
(the observed held-worker model is carried across later turns),
`failure` (`{ kind, message }` or `null`), `classification` (`{ class, rule }`
on a failed attempt — `class` one of `availability`, `output`,
`unclassified`; `rule` the classifier rule that matched, or `null` when no
rule recognised the diagnostic — `null` on a complete attempt),
`chain_decision` (on a failed attempt of a call with a `fallback` chain, the
harness's decision after it: `advanced`, `retried-in-place`, `exhausted`, or
`chain-not-consulted` — see the fallback-chain bullet under Failure
semantics; `null` on a complete attempt, without a chain, or when the run's
own ending cut the attempt short), `diagnostics`, `app_server_diagnostic`, `token_usage_events` (engine-native
per-attempt events), `worker_exit`. The `cost_rollup` books each attempt
under its own `target.engine` and served model, so a chained agent's spend
lands where it was spent.

`transcripts` is an array; each entry carries: `attempt`, `path`, `format`,
`source`, `partial` (`true` if its turn ended before completion, otherwise
`false`), and engine-specific ids (`session_id`, `thread_id`).
`transcripts_unavailable` is `null` when that array has entries; otherwise it
names why it is empty. `substrate-never-started` means every recorded attempt
was refused before its worker existed.

## Script shape

A workflow script must begin with `export const meta = { name, description }`
as an object literal, optionally followed by
`export const defaults = { <engine>: { model?, effort?, fallback? } }`
(per-engine defaults; defined per-call options win; `fallback` is the same
ordered chain of `{ engine, model, effort? }` targets `agent()` accepts,
engine-agnostic — a Codex block may name a Claude target — and judged whole
at load). Blank lines, `//` comments
ending in LF, CR, CRLF, U+2028 LINE SEPARATOR, or U+2029 PARAGRAPH SEPARATOR,
and `/* ... */` comments may separate these exports; a
`defaults` export declared later in the workflow body is rejected with a
placement error. If another syntax error makes that placement check
inconclusive, the runtime says so and preserves the original `SyntaxError` as
its cause. The rest of the file is the workflow body,
executed as **ordinary, unsandboxed Node** — the body of a single async
function, so `return` produces the run's result and top-level `await` works.
Body syntax errors name the script's own line and column with a source excerpt
and caret. If the body ends mid-expression, the position is just after its last
non-whitespace character; long source lines show a short excerpt around the
error.
The full platform is available alongside the hooks below: every Node global
(`process`, `Buffer`, `fetch`, timers — a
`await new Promise(r => setTimeout(r, ms))` sleep is ordinary code), the
filesystem and network, `require(...)` and dynamic `import()` resolving from
the script's own path, and `import.meta` (its URL is the script's own,
tagged with a query keyed on the body's content — one body, one compiled
module, however many times a long-lived caller runs it; a changed body is
a new module, never a stale one). Static `import` syntax does not apply —
the body is a function body, not module top level. The script is the
trusted orchestration program of the user who launched it; workers are
dispatched only through `agent()`, and prompts constrain behaviour, not
capability. The script's own `meta` export is bound read-only (reading
`meta.name` works; writing to it or rebinding it throws). A free identifier
that is neither a Node global, a bound hook, nor a module-scope binding
fails **at load, before any worker spawns**, naming the unknown
identifiers — a `typeof X` probe is fine; a mistyped name is a load error,
not a `ReferenceError` after paid agent phases. One boundary of the opt-in
`--timeout` is worth knowing: it stops the run's wait at the next `await`
settlement — the body itself is never interrupted, and a synchronously
spinning loop can only be stopped by killing the process — the
orchestrator remains the real backstop.

## Hooks

- `agent(prompt, options)` — dispatch one worker; see below.
- `session(options)` — create a multi-turn worker session; see the section
  below.
- `hold(options)` — raise a decision hold and await its answer; see the
  section below.
- `workflow(nameOrRef, args?)` — run a saved workflow by name, or
  `{ scriptPath }` relative to the run cwd. One level only: a child workflow
  calling `workflow()` throws.
- `parallel(thunks)` — `Promise.all` over thunks. A dispatched worker's
  failure is already the leg's own `null` (see *Return contract*); an
  ordinary thrown error from the thunk itself yields `null` in its slot and
  is logged. Any pre-spawn author error —
  a rejected `agent()` option, a malformed schema, an unresolvable
  `workflow()` reference or bad `workflow()` arguments, a nesting
  violation — propagates and fails the run.
- `pipeline(items, ...stages)` — runs each item through the stages
  (`stage(previous, originalItem, index)`), items in parallel; a stage failure
  yields `null` for that item, with the same pre-spawn author-error
  exception as `parallel()`.
- `phase(title)` / `log(message)` — run log; `phase` also updates live status.
- `tally(name, value)` — record a named numeric count into the run
  manifest's `tallies`, beside the usage rollup: `await tally("fix rounds",
  3)`. Numbers only, last write per name wins; a blank name or a non-finite
  value throws before anything is recorded. The runtime cannot know which
  worker verified which, but the script does — a count it records is the
  accountability the archive can honestly carry.
- `budget.spent(engine)` / `budget.remaining(engine)` — token accounting
  (remaining is `Infinity` without a ceiling). opencode uses stream step usage
  when session export is unavailable; both paths charge the final input/cache
  snapshot plus every output/reasoning delta. A stream without usable token
  data emits no usage event and therefore does not advance spend towards its
  ceiling.
- `worktrees` — finished worktree records from any engine, including the final
  tip commit, whether each worktree changed, and whether an unchanged worktree
  was removed.
- `args` — the CLI positional strings, or the `--json-args` value.

## Multi-turn worker sessions

`session(options)` creates a persistent worker on `'claude'` or `'codex'` and
returns a handle whose `send(prompt, { schema? })` runs one turn against the
*same* worker each time — the follow-up that returns to the builder holding
the context of what it built, instead of a cold dispatch re-briefed through a
pasted summary. An opencode session throws before any worker spawns (the
engine is held at its one-shot surface).

- **Fixed at creation:** `engine`, `model`, `effort`, plus `fallback`,
  `cwd`, `isolation`, `timeoutMs`, `maxAttempts`, `label`, `phase`, `strip`,
  and `stalenessMark` (below). The fallback chain applies to the
  **creating turn alone**: the target that answers fixes the session's
  engine and model for its life (`handle.engine` reads the answering
  engine), and a later turn's availability failure fails that turn —
  escalation is a fresh dispatch. Changing model or effort would invalidate the
  session's prompt cache — escalation is a fresh dispatch, not a mid-session
  switch. **Per turn:** `schema` alone, on `send()`; each turn gets the same
  validated-return, tolerant-parse, bounded-retry, and failure-as-value
  contract as a one-shot `agent()` call (a schema turn resolves the
  validated value or `null`; a bare turn resolves the reply text or `null`;
  a failed turn's account is on that turn's own agent record, and the
  session stays usable for the next `send()`). Creation spawns nothing — the
  worker starts at the first `send()`.
- **Turns are sequential:** `send()` while a previous send is unsettled
  throws, as does `send()` after `close()` or after the run ends.
- **Concurrency and budget are per turn:** a turn holds its engine-cap and
  ceiling slot from its dispatch to its settlement, and an idle session
  holds nothing; each `send()`'s budget admission is judged at its own
  dispatch, exactly like a one-shot call.
- **Cache economics:** a Claude session's worker is dispatched with the
  1-hour prompt-cache TTL in its environment
  (`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h`; a machine-declared
  `worker_environment` value for that variable wins); one-shot Claude
  workers keep the engine's 5-minute default. Codex exposes no TTL knob.
- **The staleness mark:** `handle.stale` reads `true` once the idle gap
  since the last settled turn outlives the session's cache economics — the
  TTL cliff on Claude, 60 idle minutes on Codex — and `handle.idleMs`
  carries the gap itself. Advisory only: a send to a stale session still
  executes; the script decides whether to pay the re-read or dispatch a
  fresh worker re-briefed from the original materials.
  `stalenessMark: false` disables the mark for that session, and
  `handle.staleAfterMs` reads the resolved threshold. The thresholds are
  library-level runtime options (`claudeSessionStaleAfterMs`,
  `codexSessionStaleAfterMs`), not CLI flags or ambient settings; on
  Claude, a machine-declared cache TTL that overrides the injected 1-hour
  value also moves the cliff, so the mark and the cache expire on one
  clock.
- **Lifetime:** `handle.close()` stops the worker early; every held session
  is closed when the run ends by any path — a run never leaves a held
  worker live. Continuation lives within one live run only: a later run
  cannot re-attach an earlier run's session.
- **The archive:** each turn is its own agent record carrying a
  `session: { id, turn }` field, so per-turn prompts, attempts, and usage
  read back like any one-shot call's, grouped by session id. A transcript
  reference is present only for a non-empty archived transcript; a turn
  without one keeps `transcripts: []` and names the reason in
  `transcripts_unavailable`. `transcript_capture` records whether the engine's
  capture path observed the turn retained or lost; only observed loss declares
  `session-client-capture-gap`. A Codex held-session follow-up carries its own
  transcript. A session
  using `isolation: 'worktree'` works one worktree for its whole life,
  finalised at session close.
- **Claude mechanics worth knowing:** follow-up turns ride the tmux reply
  valve into the held session, delivered in bounded slices so a follow-up of
  any size (whole diffs included) arrives intact; without tmux, a session's
  follow-up or correction fails loudly rather than silently substituting a
  fresh worker, and a refused injection names the tmux step that failed and
  what it said in the turn's `claude-valve-error` failure.

## Holds

`await hold({ content, verdicts, timeoutMs? })` publishes a decision request
and resolves `{ verdict, note }` once a decider answers — the runtime's
uniform rendering of the sentinel-file-and-poll convention hold-bearing
pipelines used to hand-roll per script.

- **Raising:** `content` is what the decider reads (a non-empty string);
  `verdicts` the non-empty set of accepted answers. The hold is published
  as a JSON file under the run's **scope** in the shared cross-run root
  (`$XDG_DATA_HOME/ensemble/holds/<scope>/`), carrying everything a decider
  needs: the content, the verdicts, a fresh nonce, the decision path, and
  the raiser's liveness evidence.
- **Scoping:** the scope is an opaque key the launcher supplies — a lead
  session's own id is a natural value — so cooperating leads on one machine
  never see each other's holds in their own views. A lead sets the
  inherited `ENSEMBLE_HOLD_SCOPE` variable once and every nested invocation
  inherits it; the `--hold-scope` flag or `holdScope` library option
  outranks the variable per run. A keyless run's holds land in the default
  shared scope, which scoped listings never show and the machine-wide
  listing always shows. Scoping is hygiene against accidental
  cross-answering; the nonce stays the correctness boundary, and the scope
  is never inferred from cwd or process ancestry.
- **Answering:** any process — the launcher or not, alive at raise time or
  not — writes `{"nonce": "<the hold's nonce>", "verdict": "<one of the
  accepted verdicts>", "note": "optional", "answered_by": "optional"}` to
  the hold's `decision_path`.
  Write-then-rename is the required write shape: write to a temp file beside
  that path and rename it into place. The runtime polls, and though an
  unparseable read is given a poll's grace before it is judged, rename
  removes the mid-write window entirely. A stale nonce, an unlisted verdict,
  or a malformed file is rejected: the bad file is consumed, the
  still-published hold record gains its rejection reason and what verdict was
  recoverable, and the hold keeps waiting. Confirm a write took effect by
  reading the listing again: a hold that remains open carries rejection
  feedback to correct the next write; a vanished hold either settled or was
  retired after its raiser was conclusively found dead. Where that
  distinction matters, read the run's archive or live snapshot rather than
  treating disappearance alone as acceptance. Rejection feedback becomes
  visible only after the poller's next read: an open hold carrying no
  rejection fields means the answer has not yet been judged — never that it
  was judged and accepted. An invalid answer never reaches
  the script as a decision. `ensemble holds answer <hold-id> --verdict <v>
  [--note <n>]` does all of this for you: it copies the nonce, writes then
  renames, records the answerer (`ENSEMBLE_CALLER_IDENTITY`, else
  host:pid), and watches the hold file for up to a few of the raiser's poll
  intervals. It prints one JSON object on stdout and exits 0 when the
  answer was consumed (the run resumed), 3 when it bounced (the rejection
  reason is included; the hold keeps waiting), 4 when the raiser has not
  read it yet (the answer file stays; never reported as accepted), and 5
  when no open hold has that id. Exit 6 means the hold settled without
  judging this answer; its stale decision file is removed. A vanished hold
  alone does not establish that the answer was accepted.
- **Enumerating:** two explicit listing contracts. `ensemble holds` shows
  the inherited scope's open holds (machine-wide when no scope is set);
  `ensemble holds --scope <scope>` names a scope explicitly; `ensemble
  holds --all` is the machine-wide view across every scope, the shared
  scope included. Each listing carries id, state, scope, verdicts, decision
  path, content, any rejection feedback a bounced answer left behind, and
  the raising run's identity card — workflow name, phase, archive path, and
  agent totals, all as of the raise (display-only, never a live view);
  `--json` emits the full records (each with its `state` and
  `run_identity`) plus what was retired. A listed hold is `open` or
  `bounced` (a rejected answer is waiting to be corrected); a dead raiser's
  hold is reported as `retired`. There is no accepted state: an accepted
  answer removes the hold. Open holds also appear in the
  run's live status snapshot while it waits.
- **Timeout:** an optional `timeoutMs` bounds an unanswered hold; expiry
  rejects the awaiting `hold()` with `HoldTimeoutError` (one clean line at
  the CLI; catch it to treat expiry as an outcome).
- **Observability:** raise, answer, rejected answer, timeout, and
  retirement each emit a runtime event and land in the archive manifest's
  `hold_events` list, so a consumer holding only the archive can
  reconstruct what the run waited on, including a rejected answer's
  submitted verdict or why none was recoverable, and who answered
  (`answered_by`, null when the decision file named no one) with their
  `note`. Settled and abandoned holds
  remove their files, and a hold whose raiser is provably dead — judged from
  the liveness evidence the record carries, never guessed — is retired by the
  enumeration or sweep that observes it, so the listing only ever shows
  answerable holds.

## `agent()` options and per-engine support

`engine` is mandatory: `'codex'`, `'claude'`, or `'opencode'` — omitted or
unknown values throw before any worker spawns.

Schemas are JSON Schema **draft-07** (the default when `$schema` is
omitted) or **draft 2020-12** (declare
`"$schema": "https://json-schema.org/draft/2020-12/schema"`). Any other
declared dialect is rejected before a worker spawns, naming the supported
dialects. A recursive `$ref` schema that compiles remains accepted; a ref-only
cycle that the compiler cannot process is refused with its location. A JavaScript
schema object with an object-reference cycle is also refused before dispatch,
with its location and a remedy. If several `agent()` options are
invalid, their names and reasons appear in one rejection.

## Programmatic runtime options

The shipped bundle (`Base/scripts/ensemble.mjs`) is a CLI artefact with no
public exports — importing it yields an empty module. The programmatic surface
(`createRuntime()` and the library API) is available in the source repository's
`src/index.ts` for callers that build from source.

`createRuntime()` accepts two Codex-only silence bounds for library callers:
`retryPromiseSilenceTimeoutMs` limits silence after an in-band retry promise,
and `firstOutputTimeoutMs` limits a started turn's wait for its first
output-bearing frame. Both default to 15 minutes, terminalise the turn when
they expire, and are deliberately neither CLI flags nor ambient settings.
The latter disarms on any output-bearing turn frame, not only an
agent-message delta; the run record's separate `first_delta_ms` field remains
the time to the first agent-message delta.

| Option | codex | claude | opencode |
|---|---|---|---|
| `model` | optional (unpinned resolves the ambient default; noted on stderr) | optional (unpinned warns on stderr) | **required**, from the curated registry; otherwise throws |
| `effort` | canonical level `minimal \| low \| medium \| high \| xhigh`, validated pre-spawn; sent natively as the thread's effort, and the run record's `resolved_effort` is the server's confirmation of the level the thread runs at | same canonical level, clamped to the CLI's nearest native level (`minimal`→`low`; `xhigh` is native); the run record's `resolved_effort` is the level the CLI's own transcript reports serving, `null` when it reports none | exempt: must name one of the registry entry's served variants; otherwise throws pre-spawn |
| `fallback` | ordered chain of `{ engine, model, effort? }` targets, Codex or Claude in any position, advanced by the harness on an availability failure (allowance, terminal overload, dead or unstartable substrate) — never on empty, unparseable, or off-schema output, which retries in place; a same-engine step keeps its cap slot, a cross-engine step releases it and re-admits on the next engine's cap and budget; `maxAttempts` counts answered attempts across the whole chain, a refusal costing none; every attempt's `target` and the `answered_by` entry land in the record | same | never a chain *entry* (throws pre-spawn); an opencode call may declare a chain of Codex/Claude targets |
| `cwd` | worker working directory; defaults to the run cwd | same | same |
| `isolation: 'worktree'` | fresh git worktree; any other defined value throws | same | same |
| `schema` | validated backend-side (`outputSchema`) *and* client-side | validated client-side | validated client-side |
| `timeoutMs` | positive integer per-turn deadline, at most `2147483647`; omitted → unbounded; any other defined value throws | same (poll deadline) | same (subprocess killed) |
| `maxAttempts` | positive integer; default 3; any other defined value throws | same | same |
| `label`, `phase` | bookkeeping only, all engines | | |
| `strip` | array of capability names (`'skills'`, `'agents'`); anything else throws. Both are enforced mechanically through a per-thread `thread/start` overlay. `agents.enabled = false` removes the collaboration tool namespace (measured 2026-08-28 on codex-cli 0.149.1). For `skills`, fresh `skills/list` queries are one second apart (up to ten samples; an aggregate wall-clock deadline, checked between samples, stops the loop once its elapsed budget is spent — each call itself is bounded by the request timeout; the result is cached per transport and cwd for the run's life, so retries and sibling stripped dispatches pay discovery once). Discovery qualifies only after the set grows from its cold result and the grown set then repeats — a tendency observed on codex-cli 0.151.0, not a structural guarantee of completeness: the acceptance is any grown-then-repeated set, so a repeated *cold* state fails closed instead of being treated as complete, and the heuristic is re-verified per codex-cli upgrade (discovery has no protocol-level completion signal). The overlay disables bundled skills and adds an exact `skills.config` deny for every accepted name (measured across three fresh codex-cli 0.151.0 processes on 2026-08-30). Discovery errors, a response that never grows, ten calls without that growth-and-repeat sequence, or the deadline expiring fail before the worker spawns. | both enforced mechanically: permission deny rules (`Skill`; `Task`/`Agent`/`ListAgents`/`SendMessage`) ride the per-dispatch settings file. Worker tool surface measured 2026-08-28 on Claude Code 2.1.250 used `mcp__`-prefixed names; that session's skills pair showed the bare `Skill` deny working (`Skill` absent under a skills strip, present in the baseline). The agents deny set was witnessed 2026-08-30 on Claude Code 2.1.251: `ListAgents` and `SendMessage` were absent at the stripped worker, while the unstripped control demonstrated discovery and messaging. `Agent` was also absent, but the witness cannot isolate it from the machine-wide `Agent` deny. `Task` remains in the delivered deny set, which the exact-set regression proves. Deny is expected to outrank every allow layer and permission mode (a judgement the live worker-boundary proof witnesses). | both **throw before the worker spawns**: measured 2026-08-27 on opencode 1.18.4, `OPENCODE_CONFIG_CONTENT` merges `permission.skill` and `permission.task` denies, but enforcement has not been demonstrated at a live worker boundary  |
| `identity: true` | identified resolution, all engines: the call resolves `{ label, phase, output, failure }` (label/phase `null` when unset) instead of the bare output. `failure` is the discrimination: `null` exactly when the worker's own settlement completed — so `output: null` beside `failure: null` is a genuine answer — and a `{ message }` account when the leg failed (a schema call's exhausted collapse, or an operational failure inside `parallel()`/`pipeline()`, where the combinator resolves `{ label, phase, output: null, failure }` for an identified call, never bare `null`). This envelope is the documented route for telling a fan-out's failed legs from legitimate `null` answers: give discrimination-sensitive legs `identity: true` and read `failure`. Non-boolean values throw before the worker spawns; the durable record is unchanged. `ensemble agent --identity` prints the envelope. | | |

Every worker is unrestricted by default: it can read and write wherever the
user running the harness can and can reach the network. `strip` is the
opt-in exception, and it restricts the named *tool-surface* capability only
— stripping `agents` removes the subagent tool, not the worker's ability to
run processes from a shell. The union of the run-wide list and the call's
own list is enforced; a call can add strips but never lift a run-wide one.
Each agent's durable record carries the requested names and the route each
resolved to (`config` or `absent`), so the archive shows how every strip
was discharged. Codex receives this full-access
posture explicitly on every turn; Claude and opencode already run without an
Ensemble-managed containment boundary. Backend web search remains available to
Codex workers without an `agent()` option.

An unrecognised option key or invalid harness-owned value throws before that
call's worker spawns. The checked value domains are `effort` (the canonical
vocabulary above; opencode judged against its registry variants instead),
`isolation`, `timeoutMs`,
`maxAttempts`, `identity`, and `strip`; engine-owned and descriptive values such as `model`,
`label`, and `phase` pass through unchecked. The removed `sandbox`,
`network`, and `webSearch` keys receive a specific removal error rather than
being ignored. The `timeoutMs` maximum is Node's largest faithfully
representable timer delay; larger authored deadlines are rejected instead of
being shortened to approximately one millisecond.

Every `agent()` prompt must be a non-empty string. An explicit per-call `cwd`
must resolve to an existing directory; either error rejects before a worker or
run-record entry is created.

Placement is resolved once per `agent()` call and retained across all retries
and in-session corrections. With `cwd` and worktree isolation together, `cwd`
selects the source repository and the worker starts in a linked worktree cut
from it; a non-git `cwd` fails before the worker spawns. An unchanged worktree
and its temporary branch are removed. Changed work is preserved and reported,
never auto-merged: committed work is recoverable through the reported branch,
while dirty uncommitted work is not recoverable through that branch and
requires the preserved linked worktree and its metadata.
If finalisation fails, the call still fails and the CLI reports the
finalisation error. Ensemble also reports the created branch through
`worktrees` and the durable agent record as changed and retained because
finalisation did not prove that it was unchanged or removed. If the worker
failed and invocation shutdown succeeded, the worker error remains the one
that propagates.
A linked worktree shares its repository's object store and refs, so this
isolates the checkout rather than containing the worker or repository.

Each durable agent record always includes `resolved_cwd` and `isolation`
(`null` when unused). Records for successfully created worktrees also include
the branch, base commit, final tip commit, and `changed` / `removed` outcome.
Agent status keeps terminal timeout and interruption distinct from generic
failure, and `termination_cause` names what settled a worker at that status
(`{ kind, message }`) whenever the runtime — rather than an individual
attempt — decided it: a run that ended under the worker, or a turn timeout.
It is `null` for a worker whose attempts already tell the story, so a record
never contradicts its own attempts. A record with no retained transcript
keeps `transcripts` as `[]` and carries the reason in
`transcripts_unavailable` — `no-attempt-ran`, `substrate-never-started`, `worker-interrupted`,
`worker-timed-out`, `session-client-capture-gap` (the engine's capture path
observed the turn's transcript lost — `transcript_capture` carries that
observation as `retained`, `lost`, or `null` where nothing was observed, and
only `lost` declares this reason), or
`engine-produced-no-transcript` — so consumers can
distinguish an empty archive from engine silence without changing the array's
shape.
Successful schema agents record `parse_route` as `direct`,
`object-fallback`, or `array-fallback`; it remains `null` until a valid value is
selected.

Registered opencode model keys (the complete set; also addressable by
provider id): `glm-5.2` (OpenRouter), `qwen-3-8-27b`, `qwen-3-8-27b-heretic-ara`,
`muse-glimmer-30b`. The last three are `local/…` entries served by the
self-hosted router and track what it actually serves; the source
repository's `src/opencode-model-registry.ts` carries the re-survey contract.

Default concurrency caps: codex 12, claude 12, opencode 2.
Calls beyond the cap queue per engine.

During ordinary execution, the optional whole-run agent ceiling is enforced
together with these caps. A worker takes both capacities in one admission
decision or queues while holding neither. When capacity frees, the
longest-waiting eligible worker starts; a worker whose engine remains full is
skipped so it cannot block another engine. One ceiling slot covers the complete
logical `agent()` call, including retries, worktree finalisation, and archival.
Child workflows share their parent's ceiling. The ceiling is machine/run policy
and cannot be set by `agent()` or the script's `defaults`. If the runtime closes
with accepted calls still queued, those calls are released outside the
admission gates during shutdown.
This can make the internal active counters temporarily exceed both limits while
shutdown settles; ordinary execution never exceeds them, and the counters
return to zero as those calls finish.

The durable manifest records the effective ceiling and every registered
engine's cap with the layer that supplied each value (`flag`, `env`,
`config-file`, or `default`). An unbounded ceiling is written explicitly as
`null`. Every agent record separates `queued_ms` from `execution_ms`; the
existing attempt `duration_ms` retains its previous meaning: it is the
engine's own measurement where the engine reports one, and otherwise the
attempt's own two recorded endpoints, so an attempt that ran never reports a
duration of `null`. When an
attempt's worker process dies rather than returns, the attempt record's
`worker_exit` carries `{ exit_code, signal }` as the engine observed them —
a killed leg is distinguishable from one that returned nothing; attempts that
returned normally record `worker_exit: null`.

A run that ends while a turn is in flight tears the transport down itself, so
the turn observes a symptom of the run's exit — a closed app-server, an
aborted poll — rather than a fault of its own. The attempt's `failure` then
names the run's settlement (`run-interrupted`, `run-timed-out`), matching the
agent's `termination_cause` above it, and the symptom is kept verbatim in
`observed_failure` (`{ kind, message }`). An attempt that failed on the
engine's own account records that failure as `failure` and
`observed_failure: null`.

**Completion sentinel.** At startup the CLI prints, on stderr, the path of a
sentinel file (`completion-sentinel.json`, under the run's own directory in
the durable-record store) that the launcher process itself writes when the
run ends. It is written on every terminal transition the launcher can
handle — success, failure, timeout, interruption, salvage — carrying
`outcome`, `exit_code`, `ended_at`, `error` (the `{ kind, message }` that
ended the run, or `null`), and `workers` (`{ done, failed, cut_short,
unsettled }`, or `null` when the launcher never got far enough to count any).
Sentinels written before the worker-tally change carry no `workers` field;
treat its absence the same as `null`.
The worker tally is a partition of the run's workers, fixed at the moment the
run ended: `done` and `failed` settled on their own account before that
moment; `cut_short` counts the workers the run's end terminated; `unsettled`
counts the workers the run abandoned, dispatched but with no outcome ever
observed. When durable recording is enabled, each worker's record states the
same thing the tally does — a `cut_short` worker's record names the run's own
shutdown status (after a run whose script returned cleanly it reads
`interrupted` with a `run-interrupted` cause, never `failed`), and an
`unsettled` worker's record says exactly that. With recording disabled the
sentinel is still written and its tally is the run's only worker-outcome
surface — self-contained, with no per-worker records behind it. The counts are
taken from the disposition the run's end decides for each worker, so a
supervisor's tally never depends on which straggler teardown happened to
settle first. A teardown that fails after a clean body is itself a failed end —
the run may leave workers alive or the archive unsealed — so the sentinel
reports `outcome: "failed"`, the teardown error as its `error`, and the
process exits non-zero rather than publishing `complete` over it. It also carries
`manifest` — the sealed manifest's self-digest (`{ sha256 }`), or
`{ unavailable }` naming why there is none (`recording-disabled`,
`manifest-unsealed`) — and its own `integrity.sentinel_sha256`, computed by
the same recipe the manifest uses, so one verification covers both files. It
is written even when durable
recording is disabled: the sentinel is supervision surface, not archive, so
the run directory is created for it alone. An uncatchable kill of the
launcher leaves no sentinel — a supervisor should keep a scheduled fallback
timer behind its filesystem watch rather than trusting the file absolutely.

**Archive announcement.** When durable recording is enabled, startup also
prints one `[run-record-archive] ` line followed by JSON with `run_id` and
`archive_path`. A tracker can parse that one line to resolve the archive the
same process has just created; an announcement failure does not fail the run.

The manifest and `result.json` both carry `error`: the `{ kind, message }` of
whatever ended the run — a script fault, an unknown engine, a budget refusal,
a whole-run timeout — or `null` when the run ended cleanly. A budget refusal
reaches the archive as a refusal named by its cause; the pre-dispatch
rejection itself is unchanged, invoking no engine.

## Return contract and failure modes

- **With `schema`**: returns the parsed JSON value once an attempt's output
  validates. A schema-valid JSON `null` is a successful value. After
  `maxAttempts` failed attempts (empty output, unparseable JSON, or
  schema-validation failure), the call also returns **`null`**, but its
  execution status is failed; `ensemble agent` uses that status to emit the
  failure envelope and exit 1. A malformed schema throws before the first
  attempt. Codex may additionally reject a schema outside its `outputSchema`
  subset, with an error saying so and naming `claude` and `opencode` as the
  engines that validate the full JSON Schema client-side; the server's
  diagnostic appears in the error once.

  On Claude and opencode the schema rides the prompt, and the worker is asked
  for a conforming JSON value while being allowed to surround it with prose or
  markdown fences — that tolerance is the specified behaviour, not a leniency.
  Where a response offers more than one candidate value, the **last** one that
  validates against the schema is the answer; a response with no validating
  candidate fails as above.
- **Without `schema`**: returns the worker's final text (trimmed, non-empty),
  or **`null`** after `maxAttempts` failed attempts — the same collapse as
  the schema shape, never a throw.
- **Once a worker has spawned, every failure is a value**, on both
  shapes alike: bad output exhausting the bound, an availability refusal no
  chain entry answers, a transport error mid-attempt, a turn deadline, a
  Codex pre-generation schema rejection. The call resolves `null`; the
  failure's class and account are on the agent record (each attempt's
  `failure` and `classification`, the agent's `termination_cause`) and, for
  an `identity: true` call, on the envelope's `failure` field; and the
  launcher announces it on stderr as
  `[<engine>] agent <id> (<label>) failed after N attempts — <cause>`, where
  `<cause>` is the operator-diagnosis rendering when the failure has one
  (a turn deadline and its lever; a dead app-server, how it died, and its
  last stderr, kept whole as evidence and stripped of terminal control —
  detail lines indented beneath the first) and otherwise the record's own
  `<kind>: <message>`, bounded to one line — so an operator watching the
  terminal still sees each worker that failed and why. A call whose chain
  reached past its own target reads
  `failed after N attempts across M chain targets — the last target's failure: <cause>`,
  `<cause>` being the last target's own failure. An author who wants a failed call to stop the script checks for
  `null` (or reads `failure` under `identity: true`), exactly as on a schema
  call. The boundary is spawn: a rejection raised before a worker exists — a
  bad option, a placement that never opened, an engine refusing the dispatch
  itself, an unenforceable strip discovered as the thread is configured —
  still throws, so a misconfigured call fails loudly, and the run's own ending
  (interrupt, whole-run timeout) still throws through a leg it tore down,
  so a bare `await` sees the run stop.
- **Retries** carry the previous failure back to the worker: Claude corrects
  in the same session when tmux is available (fresh dispatch with the failure
  appended otherwise); codex and opencode retry with the failure appended to
  the prompt.
- **Availability failures and the fallback chain.** Every failed attempt is
  classified from the engine's own diagnostic — `availability` (Codex's
  `usageLimitExceeded`, `rateLimitExceeded`, `serverOverloaded`, a
  connection the provider refused, a dead or unstartable app-server;
  Claude's synthetic API-refusal reply carrying a 429, 503, or 529, a
  `claude --bg` Claude Code refused — see the dispatch bullet below: a refusal is
  never a spent attempt — a dispatch the daemon never registered, a session
  that never showed life),
  `output` (empty, unparseable, off-schema), or `unclassified` (a deadline,
  a Codex rejection of the authored schema before generation, a client
  diagnostic about a bad model name, or a diagnostic no rule
  recognised — recorded with `rule: null` so a stale table is visible in
  the archive rather than silently stranding chains). With a `fallback`
  chain declared, an availability failure with an entry remaining
  re-dispatches the same prompt, schema, placement, and strip on the next
  target, fresh, consuming no attempt; on the last target (or with no
  chain) it is the call's own failure exactly as before, and an in-band
  overload the provider promises to retry stays the bounded in-place retry
  it always was — so a chain whose every target refuses fails with the last
  target's own failure, every attempt classified in the record. Each failed
  attempt of a chained call records the harness's `chain_decision` after it:
  `advanced` (moved to the next entry), `retried-in-place`, `exhausted`
  (the call settles on this failure), or `chain-not-consulted` (the failure
  matched no rule — `rule: null` — while an entry remained, so the chain,
  which advances on availability alone, was not asked). The launcher
  announces the chain on stderr: an answer from an entry as
  `[<engine>] agent <id> (<label>) answered by fallback entry <n> (<engine>/<model>) — the declared target <engine>/<model> was refused: <kind>: <message>`
  (with `; K further chain entries were refused too` when later entries
  refused as well), and the first unconsulted failure as
  `[<engine>] agent <id> (<label>) fallback chain not consulted — attempt <n> on <engine>/<model> failed unclassified (<kind>: <message>); the declared chain (<N> entries) advances on availability failures only`,
  worker text bounded to one line. Each line is tagged with the engine it
  reports on — the answering entry's, the last target's, or the unconsulted
  attempt's own — and every fact on these lines is on the agent record. A
  chain exhausted by a refusal that throws (a `ClaudeDispatchError` on the
  last target) is announced by the `failed after` line before the throw. An empty
  or malformed chain, an opencode entry, or an engine the run does not carry throws
  `FallbackTargetRejectedError` before any worker spawns.
  A Codex schema rejection returns `null` after one thread start without
  retry or chain advance.
- **Claude dispatch and the trust gate.** The harness dispatches
  every Claude worker with the workspace declared sandboxed —
  `CLAUDE_CODE_SANDBOXED` on the `claude` process it launches and on the
  reply valve's attach client — which Claude Code answers by skipping its
  per-directory trust dialog, so a worker placed by `cwd` or `isolation` in
  a fresh scratch directory, a sibling checkout, or a generated worktree
  dispatches with no operator ceremony and no write to the operator's Claude
  configuration. A dispatch Claude Code still refuses before the session
  exists — a daemon that will not start, a directory it cannot resolve, a
  version that ignores the declaration — is a substrate refusal, not a
  worker failure: recorded on the agent record as a refused attempt
  classified `availability` (`claude.dispatch-refused`), it spends no
  attempt, advances the fallback chain where an entry remains, and otherwise
  throws `ClaudeDispatchError` (a pre-spawn member) out of `agent()` and
  through `parallel()`/`pipeline()`, failing the run with the placed
  directory, the declaration, and Claude Code's own refusal text (flattened
  to one bounded line) on one stderr line — never `null`, so a run whose
  every Claude worker was refused can never end `complete`. A dispatch the
  daemon accepted but never registered within the dispatch bound is not a
  refusal — Claude Code did not decline — and stays an operational failure
  the loop spends and retries. Codex's analogue is the same substrate
  refusal (`CodexSubstrateRefusedError`): an app-server that never started
  or is already gone when a thread is opened refuses the dispatch pre-spawn,
  while a `thread/start` the running server rejects (a bad model) is the
  server answering and stays the attempt's own failure.
- **Operational worker failures** on Claude and opencode (a dispatch the
  daemon took but never registered, a registered session that died, poll
  timed out, transcript unreadable, session settled without a provable
  completion, subprocess killed on deadline, run exited non-zero) degrade to
  an empty attempt inside the retry loop — they consume attempts rather than
  hanging or throwing, with the worker's partial text, exit evidence, and the
  engine's own diagnostic retained in the failed attempt record. A Codex turn
  deadline, first-output deadline, or a thread the app-server declared failed
  is the same operational failure under the one retry rule (settled
  2026-09-14): it consumes an attempt and the call retries within its bound
  with the failure carried into the next attempt's prompt, resolving `null`
  at exhaustion with every attempt on the record — a call whose deadline
  should end it sets `maxAttempts: 1`. The rule's one exemption is Codex's
  pre-generation schema rejection, which no retry can change: one thread
  start, then the call's `null`. A `TurnTimeoutError`
  the direct-agent form surfaces renders through the
  operator-diagnosis seam (a cause-first line, indented detail, no stack)
  and discriminates two deadlines whose remedies differ: the **per-agent
  turn deadline** — the `agent()` call's own `timeoutMs` — where the
  remedy is that call's timeout or narrowing the work it asks for; and
  the **transport request deadline** — an app-server request exceeding
  its own timeout — where the agent's `timeoutMs` is not the cause and
  raising it will not help (the transport request timeout is a
  library-level option, not a CLI flag or ambient setting). The
  startup-handshake timeout is excluded: it is rethrown as
  `AppServerStartupTimeoutError` before the diagnosis seam sees it. JSON-RPC backpressure while starting a turn and
  a terminal notification whose `error.codexErrorInfo` is
  `serverOverloaded` retry within the attempt bound like every other
  post-spawn failure; the call resolves `null` if one survives the final
  attempt. A notification with `willRetry: true` leaves the
  current turn open for the app-server's own retry. A `turn/started`, turn
  diff or plan update, or any `item/*` notification resets Ensemble's count of
  those promises; a sixth consecutive notification without such progress
  rejects the turn — as a **retryable** operational failure whatever the
  underlying diagnostic, since the app-server itself labelled the error
  transient. The rejection retains the last error notification's rendered
  diagnostic in the thrown error and failed attempt record. Between one and
  five retry promises, a still-running app-server that then sends no further
  notification is terminalised by the programmatic
  `retryPromiseSilenceTimeoutMs` bound after 15 minutes by default. A
  `thread/status/changed` notification with `status.type: "systemError"`
  rejects the live turn as a non-retryable terminal app-server failure. The
  current Codex protocol supplies no diagnostic field on that notification,
  so Ensemble reports that absence rather than inventing request detail;
  retryability remains reserved for explicit transport-level signals.
- **Budget**: each `agent()` call checks the engine's ceiling once, at
  dispatch — synchronously at the `agent()` call site, before the worker
  enters the concurrency queue. Once spend reaches the ceiling, a
  call that has not yet dispatched throws a budget-exhausted error (a ceiling
  of 0 admits no call and says so, naming the ceiling to raise). A call that
  starts under the ceiling runs its full retry bound even if spend crosses
  the ceiling mid-call, so a worker's own failure is never rewritten as
  budget exhaustion by concurrent spend; turns already started can
  collectively overshoot the ceiling.
- **Whole-workflow timeout / interrupt**: the run exits non-zero (1 on
  timeout, 130 or 143 on SIGINT or SIGTERM) and emits the partial-result
  envelope described above; completed workers' outputs are not lost.

Ordinary errors thrown by `parallel()` thunks or `pipeline()` stage callbacks
surface as `null` elements, so callers must null-check fan-in results. The
narrow exception is the pre-spawn author-error family, from any hook: a
rejected or invalid `agent()` option, a malformed schema, an unresolvable
`workflow()` reference or non-JSON `workflow()` arguments, a nesting
violation, or a composed child's load-time authoring failure propagates and
fails the run.
