---
name: skill-and-plugin-authoring
description: Author, import, update, or repair Claude Code and Codex skills, for either tool or both, standalone or in a plugin; package skills and hooks as a plugin with a marketplace. Use when asked to create or write a skill, turn instructions or a workflow into a skill, fix a skill that triggers wrongly or is not followed, move a skill between the two tools, make, publish, or add a plugin or marketplace, or add or configure a plugin hook or a skill-scoped hook. Not for authoring MCP servers or subagents, investigating why a session ignored instructions, or prompt wording outside a skill package.
---

# Skill and Plugin Authoring

A skill is a directory holding a `SKILL.md` — YAML frontmatter that decides *whether* the
skill is invoked, then a Markdown body that steers the agent once it is — plus any supporting
files the body points at. A plugin is a directory of skills, hooks, and other components that
a tool installs and loads as one unit, usually from a marketplace catalogue.

Where a fact below is one tool's, it is named; everything unnamed holds for both. Confirm a
contract against the installed tool before leaning on it; both tools move quickly and this text
is a snapshot.

## Modes

Classify the request at intake:

- **New** — nothing exists; author from the intake interview.
- **Import** — one or more existing skills, possibly written for the other tool, become one
  skill here. The baseline to preserve is the old skill, not no skill at all.
- **Update** — revise an existing skill, including one that misfires or is not followed. Keep
  the diagnosis separate from the first guessed fix; a remedy handed to you (a review finding,
  a user's hunch) is a candidate to re-judge, not a specification.
- **Package** — wrap finished skills, and any hooks, as a plugin for one tool or both, with a
  marketplace so others can install it.

Import and update read `references/importing-and-updating.md` before any file changes; a
report that a skill does not trigger, over-triggers, or is not followed also reads
`references/troubleshooting.md` before diagnosing. Package reads the plugin reference for each
tool it ships to, and `references/hooks.md` when hooks are involved. A request to add or change
a hook alone reads `references/hooks.md`.

## Workflow

1. **Intake**, scaled like the review. For a new skill, an import, or a change to the
   description, the triggers, or what the skill verifies, run the interview below as a
   conversation and, before writing any file, play back the skill's job, when it triggers,
   what is in and out of scope, and what good output looks like, and get the user's
   confirmation. For import and update, read the package first (step 2) so the playback
   carries the list of what must remain true, for the user to confirm or amend. For package
   mode, play back the plugin's name, the target tools, how it will be distributed, and
   whether a plugin is warranted at all. A typo, link, or one-section fix needs no interview.
   Where no user can answer — a dispatched brief, a headless run — the brief is the confirmed
   intake: record the playback and any assumptions in the summary, and stop only if the
   skill's job, triggers, or good output cannot be read from it.
2. **Read before changing.** For import and update, read the whole package — `SKILL.md` and
   every supporting file — and keep an unchanged copy of it (`references/importing-and-updating.md`,
   *Before changing anything*). Read the tool contract in `references/skill-contracts.md`
   whenever frontmatter, paths, or invocation are in play.
3. **Draft** by `references/prompt-craft.md`: the body states goals, hard constraints, and
   success criteria, and enumerates steps only where an operation is fragile. Detail the
   agent needs at a specific moment goes in a supporting file behind a when-to-read link
   (`references/progressive-disclosure.md`).
4. **Write the description last**, from the finished body, by *Description* below.
5. **Validate** what was produced. A plugin or marketplace root: `claude plugin validate
   <root>` on Claude Code; on Codex, the local install loop in `references/plugins-codex.md`.
   A standalone skill: read its frontmatter back against the table in
   `references/skill-contracts.md`, then confirm it is listed with its description intact in a
   fresh session of each target tool — `claude plugin validate <skills-folder>` checks a folder
   of skills' frontmatter but refuses a bare skill directory, and a one-shot run (`claude -p`,
   `codex exec`) asking the agent to list its skills with their descriptions is the
   non-interactive listing check. A target tool not installed on this machine gets the
   read-back only, and the summary names it as unvalidated there.
6. **Review** at the weight the change earns — `references/review.md` (*Choosing the weight*)
   lists the rungs and their triggers; blast radius sets the minimum and the user may raise
   it, never lower it. Reconcile every finding against the text before acting on it; a
   defended survival is a valid outcome.
7. **Test the behaviour** only when a named uncertainty needs an observation to settle it or
   the user asks: a trigger probe in a fresh session, or on Claude Code a plugin eval
   (`references/plugins-claude-code.md`, *Evals*). A changed description or trigger set, and
   the removal of inherited scaffolding, are named uncertainties. Treat the tool's
   documentation as the first source of truth and runtime behaviour as the tie-breaker.
8. **Summarise** what changed, what was verified, and what remains uncertain.

Jump in at whichever stage the user has already reached, but not past the intake the change
earns.

## Intake Interview

At the intake the Workflow assigns the change, establish before writing or rewriting
behaviour-bearing text:

1. What should the skill enable the agent to do?
2. When should it trigger — which user phrases, file types, or situations count, and which
   nearby requests should *not* trigger it?
3. What does the output, decision, or side effect look like when the skill works well?
4. Which examples, input formats, integrations, scripts, or dependencies matter?
5. Which edge cases, failure modes, or annoying behaviours are already known?
6. Which tools must it load on — Claude Code, Codex, or both — and does it ship alone or
   inside a plugin? A single-tool source does not settle this; ask.
7. For import and update: is the list of what must remain true (derived from reading the
   package) complete and correct?
8. Beyond the review rung the change earns, does the user want a trigger probe or an eval run?

For package mode, ask instead: is a plugin warranted (shared with others, installed in many
projects, or released in versions), what are the plugin name and namespace, which tools and
marketplaces, which source type and versioning, and are there hooks the install notes must tell
Codex users to trust?

If questions 1 to 3 cannot be answered from the request, ask rather than assume.

## Principles

- **Concise for accuracy, not omission.** Shorter instructions are followed more reliably,
  but brevity is not licence to drop a gate, constraint, or distinction. Keep `SKILL.md`
  lean by moving detail into supporting files, not by deleting guidance.
- **State goals, not scaffolding.** A step-by-step scaffold narrows the model to the one path
  the author foresaw. Reserve enumerated steps for fragile operations — exact commands, file
  formats, irreversible actions.
- **Every instruction earns its place.** The test: would the agent get this wrong without it?
  If not, cut it.
- **Gotchas by applicability.** A concrete environment fact that defies reasonable assumptions
  is the highest-value content a skill carries. One that bites in every session of the skill
  goes in `SKILL.md`; one tied to a single mode or moment goes at the top of that moment's
  reference, with the `SKILL.md` link naming the hazard.
- **Skills are composable.** Write for an agent that also has other skills, project rules,
  and built-in tools; do not restate what a specialised skill or the tool already does.
- **Illustrative values become defaults.** A sample filename, number, or format dropped in to
  make a sentence concrete gets copied as the canonical answer. Show a value only when it is
  a genuine requirement; otherwise describe the property.
- **Shipped files carry guidance, not commentary about it.** Strip authoring rationale,
  self-reference ("as shown above"), provenance ("added after the incident on…"), and
  present-state narration. A reader who never saw the earlier version must be served.
- **Plain Markdown, calm language.** Emphatic absolutes (ALWAYS, NEVER, CRITICAL) are for
  genuine invariants; for judgement calls, state a decision rule. Modern models enforce
  emphasis as literal hard rules and trust the calm sentences less.

## Description

The description is a routing key read alongside every other skill's, on every turn, before
the body exists to the model. It answers one question — whether to invoke — and never how
the skill works.

- Name the job and the trigger conditions in terms a user would actually say. A what-only
  description leaves the *when* to inference and under-triggers.
- Third person or imperative; no "I" or "you".
- Every term present should be one the skill wants to match on. An incidental keyword — an
  output directory, a tool the skill happens to use, a list of its internal stages — matches
  as strongly as a deliberate trigger and fires the skill on requests about *those*.
- Negative clauses ("not for X — that is Y") go where a mis-route is live: fullest for a
  confusion that has happened, one short clause for a likely one (a similarly named skill,
  an adjacent stage of the same workflow), none where no confusion target exists. Where two
  local skills border each other, make the clauses reciprocal. Draw the boundary by kind of
  job where the skill may travel: a named neighbour may not exist where the skill lands.
- On update, re-derive the description whole from the current body; never append. It is not
  a changelog.
- Front-load the key use case: both tools truncate or shorten long descriptions in the
  listing (`references/skill-contracts.md`, *Context budgets*).

## Body

- Lead with what shapes every session of the skill: the doctrine, the signals, the contracts
  whose violation is silent. Detail needed at one moment — a procedure, an API surface, a
  worked example — rides a supporting file read at that moment, with a link that says *when*
  to read it ("read `references/api-errors.md` if the API returns a non-200 status").
- Keep the body comfortably under about 500 lines; the per-tool budgets that make this
  matter are in `references/skill-contracts.md` (*Context budgets*).
- Do not duplicate between `SKILL.md` and supporting files; the stale copy eventually wins.
- Where behaviour must be deterministic rather than hoped for — a forbidden command, a
  validation that must run — prefer a bundled script or, on Claude Code, a skill-scoped hook
  (`references/hooks.md`) over stronger prose.
- Use concrete, realistic prompts in any test cases you write.
- On Claude Code a backtick-wrapped command prefixed with an exclamation mark runs at skill
  *load*, even inside documentation that merely forms the pattern; `references/skill-contracts.md`
  (*Load-time behaviour*) covers both its deliberate use and how to avoid tripping it.

## Frontmatter

Both tools read YAML frontmatter between `---` lines at the very top of `SKILL.md`. Both
document `name` and `description`; Codex also documents `license`, `metadata`, and
`allowed-tools`, and Claude Code a wider set that Codex ignores rather than refuses. Controls one
tool enforces at load, such as who may invoke the skill, cannot be carried in the body, which is
read only after selection: `references/skill-contracts.md` (*Frontmatter*, *Invocation and
control*) gives each tool's keys and mechanism and what a shared package has to give up.

## Plugins

A marketplace is a JSON catalogue in a repository listing plugins and where to fetch each.
Skills and hook configuration get authoring guidance here; agents, MCP servers, app
connectors, and the other component kinds appear in the layout trees only, so a request to
write one of those is outside this skill and should be said so rather than improvised.

Decide at intake whether a plugin is warranted at all. A skill under the tool's own skills
directory already loads in every project on that machine; a plugin earns its manifest when
the setup is shared with others, installed in many projects, or released in versions.

Read `references/plugins-claude-code.md` and `references/plugins-codex.md` for each tool's
manifest, layout, marketplace schema, install commands, local test loop, and gotchas; the
former's *One repository, both tools* shows a single repository publishing to both.

## Workspace

Author the skill in place — the tool's skills directory, or the plugin's `skills/`. Anything
transient — the unchanged copy of a package being imported or updated, review prompts and
reports, probe transcripts — goes in a per-task directory you create with `mktemp -d` and
delete when the task ends.

## Checklist

Final-state assertions:

- [ ] the intake the change earns was played back and confirmed, or the brief recorded as it
- [ ] frontmatter checked against each target tool's table; `name` equals the directory
- [ ] description re-derived whole: whether-to-invoke only, no incidental keywords
- [ ] the review rung stated and run; findings reconciled, never silently adopted or reversed
- [ ] import/update: whole source read first and its copy kept; nothing that must remain true
      was lost
- [ ] plugin: manifest validates, entry name equals manifest name, loads from a fresh session
