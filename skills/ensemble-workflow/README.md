# Ensemble runtime bundle — usage

This directory ships one artefact: `Base/scripts/ensemble.mjs`, the
self-contained launcher for the Ensemble CLI, built from `src/` by
`npm run build:skill`. The skill that teaches workflow authoring and
orchestration is maintained separately and is not mirrored here; this file
covers only what the runtime itself does, derived from `src/`.

## Invocation

There is no `ensemble` binary on `PATH`. Run the bundle with Node (>= 24.14.0;
older Nodes exit 1 with a version error):

```
node skills/ensemble-workflow/Base/scripts/ensemble.mjs \
  [--json-args '<json>'|@file] [--budget engine=N] [--agent-ceiling N|null] \
  [--concurrency engine=N] [--timeout ms] [--strip capability] <script.js> [args...]
node skills/ensemble-workflow/Base/scripts/ensemble.mjs agent \
  --engine <engine> [--model <model>] [--effort <effort>] \
  [--fallback-model <model>] [--label <label>] [--phase <phase>] [--cwd <path>] \
  [--isolation worktree] [--identity] [--schema '<json>'|@file] \
  [--max-attempts N] [--strip capability] [--task <identity>] [--caller-identity <identity>] \
  [--budget engine=N] [--agent-ceiling N|null] [--concurrency engine=N] \
  [--timeout ms] [prompt]
node skills/ensemble-workflow/Base/scripts/ensemble.mjs workflows
```

- `--json-args` replaces the positional string args with a parsed JSON value
  (`@file` reads the JSON from a file).
- Workflow tuning flags must precede the script path. To pass a script argument
  that has the same spelling as a tuning flag, put `--` before the script path:
  `-- <script.js> --json-args`.
- `--budget engine=N` sets a per-engine token ceiling; `--concurrency engine=N`
  caps that engine's parallel workers. Both repeatable, one engine each.
- `--agent-ceiling N` caps all workers in the run across every engine. It is
  unset and unbounded by default; `--agent-ceiling null` explicitly lifts a
  lower-layer machine ceiling for one run.
- `--timeout ms` is the whole-workflow deadline, distinct from a per-call
  `timeoutMs` inside the script. At most 2147483647 (the 32-bit timer bound);
  a larger value is a usage error.
- `--caller-identity <identity>` records the opaque identity of the invoking
  session. It applies to both workflow and direct-agent runs and outranks
  `ENSEMBLE_CALLER_IDENTITY` when both are supplied.
- `agent` runs one worker without a script. Supply its prompt as the final
  argument, or omit the argument and pipe the prompt on stdin. `--schema`
  accepts inline JSON or `@file` and prints the same validated value that
  `agent()` returns in a workflow. `--max-attempts` overrides the per-call
  retry bound (default 3), as `maxAttempts` does in a script. `--label` and
  `--phase` annotate the worker in progress output and its durable run record.
  `--fallback-model` supplies Claude's declared-degradation model and is
  rejected by the other engines. `--task` copies an optional identity into the
  run record for benchmark grouping.
- `--strip capability` (repeatable) strips a named tool-surface capability —
  `skills` or `agents` — from workers. Before a workflow script it applies
  run-wide to every `agent()` call; on the `agent` subcommand it applies to
  that worker. Enforcement and failure semantics are the `strip` option's
  (see the options table).
- Direct-agent `--cwd` and `--isolation worktree` use the same placement
  lifecycle as a scripted call. An isolated run reports its branch on stderr;
  a branch containing changed work is retained for recovery.
- `workflows` lists saved workflows from `.claude/ensemble/workflows/`
  (project) and `$XDG_DATA_HOME/ensemble/workflows/` (user); unparseable
  entries are noted on stderr and skipped.

Exit 0 prints the script's return value, or the direct agent's return value, as
JSON on stdout. The return value and any `workflow()` arguments must be JSON
values: a function, a symbol, a cycle, or a BigInt fails the run at settlement
with the offending path named (one clean line, exit 1), never a lossy
approximation. A `toJSON` method is honoured as `JSON.stringify` would, but the
return value crosses a structured-clone boundary first, so a `toJSON` on a
class prototype does not survive to settlement — return plain data instead.
A script with no top-level return prints `null`, and JSON's own mappings
(`undefined` properties vanish; `Infinity` from `budget.remaining` on an
unbounded engine prints as `null`) remain permitted. Exit 1 (failure,
whole-workflow timeout, SIGINT or SIGTERM) prints a partial-result envelope
instead:
`{"partial":true,"reason":"failed"|"timed-out"|"interrupted","completed":[...]}`
with every successfully finished worker's output. A schema agent that exhausts
its attempts also exits 1 with this envelope rather than printing bare `null`.
If the schema accepts JSON `null` and the worker returns it successfully, the
direct command instead exits 0 and prints `null`.
Exit 2 is a usage error.

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
`ENSEMBLE_CALLER_IDENTITY` is separate from those runtime settings: when
present, it records the invoking session's opaque identity in the manifest;
an explicit `--caller-identity` wins. With neither, `caller_identity` is
`null`, and this does not change the manifest's `meta.task` grouping key.
`ENSEMBLE_AGENT_CEILING=null` explicitly restores an unbounded run over a
machine-file value. Other values that are not positive integers, including `0`,
fail loudly.
The record and status switches accept `on`/`off`, `true`/`false`, `yes`/`no`,
or `1`/`0`; malformed values fail rather than falling back. The durable archive
defaults to `$XDG_DATA_HOME/ensemble` (normally
`~/.local/share/ensemble`). A composed run stays one run: the manifest's
`workflow_invocations` lists the root and every `workflow()` child in call
order — each with its archived source and arguments, their hashes, and a
parent link — recorded before the child runs. Each args entry names a
`canonical_archive_path` whose exact canonical JSON text is what
`args.sha256` covers, so an archive consumer can verify it without the
writer. The root's `meta.task` remains the single grouping identity.

Summary usage in the record (schema version 3) uses one declared vocabulary:
`freshInputTokens`, `cachedInputTokens` (with `cacheReadTokens` /
`cacheCreationTokens` splitting it where the engine separates the two),
`outputTokens`, and `reasoningOutputTokens` — disjoint classes summing to
`totalTokens`, each engine's native fields mapped under one inclusion rule
(Codex reports cached within input and reasoning within output; the summary
subtracts both out). `reasoningOutputTokens: null` means the engine does not
separate reasoning — not zero. The manifest's `cost_rollup` keys spend per
engine and per *served* model (the literal `unresolved` when no served model
was ever learned, never the requested pin); its cost entries are
`provider-reported` figures only, and a bucket with no provider figure reads
`unavailable` with the reason (`no-provider-cost-reported`,
`unlike-currencies`) rather than an amount-less estimate. Agent records
record `resolved_effort` beside `resolved_model`, at record and attempt level.
Each agent record carries its
own `usage` — the summary, or `unavailable` with the reason
(`no-attempt-ran`, `engine-reported-no-usage`) so an agent with no usage data
is never indistinguishable from a zero-spend one. The engine-native usage
events remain per attempt beneath the summaries, untouched. Status
defaults to the run's `.claude` directory only when that directory already
exists; an explicit status directory must also
already exist.

## Script shape

A workflow script must begin with `export const meta = { name, description }`
as an object literal, optionally followed by
`export const defaults = { <engine>: { model?, effort?, fallbackModel? } }`
(per-engine defaults; defined per-call options win). Blank lines, `//` comments
ending in LF, CR, CRLF, U+2028 LINE SEPARATOR, or U+2029 PARAGRAPH SEPARATOR,
and `/* ... */` comments may separate these exports; a
`defaults` export declared later in the workflow body is rejected with a
placement error. If another syntax error makes that placement check
inconclusive, the runtime says so and preserves the original `SyntaxError` as
its cause. The rest of the file is the workflow body,
executed as **ordinary, unsandboxed Node** — the body of a single async
function, so `return` produces the run's result and top-level `await` works.
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
- `workflow(nameOrRef, args?)` — run a saved workflow by name, or
  `{ scriptPath }` relative to the run cwd. One level only: a child workflow
  calling `workflow()` throws.
- `parallel(thunks)` — `Promise.all` over thunks; an ordinary thrown error
  yields `null` in its slot and is logged. Any pre-spawn author error —
  a rejected `agent()` option, a malformed schema, an unresolvable
  `workflow()` reference or bad `workflow()` arguments, a nesting
  violation — propagates and fails the run.
- `pipeline(items, ...stages)` — runs each item through the stages
  (`stage(previous, originalItem, index)`), items in parallel; a stage failure
  yields `null` for that item, with the same pre-spawn author-error
  exception as `parallel()`.
- `phase(title)` / `log(message)` — run log; `phase` also updates live status.
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

## `agent()` options and per-engine support

`engine` is mandatory: `'codex'`, `'claude'`, or `'opencode'` — omitted or
unknown values throw before any worker spawns.

## Programmatic runtime options

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
| `effort` | passed to the turn | passed to the CLI | passed as the model variant |
| `fallbackModel` | throws | supported (declared degradation) | throws |
| `cwd` | worker working directory; defaults to the run cwd | same | same |
| `isolation: 'worktree'` | fresh git worktree; any other defined value throws | same | same |
| `schema` | validated backend-side (`outputSchema`) *and* client-side | validated client-side | validated client-side |
| `timeoutMs` | positive integer per-turn deadline, at most `2147483647`; omitted → unbounded; any other defined value throws | same (poll deadline) | same (subprocess killed) |
| `maxAttempts` | positive integer; default 3; any other defined value throws | same | same |
| `label`, `phase` | bookkeeping only, all engines | | |
| `strip` | array of capability names (`'skills'`, `'agents'`); anything else throws. `agents` is enforced mechanically: a per-thread `thread/start` config overlay (`agents.enabled = false`) removes the collaboration tool namespace from the tool schema Codex sends the model (measured 2026-08-28 on codex-cli 0.149.1; the overlay is per-thread and does not leak between siblings). `skills` **throws before the worker spawns**: skills reach a Codex worker as prompt text plus shell-readable files, so no configuration surface can strip the capability. | both enforced mechanically: permission deny rules (`Skill`; `Task`/`Agent`) ride the per-dispatch settings file; deny is expected to outrank every allow layer and permission mode (a judgement the live worker-boundary proof witnesses) | both **throw before the worker spawns**: measured 2026-08-27 on opencode 1.18.4, `OPENCODE_CONFIG_CONTENT` merges `permission.skill` and `permission.task` denies, but enforcement has not been demonstrated at a live worker boundary |
| `identity: true` | identified resolution, all engines: the call resolves `{ label, phase, output }` (label/phase `null` when unset) instead of the bare output — a schema call's `null` collapse included, so a fan-in keeping the envelope still knows which worker failed. An identified call that fails *operationally* inside `parallel()`/`pipeline()` also keeps its identity: the combinator resolves `{ label, phase, output: null }` for it, never bare `null`. Non-boolean values throw before the worker spawns; the durable record is unchanged. `ensemble agent --identity` prints the envelope. | | |

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
call's worker spawns. The checked value domains are `isolation`, `timeoutMs`,
`maxAttempts`, `identity`, and `strip`; engine-owned and descriptive values such as `model`,
`effort`, `label`, and `phase` pass through unchecked. The removed `sandbox`,
`network`, and `webSearch` keys receive a specific removal error rather than
being ignored. The `timeoutMs` maximum is Node's largest faithfully
representable timer delay; larger authored deadlines are rejected instead of
being shortened to approximately one millisecond.

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
never contradicts its own attempts. A record whose engine left no transcript
carries `transcripts` as `{ "unavailable": <reason> }` — `no-attempt-ran`,
`worker-interrupted`, `worker-timed-out`, or `engine-produced-no-transcript` —
rather than an empty list a reader would take for engine silence.
Successful schema agents record `parse_route` as `direct`,
`object-fallback`, or `array-fallback`; it remains `null` until a valid value is
selected.

Registered opencode model keys (also addressable by provider id):
`glm-5.2`, `qwen-3-8-27b`, `qwen-3-8-27b-heretic-ara`, `muse-glimmer-30b`.
The `local/…` entries are served by a self-hosted router and track
what it actually serves; `src/opencode-model-registry.ts` carries the
re-survey contract.

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
ended the run, or `null`), and `workers` (`{ done, failed, unsettled }`, or
`null` when the launcher never got far enough to count any). It also carries
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
  subset, with an error saying so.

  On Claude and opencode the schema rides the prompt, and the worker is asked
  for a conforming JSON value while being allowed to surround it with prose or
  markdown fences — that tolerance is the specified behaviour, not a leniency.
  Where a response offers more than one candidate value, the **last** one that
  validates against the schema is the answer; a response with no validating
  candidate fails as above.
- **Without `schema`**: returns the worker's final text (trimmed, non-empty);
  **throws** an empty-output error after `maxAttempts` empty attempts.
- **Retries** carry the previous failure back to the worker: Claude corrects
  in the same session when tmux is available (fresh dispatch with the failure
  appended otherwise); codex and opencode retry with the failure appended to
  the prompt.
- **Operational worker failures** on Claude and opencode (dispatch died, poll
  timed out, transcript unreadable, session settled without a provable
  completion, subprocess killed on deadline, run exited non-zero) degrade to
  an empty attempt inside the retry loop — they consume attempts rather than
  hanging or throwing, with the worker's partial text, exit evidence, and the
  engine's own diagnostic retained in the failed attempt record. A Codex turn timeout or non-retryable app-server error
  **throws** out of `agent()`. JSON-RPC backpressure while starting a turn and
  a terminal notification whose `error.codexErrorInfo` is
  `serverOverloaded` retry within the attempt bound; either throws if it
  survives the final attempt. A notification with `willRetry: true` leaves the
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
  rejects the live turn immediately and records `systemError`.
- **Budget**: each `agent()` call checks the engine's ceiling once, when it
  starts (leaves the concurrency queue); once spend reaches the ceiling, a
  call that has not yet started throws a budget-exhausted error. A call that
  starts under the ceiling runs its full retry bound even if spend crosses
  the ceiling mid-call, so a worker's own failure is never rewritten as
  budget exhaustion by concurrent spend; turns already started can
  collectively overshoot the ceiling.
- **Whole-workflow timeout / interrupt**: the run exits 1 and emits the
  partial-result envelope described above; completed workers' outputs are not
  lost.

Ordinary errors thrown by `parallel()` thunks or `pipeline()` stage callbacks
surface as `null` elements, so callers must null-check fan-in results. The
narrow exception is the pre-spawn author-error family, from any hook: a
rejected or invalid `agent()` option, a malformed schema, an unresolvable
`workflow()` reference or non-JSON `workflow()` arguments, a nesting
violation, or a composed child's load-time authoring failure propagates and
fails the run.
