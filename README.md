# Ensemble

A deterministic multi-agent orchestration harness for OpenAI Codex, mirroring
Claude Code's `Workflow` tool. An LLM (most often Claude) authors a JavaScript
workflow and runs it through a CLI that fans many Codex agents out over a task
and fans their structured results back in — with schema-validated output,
retry/verify, budget tracking, and worktree isolation.

**Status:** feature-complete v1, landed and tested. The harness spawns a
`codex app-server`, runs `agent()` calls with schema-validated structured output
and bounded retry, schedules concurrent workers under a self-imposed cap,
accounts for token budget, and offers the full script surface — `parallel()`,
`pipeline()`, a `node:vm` restricted-globals sandbox, and `isolation:'worktree'`
for writable parallel agents — driven by the `ensemble <script.js> [args]`
CLI (result JSON on stdout, logs on stderr, non-zero exit on a thrown script).

```bash
ensemble my-workflow.js > result.json 2> run.log
```

The agent skill teaching the hooks API and the invoke pattern is maintained
outside this repository; any shell-capable orchestrator runs the same CLI
directly.
