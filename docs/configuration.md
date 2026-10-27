# Configuration

Ensemble needs no configuration to run Codex and Claude workers. opencode
workers need the models they may use declared in the machine configuration
file.

## How settings resolve

The agent ceiling, each engine's concurrency cap, the durable run record, and
the live status file each resolve independently through these layers, highest
first:

1. A command-line flag (agent ceiling and concurrency caps only; see
   [CLI](cli.md)).
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
| Agent ceiling (all engines together) | Unbounded |
| Durable run record | On, stored under `$XDG_DATA_HOME/ensemble/` (normally `~/.local/share/ensemble/`) |
| Live status file | On when the run's working directory contains a `.claude/` directory; written there |
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

Follow-up turns to a held Claude session are typed in through tmux. The tmux
client receives the declared variables from a tmux server started for that one
injection, so declared values never appear on a command line, where other
local users could read them.

Any `claude` process Ensemble launches can start the per-user daemon when it
is not already running, and that daemon then serves every later Claude session
on the machine. So that one run's settings do not leak into later sessions,
the run's own `ENSEMBLE_` settings (`ENSEMBLE_RUN_RECORD`,
`ENSEMBLE_RUN_RECORD_DIR`, `ENSEMBLE_STATUS`, `ENSEMBLE_STATUS_DIR`,
`ENSEMBLE_AGENT_CEILING`, `ENSEMBLE_CONCURRENCY_*`, `ENSEMBLE_HOLD_SCOPE`,
`ENSEMBLE_CALLER_IDENTITY`, and `ENSEMBLE_DISPATCH_REMAP`) are withheld from every `claude` process Ensemble
launches; a `worker_environment` declaration of one of those names is still
injected. Codex and opencode workers end with the run and inherit those
variables normally. A nested `ensemble` invocation inside a Claude worker
therefore resolves those settings from the machine configuration and the
defaults. The hold scope is the exception: it is passed to the worker session
through the settings file, so nested invocations still share it.

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
| `ENSEMBLE_HOLD_SCOPE` | Scope for decision holds, inherited by nested invocations; `--hold-scope` overrides it (see [Holds](workflow-scripts.md#holds)) |
| `ENSEMBLE_DISPATCH_REMAP` | Comma-separated dispatch remap rules, `key=engine[:model]` each; any `--remap` flag replaces the whole value (see [Dispatch remap](workflow-scripts.md#dispatch-remap)). Deliberately no configuration-file layer: a standing remap would make every cross-engine workflow on the machine single-family without a trace in the launch |

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

The live status file defaults to the `.claude/` directory under the run's
working directory, and is written only when that directory already exists.
While status is on, a status directory set by `ENSEMBLE_STATUS_DIR` or
`status.dir` must already exist; otherwise the run stops with an error naming
it.

See [Run records and live status](run-records.md) for what these files
contain.

## Library runtime options

Ensemble can also be used as a library from a source checkout
(`createRuntime()` and the rest of the API exported by `src/index.ts`). The
standalone launcher exports nothing. Apart from `holdScope`, which mirrors
`--hold-scope`, these options have no flag or environment variable:

| Option | Default | Description |
|---|---|---|
| `retryPromiseSilenceTimeoutMs` | 15 minutes | Codex only. How long a turn may stay silent after the app-server promises to retry before the turn is ended |
| `firstOutputTimeoutMs` | 15 minutes | Codex only. How long a started turn may wait for its first output-bearing frame |
| `requestTimeoutMs` | 30 seconds | Codex app-server transport request timeout |
| `claudeSessionStaleAfterMs` | 60 minutes, or a cache TTL declared in `worker_environment` | When a held Claude session is marked stale (see [Sessions](workflow-scripts.md#multi-turn-sessions)) |
| `codexSessionStaleAfterMs` | 60 minutes | When a held Codex session is marked stale |
| `holdScope` | None | Hold scope for the runtime's runs; overrides `ENSEMBLE_HOLD_SCOPE` |

`firstOutputTimeoutMs` is satisfied by any output-bearing turn frame, not only
an agent-message delta; the run record's `first_delta_ms` still measures the
time to the first agent-message delta.
