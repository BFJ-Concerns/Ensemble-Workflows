# Ensemble

Ensemble runs JavaScript workflow scripts that coordinate many AI coding
agents across several engines: **Codex**, **Claude Code**, and **opencode**.
A script fans work out to agents, collects their structured answers, and
combines them. Each agent call names the engine it runs on, so one model
family can check another's work within a single run.

- Codex runs over `codex app-server`, Claude runs as Claude Code background
  sessions (`claude --bg`), and opencode runs through `opencode run`. Every
  call names its engine; there is no default.
- A call given a JSON Schema returns a value that validates against it, or
  `null` if the call fails.
- `parallel()` and `pipeline()` fan work out, `session()` keeps a worker's
  context across turns, `workflow()` runs saved workflows inline, and
  `hold()` pauses a run for an outside decision.
- Per-engine concurrency caps, an optional run-wide agent ceiling, per-engine
  token budgets, and per-call deadlines and retry bounds keep a run in check.
- A fallback chain moves a call to another engine or model when its target is
  unavailable.
- `isolation: "worktree"` gives a worker its own git worktree, so parallel
  workers can edit the same repository.
- A run can publish a live status file while it runs, and by default leaves
  a durable archive of its prompts, attempts, transcripts, and token counts.

## Requirements

- Node.js 24.14.0 or later.
- The CLI for each engine you use, installed and signed in: `codex` for
  Codex, `claude` (Claude Code) for Claude, and `opencode` for opencode.
  opencode models must also be declared in the
  [machine configuration](docs/configuration.md#opencode_models).
- `tmux`, for follow-up turns and in-session corrections on Claude.
- `git`, for worktree isolation.

Ensemble is developed and tested on Linux.

> [!WARNING]
> Workers run unrestricted. Each one can read and write anywhere the user
> running Ensemble can, and can reach the network. Run Ensemble only where
> that is acceptable.

## Getting started

The launcher, `skills/ensemble-workflow/Base/scripts/ensemble.mjs`, is a
single self-contained file, so a checkout runs it with no install step:

```sh
git clone https://github.com/BFJ-Concerns/Ensemble-Workflows.git
cd Ensemble-Workflows
node skills/ensemble-workflow/Base/scripts/ensemble.mjs agent \
  --engine codex --model gpt-6-luna 'Say hello in one sentence.'
```

The answer is printed on stdout as JSON:

```json
"Hello!"
```

The rest of this README writes the launcher as `ensemble`. An alias gives it
that name:

```sh
alias ensemble='node /path/to/Ensemble-Workflows/skills/ensemble-workflow/Base/scripts/ensemble.mjs'
```

The launcher can also be copied anywhere on its own and run with `node`.

## A first workflow

This script asks Codex for likely bugs in a file, then has Claude check each
claim independently and keeps only the confirmed ones:

```js
export const meta = {
  name: "find-and-verify",
  description: "Find likely bugs with Codex, then confirm each with Claude",
};

const file = args[0];

phase("Find");
const found = await agent(`Read ${file} and list the likely bugs in it.`, {
  engine: "codex",
  model: "gpt-6.1-sol",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["bugs"],
    properties: {
      bugs: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["line", "claim"],
          properties: {
            line: { type: "integer" },
            claim: { type: "string" },
          },
        },
      },
    },
  },
});
if (found === null) throw new Error("the finder failed");

phase("Verify");
const verdicts = await parallel(
  found.bugs.map((bug) => () =>
    agent(
      `In ${file} at line ${bug.line}, someone claims: "${bug.claim}". ` +
        `Read the code and decide whether this is a real bug.`,
      {
        engine: "claude",
        model: "opus",
        label: `line ${bug.line}`,
        schema: {
          type: "object",
          required: ["real", "reason"],
          properties: {
            real: { type: "boolean" },
            reason: { type: "string" },
          },
        },
      },
    ),
  ),
);

return found.bugs.filter((_, i) => verdicts[i]?.real === true);
```

Run it with the file to check as its argument, keeping the result and the log
apart:

```sh
ensemble find-and-verify.js src/parser.ts > result.json 2> run.log
```

A script begins with its `meta` export and runs as the body of an async
function in ordinary Node, so it can use the filesystem, the network, and any
Node module. The hooks it can call:

| Hook | Purpose |
|---|---|
| `agent(prompt, options)` | Run one worker and return its answer, or `null` if it failed |
| `session(options)` | Create a multi-turn worker that keeps its context between turns |
| `parallel(thunks)` | Run calls concurrently |
| `pipeline(items, ...stages)` | Run each item through a series of stages |
| `workflow(name, args)` | Run a saved workflow inline |
| `hold(options)` | Pause until someone outside the run makes a decision |
| `phase(title)`, `log(message)` | Write to the run log |
| `tally(name, value)` | Record a named count in the run record |
| `budget`, `worktrees`, `args` | Token accounting, isolated worktrees, and the script's arguments |

[Workflow scripts](docs/workflow-scripts.md) covers every hook and option,
the differences between engines, and how failures are reported.

## Command line

```text
ensemble [run options] <script.js> [args...]          run a workflow script
ensemble agent --engine <engine> [options] [prompt]   run a single agent
ensemble workflows                                    list saved workflows
ensemble holds [--json] [--scope <scope> | --all]     list open decision holds
ensemble holds answer <hold-id> --verdict <verdict>   answer a decision hold
```

Workflow and agent results go to stdout as JSON, and logs go to stderr. A
run that fails or is interrupted exits non-zero and prints a partial result
holding every completed worker's output. Run options set per-engine token budgets
(`--budget codex=200000`), concurrency caps, a whole-run timeout, and more;
see [CLI](docs/cli.md).

## Configuration

Ensemble runs Codex and Claude workers without any configuration. An optional
file at `~/.config/ensemble/config.json` sets concurrency caps, a run-wide
agent ceiling, where run records and status files go, extra environment
variables for workers, and the models opencode may use. `ENSEMBLE_*`
environment variables override the caps, the ceiling, and the run record and
status settings. See [Configuration](docs/configuration.md).

## Run records and live status

While a run is active it writes a small JSON status file — phase, per-engine
counts and token spend, live workers, open holds — by default to `.claude/` in
its working directory, when that directory exists. By default every run also
leaves an archive under `~/.local/share/ensemble/runs/` holding the workflow
source and arguments, each agent's prompt, attempts, outputs, transcripts,
and token usage, and a manifest with integrity hashes. A completion sentinel
file tells a supervising process when, and how, the run ended. See
[Run records and live status](docs/run-records.md).

For an accepted run with a status namespace present, its own status file is
published before any worker dispatch and removed only after the terminal
sentinel write attempt. When the write succeeds, the sentinel is present
before status disappears. Publication begins after the launcher starts and accepts
the invocation; failed status or sentinel writes never fail the run.

## Documentation

- [Workflow scripts](docs/workflow-scripts.md): the script format, hooks,
  `agent()` options, sessions, holds, and failure handling.
- [CLI](docs/cli.md): commands, options, output, and exit codes.
- [Configuration](docs/configuration.md): the configuration file, environment
  variables, and defaults.
- [Run records and live status](docs/run-records.md): the status file,
  completion sentinel, and run record formats.

## Building from source

```sh
npm ci
npm run build
```

The build compiles the TypeScript in `src/` to `dist/` and rebuilds the
launcher at `skills/ensemble-workflow/Base/scripts/ensemble.mjs`.

## Licence

Copyright (C) 2026 BFJ Concerns.

Ensemble is licensed under the GNU Affero General Public License, version 3
or (at your option) any later version. See [LICENSE](LICENSE). The launcher
file opens with this copyright and licence notice, so a copy carried on its
own keeps it. It also bundles third-party packages under their own licences,
listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) and included at the end
of the launcher file itself.
