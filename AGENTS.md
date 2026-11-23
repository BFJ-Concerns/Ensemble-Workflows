# Ensemble

Ensemble is a TypeScript/Node runtime that runs JavaScript workflow scripts over
AI coding agents on four engines: Codex (`codex app-server`), Claude
(`claude --bg` background sessions), opencode (`opencode run`), and ZCode
(one headless `zcode` run per turn). `agent()` requires an explicit `engine`,
so one model family can check another's work in a single run. `README.md` gives the overview; `docs/` is the usage reference.

## Commands

`just` is the front door; `just --list` shows every recipe.

- `just verify` is the gate: ESLint, the test suite (`npm test` compiles and
  rebuilds the launcher first), then a check that the rebuild left the tracked
  launcher unchanged (`git diff --exit-code` on it, against the index). CI
  runs this same recipe, so a new check belongs in the justfile rather than in
  a workflow file.
- `just test-live` runs the live tests against real engines and is outside the
  gate. Legs that need a model read `ENSEMBLE_LIVE_CODEX_MODEL`,
  `ENSEMBLE_LIVE_OPENCODE_MODEL` or `ENSEMBLE_LIVE_ZCODE_MODEL` (a zcode
  `provider/model`) and skip while it is unset.

`scripts/run-test-suite.mjs` runs every compiled test pattern it is given
(the whole suite by default) and refuses to start if any pattern names no
file. It withholds the calling shell's run settings (`ENSEMBLE_HOLD_SCOPE`,
`ENSEMBLE_STATUS_DIR` and the rest of the environment layer) from the tests,
so a test that needs one declares it.

A live run through `scripts/run-test-suite.mjs` (`ENSEMBLE_LIVE=1`, the whole
suite or named files) first settles the daemon serving the machine's Claude
config home, once, in `test/live/suite-setup.ts`. A live test that depends on
that daemon reads the published record with `suiteClaudeDaemon()`
(`test/live/suite-claude-daemon.ts`); it never starts or stops that home's
daemon, and never takes a first identity of it for itself. A proof of daemon
startup uses a private config home, which the suite leaves alone.

The test suite needs a systemd user session (some tests bound child processes
with `systemd-run --user --scope`) and `codex` on `PATH` (some tests ask it for
the app-server protocol schema).

## The plugin and the launcher

`plugin/` is the directory Claude Code and Codex install: a manifest for each
tool (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`)
and one skill, `plugin/skills/ensemble-workflow/`. The catalogues that offer
it sit at the repository root, `.claude-plugin/marketplace.json` for Claude
Code and `.agents/plugins/marketplace.json` for Codex; opencode has no plugin
format that carries a skill, so its users link the skill directory into their
skills directory. An install copies `plugin/` whole and both tools load
components from it by directory name, so it holds the manifests and the skill
and nothing else. `test/unit/plugin-layout.test.ts` holds that, and the
shapes Codex reads without validating.

The skill directory holds:

- `SKILL.md` and `references/`, the guidance an agent drives the runtime with;
- `agents/openai.yaml`, Codex's listing of the skill;
- `scripts/ensemble.mjs`, the self-contained launcher, built from `src/` by
  `npm run build:skill`. The skill's text and every install find it at that
  path, so do not move or rename it.

The skill's text ships beside the launcher it describes, so a change to
runtime behaviour updates the text in the same change, as it does the pages
in `docs/`. `test/unit/plugin-skill-text.test.ts` fails when the flags,
`ENSEMBLE_*` variables, engines, `agent()` options or script hooks the text
names differ from the runtime's, and when the text would not load on one of
the three tools. The text is read on machines other than this one: it names
no host, path, service or model-routing policy of any one of them, and it
writes every command as `node <launcher>`, never as an `ensemble` on `PATH`.

Both manifests carry the product's version. `scripts/release-version.mjs`
checks them against `package.json` and writes them on a bump.

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
the code publishes. That page states each artefact family's current schema
version once, in the table under its "Schema versions" heading; a test reads
a family's row with `documentedSchemaVersion()`
(`test/documented-schema-versions.ts`) and compares it with what the runtime
writes.
