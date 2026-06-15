# Ensemble

A deterministic multi-agent orchestration harness for multiple LLM engines,
mirroring Claude Code's `Workflow` tool. An LLM (most often Claude) authors a
JavaScript workflow and runs it through a CLI that fans many agents out over a
task — each on a chosen engine, **Codex or Claude** — and fans their structured
results back in, with schema-validated output, retry/verify, budget tracking, and
worktree isolation. Its distinctive capability is **cross-engine verification**:
one model family checks another within a single run, so an answer that survives
both is stronger than either family could vouch for alone.

**Status:** feature-complete v1, landed and tested. The harness runs
`agent()` calls on either engine — Codex over a `codex app-server`, Claude as
`claude --bg` background sessions — with schema-validated structured output and
bounded retry, schedules concurrent workers under a per-engine self-imposed cap,
accounts for token budget across both engines, and offers the full script
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
