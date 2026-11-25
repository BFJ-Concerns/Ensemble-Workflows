# Reviewing a Skill

Review in a fresh session separate from the authoring context: give it a brief and the
skill's path, and it reads cold, as the skill's future reader will. No special tooling is
needed.

## Choosing the weight

Price the review by blast radius, not diligence:

- **None** — typos, link fixes, clarifications that change nothing about how the skill loads,
  is followed, or is verified. Validation on the target tool is the whole gate.
- **One scoped pass** — a change confined to one section or one behaviour of a skill that
  works. One reviewer runs the defect hunt and the concision attack, with inputs limited to
  the changed sections and enough surrounding text to judge fit.
- **The full brief** — a new skill, an import, a restructure, or any change to the
  description, the triggers, or what the skill verifies. One reviewer runs the defect hunt and
  the concision attack over the whole package; for import and update a second, separate
  reviewer runs the preservation comparison first, blind to what changed.

A scoped pass whose findings suggest the change disturbed more than intended steps up. Blast
radius sets the minimum; the user may ask for more, never less. State the rung chosen, and why,
when surfacing results.

## Running a review

1. Write the review prompt to a scratch file: the brief, followed by a `## Provided Inputs`
   section carrying the skill's absolute path, each file's loading profile (description:
   every turn; the main file: every invocation; references: on demand), the path to the
   contract of the loader that reads the skill where that is not a coding tool's, and nothing
   about the authoring story — not the source, not what moved, not what you hoped for. A reviewer that
   knows the story confirms the story.
2. Dispatch it to a fresh context that can read the files: a one-shot `claude -p` or
   `codex exec` run, another installed tool's non-interactive mode, or a subagent, started in
   the scratch directory — not in the project, whose guidance, memory, and installed skills
   would load into the reviewer — with the skill's absolute path in the prompt. Where a tool
   running another model family is installed, use it: a skill drafted in a Claude Code
   session is reviewed by `codex exec`, and the reverse, because a different family catches
   what a same-family read rationalises away. Where only one family is available, use a
   different model than the one that drafted; one *below* the drafting tier previews the
   weakest reader who will execute the text.
3. Capture the whole structured report, not the verdict line, and bring its substance to the
   user in chat. Never collapse a report to "PASS".

## The briefs

- **Defect hunt** — below.
- **Concision attack** — `references/concision-attack.md`, with the artefact path and loading
  profile filled in.
- **Preservation comparison** (import and update) — `references/preservation-blind.md`, with
  the baseline copy as the original and the candidate as the candidate, and nothing else. The
  baseline is the old skill, not no skill; for an import from several sources, give the
  directory holding all of them.

## The defect hunt

Review the skill package at the provided path as one artefact: its main file first, then
every file it links, then every other file under the directory whether or not the body links
it.
Judge the text as written; give no credit for intent, but allege no defect without textual
evidence. Prefer fewer high-confidence findings over many weak ones. Do not spend time on
praise.

Dimensions:

- **Discovery** — does the `description` state what the skill does *and when* to invoke it,
  in terms a user would say, without implementation detail or incidental keywords, with
  negative clauses only where a mis-route is plausible?
- **Frontmatter** — only the keys or fields the skill's loader accepts, and a name that agrees
  with the directory wherever the loader expects it to.
- **Workflow coherence** — are the steps and gates followable and consistent with each other
  and with the supporting files? Does any instruction contradict another?
- **Load profile** — does the body carry what every session needs and push moment-specific
  detail into supporting files behind when-to-read links? Would anything in the body be lost
  without harm?
- **Over-prescription** — is a procedure enumerated where a goal, constraints, and success
  criteria would serve a capable model better?
- **Artefact hygiene** — flag authoring rationale, self-reference, provenance, present-state
  narration, and emphasis inflation.
- **Supporting-file consistency** — every bundled file load-bearing and referenced; nothing
  stale, orphaned, or contradicting the body.
- **Load-time hazards** — text the loader expands or runs when the skill loads that is not
  meant to run: on Claude Code, and on opencode for a skill run as a command, a backtick
  command prefixed with `!`.

Report, in this order: **Verdict** (`PASS` or `ISSUES`); **Files reviewed**; **Findings**, each
as `[F1][severity][confidence][category] path — section or lines — the problem, why it
matters, the evidence, what should change`, or `- none`; **Considered and rejected**, with a
reason each; **Summary**.

## Reconciling findings

Check every finding against the text, the request, and the target tool's current
documentation before acting. Adopt, adapt, or defend — a defended survival is a valid
outcome, and so is rejecting a finding the reviewer could not see the reason for.

For a preservation loss, a deliberate narrowing is the intended outcome until shown otherwise,
and an unintended loss is restored. Record the disposition of every loss when surfacing
results.

When a later pass repeats an objection you have already reconciled, with no new evidence,
keep the earlier disposition, say so in the summary, and carry on with the other findings and
the change. If a finding needs the user's decision, include the finding itself or a faithful
summary in the question; never ask the user to rule on an unseen review.
