---
name: ensemble-workflows-skill-creator
description: Write, import, update, repair or review an agent skill for Claude Code, Codex, opencode, zcode or the Antigravity CLI. Use when asked to create or write a skill, turn instructions or a workflow into a skill, fix a skill that triggers wrongly or is not followed, or move a skill from one tool to another. Not for packaging skills or hooks as a plugin, and not for prompt wording outside a skill.
license: Complete terms in LICENSE.txt
---

# Writing Skills

A skill is a directory holding a `SKILL.md`: YAML frontmatter that decides *whether* the skill
is invoked, then a Markdown body that steers the agent once it is, plus any supporting files
the body points at. All five tools read the same shape. They differ in where skills load from,
which frontmatter keys they act on, how a user invokes one and what limits they set, and
`references/skill-contracts.md` gives those differences tool by tool. Where a fact below holds
for one tool only, it names the tool. Confirm a contract against the installed tool before
relying on it: these tools change quickly and the reference is a snapshot.

## Modes

Classify the request at intake:

- **New** — nothing exists; author from the intake interview.
- **Import** — one or more existing skills, possibly written for another tool, become one
  skill here. The baseline to preserve is the old skill, not no skill at all.
- **Update** — revise an existing skill, including one that misfires or is not followed. Keep
  the diagnosis separate from the first guessed fix; a remedy handed to you (a review finding,
  a user's hunch) is a candidate to re-judge, not a specification.

Import and update read `references/importing-and-updating.md` before any file changes; a
report that a skill does not trigger, over-triggers, or is not followed also reads
`references/troubleshooting.md` before diagnosing. A skill that must enforce something with a
hook reads `references/tool-hooks.md`. Packaging finished skills as a plugin is a separate
job, for the repository's plugin-packaging skill where it has one.

## Workflow

1. **Intake**, scaled to the change. For a new skill, an import, or a change to the
   description, the triggers, or what the skill verifies, settle the questions under *Intake
   Interview*, then play back the skill's job, when it triggers, what is in and out of scope,
   and what good output looks like before writing any file. For import and update, read the
   package first (step 2) so the playback carries the list of what must remain true. Ask only
   a genuine choice, each with your recommendation: one the work cannot proceed without waits
   for the answer, and one it can proceed past takes the stated default, which the summary
   names. A playback with no genuine choice in it is a report, not a question, so go on
   without waiting for a reply. A typo, link, or one-section fix needs no interview. Where no
   user can answer — a dispatched brief, a headless run — the brief is the intake: record the
   playback and any assumptions in the summary, and stop only if the skill's job, triggers,
   or good output cannot be read from it.
2. **Read before changing.** For import and update, read the whole package — `SKILL.md` and
   every supporting file — and keep an unchanged copy of it (`references/importing-and-updating.md`,
   *Before changing anything*). Read `references/skill-contracts.md` whenever frontmatter,
   paths, or invocation are in play.
3. **Draft.** Use the repository's prompt-writing skill before writing or substantially
   revising the skill's text. The body states goals, hard constraints, and success criteria,
   and enumerates steps only where an operation is fragile. Detail the agent needs at a
   specific moment goes in a supporting file behind a when-to-read link
   (`references/progressive-disclosure.md`).
4. **Write the description last**, from the finished body, by *Description* below.
5. **Validate** what was produced: read its frontmatter back against each target tool's table
   in `references/skill-contracts.md`, then confirm the skill is listed with its description
   intact in a fresh session of each target tool, by the listing check the same reference
   gives for that tool. A target tool not installed on this machine gets the read-back only,
   and the summary names it as unvalidated there.
6. **Review** at the weight the change earns — `references/review.md` (*Choosing the weight*)
   lists the rungs and their triggers; blast radius sets the minimum and the user may raise
   it, never lower it. Reconcile every finding against the text before acting on it; a
   defended survival is a valid outcome.
7. **Test the behaviour** only when a named uncertainty needs an observation to settle it or
   the user asks: a trigger probe in a fresh session. A changed description or trigger set,
   and the removal of inherited scaffolding, are named uncertainties. Treat the tool's
   documentation as the first source of truth and runtime behaviour as the tie-breaker.
8. **Summarise** what changed, what was verified, each default taken in place of an answer,
   and what remains uncertain.

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
6. Which tools must it load on — Claude Code, Codex, opencode, zcode, the Antigravity CLI —
   and does it ship alone or inside a plugin? A single-tool source does not settle this; ask.
7. For import and update: is the list of what must remain true (derived from reading the
   package) complete and correct?
8. Beyond the review rung the change earns, does the user want a trigger probe?

If questions 1 to 3 cannot be answered from the request, ask rather than assume.

## Principles

- **Concise for accuracy, not omission.** Shorter instructions are followed more reliably,
  but brevity is not licence to drop a gate, constraint, or distinction. Keep `SKILL.md`
  lean by moving detail into supporting files, not by deleting guidance.
- **Every instruction earns its place.** The test: would the agent get this wrong without it?
  If not, cut it. A step, check, or gate also names the failure it prevents, and a change
  that touches an existing one holds it to the same test.
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
- **One term per concept, and no dated facts.** Keep one name for each thing throughout the
  package. Describe the current method rather than "before August, use the old API", and give
  one default with the one condition that selects an alternative rather than a menu.

## Description

The description is a routing key read beside every other skill's before the body loads. It
answers whether to invoke, never how the skill works.

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
- Front-load the key use case: the tools shorten or truncate long descriptions in the listing,
  and zcode refuses one over 1,024 characters (`references/skill-contracts.md`, *Limits*).

## Body

- Lead with what shapes every session of the skill: the doctrine, the signals, the contracts
  whose violation is silent. Detail needed at one moment — a procedure, an API surface, a
  worked example — rides a supporting file read at that moment, with a link that says *when*
  to read it ("read `references/api-errors.md` if the API returns a non-200 status").
- Keep the body comfortably under about 500 lines; the per-tool budgets that make this
  matter are in `references/skill-contracts.md` (*Limits*).
- Do not duplicate between `SKILL.md` and supporting files; the stale copy eventually wins.
- Where behaviour must be deterministic rather than hoped for — a forbidden command, a
  validation that must run — prefer a bundled script or a hook (`references/tool-hooks.md`)
  over stronger prose.
- Use concrete, realistic prompts in any test cases you write.
- On Claude Code, and on opencode when a skill runs as a command, a backtick-wrapped command
  prefixed with an exclamation mark runs at skill *load*, even inside documentation that merely
  forms the pattern; `references/skill-contracts.md` (*Load-time behaviour*) covers both its
  deliberate use and how to avoid tripping it.

## Frontmatter

Every tool reads YAML frontmatter between `---` lines at the very top of `SKILL.md`, and all
five read `name` and `description`. Beyond those they differ: Claude Code acts on a wide set of
keys, and the others act on few. A key a tool does not know is ignored on most, but zcode marks
a skill carrying one as unsafe to load automatically. Controls one tool enforces at load, such as who may
invoke the skill, cannot be carried in the body, which is read only after selection:
`references/skill-contracts.md` (*Frontmatter*, *Invocation and control*) gives each tool's keys
and mechanism, and what a skill meant for several tools has to give up.

## Workspace

Author the skill in place, in the tool's skills directory or the plugin's `skills/`. Anything
transient — the unchanged copy of a package being imported or updated, review prompts and
reports, probe transcripts — goes in a per-task directory you create with `mktemp -d` and
delete when the task ends.

## Checklist

Final-state assertions:

- [ ] the intake the change earns was played back, and each genuine choice answered or its
      default named in the summary
- [ ] frontmatter checked against each target tool's table; `name` equals the directory
- [ ] description re-derived whole: whether-to-invoke only, no incidental keywords
- [ ] the review rung stated and run; findings reconciled, never silently adopted or reversed
- [ ] import/update: whole source read first and its copy kept; nothing that must remain true
      was lost
