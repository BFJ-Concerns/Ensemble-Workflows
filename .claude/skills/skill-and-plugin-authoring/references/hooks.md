# Hooks for Plugins and Skills

A hook runs a command at a point in the tool's lifecycle — before a tool call, after an edit,
when a session starts — and can inject context, block an action, or rewrite its input. Hooks
turn an instruction the model might skip under pressure into a gate it cannot. Both tools use
the same configuration shape and the same core protocol; the differences are in the event
vocabulary, the trust model, and a few handler fields.

## Configuration shape

```json
{
  "description": "optional, plugins only",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/check-command.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

- `hooks` maps an event name to an array of matcher groups; each group has an optional
  `matcher` and a `hooks` array of handlers.
- `matcher` filters by the event's subject — the tool name for tool events (`Bash`,
  `Edit|Write`, `mcp__<server>__.*`; Codex reports its shell as `Bash` and its file edits as
  `apply_patch`, which also matches `Edit` or `Write`, so those three matchers fire on both
  tools), the source for `SessionStart` (`startup`, `resume`,
  `clear`, `compact`), the trigger for compaction events (`manual`, `auto`). Letters, digits,
  `|` and `,` match exactly or as a list; anything else is an unanchored regex; `*`, empty, or
  absent matches everything.
- `type: command` is the portable handler. `command` is required; `timeout` is seconds
  (default 600). Claude Code adds exec form — an `args` array, in which case `command` is
  spawned directly with no shell — plus `if` (permission-rule syntax such as `Bash(git *)`),
  `async`, `shell`, `onFailure`, `statusMessage`, and `once`; and the handler types `http`,
  `mcp_tool`, `prompt`, and `agent`. Codex accepts `mcp_tool` and parses but skips `prompt`
  and `agent`. A hook meant for both tools uses `type: command` in shell form.

## Where plugin hooks live

| | Claude Code | Codex |
| :- | :- | :- |
| Default file | `hooks/hooks.json` at the plugin root, event map wrapped in `"hooks"` | `hooks/hooks.json` at the plugin root, same wrapper |
| Manifest key | `hooks` in `.claude-plugin/plugin.json`: file path(s) or inline event map, *merged* with the default file | `hooks` in `.codex-plugin/plugin.json`: file path(s) or inline objects, *replacing* the default file |
| Path variables | `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}` | `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`; the `CLAUDE_*` names also set |
| Outside plugins | `hooks` key in `settings.json` layers | `~/.codex/hooks.json` or `[hooks]` in `config.toml`; same per project under `.codex/` |

Paths in a manifest start with `./` and stay inside the plugin root. Quote the root variable
in shell-form commands so a path with spaces stays one word; on Claude Code prefer exec form.
Write a hook that both tools will run with `${CLAUDE_PLUGIN_ROOT}`, which Codex also sets.

## Events

Common to both tools, one line each:

| Event | Fires | Can |
| :- | :- | :- |
| `SessionStart` | session starts or resumes | add context |
| `UserPromptSubmit` | prompt submitted, before the model sees it | block; add context |
| `PreToolUse` | before a tool call | deny or allow; rewrite input; add context |
| `PermissionRequest` | a tool call needs an approval decision | allow or deny |
| `PostToolUse` | after a tool returns | block; add context |
| `SubagentStart` / `SubagentStop` | a subagent starts / finishes | (stop) continue it |
| `Stop` | the turn ends | continue it |
| `PreCompact` / `PostCompact` | around context compaction | — |
| `SessionEnd` | session ends | — |

Claude Code adds many more, among them `Setup`, `PostToolUseFailure`, `PostToolBatch`,
`Notification`, `TaskCreated`, `TaskCompleted`, `InstructionsLoaded`, `ConfigChange`,
`CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreModelSwitch`,
`PostModelSwitch`, `Elicitation`, and `ElicitationResult`. Codex adds `Interrupt`. A hook on
an event the other tool lacks is simply never fired there, so a dual-tool plugin can carry
tool-specific events without breaking; keep the behaviour the plugin *depends on* within the
common set.

## Command protocol

The handler receives one JSON object on stdin: `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, plus event fields — `tool_name`, `tool_input`, `tool_use_id` for tool
events, `prompt` for prompt events, `tool_response` after a tool. `tool_input.command` carries
the command for `Bash` on both tools and for `apply_patch` on Codex; other tools send their own
arguments. Claude Code adds
`permission_mode` and, inside a subagent, `agent_id` and `agent_type`; Codex adds `model` and
`turn_id`.

Exit codes:

- `0` — success. If stdout is a single JSON object it is parsed as a decision; otherwise plain
  text is added as context on the events that accept it (`SessionStart`, `UserPromptSubmit`,
  and `SubagentStart` on both tools) and ignored elsewhere.
- `2` — block, for events that can. Stderr is the reason fed back to the model.
- Anything else — a non-blocking error; the action proceeds and the failure is reported.

Pick one control mechanism per hook — JSON on exit 0, or exit 2 with stderr — not both. JSON
decisions go under `hookSpecificOutput` with `hookEventName` set:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Database writes are not allowed in this repository",
    "additionalContext": "optional factual statement for the model"
  }
}
```

`permissionDecision` takes `allow` or `deny` on both tools (Claude Code also `ask` and
`defer`); `updatedInput` replaces the tool arguments (Codex requires `allow` alongside it).
`systemMessage` shows a warning to the user on every event. Top-level `continue: false` with
`stopReason` halts the agent, but not from every event: Codex ignores it on `PreToolUse` and
`PermissionRequest` — the hook run is marked failed and the tool call proceeds — so a guard on
those events denies with `permissionDecision` or exit code 2, never with `continue`. The legacy
top-level `decision: "block"` with `reason` works on `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Stop`, and `SubagentStop` on both tools.

A minimal `PreToolUse` guard:

```bash
#!/bin/sh
cmd=$(jq -r '.tool_input.command // empty')
case "$cmd" in
  *"rm -rf"*) printf '%s\n' "Destructive delete refused by project policy" >&2; exit 2 ;;
esac
exit 0
```

## Codex trust

Codex runs a non-managed hook only after the user reviews and trusts it. Trust binds to the
hook definition's hash, so a new or edited hook is skipped — silently — until re-trusted
through `/hooks`. Enabling a plugin does not trust its hooks. Hooks are on by default
(`[features] hooks = false` disables them); `--dangerously-bypass-hook-trust` skips persisted
trust for one invocation and is for automation the user controls, not a default. Document
the `/hooks` step in the plugin's install notes, or users will see the hook do nothing.

## Skill-scoped hooks on Claude Code

A Claude Code skill may carry a `hooks:` frontmatter key with the same event map. The hooks
register when the skill is invoked and stay for the rest of the session, which makes them the
lever for behaviour a skill must enforce deterministically: a `PreToolUse` guard on a
forbidden command, a `PostToolUse` check on output, a `SessionStart` setup step.

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "\"${CLAUDE_PLUGIN_ROOT}\"/skills/<name>/scripts/security-check.sh"
```

The command runs from the session's working directory, so a bare relative path looks for the
script in the user's repository, not the skill, and a script that is not found is a non-blocking
error: the guard fails open with no warning. `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
and `${CLAUDE_PROJECT_DIR}` are substituted in hook commands wherever the hook is defined,
including skill frontmatter, which anchors a plugin skill's script. A skill installed outside a
plugin has no documented hook-command variable for its own directory (`${CLAUDE_SKILL_DIR}`
is substituted in the body and `allowed-tools`, not in hooks), so it uses an absolute path or a
script the body installs first. Either way, invoke the skill from a different working directory
and confirm the guard blocks before relying on it.

Codex gives the key no effect, so a skill that must load on both tools expresses the gate as a
bundled script the body asks the agent to run, and a plugin that must enforce it on Codex
carries the hook in `hooks/hooks.json` instead.
