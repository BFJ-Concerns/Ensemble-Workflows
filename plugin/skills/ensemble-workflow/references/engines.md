# Engines and worker placement

How each of the five engines takes a call, what each needs before it can run
a worker, how to remove capabilities from a worker, and how `cwd` and
worktree isolation place one.

Contents: what the engines share · differences at a glance · `codex` ·
`claude` · `opencode` · `agy` · `zcode` · when an engine cannot be reached ·
`strip` and `lean` · placement

## What the engines share

Every engine honours one contract: the worker's final text, or with a
`schema` a value that validates against it, or `null` when the worker
failed. A worker on any engine runs unrestricted, with the launching user's
reach over the filesystem and the network; the runtime contains none of
them.

Engines start on first use. A script that names only `claude` runs on a
machine with no `codex` installed, and an engine that cannot start fails
only the calls that name it.

Each engine has its own concurrency cap: 12 workers at once on `codex`,
`claude`, `agy` and `zcode`, and 2 on `opencode`, unless the machine or
`--concurrency engine=N` says otherwise. Calls beyond the cap queue and are
admitted in the order they asked.

## Differences at a glance

| | `codex` | `claude` | `opencode` | `agy` | `zcode` |
|---|---|---|---|---|---|
| `model` | Optional | Optional | Required: a model the machine configuration declares | Optional: a base name `agy` lists | Required: `provider/model` |
| `effort` with none given | Engine default | Engine default | Engine default | Engine default | The model's highest listed level |
| `schema` | Enforced by the backend, then checked | Sent in the prompt, then checked | Sent in the prompt, then checked | Sent in the prompt, then checked | Sent in the prompt, then checked |
| `strip` | Yes | Yes | Yes | Refused | Yes |
| `lean` | Refused | Yes | Yes | Refused | Refused |
| `session()` | Yes | Yes | Refused | Yes | Yes |
| Fallback chain entry | Yes | Yes | Yes, for one-shot calls | Yes | Yes |

"Refused" means the call throws before its worker spawns.

## `codex`

Workers are threads of one Codex app-server that the run starts and shares.

- **Needs:** the `codex` CLI, signed in (`codex login`).
- **Model:** optional. Without one, Codex's own default runs and stderr
  names the model it resolved to. A model Codex does not know fails the
  attempt as `model-not-found`.
- **Schema:** Codex's backend accepts only a subset of JSON Schema. A
  schema outside it returns `null` at once, with no retry. The form that
  every engine accepts is in [script-api.md](script-api.md).
- **One process for the run.** If the app-server dies, the runtime does not
  restart it: every open Codex session is lost, and a later Codex entry in
  a fallback chain cannot answer. Recover from that with an entry on
  another engine.

## `claude`

Workers are Claude Code background sessions.

- **Needs:** the `claude` CLI, signed in (`claude auth login`); `tmux`,
  which the runtime uses to deliver prompts, follow-up turns and
  corrections; and a one-time consent. Claude workers run with permission
  prompts bypassed, which Claude Code allows only after the user has run
  `claude --dangerously-skip-permissions` interactively and accepted its
  disclaimer, once for the Claude configuration home the workers use. The
  runtime never accepts it for the user. A dispatch refused for want of the
  consent names the command to run; pass that to the user.
- **Model:** optional. Claude Code's own aliases (`opus`, `sonnet`, `haiku`)
  work as model names. A call with no model is flagged on stderr.
- **Effort:** `none` and `minimal` run as `low`.
- **The answer is the final reply.** When a worker starts a long command in
  the background and ends its turn to wait, the runtime waits too, for the
  reply that follows the task's completion. Claude Code may refuse a long
  foreground command, so tell a worker with long builds or tests to run
  them as background tasks. With a `timeoutMs`, a task that never finishes
  times the attempt out; without one, the wait lasts as long as the session.
- **A prompt that begins with `/name` is a command.** Claude Code runs the
  skill of that name, as if the line had been typed. When no skill by that
  name exists where the worker runs, nothing reaches the model, and the
  call fails at once as `claude-command-not-skill` without a retry. A
  `lean` worker loads none of the operator's installed skills. To send text
  that starts with a slash as text, put something before it.
- **Budget:** Claude spend counts cache reads, and every call re-reads
  Claude Code's own system prompt and tool definitions. A short answer from
  a fresh worker still spends tens of thousands of budget tokens.

## `opencode`

Each attempt is one run of the opencode CLI.

- **Needs:** the `opencode` CLI with its provider signed in
  (`opencode auth login`), and the model declared in the machine
  configuration's `opencode_models` section. The runtime ships no models:
  without a declaration every opencode call is refused before it spawns,
  and the refusal names the section, the file, and the models that are
  declared. See [machine-configuration.md](machine-configuration.md).
- **Model:** required. Give a declared key or its `provider/model` route.
- **Effort:** a canonical level, or one of the raw variant names the
  model's declaration lists.
- **No sessions.** `session()` on `opencode` is refused. An opencode entry
  can sit in a one-shot call's fallback chain, never in a session's.
- **Permissions:** the runtime starts opencode with its permission prompts
  approved automatically. Explicit denies in the operator's opencode
  configuration still apply.
- **Concurrency:** 2 at once unless raised.

## `agy`

Each worker is one session of Google's Antigravity CLI.

- **Needs:** the `agy` CLI, signed in to an account. A missing sign-in is
  repaired by signing in through `agy` itself.
- **Model:** optional. Give a base name as `agy` lists it; the reasoning
  level is not part of the name, it is the call's `effort`. A model `agy`
  does not list throws before any prompt is sent, and the error names what
  `agy` offers.
- **No `strip` and no `lean`:** both are refused before the worker spawns.
- **The answer** is the message text after the turn's last tool call. When
  `agy` ends a turn while its shell commands are still running, the runtime
  keeps the worker open until they end and takes the follow-up as the
  answer.

## `zcode`

Each turn is one headless run of the ZCode CLI.

- **Needs:** a `zcode` that can be told one run's provider, model and
  reasoning level, and that prints its model listing with `zcode models`. A
  ZCode lacking either ability is refused before any worker spawns, and the
  refusal names what it lacks. Provider credentials are configured in ZCode
  itself.
- **Model:** required, written `provider/model` with the names
  `zcode models` prints, split at the first `/`. ZCode, not Ensemble,
  refuses a name it does not list.
- **Effort:** clamped to the levels ZCode lists for the model. A call with
  no `effort` runs at the model's highest listed level.
- **Prompt size:** ZCode takes the prompt as one command-line argument,
  which Linux bounds at 128 KiB. A longer prompt is refused before the
  worker spawns. Pass a path to large material in place of the material.
- **No `lean`.**

## When an engine cannot be reached

| What the failure says | What to do |
|---|---|
| `authentication-failure`, or a sign-in is required | Give the user the sign-in step the message names. Signing in is the user's to do |
| Claude's bypass-permissions consent is missing | Give the user the command the refusal names |
| `model-not-found` | The engine does not serve that model name. Choose one it lists |
| A model is not declared in `opencode_models` | Use a declared model, or ask the user to declare this one |
| `ResourcePreflightRefusedError` | The launching process cannot use a directory the engine needs. The error names the directory, the setting that moves it, and any sandbox it identified |
| A `…SubstrateRefusedError`, or `ClaudeDispatchError` | The engine could not start or refused the dispatch itself. The message carries the engine's own account |

A bad model name is the script's to correct: `model-not-found` is retried
in place, and an undeclared opencode model throws before the worker spawns.
The other rows are availability failures. A fallback chain with an entry
remaining moves past one, and with none the call fails or throws as
[failures.md](failures.md) describes. When the user cannot repair an engine
now and the run should proceed on another, move the dispatches as
[rerouting.md](rerouting.md) describes.

## `strip` and `lean`

Both are opt-in. A worker asked for neither keeps its engine's whole tool
surface and the operator's whole context.

**`strip`** removes a named tool capability from a worker: `"skills"` (the
tool that loads skills) or `"agents"` (the tools that spawn subagents and
message other agents). Use it when a leg should do its work itself, with no
delegating and no skill of the operator's steering it.

- It is enforced through the engine's own configuration, never through the
  prompt, on `codex`, `claude`, `opencode` and `zcode`. `agy` refuses it.
- It removes the tool, not the ability: a worker stripped of `agents` can
  still start processes from its shell.
- Where the runtime cannot confirm the capability is gone, the call is
  refused before the worker spawns. It never runs unstripped in silence.
- A run-wide `--strip` and a call's own `strip` add together. A call cannot
  lift a run-wide strip.

**`lean`** starts a worker without the operator's interactive context:
user-level rules and instructions, the installed skill listing, and
configured MCP tools. It keeps its filesystem and network reach and the
engine's built-in tools. Use it for small legs that the context only
weighs down, and for a check that should not inherit the operator's
conventions.

- `claude` and `opencode` arrange it; on both, the project's own instruction
  files are left out as well. `codex`, `agy` and `zcode` refuse it.
- A lean worker knows none of the project's conventions. Put what it needs
  in the prompt.
- `--lean` applies to every worker in the run, and a call cannot lift it.

## Placement

`cwd` sets the directory a worker runs in, on every engine. It must exist,
and defaults to the run's working directory. A worker's edits land where it
was placed.

`isolation: "worktree"` gives the worker a fresh linked git worktree on a
temporary branch, so several workers can edit one repository at once.

- The branch starts at the source checkout's `HEAD`. Uncommitted changes in
  that checkout are not in the worktree; commit first what workers need to
  see.
- With `cwd` as well, `cwd` chooses the source repository. A `cwd` outside
  any git repository is refused, as is a machine with no `git` on `PATH`.
- Worktrees live in a `<repo>.ensemble-workflows-worktrees/` directory
  beside the repository.
- When the worker finishes, an unchanged worktree and its branch are
  removed. Changed work is kept and reported, never merged: committed work
  is on the reported branch, and uncommitted changes exist only in the kept
  worktree. Tell an isolated worker to commit its work, so that the branch
  holds all of it.
- The script reads the outcome from `worktrees`
  ([script-api.md](script-api.md)), and stderr reports each kept worktree
  in a `[worktree]` line with its path and branch.
- A session placed in a worktree works in that one worktree for its whole
  life.
- Isolation separates checkouts. It does not contain the worker, which can
  still write anywhere.

Collecting kept work is the caller's job once the run has ended: merge or
cherry-pick each reported branch, then remove the worktree and delete the
branch with git.

Each isolated worker that builds the project builds its own copy. Where the
machine cannot bear that many builds at once, lower the engine's cap for the
run with `--concurrency engine=N`.
