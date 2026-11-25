# Hooks for Plugins and Skills

A hook runs a command at a point in the tool's lifecycle — before a tool call, after an edit,
when a session starts — and can inject context, block an action, or rewrite its input. Hooks
turn an instruction the model might skip under pressure into a gate it cannot. Claude Code and
Codex share one configuration shape and one core protocol, and differ in the event vocabulary,
the trust model, and a few handler fields; the first sections below are theirs. zcode and the
Antigravity CLI (`agy`) use a similar shape with their own events, and opencode has no command
hooks at all (*Hooks on the other tools*). Facts here were checked against Claude Code 2.1.332,
Codex CLI 0.171.0, opencode 1.18.4, zcode 0.17.1 and agy 1.5.16.

## Configuration shape

```json
{
  "description": "optional",
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
  tools), the source for `SessionStart` (`startup`, `resume`, `clear`, `compact`), the trigger
  for compaction events (`manual`, `auto`). A matcher of plain names — letters, digits, and
  `|` or `,` between names (Claude Code also allows `_`, `-` and spaces) — matches those names
  exactly; anything else is an unanchored regex; `*`, empty, or absent matches everything. A
  few events match by rules of their own.
- `type: command` is the portable handler. `command` is required; `timeout` is in seconds,
  and its default depends on the tool and the event, as short as one second for Codex's
  `SessionEnd` and `Interrupt`, so set it on any hook that does real work. Claude Code adds exec
  form — an `args` array, in which case `command` is spawned directly with no shell — plus `if`
  (permission-rule syntax such as `Bash(git *)`), `async`, `shell`, `onFailure`,
  `statusMessage`, and `once`; and the handler types `http`, `mcp_tool`, `prompt`, and `agent`.
  Codex accepts `mcp_tool`, parses but skips `prompt` and `agent`, and adds `async`,
  `commandWindows` and `additionalContextLimit`. A hook meant for both tools uses
  `type: command` in shell form.

## Where plugin hooks live

| | Claude Code | Codex |
| :- | :- | :- |
| Default file | `hooks/hooks.json` at the plugin root, event map wrapped in `"hooks"` | `hooks/hooks.json` at the plugin root, same wrapper |
| Manifest key | `hooks` in `.claude-plugin/plugin.json`: file path(s) or inline event map, *merged* with the default file | `hooks` in `.codex-plugin/plugin.json`: file path(s) or inline objects, *replacing* the default file |
| Path variables | `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}` | `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`; the `CLAUDE_*` names also set |
| Outside plugins | `hooks` key in `settings.json` layers | `hooks.json` or `[hooks]` in `config.toml` in the Codex home; the same per project under `.codex/` |

Paths in a manifest start with `./` and stay inside the plugin root. Quote the root variable
in shell-form commands so a path with spaces stays one word; on Claude Code prefer exec form.
Write a hook that both tools will run with `${CLAUDE_PLUGIN_ROOT}`, which Codex also sets.

## Events

Common to Claude Code and Codex, one line each:

| Event | Fires | Can |
| :- | :- | :- |
| `SessionStart` | session starts or resumes | add context |
| `UserPromptSubmit` | prompt submitted, before the model sees it | block; add context |
| `PreToolUse` | before a tool call | deny or allow; rewrite input; add context |
| `PermissionRequest` | a tool call needs an approval decision | allow or deny |
| `PostToolUse` | after a tool returns | block; add context |
| `SubagentStart` / `SubagentStop` | a subagent starts / finishes | (stop) continue it |
| `Stop` | the turn ends | continue it |
| `PreCompact` / `PostCompact` | around context compaction | Claude Code: block compaction (`PreCompact`); Codex: halt with `continue: false` |
| `SessionEnd` | session ends | — |

Claude Code adds many more, among them `Setup`, `PostToolUseFailure`, `PostToolBatch`,
`PreSkillShellCommand`, `Notification`, `TaskCreated`, `TaskCompleted`, `InstructionsLoaded`,
`ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`,
`PreModelSwitch`, `PostModelSwitch`, `Elicitation`, and `ElicitationResult`. Codex adds
`Interrupt`, and `PreModelRequest` and `PostModelRequest`, which observe and cannot block. A
hook on an event the other tool lacks is simply never fired there, so a dual-tool plugin can
carry tool-specific events without breaking; keep the behaviour the plugin *depends on* within
the common set. Codex's hooks do not see every tool: hosted tools and `write_stdin` escape them,
so a guard there covers the shell and file edits, not everything the agent can do.

## Command protocol

The handler receives one JSON object on stdin: `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, plus event fields — `tool_name`, `tool_input`, `tool_use_id` for tool
events, `prompt` for prompt events, `tool_response` after a tool. `tool_input.command` carries
the command for `Bash` on both tools and for `apply_patch` on Codex; other tools send their own
arguments. Claude Code adds `permission_mode` and, inside a subagent, `agent_id` and
`agent_type`; Codex adds `model` and `turn_id`.

Exit codes:

- `0` — success. If stdout is a single JSON object it is parsed as a decision. Otherwise plain
  text is added as context on `SessionStart` and `UserPromptSubmit`, read as compaction
  instructions on Claude Code's `PreCompact`, and ignored elsewhere; `SubagentStart` takes
  context only as JSON `additionalContext`.
- `2` — block, for events that can. Stderr is the reason fed back to the model.
- Anything else — a non-blocking error: the action proceeds and the user sees a hook-error
  notice. Claude Code still applies valid JSON on stdout, and a handler with
  `onFailure: "block"` blocks on an execution error instead.

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
`defer`); `updatedInput` replaces the tool arguments (Codex requires `allow` alongside it). A
`PermissionRequest` hook decides with `hookSpecificOutput.decision.behavior` (`"deny"` or
`"allow"`) instead, and exit 2 is not a decision there. `systemMessage` shows a warning to the
user on most events; Claude Code drops it on `SessionEnd`, `Notification`,
`InstructionsLoaded`, `PreCompact` and `PostCompact`. Top-level `continue: false` with
`stopReason` halts the agent, but not from every event: Codex ignores it on `PreToolUse` and
`PermissionRequest` — the hook run is marked failed and the tool call proceeds — so a guard on
`PreToolUse` denies with `permissionDecision` or exit code 2, and one on `PermissionRequest`
with `decision.behavior`, never with `continue`. The legacy top-level `decision: "block"` with
`reason` works on `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, and `SubagentStop` on
both tools. Claude Code caps a hook's context and message strings at about 10,000 characters
and spills the rest to a file.

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

Codex runs a non-managed hook only after the user reviews and trusts it. A new or edited hook
is held until it is trusted again through `/hooks`, and Codex warns about it at startup; a
change to a script the hook runs can need trust renewed even when the hook definition is
unchanged. Enabling a plugin does not trust its hooks. Hooks are on by default
(`[features] hooks = false` disables them); `--dangerously-bypass-hook-trust` skips persisted
trust for one invocation and is for automation the user controls, not a default. Document the
`/hooks` step in the plugin's install notes, or users will see the hook do nothing.

## Skill-scoped hooks on Claude Code

A Claude Code skill may carry a `hooks:` frontmatter key with the same event map. The hooks
register when the skill is invoked and stay until the conversation is left with `/clear` or
`/resume` or the process exits — every later turn, unrelated or not — which makes them the
lever for behaviour a skill must enforce deterministically: a `PreToolUse` guard on a forbidden
command, a `PostToolUse` check on output, a `SessionStart` setup step. They live in the
process, not in the session's record, so a session resumed in a new process (`claude --resume
<id>`) invokes the skill again before relying on its guard. One skill's hooks are limited to
1,024 handlers and 16,384 characters of matchers; past either, none of them register.

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "\"${CLAUDE_PLUGIN_ROOT}\"/skills/<name>/scripts/security-check.sh"
```

The command runs from the session's working directory, so a bare relative path looks for the
script in the user's repository, not the skill, and a script that is not found is a
non-blocking error: the guard lets the action through, with only a hook-error notice.
`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, and `${CLAUDE_PROJECT_DIR}` are substituted in
hook commands wherever the hook is defined, including skill frontmatter, which anchors a plugin
skill's script. A skill installed outside a plugin has no documented hook-command variable for
its own directory (`${CLAUDE_SKILL_DIR}` is substituted in the body and `allowed-tools`, not in
hooks), so it uses an absolute path or a script the body installs first. Either way, invoke the
skill from a different working directory and confirm the guard blocks before relying on it.

No other tool gives the key an effect, so a skill that must load on several tools expresses the
gate as a bundled script the body asks the agent to run, and a plugin that must enforce it
carries the hook in its plugin hooks file instead.

## Hooks on the other tools

**zcode** reads command hooks from its user and project config under `hooks.events`, with
`hooks.enabled: true`. Its events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PostToolUseFailure` and `Stop`, each a list of
`{ matcher, hooks: [...] }` groups. A handler is `type: command` (with `async`, `shell` and
`timeout` in seconds) or `type: process` (with `args`), `command` required either way. A
project's hooks run only once the workspace is trusted: `zcode hooks trust review|grant|status|revoke`.
A zcode plugin carries hooks in `hooks/hooks.json`, as Claude Code's and Codex's do.

**agy** reads hooks from the project's `.agents/hooks.json` and `.gemini/config/hooks.json` in
the user's home directory, and from `hooks.json` at a plugin's root. Each top-level key
names a hook, with optional `enabled` (default true). Its events are `SessionStart`,
`PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` and `Stop`; tool events take
matcher groups, the others a flat list of handlers. A handler needs `command`, optionally
`type: "command"` and `timeout` in seconds (default 30), and runs synchronously with `sh -c`
from the directory holding the hooks file, exchanging JSON with camelCase fields on stdin and
stdout. HTTP and prompt handlers are not supported, and a project's hooks need the workspace
trusted. These facts come from agy's bundled guide; its hooks were not run.

**opencode** has no command hooks. Its plugins are code, and a plugin's returned callbacks are
its hooks: among them `event`, `config`, `chat.message`, `chat.params`, `tool.execute.before`,
`tool.execute.after`, `command.execute.before`, `shell.env` and `permission.ask`. Most take
`(input, output)` and change `output` in place, so a guard on opencode is written as a plugin.
