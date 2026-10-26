# The Script API

The full authoring surface for workflow scripts: script anatomy, every hook and its options, saved workflows, and the schema subset Codex accepts. Read this when writing or editing a script; `SKILL.md` carries only the contracts that prevent silent misuse.

## Script anatomy

Every script begins with an `export const meta = { … }` object literal, then a
body that uses the hook globals and returns a value:

```js
export const meta = {
  name: "my-workflow",
  description: "One line on what this does"
};

// body: top-level await is allowed; return the result you want on stdout
const answer = await agent("Say hello in one word.", { engine: "codex" });
return { answer };
```

- `meta` must be the **very first thing in the file** — nothing may precede it,
  **not even a comment or file header** — and a plain object literal (it is
  extracted and evaluated before the body runs, so it cannot reference body
  variables). `name` and `description` are the meaningful fields, and
  `meta.task` is copied verbatim into the run record as an opaque grouping
  key for tools that evaluate archives; other keys are accepted but not
  interpreted. There is no live progress tree: `phase()`, `log()`, and the
  `label`/`phase` options are stderr logs, status-file updates, and run
  record entries, not a rendered display.
- An optional **second export**, `export const defaults = { … }`, may sit
  between `meta` and the body (blank lines and comments may separate the two
  exports; a `defaults` declared later in the body is rejected with a placement
  error): per-engine policy that every `agent()` call and `session()` on that
  engine inherits and any call-site option overrides. Keys are engine names;
  each may set `model`, `effort`, and `fallback` — anything else throws before
  the body runs. The values are checked then too, not at first use: a
  `fallback` chain naming an opencode entry, or an opencode `model` the
  machine configuration does not declare, fails **before the body runs**
  rather than partway through a fan-out. Use it to state a script's model
  and effort policy once, auditably, instead of scattering pins across thirty
  calls:

  ```js
  export const meta = { name: "review", description: "…" };
  export const defaults = {
    codex: { model: "<a Codex model>", effort: "low" },
    claude: { model: "<a Claude model>", effort: "medium" }
  };
  ```

  Pin both even when they match today's surface defaults: per-model defaults
  are uneven and shift, and a pinned pair makes the policy auditable in the
  script itself (*Choosing an effort level* in `SKILL.md` is the judgement
  for picking a level). Defaults are per script: a child run via `workflow()`
  applies its own `defaults` block, not the parent's.
- The body runs as **ordinary, unsandboxed Node**: every Node global —
  `process`, `Buffer`, `fetch`, timers (an
  `await new Promise(r => setTimeout(r, ms))` sleep is ordinary code) — plus
  the filesystem, the network, `require(...)` and dynamic `import()`
  resolving from the script's own path, and `import.meta`. Static `import`
  syntax does not apply — the body is a function body, not module top level.
  A syntax error in the body is reported at the script's own line and column
  with a source excerpt and caret. Two guards survive: a free identifier that
  is neither a Node global, a bound hook, nor a module-scope binding **fails
  at load, before any worker spawns**, naming the unknown identifiers — a
  `typeof X` probe is fine, but a mistyped name is a load error, not a
  `ReferenceError` after paid agent phases; and the script's own `meta`
  export is bound read-only in the body. The script is the trusted
  orchestration program of the user who launched it; workers are dispatched
  only through `agent()` and `session()`. Waiting on and inspecting the world
  is free in-script code — sleep, watch a path, read a file, `fetch` a status
  endpoint — so never spend a paid worker on a wait. One boundary of the
  opt-in `--timeout`: it stops the run's wait at the next `await`
  settlement — the body itself is never interrupted, and a synchronously
  spinning loop can only be stopped by killing the process. End the body
  with `return`, never `process.exit`: the body runs in the launcher's own
  process, and an exit call is intercepted and settles the run as failed
  (*Stopped and failed runs leave salvage* in `SKILL.md`).

## A kept script carries its contract in its header

A one-run script needs nothing beyond `meta`. A **kept** script — saved into a
workflow registry, shipped with a skill, or kept in a project repository — is
dispatched by sessions that never saw it written, and must let them dispatch
it without reading its body. It states its whole contract in three comment
blocks directly after `meta` and `defaults`, in this order and under these
labels:

- `// INPUT (--json-args @file):` — every field the script reads from
  `args`: its name, shape, whether it is required, and what it means. Pass
  the inputs by file (`@file`) when any field carries prose. Preparation the
  caller owes before dispatch belongs in this block too — a workspace staged,
  a file written, a commit resolved to a hash — because a reader of the
  inputs is deciding what to prepare.
- `// OUTPUT (stdout JSON):` — the shape of the return value the launcher
  prints as one JSON line: each field's meaning, and how a failed leg shows
  up in it (a named `null`, a `failure` field, a `gaps` list), so the reader
  knows what to check before trusting the rest.
- `// RUN:` — the invocation, written with the `ensemble` shorthand (*The
  launcher* in `SKILL.md` expands it) and `<skill>` for the script's own
  installed directory; the run-tuning flags the script relies on
  (`--hold-scope` for one that raises holds, `--agent-ceiling` or
  `--concurrency` where the width is the launch's); where stdout and stderr
  go; and any constraint on the launch directory (an empty directory for a
  blind pass, the code repository for one that reads it). The block names no
  detached-launch wrapper: how a run that outlives a turn is backgrounded is
  the dispatcher's own concern. A blank line closes the block.

The header is the contract, and a dispatcher reads it alone. This read
returns the exports and the three blocks and stops at the blank line that
closes `RUN`:

```sh
awk '/^\/\/ RUN/ { r = 1 } r && /^$/ { exit } { print }' <skill>/workflows/<script>.js
```

Design notes a script carries beyond its contract — why a stage is blind, how
its hold protocol works — sit after that blank line, where the read does not
reach.

## Hooks

These globals are bound for you — do not declare or import them.

### `agent(prompt, opts)`

Spawns one worker on the named engine (or on the engine and model a named
target binds) and returns its result. `engine` or `target` is mandatory.

- **Without `schema`** → resolves to the worker's final message **text**
  (trimmed, non-empty string). If the worker keeps returning empty output,
  the call retries up to `maxAttempts` and then resolves **`null`** — the
  same collapse as the schema shape, never a throw.
- **With `schema`** → the output is parsed as JSON and **validated client-side
  against the full JSON Schema** (nested shapes, enums, `required`), and the
  **validated value** is returned — any JSON value the schema admits; Claude and
  opencode accept non-object top levels, while Codex's subset requires an object
  (*Schemas Codex accepts*). On empty, unparseable, or schema-invalid
  output it retries up to `maxAttempts` and then returns **`null`**. Prefer an
  object top level for fan-ins so `null` can only mean failure and
  `.filter(Boolean)` is safe; a schema that admits falsy values (`false`, `0`,
  `""`, JSON `null`) makes a successful result indistinguishable from
  exhaustion.

**Once a worker has spawned, every failure is a value.** On both shapes
alike — bad output exhausting the bound, an availability refusal no fallback
entry answers, a transport error mid-attempt, a turn deadline, a Codex
rejection of the schema before generation — the call resolves `null`; the
failure's class and account are on the agent record (each attempt's
`failure` and `classification`, the agent's `termination_cause`) and, under
`identity: true`, on the envelope's `failure` field; and the launcher
announces it on stderr as
`[<engine>] agent <id> (<label>) failed after N attempts — <cause>` (a call
whose chain reached past its own target reads `… across M chain targets —
the last target's failure: <cause>`). An author who wants a failed call to
stop the script checks for `null`, or reads `failure` under `identity: true`.
The boundary is spawn: a rejection raised before a worker exists — a bad
option, a placement that never opened, a substrate refusing the dispatch
itself, an unenforceable strip discovered as the thread is configured, a
budget refusal — still throws, and the run's own ending (interrupt, whole-run
timeout) still throws through a leg it tore down, so a bare `await` sees the
run stop.

This return contract is identical on all engines; only *how* the schema is
enforced differs (*The engines* in `engines.md`).

**A schema-bearing reply may carry prose around its JSON, and the last valid
value wins.** The runtime does not require the final message to be bare JSON: it
scans the text for every parseable JSON value and takes the **last one that
validates** against your schema. A candidate is the whole reply, any balanced
`{…}` or `[…]` region in it, or a line holding nothing but one JSON scalar
(`null`, `false`, `0`, `""` on its own line, fenced or not); a scalar
mentioned mid-sentence is prose, not a candidate. The agent record's
`parse_route` names the shape that won (`direct`, `object-fallback`,
`array-fallback`, `scalar-line`). On Claude and opencode the worker is told this
outright — the prompt asks it to *include* a conforming value and explicitly
permits surrounding prose and markdown fences. That tolerance is the specified
contract, not a leniency to write around, so a worker that reasons aloud before
answering is not a failure mode you need to prompt away.

Its one sharp edge: when a reply contains several schema-valid values, the last
one is the answer. A worker that shows a worked example and then gives its real
answer is read correctly; one that gives its answer and then illustrates a
counter-example is not. Where that ordering is plausible, tell the worker in the
prompt to put its final value last.

`opts`:

| Option | Type | Effect |
| --- | --- | --- |
| `engine` | `'codex'` \| `'claude'` \| `'opencode'` | **Required unless `target` is given.** Selects the worker engine. No default. |
| `target` | string | A named target bound in the machine configuration, in place of `engine` and `model` — one or the other, never both (*Named targets* in `rerouting.md`). |
| `schema` | JSON Schema object | Turns on structured output; returns a validated JSON value or `null`. See *Schemas Codex accepts* below. |
| `model` | string | The worker model (engine-specific). **Required on opencode** and must name a model the machine configuration declares under `opencode_models`, by its key or its `provider/model` route — see *opencode* in `engines.md`. Codex and Claude strings pass through unchecked. |
| `effort` | string | Reasoning effort, one canonical vocabulary on Codex and Claude — `'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh'` — validated **before the worker spawns** (*Choosing an effort level* in `SKILL.md`). Codex takes the level natively; Claude clamps only `minimal`→`low`. `resolved_effort` on the agent record is the level the engine reports serving, or `null` when it reported none. opencode is exempt: `effort` maps to the provider variant (`--variant`) and must name one of the `variants` the model's declaration lists, or it throws pre-spawn. |
| `fallback` | array | Ordered chain of `{ engine, model, effort? }` targets (Codex or Claude in any position) or `{ target, effort? }` entries the runtime advances to on an **availability** failure — allowance, terminal overload, a dead or unstartable substrate — never on empty, unparseable, or off-schema output, which retries in place. `maxAttempts` counts answered attempts across the whole chain; the record carries `fallback`, `answered_by`, and per-attempt `chain_decision`. An opencode target in the chain throws pre-spawn; an opencode call may still declare a chain of Codex/Claude targets. *Fallback chains* in `rerouting.md` has the detail. |
| `cwd` | string | Worker working directory, any engine; must exist; defaults to the run cwd. With `isolation`, selects the source repository the worktree is cut from. |
| `isolation` | `'worktree'` | Run the worker in a fresh git worktree cut from the (`cwd`-selected) repository — **all engines**. See *Placement* in `engines.md`. |
| `timeoutMs` | number | Per-attempt deadline in ms (positive integer, at most `2147483647` — a larger value is rejected, not shortened). **No default — unbounded unless set**: a worker is not killed for running long. See *Backstopping a long or stuck run* in `SKILL.md`. |
| `maxAttempts` | number | Bound on answered attempts — empty or invalid output, backpressure, and post-spawn operational failures (a dead session, a turn deadline) all consume one; a refusal the fallback chain advances past consumes none. Counted across the whole chain. Default 3; set `1` when a deadline should end the call rather than retry it. |
| `label`, `phase` | string | Recorded on the worker in live status and the durable run record, and the keys a dispatch remap's `label:`/`phase:` rules match. An explicit `phase` overrides the current run phase captured from `phase(title)`. |
| `identity` | boolean | `true` resolves `{ label, phase, output, failure }` (label/phase `null` when unset) instead of the bare output. `failure` is the discrimination: `null` exactly when the worker's own settlement completed — so `output: null` beside `failure: null` is a genuine answer — and a `{ message }` account when the leg failed: a schema call's exhausted collapse, or an operational failure inside `parallel()`/`pipeline()`, which resolves `{ label, phase, output: null, failure }`, never bare `null`. Non-boolean values throw before the worker spawns. `ensemble agent --identity` prints the envelope. |
| `strip` | array | Strip named tool-surface capabilities from the worker: `'skills'`, `'agents'` — anything else throws before the worker spawns. See *Workers are unrestricted by default* below. |

**Unknown option keys throw before the worker spawns** — a typo like
`maxAttemps` fails loud instead of being silently ignored, and so does an
invalid value for a harness-owned option (`target`, `effort`, `isolation`,
`timeoutMs`, `maxAttempts`, `identity`, `strip`). Codex/Claude `model`
strings pass through unchecked; an opencode `model` is checked against the
machine's declarations, and a `fallback` chain's targets are checked (an empty
or malformed chain, an opencode entry, or an engine the run does not carry
throws `FallbackTargetRejectedError`), both before dispatch. When several
options are invalid at once, one rejection names them all. The former
`sandbox`, `network`, and `webSearch` options, and `fallbackModel`, are
removed and throw a specific removal error, never a silent no-op. The prompt
must be a **non-empty string**, and an explicit per-call `cwd` must name an
**existing directory** — either error rejects before a worker or run-record
entry is created.

### Availability failures and the fallback chain

Every failed attempt is classified from the engine's own diagnostic, and the
class decides what happens next:

- **`availability`** — Codex's `usageLimitExceeded`, `rateLimitExceeded`, or
  `serverOverloaded`, a connection the provider refused, a dead or
  unstartable app-server; Claude's synthetic API-refusal reply carrying a
  429, 503, or 529, a `claude --bg` Claude Code refused, a dispatch the
  daemon never registered, a session that never showed life.
- **`output`** — empty, unparseable, or off-schema output.
- **`unclassified`** — a deadline, a Codex rejection of the authored schema
  before generation, a client diagnostic about a bad model name, or a
  diagnostic no rule recognised (recorded with `rule: null`, so a stale
  classifier table is visible in the archive rather than silently stranding
  chains).

Only an availability failure advances a declared `fallback` chain; the
mechanics, the record fields, and the stderr lines are in `rerouting.md`.

### Substrate refusals

A dispatch the engine's substrate declines before any session exists is not
a worker failure and spends no attempt. The runtime sets
`CLAUDE_CODE_SANDBOXED` on every Claude worker and valve attach client, so
Claude Code skips its per-directory trust dialog wherever the worker is
placed (the mechanics are in `engines.md`). A dispatch Claude Code
still refuses — a daemon that will not start, a directory it cannot resolve,
a version that ignores the declaration — is recorded as a refused attempt
classified `availability` (`claude.dispatch-refused`), advances the fallback
chain where an entry remains, and otherwise throws `ClaudeDispatchError` (a
pre-spawn member) out of `agent()` and through `parallel()`/`pipeline()`,
failing the run with the placed directory, the declaration, and Claude Code's
own refusal text on one stderr line. A dispatch the daemon accepted but never
registered within the dispatch bound is not a refusal — Claude Code did not
decline — and stays an operational failure the retry loop spends. Codex's
analogue is `CodexSubstrateRefusedError`: an app-server that never started or
is already gone when a thread is opened refuses pre-spawn, while a
`thread/start` the running server rejects (a bad model) is the server
answering and stays the attempt's own failure.

**Workers are unrestricted by default.** Every worker, on every engine, runs
with the full filesystem and network access of the user running the runtime —
there is no sandbox and no Ensemble-managed network boundary. Backend web
search remains available to Codex workers without any option. When a worker
must not touch something, say so in its prompt — and remember prompts constrain
behaviour, not capability, so route genuinely untrusted work elsewhere.

The one opt-in restriction is `strip`, and it removes the named *tool-surface*
capability only — stripping `agents` removes the worker's subagent and
agent-messaging tools, not its ability to run processes from a shell. A
run-wide `--strip` list (set before the script path) unions with each call's
own `strip`: a call can add strips, never lift a run-wide one. Enforcement is
per-engine:

- **Codex** — both are enforced mechanically through a per-thread
  `thread/start` config overlay: `agents` disables the collaboration tool
  namespace, and `skills` disables bundled skills plus an exact
  `skills.config` deny for every discovered skill name. Skill discovery
  **fails closed**: the runtime samples the installed skills up to ten times
  one second apart until the set stops changing; a discovery error, a set
  that never settles, or the discovery deadline expiring fails before the
  worker spawns rather than shipping an incomplete deny list. The settled
  result is cached per working directory for the run's life.
- **Claude** — both are enforced mechanically as permission deny rules
  (`Skill`; `Task`/`Agent`/`ListAgents`/`SendMessage`) riding the
  per-dispatch settings file.
- **opencode** — both **throw before the worker spawns**: enforcement has not
  been demonstrated at a live worker boundary, so the runtime refuses rather
  than pretending.

Each agent's durable record carries the requested strip names and the route
each resolved to, so the archive shows how every strip was discharged.

### Writing worker prompts

A worker's output is only as good as its prompt. State the task, what success
looks like, and exactly what to return; a vague schema-bearing prompt is the
usual cause of retries and `null`s. Frame **verification prompts** to check
independently and to hunt for why a claim is **wrong**, not merely to agree —
that framing is what makes cross-engine verification catch anything.

### `session(options)` — multi-turn workers

`session(options)` creates a **persistent worker** on `'claude'` or `'codex'`
and returns a handle whose `send(prompt, { schema? })` runs one turn against
the *same* worker each time — the follow-up that returns to the builder still
holding the context of what it built, instead of a cold dispatch re-briefed
through a pasted summary. An opencode session throws before any worker spawns
(that engine is held at its one-shot surface).

```js
const builder = session({ engine: "claude", model: "<a Claude model>", effort: "medium" });
const plan = await builder.send("Read src/parser/ and propose a fix plan.", { schema: planSchema });
const diff = await builder.send("Now implement step 1 of your plan.");
await builder.close();
```

- **Fixed at creation:** `engine` (or `target`), `model`, `effort`, plus
  `fallback`, `cwd`, `isolation`, `timeoutMs`, `maxAttempts`, `label`,
  `phase`, `strip`, and `stalenessMark` (below). The fallback chain applies
  to the creating turn alone: the target that answers fixes the session's
  engine and model for its life (`handle.engine` reads the answering
  engine), and a later turn's availability failure fails that turn. Changing
  model or effort would invalidate the session's prompt cache — escalation
  is a fresh dispatch, not a mid-session switch. **Per turn:** `schema`
  alone, on `send()`; each turn gets the same validated-return,
  tolerant-parse, bounded-retry, and failure-as-value contract as a one-shot
  `agent()` call (a schema turn resolves the validated value or `null`; a
  bare turn resolves the reply text or `null`; a failed turn's account is on
  that turn's own agent record, and the session stays usable for the next
  `send()`). Creation spawns nothing — the worker starts at the first
  `send()`.
- **Turns are sequential:** `send()` while a previous send is unsettled
  throws, as does `send()` after `close()` or after the run ends.
- **Concurrency and budget are per turn:** a turn holds its engine-cap and
  ceiling slot from dispatch to settlement, and an idle session holds
  nothing; each `send()`'s budget admission is judged at its own dispatch,
  exactly like a one-shot call.
- **Cache economics:** a Claude session's worker is dispatched with the
  1-hour prompt-cache TTL in its environment
  (`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h`; a machine-declared
  `worker_environment` value for that variable wins); one-shot Claude
  workers keep Claude Code's default. Codex exposes no TTL knob.
- **The staleness mark:** `handle.stale` reads `true` once the idle gap since
  the last settled turn outlives the session's cache economics — the TTL
  cliff on Claude, 60 idle minutes on Codex — and `handle.idleMs` carries the
  gap itself. Advisory only: a send to a stale session still executes; the
  script decides whether to pay the re-read or dispatch a fresh worker
  re-briefed from the original materials. `stalenessMark: false` disables the
  mark for that session, and `handle.staleAfterMs` reads the resolved
  threshold.
- **Lifetime:** `await handle.close()` stops the worker early, once any turn
  in flight has settled; every held session is closed when the run ends by
  any path — a run never leaves a held worker live, and a later run cannot
  re-attach an earlier run's session.
- **The archive:** each turn is its own agent record carrying a
  `session: { id, turn }` field, so per-turn prompts, attempts, and usage
  read back like any one-shot call's, grouped by session id. A session with
  `isolation: 'worktree'` works one worktree for its whole life, finalised at
  session close.
- **Claude mechanics:** follow-up turns ride the tmux reply valve into the
  held session, delivered in bounded slices so a follow-up of any size
  (whole diffs included) arrives intact; without `tmux`, a session's
  follow-up or correction **fails loudly** rather than silently substituting
  a fresh worker — a session-using script hardens the tmux requirement from
  degraded-mode to necessary — and a refused injection names the tmux step
  that failed, and what it said, in the turn's `claude-valve-error` failure.

Reach for a session when later turns genuinely profit from the worker's
accumulated context (build-then-refine, propose-then-implement,
review-then-fix); a fan-out of independent briefs still wants one-shot
`agent()` calls.

### `parallel(thunks)`

Barrier fan-out: runs every thunk concurrently and awaits all of them. A
dispatched worker's failure is already the leg's own **`null`** (*`agent()`*,
above); a thunk that throws for any other reason also resolves to `null`
in that slot — the call itself never rejects, and the real error is logged to
stderr. Always `.filter(Boolean)` the result before using it. One deliberate
exception: the **pre-spawn author-error family**, from any hook — an unknown
`agent()` option key or invalid value, a malformed schema, a rejected
fallback target or named target, a placement that fails before dispatch (a
non-git `cwd` with `isolation`), a substrate refusing the dispatch
(`ClaudeDispatchError`, `CodexSubstrateRefusedError`), an unresolvable
`workflow()` reference or non-JSON `workflow()` arguments, a nesting
violation, or a composed child's load-time authoring failure — propagates and
fails the run rather than collapsing to `null`. A budget-exhausted dispatch is
an ordinary thrown error: it nulls the slot here and throws only from a bare
`await agent(...)`. A slot whose call set `identity: true` keeps its identity
even when it fails operationally: the combinator resolves `{ label, phase,
output: null, failure }` for it, never bare `null` — so `.filter(Boolean)` no
longer drops that slot; partition on `.failure` instead when using identified
calls in a fan-in (filtering on `.output` would also discard a genuine `null`
answer, which carries `failure: null`).

```js
const results = await parallel([
  () => agent("Task A", { engine: "codex", schema }),
  () => agent("Task B", { engine: "claude", schema })
]);
const ok = results.filter(Boolean);
```

Each thunk must be a function (`() => agent(...)`) — `parallel` controls when
they start. Thunks may target different engines, so a single `parallel` can fan a
job across several families at once.

### `pipeline(items, ...stages)`

Runs each item through all stages **independently — there is no cross-item
barrier**. Item A can be in stage 3 while item B is still in stage 1. Stage
callbacks receive `(previous, originalItem, index)`; the first stage's
`previous` is the item itself. A stage that throws drops **only that item** to
`null` (its remaining stages are skipped) and logs to stderr — with the same
pre-spawn rejection exception as `parallel`.

```js
// A per-item find→verify pipeline that crosses engines in stage 2:
const checked = await pipeline(
  topics,
  (topic) => agent(`Research ${topic}.`, { engine: "codex", schema: noteSchema }),
  (note, topic, i) =>
    agent(`Verify note ${i} about ${topic}: ${JSON.stringify(note)}`, { engine: "claude", schema: verdictSchema })
);
```

Use `pipeline` (not a barrier between `parallel` stages) whenever stages are
per-item independent — it keeps fast items moving instead of waiting on the
slowest item of the previous stage.

### `workflow(nameOrRef, args)`

Runs a saved workflow inline and returns the child workflow's result.
`nameOrRef` is either:

- a **name** string, resolved by reading saved workflows' `meta.name` from the
  workflows registry; or
- **`{ scriptPath }`**, which runs a saved script file by path. Relative paths
  resolve like the top-level CLI script path: from the run cwd.

The child receives the `args` value passed to `workflow()` as its `args`
global. That value must be a JSON value — a function, symbol, cycle, or
BigInt anywhere in it fails the run with the offending path named.
It shares the parent's **same run context**: per-engine concurrency caps,
per-engine budget ledgers, `worktrees` side channel, and durable run record. A
child's worker calls therefore spend from the same engine ledgers as the parent,
and parent ceilings still bite. A composed run stays one run in the durable
record: the manifest's `workflow_invocations` lists the root and every
`workflow()` child in call order — each with its resolved script path, archived
source and canonical arguments, their hashes, and a parent link, written before
the child runs — while the root's `meta.task` remains the single grouping
identity.

Nesting is **one level only**: `workflow()` called inside a child throws. This is
composition and reuse, not recursion; use ordinary JavaScript loops or functions
when the current script needs recursive control flow.

### `hold({ content, verdicts, timeoutMs? })` — decision holds

`await hold(...)` publishes a decision request and resolves
`{ verdict, note }` once a decider answers. Use it wherever a run must pause
for a judgement the script cannot make itself — a user sign-off, an
orchestrator's go/no-go — without burning a worker on the wait.

- **Raising:** `content` is what the decider reads (a non-empty string);
  `verdicts` the non-empty set of accepted answers. The hold is published as
  a JSON file under the run's **scope** in the shared cross-run root
  (`$XDG_DATA_HOME/ensemble/holds/<scope>/`), carrying everything a decider
  needs: the content, the verdicts, a fresh nonce, the decision path, and
  the raiser's liveness evidence. Open holds also appear in the run's live
  status file.
- **Scoping:** the scope is an opaque key the launcher supplies — an
  orchestrating session's own id is a natural value — so cooperating sessions
  on one machine never see each other's holds in their own views. Set the
  inherited `ENSEMBLE_HOLD_SCOPE` variable once and every nested invocation
  inherits it; the `--hold-scope` flag (workflow and `agent` runs alike)
  outranks the variable per run. A keyless run's holds land in the default
  shared scope, which scoped listings never show and the machine-wide listing
  always shows. Scoping is hygiene against accidental cross-answering, not a
  security boundary: the nonce stays the correctness gate, and the scope is
  never inferred from cwd or process ancestry.
- **Answering:** `ensemble holds answer <hold-id> --verdict <v> [--note <n>]`
  copies the nonce, writes then renames the decision file, records the
  answerer (`ENSEMBLE_CALLER_IDENTITY`, else `host:pid`), and watches the
  hold for a few of the raiser's poll intervals, printing one JSON object on
  stdout. Exit `0` means the answer was consumed and the run resumed; `3` it
  bounced (the reason is reported; the hold keeps waiting); `4` the raiser
  has not read it yet (the answer file stays; never reported as accepted);
  `5` no open hold has that id; `6` the hold settled without judging this
  answer (its stale decision file is removed). Any process can also answer by
  hand: write `{"nonce": "<the hold's nonce>", "verdict": "<one of the
  accepted verdicts>", "note": "optional", "answered_by": "optional"}` to a
  temp file beside the hold's `decision_path`, then rename it into place —
  the runtime polls, and the rename removes the mid-write window. A stale
  nonce, an unlisted verdict, or a malformed file is rejected: the bad file
  is consumed, the still-published hold record gains its rejection reason,
  and the hold keeps waiting — an invalid answer never reaches the script.
  An open hold carrying no rejection fields means the answer has not yet
  been judged (feedback appears only after the poller's next read), never
  that it was accepted; an accepted answer removes the hold, and so does a
  retirement after the raiser was found dead — where that distinction
  matters, read the run's archive or live status rather than treating
  disappearance alone as acceptance.
- **Enumerating:** `ensemble holds` shows the inherited scope's open holds
  (every scope when none is set); `ensemble holds --scope <scope>` names a
  scope explicitly; `ensemble holds --all` is the machine-wide view across
  every scope, the shared scope included. Each listing carries id, state,
  scope, verdicts, decision path, content, any rejection feedback a bounced
  answer left behind, and the raising run's identity card — workflow name,
  phase, archive path, and agent totals as of the raise; `--json` emits the
  full records. A listed hold is `open` or `bounced` (a rejected answer is
  waiting to be corrected); a dead raiser's hold is reported as `retired`.
  There is no accepted state — an accepted answer removes the hold.
- **Timeout:** an optional `timeoutMs` bounds an unanswered hold; expiry
  rejects the awaiting `hold()` with `HoldTimeoutError` — catch it to treat
  expiry as an outcome rather than a run failure.
- **Observability:** raise, answer, rejected answer and timeout each land in
  the archive manifest's `hold_events` list, with who answered
  (`answered_by`, `null` when the decision file named no one) and their
  `note`; a retirement lands there only when the raising run's own startup
  sweep observed it — one a listing observes is not recorded. A hold whose raiser is provably dead — judged from the
  liveness evidence the record carries, never guessed — is retired by the
  enumeration or sweep that observes it, so the listing only ever shows
  answerable holds.

### `phase(title)` and `log(message)`

Plain logging to **stderr**. `phase("compile")` writes `[phase] compile` and
updates the run's current phase in the live status file (and is the phase a
dispatch remap's `phase:` rules match for calls without their own `phase`);
`log(...)` writes the message verbatim. There is no rendered progress tree —
only the status file and the log stream. The status file itself — fields,
liveness rules, where it lives — is in `run-evidence.md`.

### `tally(name, value)`

Records a named numeric count into the run manifest's `tallies`, beside the
usage rollup: `await tally("fix rounds", 3)`. Numbers only, last write per
name wins; a blank name or a non-finite value throws before anything is
recorded. The runtime cannot know which worker verified which, or how many
rounds a loop took — the script can, and a count it records is the
accountability the archive can honestly carry.

### `budget`

Reading the ledger is always fine; *setting* a ceiling is not something to do
unasked — see the run-tuning note under *The loop* in `SKILL.md`. With no
`--budget` flag every engine is unbounded, which is the right default for most
runs.

`{ spent(engine), remaining(engine) }` — **per-engine**, named like `agent()`:

```js
budget.spent("codex");      // Codex tokens consumed so far
budget.remaining("codex");  // tokens left under Codex's ceiling
budget.spent("claude");
budget.remaining("opencode");
```

Each engine has an **independent ledger** — there is no aggregate pool and no
zero-argument call. Ceilings are set per engine with the `--budget engine=N`
flag. An engine with **no ceiling** is unbounded: `remaining()` returns
`Infinity` (which serialises to JSON `null` if you return it directly). When
an engine *has* a ceiling, `agent()` checks it **once per call, at dispatch** —
before the worker enters the concurrency queue, and again when a fallback step
moves it to another engine — and **throws `BudgetExceededError`** for a call
that has not yet dispatched once spend has reached the ceiling (a ceiling of
`0` admits no call and says so). Enforcement is per-engine, so an opencode
ceiling stops only opencode calls while Codex and Claude keep running. A call
that starts under the ceiling runs its full retry bound even if concurrent
spend crosses the ceiling mid-call, so a worker's own failure is never
rewritten as budget exhaustion; turns already started can collectively
overshoot the ceiling. This is what makes **loop-until-budget** viable: gate a
loop on `budget.remaining('codex') > 0` and it terminates when Codex's ceiling
is hit (see `patterns.md`).

Cross-engine note: the ledgers measure different things. Codex tokens come
from the app-server's usage events; Claude tokens are read from the worker's
transcript once per API call (rows sharing a message id count once, summed
across the turn's calls; a held session's later turn counts only the calls it
made); opencode tokens come from opencode's session export, or from its
stream's per-step usage when that export is unavailable, and a stream carrying
no usable token data advances no spend. The ledgers are kept **separate,
never summed** — the engines have different cost and allowance models, so a
combined figure would mix unlike things.

### `worktrees`

A read-only array of finished isolated-worktree records, appended as
`isolation:'worktree'` agents on any engine complete — including cleaned-up
ones. Each record is `{ path, branch, baseCommit, tipCommit, changed,
removed }` (`tipCommit` is the branch's final commit — equal to `baseCommit`
when the worker committed nothing); filter on `changed` to find the worktrees
actually left on disk for you to inspect or merge (a `removed: true` record's
path and branch no longer exist).

### `args`

By default, the CLI tokens after the script path, as a **`string[]`** (raw argv —
not parsed JSON). Parse them yourself:

```bash
ensemble brief.js TCP DNS HTTP
```
```js
const topics = args;            // ["TCP", "DNS", "HTTP"]
const count = Number(args[0]);  // coerce as needed
```

Pass `--json-args '<json>'` **before** the script path and `args` is instead the
**parsed JSON value** — an object, array, number, whatever you encode (a JSON
`null` arrives as an empty array):

```bash
ensemble --json-args '{"topics":["TCP","DNS"],"rounds":3}' brief.js
```
```js
const { topics, rounds } = args;  // args is the parsed object
```

`--json-args` and positional tokens are mutually exclusive: when `--json-args` is
present, tokens after the script path are ignored for `args` (the script still
runs). Without it, `args` is always the `string[]`.

**Prose payloads: write the JSON to a file and pass `@file`.** A prose-heavy
payload (a research brief, instructions, a rubric) built inline is a
shell-quoting trap: an apostrophe inside the prose — `the API's quirks` — closes
the bash single-quote, and a following `(` then parses as a subshell. Prefix the
file path with `@` and the launcher reads the JSON directly, without command
substitution or shell interpretation. Relative paths resolve from the run's
working directory; absolute paths work as written:

```bash
# payload.json: {"topic":"the API's quirks (part 2)","rounds":3}
ensemble --json-args @/abs/path/payload.json brief.js
```

Valid JSON cannot begin with `@`, so the file form is unambiguous. A missing,
unreadable, or invalid JSON file exits with code `2` and a usage error before the
workflow starts, as does a value nested deeper than 256 levels of arrays or
objects, in either form.

## Saved workflows

Saved workflows live in a registry that starts empty. Project-level entries live
under `<cwd>/.claude/ensemble/workflows/` (an Ensemble-owned path — the same
directory whatever tool hosts the orchestrator); user-level entries live under
`${XDG_DATA_HOME:-~/.local/share}/ensemble/workflows/`. Project entries are
resolved first and shadow same-named user entries. Files are plain workflow
source files, so project-level saved workflows can be committed and shared.

Discover before composing by name:

```bash
ensemble workflows
```

The command lists saved workflows from **both** scopes by `meta.name` and
`meta.description`. Names come from metadata, not filenames, so enumerate what
already exists before calling `workflow("name", args)` and before adding
another saved workflow. If the same name exists in both registries, both
entries appear in the listing — the user entry labelled `user (shadowed by
project)` — even though `workflow("name")` resolves only the project entry at
call time. Files whose metadata cannot be parsed are noted on stderr and
skipped.

### What to save

Save a workflow when it has become a stable, named building block — a verifier
panel, triage pass, reducer, or research stage likely to be reused. Give it a
clear `meta.name`, a useful `meta.description`, and a boundary expressed through
`args` and its return value rather than hidden assumptions about one parent
script. Keep task-specific glue and one-off experiments inline; the registry is
a curated toolbox, not a dumping ground — but equally, do save the patterns you
keep rewriting. A saved workflow is a kept script, so it carries the header
contract (*A kept script carries its contract in its header*).


## Schemas Codex accepts

Schemas on every engine are JSON Schema **draft-07** (the default when
`$schema` is omitted) or **draft 2020-12** (declare
`"$schema": "https://json-schema.org/draft/2020-12/schema"`); any other
declared dialect is rejected before a worker spawns, naming the supported
dialects.

Codex validates `outputSchema` backend-side **before** generation and accepts a
**stricter subset than full JSON Schema** — some schemas the Claude and
opencode engines accept are rejected by Codex. When Codex rejects a schema,
the call resolves **`null` after one thread start** — no retry, no chain
advance, since no retry can change the verdict — with the rejection on the
agent record and stderr as `CodexSchemaSubsetUnsupportedError`, naming
`claude` and `opencode` as the engines that validate the full JSON Schema
client-side and quoting the server's diagnostic once. It is one of the
failure-as-value cases, so a fan-in sees it as an ordinary `null`; read the
record (or `failure` under `identity: true`) to tell it from a worker that
returned bad JSON, which retries before collapsing. Write object schemas that
follow these rules and you stay inside the accepted subset (and they validate
fine on the other engines too, so the same schema works everywhere).
Separately from Codex's subset: a schema that does not compile as JSON Schema
*at all* throws `InvalidAgentSchemaError` from `agent()` on **any** engine,
before a worker spawns — a broken schema never costs a paid turn; a
JavaScript schema object with a reference cycle is refused the same way with
its location, while recursive `$ref` schemas that compile are accepted.
Codex-subset rules:

- Top level is `type: "object"`.
- Set `additionalProperties: false`.
- Every key in `required` also appears in `properties`.
- Optional properties are fine to author: Codex's strict structured-output mode
  has no optionality, so the runtime promotes any property absent from
  `required` into the Codex-bound `outputSchema` copy automatically. The
  client-side validator still enforces your **full** schema after output
  arrives, on all engines. One behavioural nuance: a Codex worker is thereby
  *compelled* to emit every declared property, while Claude and opencode may
  omit optional ones — so never treat a field's presence as signal, and give
  an optional free-text field (an `outOfScopeConcerns`, say) an explicit
  "empty string when none" convention so Codex workers aren't nudged into
  inventing content for it.
- Avoid exotic constructs like `{"not": {}}` or bare/recursive `$ref` games.

```js
const noteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "summary"],
  properties: {
    topic: { type: "string" },
    summary: { type: "string" }
  }
};
```
