# Rerouting: Named Targets, the Dispatch Remap, and Fallback Chains

The three mechanisms that move a workflow's dispatches between engines and
models without editing the script, and the machine configuration file that
carries two of them. Read this when an engine family is refusing, out of
allowance, or regressing; when writing a script that names roles instead of
engines; or when a run's record shows a dispatch landing somewhere other than
where the script asked.

## Choosing the mechanism

- **The script names roles** (`target: "doer"`): edit the binding in the
  machine configuration's `targets` map and re-run. The change reaches every
  workflow on the machine that uses the name, from the next run onward.
- **The script names literal engines**, or one run alone should move: pass
  `--remap` at launch (or set `ENSEMBLE_DISPATCH_REMAP` for a shell session).
  Nothing on disk changes.
- **Future runs should survive the outage on their own**: declare a
  `fallback` chain on the call or in `defaults`, so an availability failure
  advances to the next target without anyone re-launching.

Whichever is used, the record says what was asked for and what ran, so a
reader comparing runs across the change sees both. A run whose finder and
verifier both landed on one family bought throughput, not the cross-engine
check — the record keeps that visible, and the report should say it.

## The machine configuration file

`$XDG_CONFIG_HOME/ensemble/config.json` (`~/.config/ensemble/config.json` when
unset). Optional — an absent file is normal and silent — and strict: it must
carry `"schema_version": 1` and only the keys below, and an unknown key,
invalid value, unreadable file or invalid JSON stops the run before any worker
starts, naming the file and the key.

| Key | Type | Description |
|---|---|---|
| `schema_version` | integer | Must be `1` |
| `agent_ceiling` | integer | Maximum workers running at once across every engine |
| `concurrency.<engine>` | integer | Maximum workers running at once on that engine |
| `run_record.enabled` | boolean | Whether runs write a durable run record |
| `run_record.dir` | string | The record store's data home (the store root, not its `runs/` subdirectory) |
| `status.enabled` | boolean | Whether runs publish a live status file |
| `status.dir` | string | Directory for live status files; must already exist while status is on |
| `worker_environment.<engine>` | object of strings | Environment variables injected into that engine's workers |
| `opencode_models` | object | The models opencode workers may use |
| `targets.<name>` | object | A named target: the engine, and optionally the model, a call naming `<name>` dispatches to |

Every numeric value is an integer of at least 1. The ceiling, caps, run record
and status settings also have an environment-variable layer above the file
(`ENSEMBLE_AGENT_CEILING`, `ENSEMBLE_CONCURRENCY_CODEX` / `_CLAUDE` /
`_OPENCODE`, `ENSEMBLE_RUN_RECORD`, `ENSEMBLE_RUN_RECORD_DIR`,
`ENSEMBLE_STATUS`, `ENSEMBLE_STATUS_DIR`) and, for the ceiling and caps, a flag
above that. The three map-valued sections — `worker_environment`,
`opencode_models`, `targets` — live in the file alone.

```json
{
  "schema_version": 1,
  "concurrency": { "codex": 4, "claude": 2 },
  "opencode_models": {
    "glm-5.2": { "provider_model": "openrouter/z-ai/glm-5.2", "family": "glm" }
  },
  "targets": {
    "doer": { "engine": "codex", "model": "<a Codex model>" },
    "reviewer": { "engine": "claude" }
  }
}
```

`worker_environment` can hold a credential (a gateway URL, a key), so inspect
the file by key — `jq 'del(.worker_environment)'` for everything else, `jq
'.worker_environment | map_values(keys)'` for the variable names alone — and
never print it whole into a transcript. Declared values reach workers through
a private per-dispatch settings file on Claude and through the environment on
Codex and opencode; the run's own `ENSEMBLE_*` settings are withheld from
every `claude` process the runtime launches, because the per-user Claude
daemon any of them may start outlives the run and serves every later session.

## Named targets

`targets` binds names of your own choosing — `doer`, `reviewer`, `grunt`,
whatever your vocabulary is — to an engine with or without a model. The
runtime ships no names.

| Field | Required | Description |
|---|---|---|
| `engine` | Yes | `codex`, `claude`, or `opencode` |
| `model` | No | The model to dispatch. Without it the call runs the script's `defaults` model for that engine, else the engine's own default, as an unpinned call does |

A script names a target where it would have named an engine and model:

```js
const plan = await agent("Plan the change", { target: "reviewer", effort: "high" });
const diff = await agent("Implement it", { target: "doer", fallback: [{ target: "reviewer" }] });
const held = session({ target: "reviewer", label: "critic" });
```

- **`target` replaces `engine` and `model`.** A call names one or the other:
  a `target` beside an `engine` or `model` throws before any worker spawns,
  naming the name, the literal, and the file whose binding would have
  supplied them. Names are a namespace of their own, so a name may spell an
  engine's name without shadowing it — targets are reached through `target`,
  never through `engine`.
- **Names resolve before the worker spawns.** Bindings are read when the
  run starts, so a rebinding reaches the next run and never one in flight. A
  name the file does not bind throws `NamedTargetRejectedError` naming the
  name and the file; a binding to an unknown engine or a malformed binding
  stops the run before any worker starts. A script that uses names needs the
  machine to bind them; a script meant to travel keeps literal engines.
- **The resolved engine's `defaults` apply.** A binding with no model takes
  the script's `defaults` model for the resolved engine, else that engine's
  own default; the block's `effort` and `fallback` fill what the call left
  unsaid, and an `effort` the call states is kept.
- **Every script dispatch resolves names**: a call's own target, a
  fallback-chain entry (`{ target, effort? }`), and a session's creation,
  once, for its life. The dispatch remap acts on the resolved pair, so an
  `engine:model` key matches what the name resolved to.
- **The record says so.** The manifest's `named_targets` carries the bindings
  in force; each agent record's `named_targets` names each target the call
  declared — or its engine's `defaults` chain supplied — beside the engine and
  model it resolved to; every attempt's `named_target` names the target it was
  dispatched through. `fallback` stays the chain as declared, names included.

## Dispatch remap

`--remap key=engine[:model]` on the launcher (before the script path, or after
`agent` on a direct dispatch; repeatable) and the `ENSEMBLE_DISPATCH_REMAP`
variable (the same rules, comma-separated) re-route a run's workers at launch.
Each rule is `key=engine[:model]`:

```sh
ensemble --remap 'phase:critique=codex' --remap 'label:propose:*=codex:<model>' review.js
ENSEMBLE_DISPATCH_REMAP='claude=codex:<model>' ensemble review.js
```

- **Keys** name the script's own roles first — `label:<glob>` and
  `phase:<glob>`, where `*` matches any run of characters and `?` one,
  anchored at both ends — then an `engine:model` pair, then a bare engine. The
  phase a key matches is the call's `phase` option, else the phase `phase()`
  last set. A rule is `<key>=<engine>[:<model>]`; `=` may appear in neither
  side, and an empty glob is rejected.
- **Specificity** decides when several keys match one dispatch: a label key
  beats a phase key beats an `engine:model` key beats an engine key; among
  keys of one kind, the first given wins.
- **The target** is an engine with or without a model. A moved dispatch takes
  the rule's model, else the script's `defaults` model for the target engine,
  else that engine's own default — exactly as an unpinned call on that engine
  would, so a call's own `model` never crosses engines; the call's `effort`
  and its fallback chain (each entry itself subject to the remap) ride across
  as declared. A rule whose target is the engine the call is already on still
  counts as a move: the call takes the rule's model, or the defaults', in
  place of its own.
- **Every dispatch resolves through the remap**: a call's own target, each
  entry of its fallback chain (so a chain cannot carry a call back onto an
  engine the launch moved it off), and a session's creation, once, for its
  life. The flags replace the variable whole; rules never merge across the
  two layers, and there is deliberately no configuration-file layer — a
  standing remap would make every cross-engine workflow on the machine
  single-family without a trace in the launch.
- **The record says so.** The manifest's `dispatch_remap` carries the rules
  and the layer that supplied them (`flag` or `env`); each moved agent record
  carries `remap` naming the key, what the script asked for and what was
  dispatched (its top-level `engine` and `model` are the dispatched target);
  the launcher announces each move on stderr as `[<engine>] agent <id>
  (<label>) remapped by "<key>": asked for <engine>/<model>, dispatched to
  <engine>/<model>`; and a rule that matched no dispatch by the run's end is
  reported as `[remap] rule "<rule>" matched no dispatch` and listed in the
  manifest's `dispatch_remap_unmatched`, so a mistyped key never silently
  leaves everything where it was.

A malformed rule is a usage error (exit `2`) before any run begins, whichever
layer supplied it.

## Fallback chains

`fallback` declares an ordered chain of other targets for a call —
`[{ engine, model, effort? }, …]`, each a Codex or Claude target, or `{ target,
effort? }` naming a named target bound to one — on the call itself, on a
`session()`, or once per engine in the script's `defaults`:

```js
export const defaults = {
  claude: { model: "<a Claude model>", fallback: [{ engine: "codex", model: "<a Codex model>" }] },
};
```

- The runtime moves the call to the next target when the current one fails
  for **availability** — the allowance is exhausted, the provider is
  overloaded past its own retries, the engine's process died or never
  started, or an engine refused the dispatch before a session existed. Output
  failures (empty, unparseable, or off-schema answers) retry on the same
  target and never advance the chain; a failure no rule classifies leaves the
  chain unconsulted, and stderr says so.
- Each step re-dispatches the same prompt, schema, placement and strip
  settings on the next target, fresh. `maxAttempts` counts answered attempts
  across the whole chain; a refusal costs none. A step to the same engine
  keeps its concurrency slot; a step to another engine releases it and is
  admitted again under that engine's cap and budget.
- A chain whose every target refuses fails with the last target's own
  failure: `null` when that failure was a spawned worker's, a throw when it
  was a substrate refusal.
- An empty or malformed chain, an opencode entry (literal, or a named target
  bound to opencode), or an engine the run does not have throws
  `FallbackTargetRejectedError` before any worker spawns. An opencode call may
  still declare a chain of Codex and Claude targets.
- On a `session()`, the chain applies to the creating turn alone: the target
  that answers fixes the session's engine and model for its life.
- The record shows each attempt's `target`, the `answered_by` entry (`-1`
  for the call's own target, the chain index after that), and each failed
  attempt's `chain_decision` — `advanced`, `retried-in-place`, `exhausted`,
  or `chain-not-consulted`. stderr announces an answer from a chain entry as
  `[<engine>] agent <id> (<label>) answered by fallback entry <n> (<engine>/<model>) — the declared target <engine>/<model> was refused: <kind>: <message>`.
