# Machine configuration and environment variables

The optional file that holds a machine's standing Ensemble settings, the
environment variables that override some of them, and how to read and edit
the file safely. The file is the operator's; it applies to every run on the
machine.

## The file

`$XDG_CONFIG_HOME/ensemble/config.json`, normally
`~/.config/ensemble/config.json`. It is optional, and an absent file is
normal: `codex`, `claude`, `agy` and `zcode` workers need none. `opencode`
workers need their models declared in it.

**Read it by key, not whole.** Its `worker_environment` section can hold a
credential, such as a gateway key, and whatever a command prints stays in
your transcript. Read every other section with
`jq 'del(.worker_environment)'` on the file, and the variable names alone
with `jq '.worker_environment // {} | map_values(keys)'`.

**It is strict.** An unknown key, an invalid value, invalid JSON, or an
unsupported `schema_version` stops every run before any worker starts, with
an error naming the file and the key. Edit it with that in mind: change one
thing, keep the rest byte for byte, and confirm with a small run.

```json
{
  "schema_version": 1,
  "agent_ceiling": 8,
  "concurrency": { "codex": 4, "claude": 2 },
  "opencode_models": {
    "<name>": { "provider_model": "<provider>/<model>", "family": "<family>" }
  },
  "targets": {
    "<name>": { "engine": "claude", "model": "<model>" }
  },
  "fallback": {
    "codex": [{ "engine": "claude", "model": "<model>" }]
  },
  "effort": {
    "*": { "ceiling": "high" }
  }
}
```

| Key | Holds |
|---|---|
| `schema_version` | Must be `1` |
| `agent_ceiling` | The most workers running at once across every engine |
| `concurrency.<engine>` | The most workers running at once on that engine |
| `worker_scope` | `"worker"` or `"run"`: how worker processes are grouped under systemd |
| `run_record.enabled`, `run_record.dir` | Whether runs are archived, and the data home the archive goes under |
| `status.enabled`, `status.dir` | Whether runs publish a live status file, and where |
| `worker_environment.<engine>` | Environment variables given to that engine's workers and to no other engine's |
| `opencode_models` | The models `opencode` workers may name |
| `targets` | Named targets; see [rerouting.md](rerouting.md) |
| `fallback` | Fallback chains keyed by `engine:model` or `engine`; see [rerouting.md](rerouting.md) |
| `effort` | Effort floors and ceilings, and per-model level maps |
| `model_families` | The family of each model name listed, for names the runtime cannot place or places wrongly |
| `zcode_providers` | Per ZCode provider, the idle minutes after which a held session is marked stale |
| `single_family_notice` | `false` silences the end-of-run notice that every worker ran on one family |

Numeric values are integers of at least 1.

## How a setting resolves

The agent ceiling, the per-engine caps, the worker grouping, and the run
record and status settings each resolve through four layers, highest first:
a command-line flag where one exists, an environment variable, this file,
the built-in default.

The maps, which are `worker_environment`, `opencode_models`, `targets`,
`fallback`, `effort`, `model_families` and `zcode_providers`, exist in the
file alone. They have to hold for runs that inherit no shell profile, so no
flag or variable can supply or lift them.

A workflow's own choices never belong here. Model and effort stay in the
script's `defaults`; the machine only bounds effort, binds names, and
supplies a chain where the script declares none.

## Environment variables

| Variable | Sets |
|---|---|
| `ENSEMBLE_AGENT_CEILING` | The agent ceiling; `null` lifts one the file sets |
| `ENSEMBLE_CONCURRENCY_CODEX`, `ENSEMBLE_CONCURRENCY_CLAUDE`, `ENSEMBLE_CONCURRENCY_OPENCODE`, `ENSEMBLE_CONCURRENCY_AGY`, `ENSEMBLE_CONCURRENCY_ZCODE` | One engine's concurrency cap |
| `ENSEMBLE_DISPATCH_REMAP` | Comma-separated dispatch remap rules; any `--remap` flag replaces the list |
| `ENSEMBLE_HOLD_SCOPE` | The scope decision holds are raised and listed under; `--hold-scope` overrides it |
| `ENSEMBLE_CALLER_IDENTITY` | An identity for the invoking session, kept in the run record; `--caller-identity` overrides it |
| `ENSEMBLE_RUN_RECORD` | Turns the durable run record on or off |
| `ENSEMBLE_RUN_RECORD_DIR` | The data home the archive goes under |
| `ENSEMBLE_STATUS` | Turns the live status file on or off |
| `ENSEMBLE_STATUS_DIR` | The directory for live status files, which must already exist |
| `ENSEMBLE_WORKER_SCOPE` | `worker` or `run`; `--worker-scope` overrides it |

The on/off switches take `on` or `off`, `true` or `false`, `yes` or `no`,
`1` or `0`. A malformed value for a setting the run would use is refused
before the run starts.

## `opencode_models`

The whole catalogue of models `opencode` workers may use. Each key is the
name a call passes as `model`; a call may also give the entry's route.

| Field | Required | Description |
|---|---|---|
| `provider_model` | Yes | The `provider/model` route opencode takes |
| `family` | No | The entry's model family |
| `variants` | No | The raw variant names the model accepts as `effort`, beside the canonical levels |
| `display_name`, `vision`, `billing` | No | A display name; whether the model takes images; `pay-as-you-go` or `self-hosted` |

Declaring a model is the operator's choice of what the machine may spend
on. When a script needs an `opencode` model that is not declared, ask the
user before adding it.

## `effort`

Bounds on reasoning effort, with no flag or variable that lifts them.

```json
"effort": {
  "*": { "ceiling": "xhigh" },
  "codex": { "floor": "low" },
  "opencode:<name>": { "levels": { "low": "<native name>", "high": "<native name>" } }
}
```

Keys are `*`, an engine, or `engine:model`. `floor` and `ceiling` each take
the most specific key that sets one. `levels`, on a model key only, maps
canonical levels to the model's native names, and replaces every other
source of that model's served levels.

A dispatch holds the requested level within the bounds, then takes the
nearest level the model serves inside them, the lower on a tie. Bounds that
admit no served level refuse the dispatch before it spawns. Where a bound
applies to a call, the call has to name a canonical effort: one with no
`effort`, or with a raw opencode variant, is refused.

## `worker_environment`

Variables declared for an engine reach that engine's workers, over any
inherited value, and reach no other engine's. Everything undeclared is
inherited from the launching process as usual. This is where a machine
points an engine at a gateway or a different credential.

One consequence for nested runs: the run's own settings
(`ENSEMBLE_AGENT_CEILING`, the five concurrency variables,
`ENSEMBLE_RUN_RECORD`, `ENSEMBLE_RUN_RECORD_DIR`, `ENSEMBLE_STATUS`,
`ENSEMBLE_STATUS_DIR`, `ENSEMBLE_CALLER_IDENTITY`, `ENSEMBLE_WORKER_SCOPE`)
are withheld from Claude workers. A launcher that a Claude worker starts
resolves them from this file and the defaults. The hold scope is passed
through, so nested runs still share it.

## Where runs are recorded

The data home is `$XDG_DATA_HOME/ensemble/`, normally
`~/.local/share/ensemble/`. It holds the run archives under `runs/`, live
status files under `status/`, hold files under `holds/`, and the user's
saved workflows under `workflows/`.

- `ENSEMBLE_RUN_RECORD_DIR` or `run_record.dir` moves the archive. The value
  names the data home, not its `runs/` directory. Use this, never a changed
  `XDG_DATA_HOME`: Claude Code keeps its own data under `XDG_DATA_HOME`, and
  a Claude dispatch made under a changed value can leave Claude Code's
  background service using it for every later session.
- `ENSEMBLE_RUN_RECORD=off` turns archiving off. The completion sentinel is
  still written.
- `ENSEMBLE_STATUS_DIR` or `status.dir` moves the status files to a
  directory that already exists; `ENSEMBLE_STATUS=off` turns them off.

The archive is unredacted: prompts, transcripts and outputs are stored as
they were. Keep it out of any directory the task will delete or publish.
