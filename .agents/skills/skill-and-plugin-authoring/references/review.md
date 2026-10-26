# Reviewing a Skill

Review in a fresh session or subagent of the host tool, separate from the authoring context:
give it this brief and the skill's path, and it reads cold, as the skill's future reader will.
No special tooling is needed.

## Choosing the weight

Price the review by blast radius, not diligence:

- **None** — typos, link fixes, clarifications that change nothing about how the skill loads,
  is followed, or is verified. Validation on the target tool is the whole gate.
- **One scoped pass** — a change confined to one section or one behaviour of a skill that
  works. One reviewer, both halves of the brief, inputs limited to the changed sections with
  enough surrounding text to judge fit.
- **The full brief** — a new skill, an import, a restructure, or any change to the
  description, the triggers, or what the skill verifies. One reviewer runs the defect hunt and
  the concision attack over the whole package; for import and update a second, separate
  reviewer runs the preservation comparison first, blind to what changed.

A scoped pass whose findings suggest the change disturbed more than intended steps up. Blast
radius sets the minimum; the user may ask for more, never less. State the rung chosen, and why,
when surfacing results.

**Packaging** has its own check rather than a rung: read the manifests and catalogues back
against the shapes in the plugin references, run the local install loop on each target tool,
and confirm each bundled skill is listed with its description intact. Skills changed along the
way take the rung their own change earns.

## Running a review

1. Write the review prompt to a scratch file: the relevant brief sections below, followed by a
   `## Provided Inputs` section carrying the skill's absolute path, each file's loading
   profile (description: every turn; `SKILL.md`: every invocation; references: on demand),
   and nothing about the authoring story — not the source, not what moved, not what you hoped
   for. A reviewer that knows the story confirms the story.
2. Dispatch it to a fresh context that can read the files: a one-shot `claude -p` or
   `codex exec` run, or a subagent, started in the scratch directory — not in the project,
   whose guidance, memory, and installed skills would load into the reviewer — with the
   skill's absolute path in the prompt. Where the other tool is installed, use it: a skill
   drafted in a Claude Code session is reviewed by `codex exec`, and the reverse — a reviewer
   from a different model family catches what a same-model read rationalises away. Otherwise
   use a different model than the one that drafted; one *below* the drafting tier previews the
   weakest reader who will execute the text.
3. Capture the whole structured report, not the verdict line, and bring its substance to the
   user in chat. Never collapse a report to "PASS".

## The brief: defect hunt

Review the skill package at the provided path as one artefact: `SKILL.md` first, then every
file it links, then every other file under the directory whether or not the body links it.
Judge the text as written; give no credit for intent, but allege no defect without textual
evidence. Prefer fewer high-confidence findings over many weak ones. Do not spend time on
praise.

Dimensions:

- **Discovery** — does the `description` state what the skill does *and when* to invoke it,
  in terms a user would say, without implementation detail or incidental keywords, with
  negative clauses only where a mis-route is plausible?
- **Frontmatter** — only keys the target tool accepts; on Codex, `name` equals the directory.
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
- **Load-time hazards** — on Claude Code, any backtick command prefixed with `!` that is not
  an intended injection.

Report, in this order: **Verdict** (`PASS` or `ISSUES`); **Files reviewed**; **Findings**, each
as `[F1][severity][confidence][category] path — section or lines — the problem, why it
matters, the evidence, what should change`, or `- none`; **Considered and rejected**, with a
reason each; **Summary**.

## The brief: concision attack

Instruction text is written for a weaker reader than the one that executes it, so it
over-explains and over-gates, and ordinary reviews only add. This pass is subtraction only:
propose removals, mergers, and shorter renderings, never additions. Calibrate to the loading
profile — text loaded every turn or every invocation deserves the hardest attack, a reference
read on demand a lighter one.

Put each passage to four questions, in rising order of judgement:

1. **Fewer words** — can this be said in less? Carry the concrete shorter rendering.
2. **Fewer concepts** — would a competent agent act correctly without this explanation?
3. **Fewer gates** — name the failure each step or check guards against; challenge it when a
   competent reader would not commit that failure, or the cost on every execution outweighs it.
4. **Lighter load** — for an always-loaded passage, is it needed at every load or only at a
   moment the reader could be pointed to? Name the destination file.

The floor: a challenge preserves what the text steers — behaviour, boundary conditions, hard
constraints, and concrete handles (exact commands, paths, tool names, formats, quoted or
dictated wording). A cut that drops a load-bearing distinction is a false finding; raise doubt
under Insufficient Evidence instead.

Report: **Verdict** (`LEAN` or `EXCESS`); **Files reviewed**; **Challenges**, each as
`[C1][words|concepts|gates|load][confidence] path — quoted text → proposed rendering or
delete — what is preserved and why the cut is safe`, or `- none`; **Considered and kept**, with
a reason each; **Insufficient evidence**; **Summary**. There is no removal quota.

## The brief: preservation comparison (import and update)

The baseline is the old skill, not no skill. Given the original package path — or the set of
source packages, for an import from several — and the candidate path, and nothing else, read
both in full and report every behaviour, gate, heuristic, warning, nuance, concrete handle, or
supporting file present in the original and absent, weakened, or altered in the candidate. Quote
the original text for each. Do not ask what was intended; do not judge whether a loss was
deliberate.

Report: **Coverage** (what was read); **Losses**, each as `[L1][severity] original path and
section — quoted text — where it would have landed in the candidate — what the candidate says
instead`, or `- none`; **Behaviours confirmed preserved**, briefly; **Summary**.

The author then adjudicates each loss against the brief: a deliberate narrowing is the
intended outcome until shown otherwise; an unintended loss is restored. Record the
disposition of every loss when surfacing results.

## Reconciling findings

Check every finding against the text, the request, and the target tool's current
documentation before acting. Adopt, adapt, or defend — a defended survival is a valid
outcome, and so is rejecting a finding the reviewer could not see the reason for. Watch for a
reviewer that keeps relitigating the same passage across passes, and stop rather than loop. If
a finding needs the user's decision, include the finding itself or a faithful summary in the
question; never ask the user to rule on an unseen review.
