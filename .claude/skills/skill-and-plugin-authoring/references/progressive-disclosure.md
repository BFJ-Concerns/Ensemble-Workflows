# Progressive Disclosure

`SKILL.md` is paid for at every invocation; a supporting file is paid for only when its
subject is in play. So the body carries what shapes every session of the skill — doctrine,
signals, the contracts whose violation is silent — and detail needed at a *specific moment*
(a landing, a dispatch, a debugging session) rides a reference read at that moment.
Importance is not a reason to stay in the body: a critical procedure used once per run belongs
in a reference behind a pointed link.

Supporting files can sit at the skill root, in `references/`, `scripts/`, `assets/`, or domain
folders. What matters is that `SKILL.md` links to each file directly and says *when* to read
it, so the agent reads only what the task needs.

## High-level guide with references

````markdown
---
name: processing-pdfs
description: Extract text and tables from PDF files, fill forms, and merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
---

# PDF Processing

## Quick start

Extract text with pdfplumber:
```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```

## Advanced features

**Form filling**: read `references/forms.md` when the task fills or reads form fields
**API reference**: read `references/api.md` when a method's signature is in doubt
````

## Organise by domain

For a skill spanning several domains, one reference per domain, with the body as the map:

```
bigquery-skill/
├── SKILL.md                 (overview and navigation)
└── references/
    ├── finance.md           (revenue, billing metrics)
    ├── sales.md             (opportunities, pipeline)
    └── product.md           (API usage, features)
```

A sales question then loads only `sales.md`. The same shape serves a skill that supports
several frameworks or providers: one file each, selected by the body.

## Conditional detail

Show the common path inline and link the advanced path:

```markdown
## Editing documents

For simple edits, modify the XML directly.

**For tracked changes**: read `references/redlining.md`
**For OOXML internals**: read `references/ooxml.md`
```

## Long reference files

A reference over about 300 lines gets a short contents list at the top, so an agent that
needs one section can find it without reading the rest. Fix relative links when moving text
into `references/`: a `references/foo.md` link breaks once the text itself lives there.
