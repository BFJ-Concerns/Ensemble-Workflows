# Ensemble

A deterministic multi-agent orchestration harness for multiple LLM engines,
mirroring Claude Code's `Workflow` tool. An LLM (most often Claude) authors a
JavaScript workflow and runs it through a CLI that fans many agents out over a
task — each on a chosen engine, **Codex or Claude** — and fans their structured
results back in, with schema-validated output, retry/verify, per-engine token
budgets, and worktree isolation. Its distinctive capability is **cross-engine verification**:
one model family checks another within a single run, so an answer that survives
both is stronger than either family could vouch for alone.

**Status:** feature-complete v1, landed and tested. The harness runs
`agent()` calls on either engine — Codex over a `codex app-server`, Claude as
`claude --bg` background sessions — with schema-validated structured output and
bounded retry, schedules concurrent workers under a per-engine self-imposed cap,
accounts for tokens against independent per-engine budget ceilings, and offers the full script
surface — `parallel()`, `pipeline()`, a `node:vm` restricted-globals sandbox, and
`isolation:'worktree'` for writable parallel Codex agents — driven by the
`ensemble <script.js> [args]` CLI (result JSON on stdout, logs on stderr,
non-zero exit on a thrown script). `agent()` requires an `engine` (`'codex'` or
`'claude'`): there is no default and neither engine is privileged.

```bash
ensemble my-workflow.js > result.json 2> run.log
```

The agent skill teaching the hooks API and the invoke pattern is maintained
outside this repository; any shell-capable orchestrator runs the same CLI
directly.

## Live status

A run continuously publishes a small JSON snapshot of what it is doing — current
phase, per-engine active/queued/done/failed counts, per-engine token spend, and
the live worker list — to `latest.json` under a status directory, written
atomically so a reader never sees a half-written file. It is the producer half of
a faithful one-line compression of Claude Code's `/workflows` view; it is *not*
the live tree, and it adds no script-facing API (`phase()`/`log()` are unchanged).

The side-channel is an ambient, environment-level concern, so it is configured by
environment variable rather than a run-tuning flag:

- `ENSEMBLE_STATUS=off` (or `0`/`false`/`no`) disables it.
- `ENSEMBLE_STATUS_DIR` overrides the directory (default:
  `${XDG_STATE_HOME:-~/.local/state}/ensemble/status`).

`ensemble --statusline` reads that snapshot and prints one compact line — meant
for Claude Code's `statusLine`, so a run kicked off through the Bash tool shows
its progress where you are already looking:

```
ensemble · ▸ Verify · codex ⚡3⏳2 48k/100k · claude ⚡1 · ✓12 ✗1 · 2m14s
```

```json
// .claude/settings.json — point statusLine at the same binary
{ "statusLine": { "type": "command", "command": "ensemble --statusline" } }
```

It prints nothing when no run is active (or one has finished or gone stale), so
the statusline falls back cleanly. Per-engine spend is shown separately, never
summed — the engines denominate different, non-comparable cost models. Set
`ENSEMBLE_STATUS_DIR` consistently for both the run and the statusline command if
you move it off the default.
