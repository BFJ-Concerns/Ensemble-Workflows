# Rerouting: the dispatch remap, named targets and fallback chains

Three mechanisms move a workflow's dispatches between engines and models
with the script left as written. This file says which to use, how each
resolves, and how to tell what a run's workers actually ran on afterwards.

## Which to use

| Situation | Mechanism | What changes |
|---|---|---|
| One run should go elsewhere now: a family is refusing, out of allowance, or answering badly | Dispatch remap at launch | Nothing on disk |
| A role should move for every workflow on the machine, until someone moves it back | Rebind the named target | The machine configuration file |
| Later runs should get past an outage with nobody relaunching them | Fallback chain | The script, or the machine configuration |

Whichever is used, the run record keeps what the script asked for beside
what was dispatched.

Before moving anything, work out which family each role would land on. A
script whose finder runs on one family and whose checker runs on another
loses its check when the two are moved together. When the checker's family
is the one misbehaving, move the checker to a third family where the machine
has one. Where it has none, run on one family and report that the
cross-family check was not performed.

## Dispatch remap

`--remap key=engine[:model]` re-routes matching dispatches for one launch.
It goes before the script path, or after `agent` for a single worker, and
repeats for several rules:

```sh
node <launcher> --remap claude=codex review.js
node <launcher> --remap 'label:verify-*=agy' --remap 'phase:Find=codex:<model>' review.js
```

`ENSEMBLE_DISPATCH_REMAP` holds the same rules separated by commas, for a
shell session that launches several runs. Any `--remap` flag replaces the
whole variable; the two never merge. There is no configuration-file layer:
a standing remap would turn every cross-family workflow on the machine
single-family with nothing in the launch to show it.

**Keys.** For each dispatch, the first matching rule in the highest-ranked
kind wins:

1. `label:<glob>` matches the call's `label`.
2. `phase:<glob>` matches the call's `phase` option, or else the phase that
   `phase()` last set.
3. `engine:model` matches the engine and model, after any named target has
   been resolved and the model filled in from the script's `defaults`.
4. `engine` matches the engine alone.

A glob matches the whole label or phase. `*` matches any run of characters
and `?` matches one. Quote a rule that has a glob, so the shell leaves it
alone. Read the script's labels and phases before writing a glob: they are
what it matches.

**Destination.** An `engine:model` pair, or an `engine` alone. Without a
model, the moved call takes the script's `defaults` model for the
destination engine, or else that engine's own default; the call's own
`model` never crosses engines. A destination on `opencode` or `zcode` needs
a model from the rule or from `defaults`, since those engines require one.

**Effort** carries over as the canonical level the call asked for, and is
resolved afresh for the destination's model. A call whose effort is a raw
opencode variant name cannot be moved to another engine; it is refused.

**Reach.** The remap applies to a call's first dispatch and to each fallback
entry the call reaches, so a chain cannot carry a call back onto an engine
the launch moved it off. A session is remapped once, at creation, from its
label and phase, and keeps that engine and model for its life.

**What the run tells you.** Stderr names the winning key for each remapped
dispatch. At the run's end, a rule that matched no dispatch is reported as
`[remap] rule "<rule>" matched no dispatch`: a mistyped key shows up
there, not as a run that silently stayed where it was. A malformed rule
rejects the invocation with exit code 2 before any run begins.

## Named targets

A named target is a name of the operator's choosing that the machine
configuration binds to an engine, with or without a model. Ensemble ships no
names. `doer` and `reviewer` below are examples.

```js
const plan = await agent(prompt, { target: "reviewer", effort: "high" });
const builder = session({ target: "doer", label: "builder" });
```

On the command line it is `agent --target <name>`.

- `target` takes the place of `engine` and `model`. A call that gives it
  beside either is refused.
- Names are resolved before any worker spawns, from the bindings read when
  the run starts. A rebinding reaches the next run, never one in flight.
- A binding with no model takes the script's `defaults` model for the bound
  engine, or else the engine's own default. That engine's `defaults` block
  also supplies `effort` and `fallback` where the call leaves them unset.
- A name the machine does not bind is refused with
  `NamedTargetRejectedError`, which lists the names the file does bind.

To learn what is bound without dispatching, call
`lookupDispatch({ target: "<name>" })` in a script, or read the `targets`
section of the machine configuration file
([machine-configuration.md](machine-configuration.md) says how to read that
file safely).

The bindings live under `targets` in that file:

```json
{
  "schema_version": 1,
  "targets": {
    "doer": { "engine": "codex", "model": "<a Codex model>" },
    "reviewer": {
      "engine": "claude",
      "fallback": [{ "engine": "codex", "model": "<a Codex model>" }]
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `engine` | Yes | `codex`, `claude`, `opencode`, `agy` or `zcode` |
| `model` | No | The model to dispatch |
| `fallback` | No | A fallback chain. An entry may name another target, and takes only that target's engine and model |

**Rebinding** is one edit to a binding's `engine` or `model`. It moves
every workflow on the machine that uses the name, from each one's next run,
so it is the operator's decision: make it when the user asks for the move
to stand. The file is strict: a binding to an unknown engine, a blank
model, an unknown field, or a chain entry naming an unbound target stops
every run before any worker starts, naming the key and the file. After an
edit, confirm it with one small dispatch on the name:

```sh
node <launcher> agent --target reviewer --effort low --identity 'Reply with the word ready.'
```

The `answeredBy` in its output names the engine, model and family the name
now reaches.

## Fallback chains

A fallback chain is an ordered list of other targets a call moves to when
its own is unavailable.

```js
export const defaults = {
  claude: {
    effort: "medium",
    fallback: [{ engine: "codex", model: "<a Codex model>" }, { target: "spare" }],
  },
};
```

An entry is `{ engine, model, effort? }` or `{ target, effort? }`, on any
engine, in any order, at any length. An entry that names an engine has to
name its model too. An entry with no `effort` takes the call's canonical
level; a raw opencode variant name passes only to another opencode entry.
An entry that names a target takes the binding's engine and model, never
the binding's own chain: chains do not nest.

**Where a call's chain comes from.** The runtime uses the first declaration
it finds, whole, never merged with another:

1. the call's own `fallback`;
2. the script's `defaults` for the engine the call is dispatched on, after
   any dispatch remap;
3. the binding of the named target the call names;
4. the machine configuration's `fallback` map, by `engine:model` and then by
   `engine`.

`fallback: false` on a call or in a `defaults` block ends the search with no
chain. So a call that declares nothing may still have a chain, from the
binding or from the machine's map. Where a doer and its checker have to
stay on different families, both say `fallback: false`.

**When the chain advances.** Only on an availability failure: the engine
refused or lost the worker before it answered. Each step dispatches the same
prompt, schema, placement, `strip` and `lean` afresh on the next entry, and
spends none of the call's attempts. A bad answer is retried on the same
target and never moves the chain.

- Every entry has to support what the call asks for. An entry on an engine
  that cannot honour the call's `strip` or `lean` is refused before the
  first dispatch.
- A step to another engine is admitted again under that engine's
  concurrency cap and token budget, and a budget refusal there throws.
- Codex entries share the run's one app-server. Once it has died, a later
  Codex entry cannot answer; put another engine in the chain to cover that.
- A chain whose every target refuses fails with the last target's failure.
- For a `session()`, the chain applies to the first turn only. The target
  that answers it is the session's engine and model for life, and every
  entry has to be on an engine that supports sessions.

**What the run tells you.** Stderr reports
`[<engine>] agent <id> (<label>) answered by fallback entry <n>`, naming
each refused target and why. When a call with a chain fails for a reason
that is not availability, stderr says the chain was not consulted. With
`identity: true`, `answeredBy` names the engine, model and family that
answered.

## Which family ran

A model's family is the group it belongs to by the name it commonly goes
by, whatever engine runs it. The runtime places a model from its name:
`claude` (with Claude Code's aliases), `gpt` (with OpenAI's other model
names), `gemini`, `glm`, `kimi`, `qwen`, `deepseek`, `grok`, `llama`,
`mistral`, `minimax`. The machine configuration can assign a family to a
name the runtime cannot place. A model placed by neither has the family
`null`: unknown, never assumed.

- Before dispatch, `lookupDispatch()` gives the family a call would run on.
  It answers `null` for a call that names no model, because the engine's
  default is known only once a worker reports it.
- After a call, `answeredBy.family` gives the family that answered,
  fallback steps included.
- At the run's end, when every worker resolved onto one family, stderr says
  `[single-family] all <n> workers resolved onto one model family: <family>`.
  The notice judges each worker on the target it was first dispatched to,
  so a checker that fell back onto its doer's family is not reported there;
  `answeredBy` shows it. The notice stays silent when any worker's family
  is unknown, and the machine configuration can turn it off.
