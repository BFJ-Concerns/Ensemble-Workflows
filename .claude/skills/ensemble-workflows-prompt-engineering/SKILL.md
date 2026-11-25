---
name: ensemble-workflows-prompt-engineering
description: Write or review instruction text for a large language model — system prompts, briefs for other agents and subagents, skills, rules, agent definitions, CLAUDE.md and AGENTS.md files, tool descriptions. Use before writing or substantially revising any of these, or when a prompt is followed badly or needs cutting back.
---

# Prompt Engineering

This follows what Anthropic and OpenAI currently publish for their current models. It differs from what most models remember about prompt writing, which comes from older models that needed more steps, more rules and more emphasis than current ones do.

## The test for every line

A current model already knows how to do most work, and it acts on what a prompt says. So each line costs something. A step is followed even after a better route appears. A rule written for one bad case is applied to the cases it was wrong for. Two lines that pull against each other make the reader stop to reconcile them, or stop altogether.

The same model cannot see what you know. Whatever the prompt leaves out, it fills with a generic default.

So keep a line only if it tells the reader something it could not work out for itself and that changes what it does. A line that passes stays however long the prompt becomes: minimal does not mean short.

## What the reader needs

What gets left out is usually what feels too obvious to the author to write down.

- **The outcome, and what done looks like.** What must be true before the work counts as finished, and how the result will be judged.
- **The purpose.** What the work is for, who it is for, and what they will do with the result. A reader that knows the purpose handles the case you did not foresee; one that does not applies your words to it mechanically.
- **The situation.** Where things stand, what has been tried or ruled out, and the facts that defy a reasonable assumption.
- **The real constraints.** What is out of scope, what may be done without asking, and where to stop. Make the boundaries as clear as the goal.
- **What to hand back.** Its form, its length, and where it goes.
- **The thing itself, where you have it.** A file, a failing test, a mockup, or working code to port, handed over instead of described.

Give all of it at the start, in one message. A task revealed a piece at a time costs more and often comes out worse.

## What to leave out

- **The method, where more than one would do.** State the outcome and leave the route to the reader. It usually plans better than a procedure written in advance, and it follows a procedure even when the procedure has stopped fitting. Write steps when their order or completeness matters, or when a deviation would cause a concrete problem: an exact command, a file format, an irreversible action.

- **What the reader would do anyway or can see for itself.** General good practice, what a file's own contents show, and instructions to be thorough, to keep going or to check the work. A model that already carries a task through and checks it will over-work and verify repeatedly when told to. Some models do stop early or wait for a go-ahead, the strongest tier included and any tier more often at low effort; those need the line, and the vendor's guidance for the model says which.

- **A guardrail against the worst case, where the right answer depends on context.** A blanket rule is wrong wherever the habit it suppresses would have been right, and it collides with what the user asks for. Tie the instruction to the context: "match the comment density of the surrounding code" where the old rule said to write no comments.
- **Emphasis.** A plainly worded line is followed. Capitals, "critical" and repetition make the reader over-apply it.
- **A rule made from one example or one past failure.** Fix the case narrowly. A line added for every incident builds a prompt that contradicts itself.
- **The same instruction in a second place.** The copies drift apart and become a conflict.
- **An authority as the reason.** "The model chooses a tool from its description alone" tells the reader how to apply an instruction. "The vendor recommends it" does not, and it goes stale. A provider's real behaviour, such as a limit or an API quirk, is a fact to state.

## Rules that are meant as rules

Some things are invariants: a safety boundary, a permission, a required field, an action that must never happen. Write those as rules. A rule is applied as written, so:

- Name exactly what it covers. A broad noun stretches the rule over routine work.
- Give its reason, so the reader can tell where it stops applying.
- Write an exception into the rule itself. A separate line elsewhere that grants the exception, or a general invitation to use judgement, barely loosens a rule that says "never".
- Delete a caution once its reason has gone. Cautions pile up in notes, memory, instruction files and messages between agents, and together they hold back routine work.

## Briefing another agent

The worker starts with your brief and nothing else. It has not seen your conversation, the files you read, or the rules you are working under. Everything under *What the reader needs* applies in full, and a brief that carries it often runs to several paragraphs. Four things are particular to a brief:

- **Bound the scope.** Say what is in and what is out. A worker given an open brief tends to turn it into more work than was wanted.
- **Restate any rule the worker must follow.** It does not inherit yours.
- **Say what to return, and ask for it short.** The result lands in your context.
- **When the worker is there to check something, give it the evidence and the question, never your conclusion.** A worker told the expected answer tends to confirm it.

Where the tool, the source or the method does matter to you, say which and why. Otherwise the method is the worker's.

## Standing instruction text

A skill, a rule, an agent definition or a guidance file is loaded again and again, into situations nobody foresaw. Each line's cost recurs, and the text cannot be as specific as a one-off prompt.

- Write down what the reader cannot find by reading the repository, or would otherwise rediscover every session: the gotchas, the house opinions, the decisions already made.
- Treat a skill as a light guide, and constrain it tightly only where a mistake would be serious. Detail needed at one particular moment goes in a separate file that is read at that moment.
- Add a line for a failure you have seen, and make it the narrowest line that fixes it. If a line keeps being missed however it is worded, it belongs in code — a hook, a check, a permission — not in stronger wording.
- Go back over the text when the model changes. Text written for an older or smaller model over-constrains a stronger one.
- A discovery description for a skill, a tool or an agent states briefly, in the third person, what it does, when to use it and where a similar request belongs instead. An API tool's description is all the documentation the tool has, so its inputs, side effects and errors go there too.

Where the artefact has a dedicated authoring skill, use that skill; it carries the rest.

## Examples, structure and format

- **An example is copied closely**: its form, its phrasing and its details. Use examples where sameness is what you want, three to five varied ones for a format, a tone or a structure. Where the output should change with its input, describe the qualities of a good result instead. To steer how an agent uses a tool, shape the tool: parameter names and allowed values teach its use without a sample run that narrows what the agent will try.
- **An incidental value is reused as though it were required.** A sample filename or a placeholder number in an instruction comes back in the output. Use a value you would be content to see reused, or describe the property.
- **Mark what is not instruction.** Wrap a document, an example or pasted input in XML-style tags so it cannot be read as part of your instructions, and choose a tag that cannot occur in what it wraps. Organise a standing file with headings and short lists.
- **Say what you want.** For format and style, a description of the target steers better than a list of things to avoid. A real boundary is still stated as a prohibition, with its scope.
- **Ask for the output format its destination needs.** The style of the prompt leaks into the output, so a prompt in heavy Markdown gets Markdown back.

## The target model

None of this is independent of the model. A smaller model, or any model at low effort, may need a check or a scope stated that a flagship handles unprompted, and text tuned for a smaller model over-constrains a flagship. When the prompt targets a particular model, read its vendor's current prompting guidance for that model before writing, and follow it where it departs from the guidance above. For a prompt several models will read, the guidance above stands. Community advice does not stand in for the vendor's guidance.

Reasoning effort is a separate lever from the prompt. To get less thinking, lower the effort; to get more, raise it. Wording does neither reliably.

## When a prompt is followed badly

The cause is more often a line that is there than a line that is missing. Find it first: ask the model which instruction it was following, or read the prompt for the line that conflicts with the one being missed. Then make the narrowest change that fixes the case, which is often a deletion or a tighter scope. For a prompt inherited from an older model, try it with the old scaffolding removed, and put back only what a failure shows is needed.

