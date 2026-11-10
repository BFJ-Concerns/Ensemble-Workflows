# Configuration

Ensemble needs no configuration to run Codex and Claude workers. opencode
workers need the models they may use declared in the machine configuration
file.

## How settings resolve

Worker scope grouping, the agent ceiling, each engine's concurrency cap,
the durable run record, and the live status file each resolve independently
through these layers, highest first:

1. A command-line flag (worker scope grouping, agent ceiling and concurrency
   caps; see [CLI](cli.md)).
2. An `ENSEMBLE_` environment variable.
3. The machine configuration file, `$XDG_CONFIG_HOME/ensemble/config.json`
   (normally `~/.config/ensemble/config.json`).
4. The built-in default.

The run record's manifest records the effective agent ceiling and
concurrency caps with the layer that supplied each (`flag`, `env`,
`config-file`, or `default`).

## Defaults

| Setting | Default |
|---|---|
| Concurrency cap | `codex` 12, `claude` 12, `opencode` 2 workers at once |
| Worker scope grouping | `worker` |
| Agent ceiling (all engines together) | Unbounded |
| Durable run record | On, stored under `$XDG_DATA_HOME/ensemble/` (normally `~/.local/share/ensemble/`) |
| Live status file | On, stored under `$XDG_DATA_HOME/ensemble/status/` |
| Token budget per engine | Unbounded (set per run with `--budget`) |
| Whole-run timeout | None (set per run with `--timeout`) |

Calls beyond an engine's cap queue for that engine. With an agent ceiling set,
a worker takes both its engine slot and a ceiling slot in one admission
decision, or queues holding neither. When capacity frees, the longest-waiting
eligible worker starts; a worker whose engine is still full is skipped so it
cannot block another engine. A call keeps its slots across its retries,
worktree clean-up, and archiving; a fallback step to another engine releases
them and is admitted again on that engine. Child workflows share their
parent's ceiling. Neither `agent()` nor a script's `defaults` can change the
ceiling. When the run ends, calls still queued are rejected without
starting.

## Machine configuration file

The file is optional; an absent file is normal and silent. It uses schema
version 1:

```json
{
  "schema_version": 1,
  "agent_ceiling": 2,
  "worker_scope": "worker",
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
  },
  "opencode_models": {
    "glm-5.2": {
      "provider_model": "openrouter/z-ai/glm-5.2",
      "family": "glm",
      "billing": "pay-as-you-go"
    }
  }
}
```

| Key | Type | Description |
|---|---|---|
| `schema_version` | integer | Must be `1` |
| `worker_scope` | `"worker"` or `"run"` | Systemd scope grouping for Claude and Codex workers |
| `agent_ceiling` | integer | Maximum workers running at once across every engine |
| `concurrency.<engine>` | integer | Maximum workers running at once on that engine |
| `run_record.enabled` | boolean | Whether runs write a durable run record |
| `run_record.dir` | string | The record store's data home (see below) |
| `status.enabled` | boolean | Whether runs publish a live status file |
| `status.dir` | string | Directory for live status files; must already exist while status is on |
| `worker_environment.<engine>` | object of strings | Environment variables injected into that engine's workers |
| `opencode_models` | object | The models opencode workers may use |

Every numeric value must be an integer of at least 1. The file is strict: an
unsupported `schema_version`, an unknown key, an invalid value, an unreadable
file, or invalid JSON stops the run before any worker starts, naming the file
and the key where applicable.

### `worker_environment`

Declares environment variables to inject into the workers Ensemble dispatches,
per engine: a variable declared for `claude` reaches Claude workers only.
Injected values override inherited ones for that engine's workers, apart from
two variables Ensemble sets on every Claude worker itself
(`CLAUDE_CODE_SANDBOXED` and `ENSEMBLE_CLAUDE_WORKER`). Everything undeclared
is still inherited from the launching process, apart from the run settings
withheld from Claude processes (below). Values must be
strings, and unknown engines or non-string values fail the run. This section
exists only in the file — there is no environment variable or flag for it —
so that it holds even for runs whose parent environment cannot be relied on.

Claude workers are served by Claude Code's per-user background daemon, whose
environment predates the run. Ensemble therefore delivers their declarations
through a private per-dispatch settings file (`claude --bg --settings`) whose
`env` block Claude Code layers over your own settings: declared keys win,
nothing else is touched, and the file is removed when the session stops. The
file's directory also holds the launcher's owner evidence (`owner.json`). The
next run that dispatches a Claude worker removes a directory whose owner
evidence shows its launcher is gone; a live launcher's directory, or one whose
owner cannot be judged, is never touched.

When `CLAUDE_CONFIG_DIR` is set, transcript discovery reads its `projects/`
directory. A declared worker value overrides the launcher's inherited value,
matching the directory used by the Claude processes; otherwise discovery uses
`~/.claude/projects/`.

Follow-up turns to a held Claude session use its external prompt editor through
a private tmux attachment. The attach client receives the declared variables
from a tmux server started for that one injection, so declared values never
appear on a command line, where other local users could read them. Its
`VISUAL` and `EDITOR` point at a private copy helper for that delivery; the
worker and your editor settings keep their configured values.

Any `claude` process Ensemble launches can start the per-user daemon when it
is not already running, and that daemon then serves every later Claude session
on the machine. So that one run's settings do not leak into later sessions,
the run's own `ENSEMBLE_` settings (`ENSEMBLE_RUN_RECORD`,
`ENSEMBLE_RUN_RECORD_DIR`, `ENSEMBLE_STATUS`, `ENSEMBLE_STATUS_DIR`,
`ENSEMBLE_AGENT_CEILING`, `ENSEMBLE_CONCURRENCY_*`, `ENSEMBLE_HOLD_SCOPE`, and
`ENSEMBLE_CALLER_IDENTITY`, `ENSEMBLE_WORKER_SCOPE`) are withheld from every `claude` process Ensemble
launches; a `worker_environment` declaration of one of those names is still
injected. Codex and opencode workers end with the run and inherit those
variables normally. A nested `ensemble` invocation inside a Claude worker
therefore resolves those settings from the machine configuration and the
defaults. The hold scope is the exception: it is passed to the worker session
through the settings file, so nested invocations still share it.

Each session's settings file remains available until Ensemble stops the
session, including when dispatch returns before `claude --bg` finishes.
Stopping the session removes its settings file.

For the same reason the daemon must not live in the launcher's own cgroup: a
memory limit or an ending there would take every Claude session on the
machine with it. Where a systemd user manager is reachable, Ensemble runs
each `claude` (and `tmux`) process it launches in a transient scope of its
own (`systemd-run --user --scope`) in the parent of the slice that holds the
launcher — a launcher in `agents-run1.slice` launches into `agents.slice`, one
in `agents.slice` or `app.slice` into the user manager's root — so a daemon
one of them starts sits outside the box the launcher's slice draws. The
process keeps its streams, environment, working directory and exit status.
Without a reachable user manager the process is launched directly. A reachable manager
that refuses the control-command scope fails that command; Ensemble does not
retry inside the launcher's box, where it could start the shared supervisor.
The best-effort worker placement below concerns adoption of existing processes.

Claude sessions and the Codex app-server are placed in transient scopes in
the slice that holds the launcher. `worker_scope` chooses one scope per Claude
worker and one for the run's shared Codex app-server (`worker`, the default),
or one scope shared by both engines (`run`). Codex workers are threads of one
process, so they share a scope even in `worker` mode. `ENSEMBLE_WORKER_SCOPE`
overrides the file; `--worker-scope worker|run` overrides both.

A launcher directly in the user manager's root slice (`-.slice`) keeps its
workers in that root slice. Its control commands also use root-slice scopes
separate from the launcher's own scope; the root slice has no higher user
slice.

The daemon forks each Claude session in its own cgroup, and the roster
(`claude agents --json`) names that process by `pid` shortly after registration.
Ensemble moves the process and its descendants when the pid appears, and
moves a session the daemon restarts under a new pid through a run-owned roster
watch, including while the session is idle between turns or after its last
turn. One roster read serves all owned Claude sessions on each watch cycle;
the watch ends when their sessions stop. Turn polling also checks placement.
Unexpected watch failures produce a bounded stderr notice and are retried.
Codex
placement is attempted before the app-server's protocol handshake. Placement
is best-effort: without a reachable user manager workers run where they
started; manager refusals do not fail dispatch. Claude placement refusals are
retried within the registration settle window and on subsequent roster polls,
even when the PID has not changed. A changed refusal and its recovery are
reported on stderr; library event listeners receive
`claude/workerScopePlacement` with the session ID, name, PID and outcome
(`refused` with a bounded reason, or `placed` with the scope unit). Repeated
identical refusals do not repeat the notice. Linux keeps memory already charged
before a move in the original cgroup. Run teardown stops the scopes Ensemble owns;
Claude control-command scopes and the shared supervisor are outside that
ownership.

> [!WARNING]
> Relocate the run record with `ENSEMBLE_RUN_RECORD_DIR`, not by pointing
> `XDG_DATA_HOME` at another directory. Claude Code keeps its own data under
> `XDG_DATA_HOME` too, and a Claude dispatch that starts the daemon under a
> changed value leaves the daemon using it for every later background session.

### `opencode_models`

Declares the models opencode workers may name. It is the whole catalogue:
Ensemble ships no models, so without this section every opencode call is
refused before its worker spawns, with an error naming the section. Like
`worker_environment`, it exists only in the file.

Each key is the name an `agent()` call passes as `model`; a call may also name
the entry by its route. A key or route that would name two entries is invalid.

| Field | Required | Description |
|---|---|---|
| `provider_model` | Yes | The `provider/model` route that `opencode run --model` takes |
| `display_name` | No | Display name; defaults to the key |
| `family` | No | Model family, for choosing between models |
| `vision` | No | Whether the model accepts image input; defaults to `false` |
| `billing` | No | `pay-as-you-go` or `self-hosted` |
| `variants` | No | The served variants the model accepts as `effort` |

With no `variants` declared, any `effort` on that model throws before the
worker spawns. Take variants from the provider's own listing: `opencode run`
forwards an unknown variant without complaint.

## Environment variables

| Variable | Description |
|---|---|
| `ENSEMBLE_AGENT_CEILING` | Agent ceiling across all engines. `null` restores an unbounded run over a value in the file; other values must be positive integers |
| `ENSEMBLE_CONCURRENCY_CODEX` | Codex concurrency cap |
| `ENSEMBLE_CONCURRENCY_CLAUDE` | Claude concurrency cap |
| `ENSEMBLE_CONCURRENCY_OPENCODE` | opencode concurrency cap |
| `ENSEMBLE_RUN_RECORD` | Turns the durable run record on or off |
| `ENSEMBLE_RUN_RECORD_DIR` | The record store's data home |
| `ENSEMBLE_STATUS` | Turns the live status file on or off |
| `ENSEMBLE_STATUS_DIR` | Directory for live status files; must already exist while status is on |
| `ENSEMBLE_CALLER_IDENTITY` | Opaque identity of the invoking session, recorded in the manifest's `caller_identity`; `--caller-identity` overrides it |
| `ENSEMBLE_WORKER_SCOPE` | `worker` or `run`; systemd worker grouping, overridden by `--worker-scope` |
| `ENSEMBLE_HOLD_SCOPE` | Scope for decision holds, inherited by nested invocations; `--hold-scope` overrides it (see [Holds](workflow-scripts.md#holds)) |

The on/off switches accept `on`/`off`, `true`/`false`, `yes`/`no`, or `1`/`0`.
A malformed ceiling, cap, switch, or directory value that the run would use is
refused before the run starts, naming the variable, the accepted form, and the
value it received; a variable that a flag overrides, or a status directory
while status is off, is not read. `0` is not a valid ceiling or cap. An empty
`ENSEMBLE_CALLER_IDENTITY` or `ENSEMBLE_HOLD_SCOPE` counts as unset.

`ENSEMBLE_CALLER_IDENTITY` does not affect the manifest's `meta.task` grouping
key. With neither the variable nor the flag set, `caller_identity` is `null`.

## Run record and status locations

The run record store's data home defaults to `$XDG_DATA_HOME/ensemble`
(normally `~/.local/share/ensemble`). `ENSEMBLE_RUN_RECORD_DIR` and
`run_record.dir` name that data home — the store root — not its `runs/`
subdirectory: archives land under `<dir>/runs/cwd/…`, so a value ending in
`runs` produces a `runs/runs/` path. Leaving the variable unset falls back to
`run_record.dir`, then to the default location; it never disables
recording. Disable recording with
`ENSEMBLE_RUN_RECORD=off` or `run_record.enabled: false`.

The live status file defaults to
`$XDG_DATA_HOME/ensemble/status` (normally
`~/.local/share/ensemble/status`), creating the directory automatically.
This location is independent of the working directory, any `.claude` entry
and archive-directory overrides. Each run publishes
`ensemble.<run-uuid>.local.json`; concurrent runs have separate files.
The CLI announces the exact path on stderr as
`[status-file] {"run_id":…,"status_path":…}` after the first successful write and before workflow execution.
Read that file while the run is active; normal shutdown removes it. Startup
removes leftovers only when owner evidence proves their process has gone.
Directory creation failure produces one `[status]` diagnostic and leaves
publication off for that run. A failed initial write also produces one diagnostic and leaves publication
off for that run, so later activity cannot create an unannounced status file.
Failures after publication produce a diagnostic without stopping the run. If a published directory
is removed, the run continues quietly and resumes publication when the
directory exists again. Disable publication with
`ENSEMBLE_STATUS=off` or `status.enabled: false`.
While status is on, a status directory set by `ENSEMBLE_STATUS_DIR` or
`status.dir` must already exist; otherwise the run stops with an error naming
it.

See [Run records and live status](run-records.md) for what these files
contain.

### Publishing status from a library caller

`resolveStatusDir(env, cwd)` returns the selected path or `null` when disabled.
The automatic data-home directory may not exist yet. `StatusFileWriter` takes
`createDirectory: true` to create it, and `ready()` reports whether the first
snapshot was published. A caller that owns directory creation can use:

```js
const dir = resolveStatusDir(process.env, process.cwd());
const writer = dir === null ? null : new StatusFileWriter({
  progress: runtime.progress, dir, createDirectory: true
});
if (writer !== null) await writer.ready();
// Close the writer when the caller stops publishing.
```

The writer leaves directories untouched unless creation is requested. Explicit
missing directories are rejected by `resolveStatusDir` before writer creation.
Call `await writer.close()` when publication ends. For layer-aware handling,
`resolveAmbientSettings({ env, cwd }).statusDir` exposes both `value` and `layer`;
the CLI creates only its automatic data-home directory.


## Library runtime options

Ensemble can also be used as a library from a source checkout
(`createRuntime()` and the rest of the API exported by `src/index.ts`). The
standalone launcher exports nothing. Apart from `holdScope` and
`workerScope`, which mirror their CLI flags, these options have no flag or
environment variable:

| Option | Default | Description |
|---|---|---|
| `retryPromiseSilenceTimeoutMs` | 15 minutes | Codex only. How long a turn may stay silent after the app-server promises to retry before the turn is ended |
| `firstOutputTimeoutMs` | 15 minutes | Codex only. How long a started turn may wait for its first output-bearing frame |
| `requestTimeoutMs` | 30 seconds | Codex app-server transport request timeout |
| `claudeSessionStaleAfterMs` | 60 minutes, or a cache TTL declared in `worker_environment` | When a held Claude session is marked stale (see [Sessions](workflow-scripts.md#multi-turn-sessions)) |
| `codexSessionStaleAfterMs` | 60 minutes | When a held Codex session is marked stale |
| `workerScope` | `worker` | Systemd scope grouping (`worker` or `run`); the library uses the explicit option or its default |
| `holdScope` | None | Hold scope for the runtime's runs; overrides `ENSEMBLE_HOLD_SCOPE` |

`firstOutputTimeoutMs` is satisfied by any output-bearing turn frame, not only
an agent-message delta; the run record's `first_delta_ms` still measures the
time to the first agent-message delta.
