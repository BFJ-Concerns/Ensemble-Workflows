# Codex-Workflows

A deterministic multi-agent orchestration harness for OpenAI Codex, mirroring
Claude Code's `Workflow` tool. An LLM (most often Claude) authors a JavaScript
workflow and runs it through a CLI that fans many Codex agents out over a task
and fans their structured results back in — with schema-validated output,
retry/verify, budget tracking, and worktree isolation.

**Status:** core runtime implemented. The importable TypeScript foundation can
spawn a `codex app-server`, run `agent()` calls, validate schema output, account
for token budget, and schedule concurrent workers. CLI, script sandbox,
workflow combinators, and worktree isolation are later layers.




