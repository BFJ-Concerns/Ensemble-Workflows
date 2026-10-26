# Engines and Placement

How each engine reaches the shared `agent()` contract, its concurrency defaults and failure modes, and how `cwd` and worktree isolation place workers. Read this when debugging engine behaviour, tuning concurrency, or running isolated fan-outs.

## The engines

All engines honour two invariants: **structured output is the contract** (a
schema agent returns a validated JSON value or `null`, never unvalidated data), and
**retry/verify is core** (empty or invalid output is re-run before giving up).
They differ only in substrate.

### Codex — workers over a `codex app-server`

- One persistent `codex app-server` process, started lazily on the first
  Codex call (a script that never dispatches to Codex runs without the CLI
  installed); each `agent()` is an ephemeral thread + turn, run with
  `approvalPolicy: "never"` so there are no approval round-trips.
- **`model` is optional but worth pinning.** An `agent()` call with no
  `model` runs whatever Codex's own configuration names as its default, and
  the launcher notes the resolved default on stderr as `runs unpinned` — so
  an unpinned fan-out spends on a model nobody chose. Pick it deliberately,
  per call or once via the script's `defaults` export. A `model` string
  passes through to Codex unchecked; a name the server rejects is the
  attempt's own failure.
- **`effort`** takes the canonical vocabulary — `minimal | low | medium |
  high | xhigh` — validated before any worker spawns and passed to the
  turn natively (an out-of-vocabulary level is a pre-spawn error, not a
  passthrough). Per-model defaults are uneven, so set effort explicitly
  rather than trusting the default. The record's `resolved_effort` is the
  level the engine reported serving.
- **Schema is enforced backend-side** via the turn's `outputSchema`, then
  re-validated client-side after the output arrives.
- A retry opens a fresh thread with the **previous failure folded into the
  prompt**, so the worker knows what to correct even without session context.
- **Transient backend errors are absorbed, bounded by messages and backed by
  time.** An error with `willRetry: true` leaves the turn open for the
  app-server's own retry; any sign of progress (turn start, a diff or plan
  update, an item notification) resets the tolerance, and a sixth consecutive
  retry promise without progress ends the turn as a retryable failure. An
  app-server that goes quiet after a retry promise, and a started turn that
  never produces an output-bearing frame, are each ended after 15 minutes by
  default (library options, deliberately neither CLI flags nor ambient
  settings). A backend `systemError` status ends the live turn at once.
- **One retry rule.** A turn deadline, a first-output deadline, a thread the
  app-server declared failed, or a retry promise that outlives its bound is
  an operational failure like any other: it consumes an attempt, the call
  retries within `maxAttempts` with the failure carried into the next
  attempt's prompt, and it resolves `null` at exhaustion with every attempt
  on the record — a call whose deadline should end it sets
  `maxAttempts: 1`. The one exemption is a pre-generation schema rejection,
  which no retry can change: one thread start, then the call's `null`. An
  app-server that never started, or has gone by the time a thread is
  opened, is a substrate refusal instead — `CodexSubstrateRefusedError`
  throws pre-spawn (advancing a declared `fallback` chain first).
- **A timeout names which deadline fired.** Where a deadline surfaces as an
  error — the direct-agent form, or the record's `termination_cause` — it
  distinguishes the **per-agent turn deadline** (the call's own `timeoutMs`:
  raise it, or narrow the work) from the **transport request deadline** (an
  app-server request exceeding its own timeout: the agent's `timeoutMs` is
  not the cause and raising it will not help).
- Workers run with **full access** (the unrestricted posture is passed
  explicitly on every turn) and have backend-side web search available
  without any option.
- Concurrency cap: **12** by default, overridable with
  `--concurrency codex=N`.

### Claude — workers as `claude --bg` background sessions

The Claude engine reaches the **same return contract** as Codex by entirely
different means — worth understanding so its behaviour doesn't surprise you:

- **Dispatch & completion.** A worker is launched with `claude --bg
  --dangerously-skip-permissions` and polled to completion. Completion is
  read from the session's **JSONL transcript** (the last assistant message
  has settled), *not* from the daemon's state field, which is not a
  dependable done-signal. Workers are prompted never to ask, so they finish
  unattended. Claude Code starts a background session in bypass mode only
  once its disclaimer has been accepted on the machine — a one-time
  interactive `claude --dangerously-skip-permissions` — which the *Live
  requirement* in `SKILL.md` covers.
- **The answer is the final reply, never an interim one.** Claude Code can
  move a long command or a Monitor into the background, let the model end
  its turn with a "waiting" message, then wake the session when the task
  ends. The runtime does not collect that interim reply: it waits for the
  reply that follows the task's delivered notification (a task the model
  stops with `TaskStop` ends at that result instead). The live status shows
  the worker `waitingOn` the task and the attempt records each wait in
  `background_waits`. The wait is bounded by the call's `timeoutMs` and
  nothing else: a task that never wakes the session times the attempt out,
  and without a `timeoutMs` the wait lasts until the session itself ends.
- **Environment hygiene.** Declared `worker_environment` values ride a
  private per-dispatch settings file (`claude --bg --settings`) whose
  directory carries the launcher's own liveness evidence, so a directory a
  killed launcher could not remove is swept by the next run that dispatches a
  Claude worker, while a live launcher's is never touched. Because any
  `claude` process the runtime launches can start the per-user daemon that
  then serves every later session, the run's own `ENSEMBLE_*` settings are
  withheld from those processes (`rerouting.md` has the list); the hold scope
  alone is delivered through the settings file, because inheritance is its
  contract.
- **No trust ceremony** (distinct from the one-time disclaimer above). Every
  `claude` process the runtime launches — the worker and the reply valve's
  attach client — carries `CLAUDE_CODE_SANDBOXED`, which Claude Code answers
  by skipping its per-directory trust dialog: a worker placed in a fresh
  scratch directory, a sibling checkout, or a generated worktree dispatches
  without anyone accepting a prompt and without a write to your Claude
  configuration. A dispatch Claude Code still refuses before the session
  exists is a substrate refusal, not a worker failure: it spends no attempt,
  advances a declared `fallback` chain, and otherwise throws
  `ClaudeDispatchError` pre-spawn with the directory and Claude Code's own
  refusal text — never a `null` a fan-in would filter away. A dispatch the
  daemon accepted but never registered is not a refusal and stays an
  operational failure the retry loop spends.
- **`effort`** takes the same canonical vocabulary, validated pre-spawn; only
  `minimal` clamps (to `low`), the rest are native. The record's
  `resolved_effort` carries the level the engine reports serving, or `null`
  when it reported none.
- **Pin `model:` deliberately.** An unpinned Claude call burns the ambient
  default model silently, so the runtime makes it visible: every
  `{ engine: 'claude' }` call with no `model` — from the call site or the
  script's `defaults` — logs a `[claude] agent N runs unpinned` warning to
  stderr; the run record attributes its spend to whatever *served* model the
  engine reports (the literal `unresolved` when none was ever learned). Pair
  a pinned model with a `fallback` chain when you want declared degradation
  on an availability failure instead of a hard failure.
- **Same unrestricted posture as every engine.** Permissions-bypassed workers
  run in the shared run cwd (or their `cwd`/worktree placement) with full
  filesystem and network access. A wide fan-out without `isolation` can
  therefore write files and run commands in the same checkout concurrently —
  prompt workers to read-only behaviour when that matters, and give write-heavy
  parallel editors `isolation: 'worktree'`.
- **Result by transcript.** The answer is the **final assistant message read from
  the persisted JSONL transcript** — not an RPC payload. Only the clean
  transcript is load-bearing.
- **Schema by extract-validate-correct.** Claude has no backend `outputSchema`,
  so the schema **rides the prompt**; the extracted message is validated
  client-side with the *same validator the Codex path uses*. The prompt asks the
  worker to *include* a conforming JSON value in its final message and explicitly
  allows prose and markdown fences around it — the tolerant contract described
  under `agent()`, where the last validating value in the message wins. On failure
  the validation error is **steered back into the same session** (an in-session
  correction that preserves context), up to `maxAttempts` — not a fresh
  re-dispatch. This makes Claude's schema enforcement as strong as Codex's
  despite the missing backend hook.
- **Graceful degradation.** The reply valve that carries the correction rides a
  disposable `tmux` pane on a private tmux server that loads no configuration
  and does not appear among your own sessions, delivering each injection in
  bounded slices so a correction or follow-up of any size arrives intact; a
  refused injection names the tmux step that failed, and what it said, in the
  attempt's `claude-valve-error` failure. Where `tmux` is absent, schemas are
  still *checked* but cannot be corrected in-session — correction falls back
  to a fresh re-dispatch that folds the prior failure into the prompt. A
  worker that stalls awaiting input is nudged a bounded number of times; an
  exhausted stall counts as an empty attempt inside the retry loop, so a call
  on either shape degrades to `null` after `maxAttempts`. Operational
  failures — a registered session that died, a poll timeout, a transcript
  unreadable or settled without a provable completion — likewise consume
  attempts, with the worker's partial text, exit evidence, and the engine's
  own diagnostic retained in the failed attempt record; a synthetic
  API-refusal reply carrying a 429, 503, or 529 is classified `availability`
  and advances a declared `fallback` chain instead of spending an attempt.
  The runtime degrades; it never hangs for want of the valve.
- Concurrency cap: **12** by default, overridable with `--concurrency claude=N`.
  Kept separate from Codex's so one engine can't starve the other (the allowance
  and daemon are a scarcer, independently rate-limited resource).

### opencode — workers through `opencode run`

The opencode engine is model-agnostic, so **`model` is mandatory** — and the
runtime ships no models of its own. The catalogue is whatever the machine
configuration declares under `opencode_models` in
`$XDG_CONFIG_HOME/ensemble/config.json` (`~/.config/...` when unset); free
passthrough to an undeclared provider/model id is deliberately not supported.
Each key is a name an `agent()` call may pass as `model`; a call may equally
name the entry by its `provider_model` route. Only `provider_model` — the
`provider/model` route `opencode run --model` takes — is required; the
optional `display_name`, `family`, `vision` (default `false`), `billing`
(`pay-as-you-go` or `self-hosted`), and `variants` describe the entry for an
author choosing between families. A key or route that would name two entries
is invalid, and the file is refused before any worker starts.

```json
"opencode_models": {
  "glm-5.2": { "provider_model": "openrouter/z-ai/glm-5.2", "family": "glm", "billing": "pay-as-you-go" }
}
```

Read that file (by key — never printing `worker_environment`) to learn what
the machine you are on declares before naming a model. Missing `model` throws
`OpenCodeModelRequiredError`; a model the file does not declare throws
`OpenCodeModelNotRegisteredError`, listing the declared names — or, when
nothing is declared at all, naming the section to declare them in. Both happen
before any worker spawns, so a script never silently falls back to an
accidental provider/model.

```js
await agent("Build a compact UI sketch.", { engine: "opencode", model: "glm-5.2" });
```

opencode schemas ride the prompt and are validated client-side by the shared
validator, like Claude's path — including the tolerant contract, where the
worker may wrap its JSON in prose and the last validating value wins. `effort`
maps to opencode's provider variant (`--variant`) and is exempt from the
canonical vocabulary: it must name one of the `variants` the model's
declaration lists, or it throws before the worker spawns — with none declared,
any `effort` throws, because `opencode run` forwards an unknown variant to
the provider without complaint, so variants are declared from the provider's
own listing, never guessed. opencode reports no served model, so the record's
`resolved_model` is the configured `provider_model`.

Use the declared metadata when pairing capabilities: a model declared
without `vision` cannot inspect images, so visual inspection needs a
vision-capable entry or another vision-capable verifier, and distinct
`family` values are what make a cross-family check genuine. The runtime
records these facts but does not enforce verifier relationships; compose the
pairing in the workflow. opencode holds its one-shot surface: `session()`,
`strip`, and a place in a `fallback` chain all throw before any worker spawns.

opencode operational failures (the subprocess killed on its deadline, a run
that exited non-zero) consume retry attempts like Claude's — they degrade to
empty attempts with the evidence retained in the failed attempt record,
rather than hanging or throwing.

- Concurrency cap: **2** by default, overridable with `--concurrency opencode=N`.
  Kept conservative because opencode providers have independent rate and
  resource limits.

Caps are self-imposed scheduler limits, not protocol ceilings; excess `agent()`
calls of an engine queue and run as that engine's slots free. The whole-run
agent ceiling (`--agent-ceiling`) is enforced together with the per-engine
caps in one admission decision: a worker takes both capacities or queues
holding neither, the longest-waiting eligible worker starts when capacity
frees, and a worker whose engine is full is skipped so it cannot block
another engine's queue. One ceiling slot covers the complete logical
`agent()` call — retries, worktree finalisation, and archival included — and
child workflows share their parent's ceiling. When the run ends, calls still
queued are rejected without starting.


## Placement: `cwd` and worktree isolation

Every worker has a **placement**, resolved once per target and kept across
that target's retries (a fallback step to another target opens its own). By
default a worker starts in the run cwd; `cwd` moves it elsewhere (it must be
an existing directory); `isolation: 'worktree'` — on **any engine** — starts
it in a **fresh linked git worktree** on a temporary branch cut from `HEAD` of
the (`cwd`-selected) repository, so parallel file-editing agents do not
collide. A non-git placement with `isolation` set fails before the worker
spawns. After the turn:

- If the worker left **no changes** — nothing dirty in the tree *and* no new
  commits on the branch — the worktree and its temporary branch are **removed**
  (its record still lands in the `worktrees` global, with `removed: true`; the
  path and branch it names no longer exist).
- If it **made changes** (dirty files or commits), the worktree is **kept** on
  disk (branch intact, `changed: true` and the branch's final `tipCommit` in
  its record), and the CLI logs
  `[worktree] changed <path> (<branch>)` to stderr. Changed work is
  preserved and reported, never auto-merged — merging is the orchestrator's
  judgement. **Committed** work survives on the reported branch; **dirty
  uncommitted** work exists only in the preserved worktree directory, so tell
  isolated workers to commit what they produce. If clean-up itself fails, the
  call fails, the error is reported, and the branch is recorded as changed
  and kept, since it was not proven unchanged.

Kept worktrees live in an `<repo>.ensemble-workflows-worktrees/` directory
*beside* the repository, invisible to `git status` inside it. Harvesting them
finishes the run: for each `worktrees` record with `changed: true`, merge or
discard the branch, then `git worktree remove <path>` and `git branch -D
<branch>` from the repository. Place isolated workers from the main checkout:
a `cwd` that is itself a linked worktree gets its kept worktrees in a
directory beside *that* worktree, nested a level deeper where a harvest does
not look. A linked worktree shares the repository's object store — it
isolates the *checkout*, it does not contain the worker (which retains full
host access).

```js
await parallel(
  files.map((f) => () =>
    agent(`Refactor ${f} to use the new API. Commit your changes.`, {
      engine: "codex", isolation: "worktree"
    })
  )
);
// Inspect what survived (skip records whose worktree was cleaned up):
for (const w of worktrees.filter((w) => w.changed)) log(`changed ${w.path} on ${w.branch}`);
```

**Build-heavy fan-outs: the count cap does not bound memory.** Each isolated
worktree is a fresh checkout, so N workers in a compiled-language repo can mean
N concurrent full builds. The per-engine concurrency cap bounds worker *count*,
not host memory, and a fleet comfortably within cap can exhaust a host. Only
the workflow author knows the build weight, so when workers will each compile
the project, lower the cap with `--concurrency engine=N` (a sanctioned
exception to the leave-run-tuning-unset rule). A shared build cache cuts the
duplicate work but adds a clobber hazard: a sibling's build can overwrite the
shared artefact mid-run, so have each worker build and copy to a path it
owns, and verify the artefact it runs is its own build.
