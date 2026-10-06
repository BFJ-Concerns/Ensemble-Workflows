# Ensemble

Deterministic multi-agent orchestration harness for multiple LLM engines
(TypeScript / Node), mirroring Claude Code's `Workflow` tool. An LLM authors a
JavaScript workflow and runs it through a CLI over a fleet of workers, each on a
chosen engine — **Codex** (`codex app-server`), **Claude** (`claude --bg`
background sessions), or **opencode** (an `opencode run` subprocess over a model
the machine configuration declares). `agent()` requires an `engine`; none is privileged. The
distinctive capability is **cross-engine verification**: one model family checks
another within a single run. (Repo: `Ensemble-Workflows`; the CLI binary and
skill are `ensemble` and `ensemble-workflow`.)

## Working in the repository

`just` is the front door — `just --list` shows every recipe.

- `just verify` is the gate: ESLint, then the test suite (`npm test` compiles
  and rebuilds the skill bundle first). CI runs this same recipe, so a green
  run here means CI's checks passed, and a new check belongs in the justfile
  rather than the workflow file.
- `just test-live` reaches real engines and is deliberately outside the gate.

Note that the gate is not read-only: building the bundle rewrites the tracked
`skills/ensemble-workflow/Base/scripts/ensemble.mjs`, so a run can leave the
tree dirty. Commit that rebuild with the change that caused it.

## Status

Feature-complete v1, landed and tested: a real multi-engine harness. `agent()`
calls run on any of three engines — **Codex** over a `codex app-server`, **Claude** as
`claude --bg` background sessions, or **opencode** over an `opencode run` subprocess
(a declared model, selected per call) — behind one engine-registry seam, with
mandatory explicit engine selection and **cross-engine verification** (one engine
finds, another verifies). Each reaches the identical return contract
(schema-validated object or `null`) through different machinery: Codex enforces
schema backend-side via `outputSchema`; Claude and opencode ride the schema on the
prompt and read the result from the session transcript — Claude over a tmux reply
valve, opencode from the exported session — correcting in-session. Shared across engines: bounded retry, per-engine concurrency caps,
per-engine token-budget ceilings, and the full script surface (`parallel()`, `pipeline()`,
full-Node workflow scripts — the former `node:vm` sandbox is retired).
`isolation:'worktree'` is uniform across all three engines.

## Only the runtime lives here

The `ensemble-workflow` skill's guidance — `SKILL.md` and its variants — is
maintained outside this repository, and this repo carries **no copy of it**: it
owns the **runtime** — `src/`, the tests, and the built bundle the skill ships.

`skills/ensemble-workflow/` holds exactly two files: the built bundle at
`Base/scripts/ensemble.mjs` (the path `npm run build:skill` writes and every
skill install expects — do not move or rename it) and a `README.md` describing
how to use the runtime, derived from `src/`.

When runtime behaviour changes (`src/`, a new option, a changed error), rebuild
the bundle with `npm run build:skill` (esbuild →
`skills/ensemble-workflow/Base/scripts/ensemble.mjs`) and keep the usage
`README.md` truthful to the new behaviour. Do not write skill guidance into
this repo: a second copy here would drift from the maintained one.
