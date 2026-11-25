# Importing and Updating Without Losing Behaviour

Compare an import or update against the old skill, not against having none: a cleaner rewrite
can still drop a gate.

## Before changing anything

1. Keep the baseline. Copy the original package — every source package, for an import from
   several — unchanged into the per-task scratch directory before the first edit, or note the
   git revision it is committed at and materialise that revision to a readable path. The
   preservation comparison reads this set as its original; editing in place destroys it.
2. Read the whole package — its main file, every supporting file, every script — not just the
   part the request names. A gate in an unlinked file is still a gate.
3. Write down what must remain true afterwards: the behaviours, the gates, the concrete
   handles (commands, paths, tool names, formats), the warnings. Play this list back at
   intake, where the user can amend it. It is the author's list: the preservation reviewer
   never sees it (`references/review.md`), and the author adjudicates each reported loss against it.
4. Separate the diagnosis from the fix. A remedy handed to you — a reviewer's suggested
   change, a user's "it's probably the description" — is a candidate to re-judge against the
   text, never a specification. Fix the cause, then check the fix did not move the symptom.
5. Make the change thorough enough to solve the diagnosed problem cleanly: do not stop at the
   smallest patch if it leaves stale guidance, dropped gates, or contradictions behind; do not
   sprawl into unrelated redesign either.

## Overwrite, do not append

Overwrite outdated text in place: a correction appended at the end sits where a bounded read
misses it, while the stale text above it keeps steering. Re-derive the description whole, by
the rule in the main file.

## Modernising an inherited skill

Skills written for earlier models often carry step-by-step scaffolding, emphatic banners, and
restated rules. Current models plan better than the scaffold and over-apply emphasis, so the
inherited shape can *cause* the deviation it was written to prevent. Whether the steps still earn
their place is a named uncertainty that warrants a test: compare the skill with the
scaffolding removed — a trigger probe or eval on a representative task on each version — and
keep what the comparison shows matters.
Do not rewrite a personal or local skill into a generic one unless the user asks for
portability.

## Moving a skill to another tool or format

The body is largely portable; the frontmatter and the invocation surface are not. Settle the
target set with the user — a skill written for one tool or loader does not tell you whether it
is wanted on another — then map each frontmatter key and each invocation handle onto the
destination's contract, and route a behaviour the destination cannot express into the body or
a bundled script, or accept its loss and say so. Where one destination has a concrete handle —
a named tool, a command, a path — and another has a different one, name each in the body ("on
Claude Code … ; on Codex …") rather than genericising to a phrase that fits neither.

## After the change

Validate on each target tool, then review at the weight the change earns (`references/review.md`,
*Choosing the weight*). At the full rung, the preservation comparison runs with the baseline
set and the candidate as its only inputs; adjudicate every reported loss against the brief and
record each disposition when surfacing results. A changed description or trigger set is a
named uncertainty, so a trigger probe in a fresh session is warranted there.
