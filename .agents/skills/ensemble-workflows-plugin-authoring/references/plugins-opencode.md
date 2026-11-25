# opencode Plugins

Facts here were read from opencode 1.18.4's source and its bundled documentation. Confirm
anything load-bearing against the installed version: the current website describes a newer
surface (plural `plugins`, `plugin add/list/update/remove`) than 1.18.4 has.

## What a plugin is

An opencode plugin is code, not a bundle of components: a JavaScript or TypeScript module whose
exported async function receives the client, the project, its directories and a Bun shell, and
returns callbacks (`references/tool-hooks.md`, *opencode*). A plugin can register tools,
provider and authentication integrations, and a `config` callback that sees the merged
configuration. It has no `skills/`, `agents/` or `hooks.json` loader, so a plugin built for
Claude Code or Codex does not load in opencode. Skills reach opencode as skills: it reads
`.opencode/skills`, `.claude/skills` and `.agents/skills` (`references/skill-contracts.md`).

## Where plugins load from

- Local files load on their own from the project's `.opencode/plugin/` or `.opencode/plugins/`,
  and the same directories under `.config/opencode/` in the user's home directory.
- A configured plugin is listed under the singular `plugin` key of the opencode config, as an
  npm specifier, a path, or a `[specifier, options]` pair:

```json
{ "plugin": ["<package>@<version>", "./plugins/<file>.ts", ["<package>", { "<option>": "<value>" }]] }
```

A relative path resolves against the config file that declares it.

## Packaging

A single file needs no manifest. A packaged plugin is an npm package whose `package.json`
names the server entry point in `exports["./server"]` or `main` (a terminal-UI entry point in
`exports["./tui"]`), and may constrain compatibility with `engines.opencode`. A local directory
without a `package.json` resolves an `index.ts`, `.tsx`, `.js`, `.mjs` or `.cjs`. A module
exporting a default object with `server()` needs an `id` when loaded from a local path; a
package's `name` serves as its id otherwise.

## Install and test

```sh
opencode plugin <module>            # add to the project's config
opencode plugin <module> --global   # add to the user's config
opencode plugin <module> --force    # replace the configured version
```

There is no list, update or remove subcommand in 1.18.4: remove a plugin by deleting its
config entry or its file. `opencode --pure` runs without external plugins, which isolates a
fault to one. Distribution is through npm, and opencode installs a configured package with Bun.

The quickest loop is a file in the project's `.opencode/plugins/`, with opencode restarted after
each edit: plugin and config files are not reloaded while it runs.
