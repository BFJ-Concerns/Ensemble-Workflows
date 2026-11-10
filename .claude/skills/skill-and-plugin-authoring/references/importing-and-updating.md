# Importing and Updating Without Losing Behaviour

Compare an import or update against the old skill, not against having none: a cleaner rewrite
can still drop a gate.

## Before changing anything

1. Keep the baseline. Copy the original package — every source package, for an import from
   several — unchanged into the per-task scratch directory before the first edit, or note the
   git revision it is committed at and materialise that revision to a readable path. The
   preservation comparison reads this set as its original; editing in place destroys it.
2. Read the whole package — `SKILL.md`, every supporting file, every script — not just the
   part the request names. A gate in an unlinked file is still a gate.
3. Write down what must remain true afterwards: the behaviours, the gates, the concrete
   handles (commands, paths, tool names, formats), the warnings. Play this list back at
   intake for the user to confirm or amend. It is the author's list: the preservation reviewer
   never sees it (`review.md`), and the author adjudicates each reported loss against it.
4. Separate the diagnosis from the fix. A remedy handed to you — a reviewer's suggested
   change, a user's "it's probably the description" — is a candidate to re-judge against the
   text, never a specification. Fix the cause, then check the fix did not move the symptom.
5. Make the change thorough enough to solve the diagnosed problem cleanly: do not stop at the
   smallest patch if it leaves stale guidance, dropped gates, or contradictions behind; do not
   sprawl into unrelated redesign either.

## Overwrite, do not append

An update that bolts a paragraph onto the end of the body leaves the new truth where a bounded
read misses it, and the stale text above it keeps steering. Overwrite the outdated text in
place; the description is re-derived whole by the rule in `SKILL.md`.

## Modernising an inherited skill

Skills written for earlier models often carry step-by-step scaffolding, emphatic banners, and
restated rules. Current models plan better than the scaffold and over-apply emphasis, so the
inherited shape can *cause* the deviation it was written to prevent. Whether the steps still earn
their place is a named uncertainty that warrants a test: compare the skill with the
scaffolding removed — a trigger probe or eval on a representative task on each version — and
keep what the comparison shows matters.
Do not rewrite a personal or local skill into a generic one unless the user asks for
portability.

## Moving a skill between Claude Code and Codex

The body is largely portable; the frontmatter and the invocation surface are not. Settle the
target set with the user — a skill written for one tool does not tell you whether it is
wanted on the other — then map each piece:

| Claude Code source | On Codex |
| :- | :- |
| frontmatter beyond `name`, `description`, `license`, `allowed-tools`, `metadata` | inert: Codex ignores keys it does not document, so keep a key whose Claude Code effect matters and route its behaviour another way for Codex |
| `disable-model-invocation: true` | `policy.allow_implicit_invocation: false` in `agents/openai.yaml` |
| `user-invocable: false` | no equivalent; the skill stays in `/skills` |
| `context: fork`, `agent`, `model`, `effort`, `paths` | no equivalent; express the intent in the body ("delegate this to a subagent", "apply only to files matching…") or accept the loss |
| `hooks:` frontmatter | no skill-scoped hooks; a bundled script the body asks the agent to run, or a plugin hook (`hooks.md`) |
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

Where one tool has a concrete handle — a named tool, a command, a path — and the other has a
different one, name both in the body ("on Claude Code … ; on Codex …") rather than genericising
to a phrase that fits neither. A skill that must load on both keeps its frontmatter to what
each tool documents and puts the rest where the table says.

## After the change

Validate on each target tool, then review at the weight the change earns (`review.md`,
*Choosing the weight*). At the full rung, the preservation comparison runs with the baseline
set and the candidate as its only inputs; adjudicate every reported loss against the brief and
record each disposition when surfacing results. A changed description or trigger set is a
named uncertainty, so a trigger probe in a fresh session is warranted there.
