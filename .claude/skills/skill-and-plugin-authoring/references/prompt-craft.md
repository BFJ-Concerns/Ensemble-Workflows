# Prompt Craft for Skill Text

These rules hold across current models because they exploit how instruction-tuned models
are trained, not any vendor's quirks. Where a tool genuinely differs, `skill-contracts.md`
says so.

## Be explicit and specific

Instruction-tuned models do what you ask and, increasingly, *only* what you ask. State every
behaviour you want, including scope: a literal-minded model will not generalise "format this
section" into "format every section".

```markdown
# Implicit (may be missed)
Process the data and return results.

# Explicit (reliable)
Process the data and return results. Before returning, verify every required
field is present, types match the schema, and no required field is null.
Return results only if those checks pass.
```

## Explain the motivation

A reason lets the model generalise an instruction to cases you did not enumerate, instead of
applying it mechanically.

```markdown
# Bare
Never use ellipses.

# With motivation (generalises)
This output is read aloud by a text-to-speech engine that cannot pronounce
ellipses, so write them out as words or drop them.
```

Ground the reason in the mechanism that makes it true, never in a vendor's name or a
benchmark. Borrowed authority gives the model nothing to act on and rots as sources age. A
provider may appear as a *fact* the instruction depends on (a real limit, a version quirk),
never as the reason to believe it.

## Only include context the agent can act on

Leave out background that changes no decision — how the surrounding system works, that the
output goes to another session, that this is step three of a pipeline. The test for every
sentence: does this change what the agent does? A reason that shapes how an instruction is
applied earns its place; an ambient fact about the plumbing does not. If a destination imposes
a requirement — a downstream parser needs JSON — state the requirement, not the backstory.

## Say what to do, not what not to do

A prohibition names what to avoid without naming the target, leaving it underspecified.

```markdown
# Negative
Do not respond in markdown.

# Positive
Write the response as flowing prose paragraphs.
```

The same holds for examples: show the behaviour wanted rather than listing behaviours to
avoid. Where the right answer varies with context, anchor the rule to the context ("match the
surrounding code's comment density") instead of legislating one outcome ("add no comments").

## Use clear, calm language

Reserve emphatic absolutes — ALWAYS, NEVER, CRITICAL, MUST — for genuine invariants: safety
rules, required output fields, actions that must never happen. For judgement calls, state a
decision rule. Current models enforce emphasis as literal hard rules and over-apply it, while
trusting the calm sentences around it less.

```markdown
# Over-emphatic
CRITICAL: You MUST validate all inputs. NEVER skip a step.

# Calm
Validate inputs before processing. Report any errors you find.
```

## Keep the benign purpose in the sentence

Automated safety classifiers read instruction text sentence by sentence and can pause a
benign session when a sentence sketches a misuse shape: a suppression verb near a sensitive
noun near a concealment act, with no purpose stated. Keep the purpose in the same sentence as
the sensitive verb, lead with the authorised destination before the exclusion, name the exact
class of information rather than a broad noun, and keep one trust boundary per sentence. This
is a clarity discipline only: where a sentence states a real security boundary, preserve the
prohibition and its scope exactly.

## Structure with Markdown; delimit embedded content with tags

Headings and sections organise the instructions you write. Content that is *not* instruction —
an example document, pasted input, retrieved context — goes inside XML-style tags so the model
cannot mistake it for your instructions. The one rule across both layers: a delimiter must
never be confusable with what it wraps, so fence a Markdown-heavy document in tags rather than
in more headings.

## Request validation explicitly

Some models add self-checks unprompted; many do not. If a check matters, write it in: make the
change, run the check, fix and re-run on failure, proceed only when it passes.

## Discovery text: third person, with trigger conditions

Write discovery text — skill descriptions, tool descriptions, agent summaries — in third
person or imperative; first or second person reads inconsistently once injected into a system
prompt. State *when* to use the capability as well as what it does; a what-only description
under-triggers.

A skill description is a routing key read beside many competitors, with the body read only
after selection, so it carries what the skill does and when to invoke it, never how it works.
Inputs, side effects, and mechanism belong in the body. Do not restate a description's
guidance in the body as reinforcement: the copies drift and become conflicting directives.

## Match specificity to fragility

Specify the outcome and the constraints that matter; leave the path to the model unless the
operation is fragile. Step-by-step scaffolding written for earlier models narrows a current
model's search to the one route the author foresaw and lowers output quality. The modern shape
of a constraining prompt is the goal, the success criteria, the hard constraints, and the stop
conditions. When inheriting a prescriptive text, compare it with the scaffolding removed before
assuming the steps still earn their place.

- **High freedom** — many approaches valid: name the aspects to cover and let the model order
  them.
- **Medium freedom** — a preferred pattern exists: give the template and say "customise as
  needed".
- **Low freedom** — the operation is fragile: give the exact command and say not to modify it.

Checklists, validate-fix-repeat loops, and explicit conditional branches belong at the low-
freedom end — exact order, exactness, or verification matters more than the model's planning.
Applied to routine work they become the over-prescription above.

## Examples over explanations — for output, not behaviour

Where quality depends on style or format, show input/output pairs: relevant, diverse enough
that the model does not latch onto an accidental pattern, clearly delimited, three to five of
them. Scope this to *output*. For steering *behaviour*, a demonstrated path gets imitated and
narrows exploration; steer through the interface instead — tool names, parameter schemas,
enums that make correct usage self-evident — plus one rule.

## Specify with artefacts where one exists

A test suite over a prose list of behaviours, a mockup over a description of a design, a
working function over an explanation of the algorithm. For qualities that resist both — taste,
tone, code quality — write a rubric naming the criteria a good result satisfies; the same
rubric hands a reviewer its judging criteria.

## Watch for anchoring from illustrative values

Incidental example values steer as strongly as deliberate ones. A placeholder filename, a
stand-in number, or a sample format gets copied as the canonical answer. When a value is a
real requirement, show it; when it only makes a sentence concrete, pick a value you would be
happy to see reused, or describe the property instead ("a timeout long enough for slow
connections" rather than a number).

## Controlling output format

Match the format to where it renders: Markdown for chat and documents, plain text where stray
markup would leak, JSON for machine consumption. Frontier models are being tuned away from
bullet-heavy output and towards prose by default; if a particular shape is wanted, say so. A
short explicit communication-style section (tone, directness, when to ask versus assume) steers
voice more reliably than correcting output afterwards.

## Anti-patterns

- **Vague instructions** — "Helps with documents" over "Extract text and tables from PDFs,
  fill forms, merge documents; use when working with PDF files or forms".
- **Time-sensitive facts baked in** — "before August use the old API" rots. Describe the
  current method; isolate legacy detail under a collapsed or clearly labelled section.
- **Too many options** — name one default and the one condition that selects the alternative.
- **Inconsistent terminology** — one term per concept, kept throughout.
- **Emphasis inflation** — repeating a rule at both ends of the file, or escalating to
  banners, makes the model over-apply that rule and discount the rest.
