# Skill Contracts: Claude Code and Codex

What each tool accepts and does with a skill. Facts here were checked against Claude Code
2.1.296 and Codex CLI 0.162.1 and their published documentation; both tools change often, so
confirm anything load-bearing against the installed version before relying on it.

## Package shape

Both tools: a directory named for the skill, holding `SKILL.md` (exact name, case-sensitive)
and optionally `scripts/`, `references/`, `assets/`, or any other supporting files the body
links. Codex additionally reads an optional `agents/openai.yaml` beside `SKILL.md` (below).

## Where skills load from

| Scope | Claude Code | Codex |
| :- | :- | :- |
| Personal | `~/.claude/skills/<name>/` | `$CODEX_HOME/skills/<name>/` (`~/.codex/skills` by default); `~/.agents/skills` also loads |
| Project | `.claude/skills/<name>/`, from the start directory and each parent up to the repo root | `.agents/skills/<name>/`, from the working directory and each parent up to the repo root; `.codex/skills` also loads |
| Nested | `<subdir>/.claude/skills/<name>/` loads when work first touches that subdirectory | — |
| Plugin | `<plugin>/skills/<name>/`, invoked as `/<plugin>:<name>` | `<plugin>/skills/<name>/`, loaded from the install cache and listed as `<plugin>:<name>` |
| Admin | managed settings directory | `/etc/codex/skills` |

Both tools namespace a plugin's skills under the plugin name, so a skill inside a plugin need
not carry the plugin's name to be identifiable. Claude Code resolves a name clash as enterprise
over personal over project. Codex does not merge two standalone skills with the same name —
both appear in the selector — so keep names unique across the paths a session loads.

## Frontmatter

YAML between `---` lines; the opening `---` must be the first line of the file.

| Key | Claude Code | Codex |
| :- | :- | :- |
| `name` | optional; sets the `/` command and, in a plugin, the namespaced segment; defaults to the directory name, which stays usable as an alias | required; the listed name. Conventionally equal to the directory name, though a mismatch is not refused |
| `description` | recommended; falls back to the first content line | required |
| `license` | tolerated | accepted |
| `metadata` | tolerated | accepted |
| `allowed-tools` | tools usable without prompting during the invoking turn | accepted |
| `when_to_use` | extra trigger text appended to `description` in the listing | ignored |
| `disable-model-invocation` | `true`: only the user can invoke; description leaves the listing | ignored |
| `user-invocable` | `false`: hidden from the `/` menu; only the model invokes | ignored |
| `argument-hint`, `arguments` | autocomplete hint; named positional arguments for `$name` substitution | ignored |
| `disallowed-tools`, `model`, `effort` | restrict tools; override model or effort for the turn | ignored |
| `context: fork`, `agent` | run the skill in an isolated subagent of the named type | ignored |
| `hooks` | hooks registered when the skill is invoked (see `hooks.md`) | ignored |
| `paths` | glob patterns; auto-load only when working on matching files | ignored |
| `shell` | `bash` or `powershell` for load-time commands | ignored |

Codex documents `name`, `description`, `license`, `allowed-tools`, and `metadata`; keys outside
that set are ignored at discovery rather than refused (checked on 0.162.1), as Claude Code
ignores keys it does not know. So a Claude-only key is inert on Codex, not fatal: a skill meant
for both may carry one when the Claude Code behaviour matters, knowing Codex gives it no
effect, and the behaviour it controls needs another route there (*Invocation and control*).

Name rules on both tools: kebab-case — lowercase, digits, hyphens; no spaces, underscores,
or capitals. Keep `name` equal to the directory name so the listed name, the invocation, and
the path agree.

## Invocation and control

- **Claude Code:** the model invokes a skill from its description, or the user types
  `/<name>` (or `/<plugin>:<name>` for a plugin skill). `$ARGUMENTS` in the body receives the
  argument string; `$0`, `$1` or `$ARGUMENTS[N]` take positional arguments with shell-style
  quoting; a declared `arguments:` list maps them to `$name` placeholders. Permission rules
  `Skill(name)` and `Skill(name *)` can allow or deny a skill.
- **Codex:** the model invokes a skill from its description unless the skill's
  `agents/openai.yaml` sets `policy.allow_implicit_invocation: false`; the user types
  `$<name>` — a plugin skill by its listed `<plugin>:<name>` — or picks from `/skills`.
  Disable a skill without deleting it with a `[[skills.config]]` entry (`path`,
  `enabled = false`) in `config.toml`.

Codex detects changes to a standalone skill automatically; if an edit does not appear, restart.
A plugin skill is read from the copy `codex plugin add` took, so a source edit reaches sessions
only after the plugin is removed and added again (`plugins-codex.md`, *Test locally*). Claude
Code reads skills at session start; `/reload-plugins` reloads plugin skills in a running
session.

## Load-time behaviour on Claude Code

A backtick-wrapped command prefixed with `!`, or a fenced block whose info string is `!`, runs
when the skill loads and its output replaces the placeholder before the model reads the body.
The inline form is recognised when the `!` starts a line or follows whitespace. Output is
inserted as plain text and not re-scanned; a failing command aborts the whole invocation.
Pre-approve the command with an `allowed-tools: Bash(…)` entry so it runs without a prompt.
The canonical form, inert here because this file is read on demand and never preprocessed:

```markdown
## Current changes

!`git diff HEAD`
```

Reach for it deliberately — it lets a skill reason over the real diff, file listing, branch, or
date instead of guessing. The hazard runs the other way: the loader cannot tell an intended
injection from documentation that merely forms the pattern, even inside inline code or a table.
Never let the literal pattern appear in a `SKILL.md` unless execution is intended; reword until
it does not. Codex has no equivalent, so a skill that needs live state on both tools asks the
agent to run the command instead.

## Context budgets

- **Claude Code:** every invocable skill's name and description sit in context on every turn.
  `description` plus `when_to_use` is truncated at 1,536 characters in the listing. After
  context compaction, the most recent invocation of each skill is re-attached keeping only
  its first 5,000 tokens, within a shared 25,000-token budget filled from the most recent
  skill — so a long body's tail does not survive a long session.
- **Codex:** the initial skills listing is capped at 2% of the context window (8,000
  characters when the window is unknown); with many skills installed, descriptions are
  shortened first and some skills may be omitted with a warning. The full `SKILL.md` loads
  only when the skill is selected.

Keep the body comfortably under about 500 lines on either tool.

## The Codex interface file

`agents/openai.yaml` beside `SKILL.md` carries presentation and policy that Codex reads and
Claude Code ignores:

```yaml
interface:
  display_name: "Grounded Commits"
  short_description: "Write and check commit messages in the Grounded Commits format"
  default_prompt: "Use $grounded-commits when committing in a repository that has adopted the format."
  # also: icon_small, icon_large, brand_color
policy:
  allow_implicit_invocation: true   # false keeps explicit $name invocation only
# dependencies:
#   tools:
#     - type: mcp
#       value: <server name>
#       description: <why the skill needs it>
```

Keep `short_description` and `default_prompt` consistent with `description`; they are the
same promise in a different surface.
