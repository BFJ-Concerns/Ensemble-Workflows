---
name: ensemble-workflows-plugin-authoring
description: Package agent skills and hooks as a plugin for Claude Code, Codex, opencode, zcode or the Antigravity CLI, or change or repair a plugin, its manifest, its marketplace or its hooks. Use when asked to make, publish or add a plugin or marketplace, ship a repository's skills to several tools as one install, or add or configure a hook. Not for writing or fixing a skill's own text, and not for writing MCP servers or subagents.
---

# Plugin Authoring

A plugin is a directory of skills, hooks and other components that a tool installs and loads
as one unit, usually from a marketplace catalogue. Claude Code, Codex, zcode and the Antigravity
CLI (`agy`) each take a bundle of that kind, with their own manifest and commands, and zcode and
agy can read or import a plugin built for Claude Code. opencode is the exception: its plugins
are JavaScript or TypeScript code, and skills reach it only as skills. Where a fact below holds
for one tool only, it names the tool. Confirm a contract against the installed tool before
relying on it: these tools change quickly, and the references are snapshots.

Read, for each tool the plugin ships to, its reference — `references/plugins-claude-code.md`,
`references/plugins-codex.md`, `references/plugins-opencode.md`, `references/plugins-zcode.md`,
`references/plugins-antigravity.md` — and `references/tool-hooks.md` whenever hooks are
involved. `references/plugins-claude-code.md` (*One repository, several tools*) shows one
repository publishing to several tools. The skills inside a plugin follow each tool's skill
contract (`references/skill-contracts.md`); writing or fixing a skill's own text is the
repository's skill-writing skill's job.

## Is a plugin warranted

Decide this at intake. A skill in a tool's skills directory already loads in every session
there, and a hook in the tool's own config already runs. A plugin earns its manifest when the
setup is shared with others, installed in many projects, or released in versions; otherwise
say so and place the skills or hooks directly.

## Workflow

1. **Intake.** Settle and play back: whether a plugin is warranted; the plugin's name and
   namespace; which tools it ships to; how it is distributed — which marketplaces, which source
   type, how it is versioned; and, for a plugin with hooks, what the install notes must tell
   users to trust (Codex's `/hooks`, zcode's and agy's workspace trust). Ask only a genuine
   choice, each with your recommendation: one the work cannot proceed without waits for the
   answer, and one it can proceed past takes the stated default, which the summary names. A
   playback with no genuine choice in it is a report, so go on without waiting. A request to
   add or change one hook needs only the hook's event, its job, and where it lives. Where no
   user can answer, the brief is the intake: record the assumptions in the summary, and stop
   only if what the plugin is for cannot be read from it.
2. **Read before changing.** For an existing plugin, read its manifests, catalogues and hooks
   whole, and keep an unchanged copy in a per-task scratch directory before the first edit.
3. **Build** the layout, manifests and catalogues each target tool's reference gives. Keep one
   plugin directory with one manifest per tool where several tools share it, and the plugin
   `name` and marketplace `name` the same on every tool, so the install id reads alike. Skills
   and hook configuration get guidance here; agents, MCP servers, app connectors and the other
   component kinds appear in the layout trees only, so a request to write one of those is
   outside this skill, and the summary says so rather than improvising one.
4. **Validate.** Read every manifest and catalogue back against the shapes in the target tool's
   reference, then run its local loop: `claude plugin validate`
   and `--plugin-dir` on Claude Code; a local marketplace and `codex plugin add` on Codex;
   `zcode plugins validate`; `agy plugin validate --strict`; a restart with the plugin in
   `.opencode/plugins/` on opencode. Then confirm in a fresh session that each bundled skill is
   listed with its description intact, and that each hook fires on the event it is for. A
   target tool not installed on this machine gets a read-back of its manifest against the
   reference only, and the summary names it as unvalidated there. A skill changed along the
   way takes the review its own change earns.
5. **Summarise** what changed, what was validated on which tool, each default taken in place
   of an answer, and what remains uncertain.

## Hooks

A hook turns an instruction the model might skip into a gate it cannot. Name the failure a hook
prevents before adding one, keep what a plugin depends on to the events every target tool
fires, and prefer a guard that denies through the tool's decision mechanism over one that only
warns. `references/tool-hooks.md` gives each tool's events, handler shape, protocol and trust
step, and the skill-scoped hooks Claude Code allows.

## Workspace

Author the plugin in place, in its repository. Anything transient — the unchanged copy of a
plugin being changed, scratch tool homes for an install test, probe transcripts — goes in a
per-task directory you create with `mktemp -d` and delete when the task ends. Run an install
test against a scratch home where the tool allows it, so the user's own tool setup is left as
it was.

## Checklist

Final-state assertions:

- [ ] whether a plugin is warranted was settled at intake
- [ ] each target tool's manifest validates or reads back clean against its reference
- [ ] plugin and marketplace names agree across tools; each catalogue entry names its plugin
- [ ] each bundled skill loads from a fresh session with its description intact
- [ ] each hook fires on its event, and the install notes name any trust step users must take
