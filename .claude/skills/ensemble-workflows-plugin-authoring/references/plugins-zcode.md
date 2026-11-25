# zcode Plugins

Facts here were read from zcode 0.17.1's source and its bundled usage guide; the lifecycle
commands below were read from source, not exercised. Confirm anything load-bearing against the
installed version.

## What a plugin is

A directory bundle that can carry skills, commands, agents, hooks and MCP servers:

```text
<plugin>/
├── .zcode-plugin/plugin.json
├── skills/<name>/SKILL.md
├── commands/<name>.md
├── agents/<name>.md
├── hooks/hooks.json
└── .mcp.json
```

zcode looks for the manifest at `.zcode-plugin/plugin.json`, then `.claude-plugin/plugin.json`,
then `.codex-plugin/plugin.json`, so a plugin already built for Claude Code or Codex needs no
third manifest: validate it here instead of adding one.

## The manifest

Only `name` is required, matching `^[a-z0-9][a-z0-9._-]{0,127}$`; a missing `version` reads as
`0.0.0`. `skills` and `commands` take lists of paths inside the plugin. An explicit `skills` list
replaces discovery of `skills/`, while a `commands` list adds to `commands/`. Hooks combine
`hooks/hooks.json` with any declared in the manifest. `channels`, `lspServers`, `outputStyles`
and `settings` are reported and ignored. A plugin's skills are listed as `<plugin>:<skill>`.

## Install and test

```sh
zcode plugins validate <directory> --json
zcode plugins list [--available] --json
zcode plugins marketplace add <URL|path|GitHub-repo> [--scope user|project]
zcode plugins marketplace list --json
zcode plugins marketplace update [<name>]
zcode plugins marketplace remove <name>
zcode plugins install <plugin>[@<marketplace>] --scope user|project
zcode plugins enable <plugin> --scope user|project
zcode plugins disable <plugin> --scope user|project
zcode plugins update <plugin>
zcode plugins uninstall <plugin> --force [--keep-data]
```

`plugin` is an alias of `plugins`, install defaults to user scope, and an uninstall run without
a terminal needs `--force`. Installed plugins, their cache and data live under
`.zcode/cli/plugins/` in the home directory.

For a plugin under development, point the user config, `.zcode/cli/config.json` in the home
directory, at the plugin's directory, where it loads as `<name>@inline`:

```json
{ "plugins": { "enabled": true, "dirs": ["/absolute/path/to/<plugin>"] } }
```

Then edit, run `zcode plugins validate`, and start a fresh session to check `zcode plugins
list`, `zcode skills list` and `zcode commands list`. A project's `.zcode/config.json` may set
`enabledPlugins` and plugin `options`, but not `dirs`.
