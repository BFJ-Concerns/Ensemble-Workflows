# Antigravity CLI Plugins

Facts here come from the guides bundled with Antigravity CLI 1.5.16 (`agy`) and from running
`agy plugin validate` and a local install in a scratch home. Confirm anything load-bearing
against the installed version.

## What a plugin is

A namespaced bundle that can carry skills, agents, rules, MCP servers and hooks:

```text
<plugin>/
├── plugin.json
├── README.md
├── skills/<name>/SKILL.md
├── agents/<name>.md
├── rules/AGENTS.md
├── hooks.json
├── mcp_config.json
└── assets/logo.svg
```

Only `plugin.json` is required, and it sits at the plugin root, not in a dot-directory. Rules
are always-on plain Markdown; the README is not given to the agent. The hooks file is
`hooks.json` at the root (`references/tool-hooks.md`, *Antigravity CLI*). `agy plugin import`
brings in a Claude Code plugin, staging its `hooks/hooks.json` as the root `hooks.json`.

## The manifest

`plugin.json` takes `name`, `description`, `displayName`, `version`, `author` (a string or
`{ "name", "url" }`), `homepage`, `repository` (a string or `{ "type": "git", "url" }`), `logo`,
`suggestedPrompts` (only three are shown) and `disabled`. Write `name` and strict JSON: the
validator accepts a missing name and JSONC, but install refuses both. `disabled: true` is only a
default, and a fresh install enabled such a plugin anyway.

## Where plugins load from

The project's `.agents/plugins/` and `.gemini/config/plugins/` in the user's home directory,
plus any declared in a `plugins.json` (`entries`, each with a `path` and optional
`include_only` or `exclude`).
Enablement overrides sit in `.gemini/config/config.json` in the home directory:

```json
{ "plugins": { "<plugin-directory-name>": { "enabled": false } } }
```

## Install and test

```sh
agy plugin validate [<target>] [--strict] [--json]
agy plugin list [--json]
agy plugin install <target>
agy plugin import [<source>]
agy plugin enable <name>
agy plugin disable <name>
agy plugin uninstall <name>
agy plugin link <marketplace> <target>
```

`install` copies a local directory into the user's plugin directory, so an edit to the source
needs a reinstall; there is no `update` subcommand. `validate` takes a directory, a manifest, a
ZIP, an HTTPS ZIP URL, a GitHub repository or subfolder, or a marketplace, but install has not
been seen to take all of those. The quickest loop is a plugin directory under the project's
`.agents/plugins/`, checked with `agy plugin validate <path> --strict`; the guides describe its
skills as available from the next turn, and `/skills reload` as the refresh.
