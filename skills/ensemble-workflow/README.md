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
  [--json-args '<json>'|@file] [--budget engine=N] [--concurrency engine=N] \
  [--timeout ms] <script.js> [args...]
node skills/ensemble-workflow/Base/scripts/ensemble.mjs workflows
```

- `--json-args` replaces the positional string args with a parsed JSON value
  (`@file` reads the JSON from a file).
- `--budget engine=N` sets a per-engine token ceiling; `--concurrency engine=N`
  caps that engine's parallel workers. Both repeatable, one engine each.
- `--timeout ms` is the whole-workflow deadline, distinct from a per-call
  `timeoutMs` inside the script.
- `workflows` lists saved workflows from `.claude/ensemble/workflows/`
  (project) and `$XDG_DATA_HOME/ensemble/workflows/` (user); unparseable
  entries are noted on stderr and skipped.

Exit 0 prints the script's return value as JSON on stdout (unserialisable
values print as `null`). Exit 1 (failure, whole-workflow timeout, SIGINT or
SIGTERM) prints a partial-result envelope instead:
`{"partial":true,"reason":"failed"|"timed-out"|"interrupted","completed":[...]}`
with every successfully finished worker's output. Exit 2 is a usage error.

Environment: `ENSEMBLE_STATUS=off` disables the live status snapshot
(`.claude/ensemble.local.json`), `ENSEMBLE_STATUS_DIR` redirects it;
`ENSEMBLE_RUN_RECORD=off` disables the durable run archive,
`ENSEMBLE_RUN_RECORD_DIR` redirects it (default `~/.local/share/ensemble`).

## Script shape

A workflow script must begin with `export const meta = { name, description }`
as an object literal, optionally followed by
`export const defaults = { <engine>: { model?, effort?, fallbackModel? } }`
(per-engine defaults; defined per-call options win). The rest of the file is
the workflow body, evaluated in a `node:vm` sandbox as an async function —
`return` produces the run's result. The sandbox exposes only the hooks below:
no `require`, no `import`, no dynamic code generation.

## Hooks

- `agent(prompt, options)` — dispatch one worker; see below.
- `workflow(nameOrRef, args?)` — run a saved workflow by name, or
  `{ scriptPath }` relative to the run cwd. One level only: a child workflow
  calling `workflow()` throws.
- `parallel(thunks)` — `Promise.all` over thunks; an ordinary thrown error
  yields `null` in its slot and is logged. A rejected `agent()` option
  propagates and fails the run.
- `pipeline(items, ...stages)` — runs each item through the stages
  (`stage(previous, originalItem, index)`), items in parallel; a stage failure
  yields `null` for that item, except that a rejected `agent()` option
  propagates.
- `phase(title)` / `log(message)` — run log; `phase` also updates live status.
- `budget.spent(engine)` / `budget.remaining(engine)` — token accounting
  (remaining is `Infinity` without a ceiling). opencode uses stream step usage
  when session export is unavailable; both paths charge the final input/cache
  snapshot plus every output/reasoning delta. A stream without usable token
  data emits no usage event and therefore does not advance spend towards its
  ceiling.
- `worktrees` — finished worktree records from any engine, including whether
  each worktree changed and whether the unchanged worktree was removed.
- `args` — the CLI positional strings, or the `--json-args` value.

## `agent()` options and per-engine support

`engine` is mandatory: `'codex'`, `'claude'`, or `'opencode'` — omitted or
unknown values throw before any worker spawns.

| Option | codex | claude | opencode |
|---|---|---|---|
| `model` | optional (unpinned resolves the ambient default; noted on stderr) | optional (unpinned warns on stderr) | **required**, from the curated registry; otherwise throws |
| `effort` | passed to the turn | passed to the CLI | passed as the model variant |
| `fallbackModel` | throws | supported (declared degradation) | throws |
| `cwd` | worker working directory; defaults to the run cwd | same | same |
| `isolation: 'worktree'` | fresh git worktree | same | same |
| `schema` | validated backend-side (`outputSchema`) *and* client-side | validated client-side | validated client-side |
| `timeoutMs` | per-turn deadline; omitted → unbounded | same (poll deadline) | same (subprocess killed) |
| `maxAttempts` | default 3 | default 3 | default 3 |
| `label`, `phase` | bookkeeping only, all engines | | |

Every worker is unrestricted: it can read and write wherever the user running
the harness can and can reach the network. Codex receives this full-access
posture explicitly on every turn; Claude and opencode already run without an
Ensemble-managed containment boundary. Backend web search remains available to
Codex workers without an `agent()` option.

An unrecognised option key throws before that call's worker spawns. The removed
`sandbox`, `network`, and `webSearch` keys receive a specific removal error
rather than being ignored.

Placement is resolved once per `agent()` call and retained across all retries
and in-session corrections. With `cwd` and worktree isolation together, `cwd`
selects the source repository and the worker starts in a linked worktree cut
from it; a non-git `cwd` fails before the worker spawns. An unchanged worktree
and its temporary branch are removed. Changed work is preserved and reported,
never auto-merged: committed work is recoverable through the reported branch,
while dirty uncommitted work is not recoverable through that branch and
requires the preserved linked worktree and its metadata.
A linked worktree shares its repository's object store and refs, so this
isolates the checkout rather than containing the worker or repository.

Each durable agent record always includes `resolved_cwd` and `isolation`
(`null` when unused). Records for successfully created worktrees also include
the branch, base commit, and `changed` / `removed` outcome.

Registered opencode model keys (also addressable by provider id):
`glm-5.2`, `gemma-4-31b-qat-standard`, `gemma-4-31b-qat-heretic`,
`qwen-3-6-27b-standard`, `qwen-3-6-27b-heretic-neo-code`.

Default concurrency caps: codex `max(1, min(16, cpus − 2))`, claude 8,
opencode 2.
Calls beyond the cap queue per engine.

## Return contract and failure modes

- **With `schema`**: returns the parsed object once an attempt's output
  validates; returns **`null`** after `maxAttempts` failed attempts (empty
  output, unparseable JSON, or schema-validation failure). A malformed schema
  throws before the first attempt. Codex may additionally reject a schema
  outside its `outputSchema` subset, with an error saying so.

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
  timed out, transcript unreadable, subprocess killed on deadline) degrade to
  an empty attempt inside the retry loop — they consume attempts rather than
  hanging or throwing. A Codex turn timeout or app-server error **throws** out
  of `agent()` (app-server backpressure alone is retried within the attempt
  bound first).
- **Budget**: each attempt checks the engine's ceiling first; once spend
  reaches it, `agent()` throws a budget-exhausted error. Ceilings are
  enforced at turn start, so a ceiling can be overshot by the turn in flight.
- **Whole-workflow timeout / interrupt**: the run exits 1 and emits the
  partial-result envelope described above; completed workers' outputs are not
  lost.

Ordinary failures inside `parallel()` and `pipeline()` surface as `null`
elements, so callers must null-check fan-in results. A rejected `agent()`
option is the narrow exception: it propagates and fails the run.
