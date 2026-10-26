# Troubleshooting a Skill

## The skill does not trigger

Check the description first:

- Too generic? "Helps with projects" matches nothing specific.
- Does it state *when* to use the skill, not only what it does? Models are conservative about
  optional capabilities; a what-only description under-triggers.
- Does it name the phrases users actually say, and the file types if any?
- Is the skill even listed? On Claude Code, `disable-model-invocation: true` removes it from
  the model's listing; on Codex, `policy.allow_implicit_invocation: false` in
  `agents/openai.yaml` does the same, and a `[[skills.config]]` entry may have disabled it.
  With many skills installed, Codex shortens descriptions and may omit skills with a warning.

Debug technique: ask the agent in a fresh session, "When would you use the <name> skill?" The
answer mirrors the description the tool exposed. Adjust what is missing.

## The skill triggers too often

- Narrow the stated domain: "process PDF legal documents for contract review" rather than
  "process documents".
- Strip incidental keywords — an output directory, a tool the skill uses, a list of internal
  stages. Each matches as strongly as a deliberate trigger.
- Add a negative clause where a real confusion target exists, sized to the evidence: a
  mis-route that has happened earns the full "not for X — that is Y"; a likely one earns a
  short clause; none where nothing plausible competes. Make clauses reciprocal between two
  bordering local skills.

## The skill loads but is not followed

Diagnose before reaching for stronger wording. Emphasis (CRITICAL, ALWAYS, bold warnings) is
usually the wrong fix: current models treat emphatic absolutes as literal hard rules and
over-apply them, while the real cause goes unaddressed.

1. **Too verbose** — agents lose focus in dense prose. Move reference material out; cut lines
   that restate what the model would do anyway.
2. **Buried** — the rule is present but mid-document, under an unrelated heading, or below a
   wall of detail. Lead with what matters under headings that name their subject; group
   related rules; do not repeat a rule at both ends of the file.
3. **Over-prescribed** — step-by-step scaffolding fights a model that plans better than the
   scaffold, and gets abandoned mid-task. State the goal, the hard constraints, and what must
   be true when done; keep steps for fragile operations only.
4. **Ambiguous** — replace a vague demand with a checkable rule: not "validate things
   properly" but "before calling create_project, verify the name is non-empty and the start
   date is not in the past; if either fails, report which and stop".
5. **Steps skipped** — bundle a validation script rather than relying on prose; on Claude
   Code, enforce with a skill-scoped hook (`hooks.md`). If it must stay in prose, state the
   reason the step exists; a motivated instruction generalises better than a bare command.
6. **Truncated** — on Claude Code only the first ~5,000 tokens of an invoked skill survive
   compaction. A rule past that point in a long body vanishes in long sessions. Move it up or
   shorten the body.

## Invoking the skill errors immediately, or runs a command before anything else

On Claude Code a backtick-wrapped command prefixed with `!` executes at load, even inside
documentation that merely forms the pattern. Make it a real, intended command or reword until
the literal pattern no longer appears (`skill-contracts.md`, *Load-time behaviour*).

## Frontmatter errors

- **"Could not find SKILL.md"** — the file must be named exactly `SKILL.md`.
- **Frontmatter ignored** — the opening `---` must be the first line of the file; check for a
  blank line or BOM above it.
- **Invalid YAML** — unclosed quotes and missing `---` delimiters are the usual causes; a
  description containing a colon followed by a space needs quoting.
- **Invalid name** — kebab-case only. Codex lists the frontmatter `name`, so a name that differs
  from the directory is listed under the frontmatter name, not refused.
- **Unknown key** — both tools ignore keys they do not document, so a Claude Code-only key has
  no effect on Codex rather than breaking the skill; the behaviour it controlled is simply
  absent there. `claude plugin validate <skills-folder>` reports frontmatter problems on
  Claude Code; on Codex, a skill missing from `/skills` after a restart is the signal.

## Changes do not appear

- **Claude Code** — skills are read at session start; `/reload-plugins` reloads plugin skills
  in a running session. A plugin edited on disk under a local-path marketplace reads in place;
  one installed from a hosted marketplace is a cached copy and needs a new version or a
  marketplace update.
- **Codex** — a standalone skill's changes are detected automatically; if not, restart. A
  plugin's skills are read from the copy `codex plugin add` took, whatever the source type,
  so an edit to the plugin source appears only after `codex plugin remove` and `codex plugin
  add` again, in a new session. Two skills with the same `name` are not merged.

## The session feels slow or degraded

Too much always-loaded text: a body over roughly 500 lines, many skills enabled at once
inflating the listing, or everything inline instead of behind on-demand references. Move
detail out, and on Claude Code check `claude plugin details <name>` for a plugin's projected
token cost.
