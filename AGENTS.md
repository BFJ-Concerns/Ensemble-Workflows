# Ensemble

Ensemble is a TypeScript/Node runtime that runs JavaScript workflow scripts over
AI coding agents on three engines: Codex (`codex app-server`), Claude
(`claude --bg` background sessions), and opencode (`opencode run`). `agent()`
requires an explicit `engine`, so one model family can check another's work in
a single run. `README.md` gives the overview; `docs/` is the usage reference.

## Commands

`just` is the front door; `just --list` shows every recipe.

- `just verify` is the gate: ESLint, the test suite (`npm test` compiles and
  rebuilds the launcher first), then a check that the rebuild left the tracked
  launcher unchanged (`git diff --exit-code` on it, against the index). CI
  runs this same recipe, so a new check belongs in the justfile rather than in
  a workflow file.
- `just test-live` runs the live tests against real engines and is outside the
  gate. Legs that need a model read `ENSEMBLE_LIVE_CODEX_MODEL` or
  `ENSEMBLE_LIVE_OPENCODE_MODEL` and skip while it is unset.

The test suite needs a systemd user session (some tests bound child processes
with `systemd-run --user --scope`) and `codex` on `PATH` (some tests ask it for
the app-server protocol schema).

## The launcher and the plugin

The repository is a plugin for Claude Code and Codex (manifests in
`.claude-plugin/`, `.codex-plugin/` and `.agents/plugins/`; the plugin and
marketplace are both named at the root) carrying one skill,
`skills/ensemble-workflow/`: its `SKILL.md` and `references/` are the guidance
an agent on any of the three tools drives the runtime with, `agents/openai.yaml`
is Codex's interface block, and `scripts/ensemble.mjs` beside them is the
self-contained launcher, built from `src/` by `npm run build:skill`. The
plugin layout fixes that path — the launcher sits beside `SKILL.md` with no
directory between — so do not move or rename it. The skill's text ships with
the runtime it describes and is kept true of it in the same change; it names
nothing particular to one machine (no hosts, paths, services or routing
policy), so a change that would add such a thing belongs in a user's own
guidance, not here.

Building rewrites the tracked launcher, so `just verify` and `npm test` can
leave the tree dirty. Commit the rebuilt launcher with the change that caused
it; the gate fails while the rebuild differs from the staged or committed
copy.

## Documentation

`README.md` and the pages in `docs/` document using Ensemble:

| Page | Covers |
|---|---|
| `docs/workflow-scripts.md` | Script format, hooks, `agent()` options, sessions, holds, failure handling |
| `docs/cli.md` | Commands, flags, output, exit codes |
| `docs/configuration.md` | Machine configuration file, `ENSEMBLE_*` variables, defaults, library options |
| `docs/run-records.md` | Live status file, completion sentinel, run record schema |

When runtime behaviour changes — a new option or flag, a changed error, a new
record field — update the matching page in the same change. Describe the
current behaviour only; how it used to work belongs in the commit message.
`test/unit/progress.test.ts` parses the status-file schema section of
`docs/run-records.md` and fails unless its field bullets match the snapshot
the code publishes.
