# Skill Contracts: the Coding Tools

What Claude Code, Codex, opencode, zcode and the Antigravity CLI (`agy`) each accept and do
with a skill. Facts here were checked against Claude Code 2.1.332, Codex CLI 0.171.0, opencode
1.18.4, zcode 0.17.1 and agy 1.5.16, against their documentation and, where marked, their
source or a run. These tools change often, so confirm anything load-bearing against the
installed version before relying on it.

## Package shape

Every tool reads the same shape: a directory named for the skill, holding `SKILL.md` (exact
name, case-sensitive) and optionally `scripts/`, `references/`, `assets/`, or any other
supporting files the body links. Codex also reads an optional `agents/openai.yaml` beside
`SKILL.md` (*The Codex interface file*, below); the others ignore it.

## Where skills load from

| Tool | Project | Personal, in the user's home directory |
| :- | :- | :- |
| Claude Code | `.claude/skills/<name>/`, from the start directory up to the repository root; `<subdir>/.claude/skills/` loads when work first touches that subdirectory | `.claude/skills/<name>/` |
| Codex | `.agents/skills/<name>/`, from the working directory up to the repository root; `.codex/skills` also loads | `skills/<name>/` in the Codex home, which is `.codex` unless `CODEX_HOME` moves it; `.agents/skills` also loads |
| opencode | `.opencode/skills/<name>/`; also reads `.claude/skills` and `.agents/skills` | `.config/opencode/skills/<name>/`; also `.claude/skills`, `.agents/skills` |
| zcode | `.zcode/skills/<name>/`; also reads `.agents/skills`, not `.claude/skills` | `.zcode/skills/<name>/`; also `.agents/skills` |
| agy | `.agents/skills/<name>/` (also `.agent/`, `_agents/`, `_agent/`), from the working directory up to the repository root | `.gemini/config/skills/<name>/` |

So one copy in `.agents/skills` reaches every tool but Claude Code, and a second copy in
`.claude/skills` covers Claude Code too. A plugin's skills load from the plugin's `skills/` and
are namespaced under the plugin name: `/<plugin>:<name>` on Claude Code, `<plugin>:<name>` on
Codex and zcode.

A name two skills share is handled differently on each tool. Claude Code resolves the clash as
enterprise over personal over project. Codex and zcode list both; zcode loads the first match,
which was the personal copy in a probe. opencode keeps whichever it loaded last, in no fixed
order. agy keeps the first it discovers and skips the rest. So keep names unique across every
path a session loads, apart from one skill copied into two directories for two tools.

## Frontmatter

YAML between `---` lines; the opening `---` must be the first line of the file.

| Key | Claude Code | Codex |
| :- | :- | :- |
| `name` | optional; sets the `/` command and, in a plugin, the namespaced segment; defaults to the directory name, which stays usable as an alias | documented as required; 0.171.0 falls back to the directory name. The listed name |
| `description` | recommended; falls back to the first content line | required |
| `license` | tolerated | accepted |
| `metadata` | tolerated | accepted |
| `allowed-tools` | tools usable without prompting during the invoking turn | accepted |
| `when_to_use` | extra trigger text appended to `description` in the listing | ignored |
| `disable-model-invocation` | `true`: only the user can invoke; description leaves the listing | ignored |
| `user-invocable` | `false`: hidden from the `/` menu; only the model invokes | ignored |
| `argument-hint`, `arguments` | autocomplete hint; named positional arguments for `$name` substitution | ignored |
| `disallowed-tools`, `effort` | restrict tools; override effort for the turn | ignored |
| `model` | model for a user's `/` invocation and for a forked run; a model-initiated invocation keeps the session's model | ignored |
| `context: fork`, `agent` | run the skill in an isolated subagent of the named type, in the background unless `background: false` | ignored |
| `hooks` | hooks registered when the skill is invoked (`references/tool-hooks.md`) | ignored |
| `paths` | glob patterns; auto-load only when working on matching files | ignored |
| `shell` | `bash` or `powershell` for load-time commands | ignored |

The other three act on few keys:

- **opencode** reads `name`, which its loader requires, and `description`; a skill without a
  description is left out of the listing. Its documentation also names `license`,
  `compatibility` and `metadata`. Other keys are ignored.
- **zcode** requires `name` and `description`, and accepts `when_to_use`, `license` and
  `metadata`. A skill carrying any other key is marked unsafe to load automatically; on 0.17.1
  it was still listed and loaded, so give a skill meant for zcode no other keys rather than
  rely on either outcome. A file without frontmatter loads under its directory name with an
  empty description.
- **agy** documents `name` (lowercase, hyphenated) and `description`, plus
  `disable-slash-command` (*Invocation and control*). Its validator warns when `name` differs
  from the directory.

Codex documents `name`, `description`, `license`, `allowed-tools`, and `metadata`, and ignores
other keys rather than refusing them, as Claude Code, opencode and agy ignore keys they do not
know. So a Claude-only key is inert elsewhere, not fatal: a skill meant for several tools may
carry one when the Claude Code behaviour matters, knowing the others give it no effect, and the
behaviour it controls needs another route there.

For the name, use lowercase letters, digits and single hyphens, at most 64 characters, equal to
the directory name. Not every tool enforces that — Claude Code and Codex accept capitals,
underscores and spaces, and Codex refuses only a name over 64 characters — but it is the form
every tool accepts, and it keeps the listed name, the invocation and the path in agreement.

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
- **opencode:** the model loads a skill with its `skill({ name })` tool. A skill also becomes a
  command unless a command already has its name, so the user can run it as `/<name>`, and
  `/skills` picks one. `permission.skill` in the config allows, asks for, or denies skills by
  name pattern, and a denied skill leaves the model's listing. There is no switch that leaves
  a skill to the user alone.
- **zcode:** the user types `/skill <name> [task]`, which asks the model to load it; otherwise
  the model matches it from the listing. There is no switch that leaves a skill to the user
  alone.
- **agy:** the user types `/<name>`, or `agy -p "/<name> …"` from a shell; the model activates
  a skill from its description. `disable-slash-command: true` removes the `/` command and leaves
  model activation. `disable-model-invocation` appears in agy's parser, but whether agy honours
  it has not been established.

Claude Code watches its personal and project skills directories and picks up additions, edits
and removals during a session; `/reload-skills` rescans, and `/reload-plugins` reloads plugin
skills. Codex detects changes to a standalone skill automatically; if an edit does not appear,
restart. A Codex plugin skill is read from the copy `codex plugin add` took, so an edit reaches
sessions only after the plugin is added again. agy offers `/skills reload`. opencode and zcode
read skills when a session starts.

## Load-time behaviour

On **Claude Code**, a backtick-wrapped command prefixed with `!`, or a fenced block whose info
string is `!`, runs when the skill loads, and its output replaces the placeholder before the
model reads the body. The inline form is recognised when the `!` starts a line or follows
whitespace. Output is inserted as plain text and not re-scanned. A failing command aborts the
invocation, except that exit 1 from a recognised search or comparison command counts as
normal. Pre-approve the command with an `allowed-tools: Bash(…)` entry so it runs without a
prompt; such commands pass through the `PreSkillShellCommand` hook event, not `PreToolUse`. The
canonical form, inert here because this file is read on demand and never preprocessed:

```markdown
## Current changes

!`git diff HEAD`
```

Reach for it deliberately — it lets a skill reason over the real diff, file listing, branch, or
date instead of guessing. The hazard runs the other way: the loader cannot tell an intended
injection from documentation that merely forms the pattern, even inside inline code or a table.
Never let the literal pattern appear in a `SKILL.md` unless execution is intended; reword until
it does not.

**opencode** has the same hazard on one path: a skill run as a command expands `$ARGUMENTS`
and `$1…` and runs `` !`…` `` substitutions, while the same skill loaded through the `skill`
tool arrives as written. **zcode** substitutes `${CLAUDE_SKILL_DIR}` and `${ZCODE_SKILL_DIR}`
with the skill's directory and nothing else. Codex and agy have no load-time substitution, so a
skill that needs live state on every tool asks the agent to run the command instead.

## Limits

- **Claude Code:** the listing gives skill descriptions about 1% of the context window by
  default, and past that budget it drops descriptions; each `description` plus `when_to_use`
  is cut at 1,536 characters by default, and both limits are settings. After context
  compaction, the most recent invocation of each skill is re-attached keeping only its first
  5,000 tokens, within a shared 25,000-token budget filled from the most recent skill, so a
  long body's tail does not survive a long session.
- **Codex:** the initial skills listing is capped at 2% of the context window (8,000
  characters when the window is unknown); with many skills installed, descriptions are
  shortened first and some skills may be omitted with a warning. The full `SKILL.md` loads
  only when the skill is selected.
- **opencode:** no limit on descriptions, bodies or the listing in the loader.
- **zcode:** a description over 1,024 characters is refused. The listing shortens each
  description to 249 characters, and past a 20,000-character listing budget falls back to names
  and paths. A body is cut at 100,000 bytes, frontmatter included.
- **agy:** only the first 24,000 bytes of a body are loaded. No description limit has been
  established.

Keep the body comfortably under about 500 lines on any tool, and the description under 1,024
characters.

## Checking a skill is listed

Start a fresh session of each target tool and confirm the skill is listed with its description
intact. Non-interactively:

- **Claude Code:** a one-shot `claude -p` asking the agent to list its skills with their
  descriptions. `claude plugin validate <folder>` checks a folder of skills' frontmatter but
  refuses a bare skill directory.
- **Codex:** a one-shot `codex exec` asking the same.
- **opencode:** a one-shot `opencode run` asking the same.
- **zcode:** `zcode skills list --cwd <project>`.
- **agy:** a one-shot `agy -p` asking the same.

## Moving a skill between tools

The body is largely portable; the frontmatter and the invocation surface are not. Map each
piece, and where one tool has a concrete handle and another a different one, name each in the
body rather than genericising to a phrase that fits neither.

| Claude Code source | On Codex |
| :- | :- |
| frontmatter beyond `name`, `description`, `license`, `allowed-tools`, `metadata` | inert: Codex ignores keys it does not document, so keep a key whose Claude Code effect matters and route its behaviour another way for Codex |
| `disable-model-invocation: true` | `policy.allow_implicit_invocation: false` in `agents/openai.yaml` |
| `user-invocable: false` | no equivalent; the skill stays in `/skills` |
| `context: fork`, `agent`, `model`, `effort`, `paths` | no equivalent; express the intent in the body ("delegate this to a subagent", "apply only to files matching…") or accept the loss |
| `hooks:` frontmatter | no skill-scoped hooks; a bundled script the body asks the agent to run, or a plugin hook (`references/tool-hooks.md`) |
| backtick command prefixed with `!` (load-time injection) | no equivalent; ask the agent to run the command and read its output |
| `$ARGUMENTS`, `$0`, named arguments | no substitution; the user's request text is the argument |
| `/name` in the body's own prose | `$name` |
| `${CLAUDE_SKILL_DIR}` or `${CLAUDE_PLUGIN_ROOT}` in the body | no documented substitution in a Codex skill body; refer to bundled files by paths relative to the skill directory |

| Codex source | On Claude Code |
| :- | :- |
| `agents/openai.yaml` interface | ignored; keep it for Codex, nothing to add for Claude Code |
| `agents/openai.yaml` `allow_implicit_invocation: false` | `disable-model-invocation: true` |
| `$name` in prose | `/name` |
| `name` equal to the directory | fine as is; on Claude Code `name` sets the command, with the directory name as the fallback and alias |

To opencode, zcode or agy, keep the frontmatter to the keys each reads (*Frontmatter*, above):
on zcode in particular, a Claude-only key marks the skill unsafe to load automatically. A
Claude Code control has no equivalent there, apart from agy's `disable-slash-command` for
`user-invocable: false`; express the intent in the body or accept the loss. A body's
`${CLAUDE_SKILL_DIR}` is substituted on zcode, not on opencode or agy, so a body meant for all
of them refers to bundled files by paths relative to the skill directory. The user invokes the
skill as each tool's *Invocation and control* entry says, so prose that tells the user how to
invoke it names each tool's form.

## The Codex interface file

`agents/openai.yaml` beside `SKILL.md` carries presentation and policy that Codex reads and
the other tools ignore:

```yaml
interface:
  display_name: "PDF Processing"
  short_description: "Extract text and tables from PDFs and fill forms"
  default_prompt: "Use $processing-pdfs to pull the tables out of this PDF."
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
