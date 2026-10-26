# Plugins on Claude Code

A plugin is a directory of components — skills, agents, hooks, MCP servers, and more — with a
manifest at `.claude-plugin/plugin.json`. Claude Code loads it as one unit, namespaces its
skills and agents under the plugin name, and installs it from a marketplace or straight from
disk. Checked against Claude Code 2.1.296; confirm with `claude plugin validate` and the
installed CLI's `--help` before leaning on a detail.

## Layout

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # the manifest; no components go in here
├── skills/
│   └── <name>/SKILL.md      # one directory per skill
├── agents/
│   └── reviewer.md          # one Markdown file per subagent
├── hooks/
│   └── hooks.json           # {"hooks": {...}} — same shape as settings hooks
├── .mcp.json                # MCP server definitions
├── bin/                     # on the Bash tool's PATH while the plugin is enabled
└── scripts/                 # anything hooks or skills call
```

Add only the directories you use. `.claude-plugin/` holds the manifest and, when the plugin
root is also a marketplace root, `marketplace.json`; components saved inside it do not load. A
`CLAUDE.md` at the plugin root is not loaded as context and draws a validator warning; put
instructions in a skill instead. A plugin whose root holds a `SKILL.md`, with no `skills/`
and no `skills` key, loads as a single skill.

Skills and agents are namespaced: skill `hello` in plugin `my-plugin` runs as
`/my-plugin:hello`, and the agent `reviewer` appears as `my-plugin:reviewer`. Hooks carry no
prefix, so a hook present in both a settings file and the plugin runs twice.

## Manifest

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What the plugin provides, as shown in /plugin",
  "author": { "name": "Your Name", "email": "optional", "url": "optional" },
  "homepage": "https://…",
  "repository": "https://…",
  "license": "MIT",
  "keywords": ["discovery", "tags"]
}
```

- `name` is the only required key: kebab-case, no spaces, `@`, `:`, or path separators. It
  becomes the namespace prefix. Names that pass as Anthropic's own are refused by the
  validator (starting `claude-`, `anthropic-`, `cc-plugin-`; `claude`, `claude-code`;
  `official` beside `claude` or `anthropic`), and a name containing `claude` or `anthropic`
  as a whole word elsewhere draws a warning.
- `version` is a free string, not checked as semver. Setting it pins installers to that
  version until you change it; omit it while a marketplace is being developed locally.
- `homepage` must parse as a URL or the plugin fails to load; `repository` is not validated.
- Component keys (`skills`, `agents`, `hooks`, `mcpServers`, `commands`, `outputStyles`,
  `lspServers`) point components outside their default directories. Every such path is
  relative to the plugin root, must start with `./`, must exist, and must stay inside the
  root. `skills` *adds* to the default `skills/` scan; `agents` and `commands` *replace*
  theirs; `hooks` and `mcpServers` *merge* with `hooks/hooks.json` and `.mcp.json`.
- `userConfig` declares values Claude Code prompts the user for on enable, referenced as
  `${user_config.KEY}` in MCP config and exported to hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`.
- Unknown top-level keys are stripped with a warning; unknown keys inside `userConfig`,
  `lspServers`, `channels`, or monitor entries are errors.

`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's installed directory in hook commands, MCP
config, and skill bodies; use it for every bundled script path. It changes on update, so state
goes in `${CLAUDE_PLUGIN_DATA}` instead. These variables are not in the environment of
commands the model runs through Bash; write the `${…}` reference in the skill body and Claude
Code substitutes it at load.

## Validate and load locally

```bash
claude plugin validate ./my-plugin          # plugin root: manifest + every skill, agent, command frontmatter
claude plugin validate ./my-marketplace     # marketplace root: catalogue + each relative-path plugin
claude plugin validate ./skills             # a folder of standalone skills: frontmatter only (a bare skill directory is refused)
claude plugin validate --strict ./my-plugin # warnings fail too; use in CI
claude --plugin-dir ./my-plugin             # load for one session, nothing written to settings
claude plugin init my-tool                  # scaffold at ~/.claude/skills/my-tool/, auto-loads every session as my-tool@skills-dir
```

- `--plugin-dir` takes the plugin root (the directory holding `.claude-plugin/`), repeats for
  several plugins, accepts a `.zip`, and from v2.1.265 accepts a folder of plugins (each
  subfolder with its own manifest loads; a marketplace root is *not* read this way).
- `CLAUDE_CODE_PLUGIN_DIRS` lists absolute paths for sessions where the flag cannot be passed.
- In a session, `/reload-plugins` applies edits made on disk; `/plugin` shows the Installed
  tab's component inventory and the Errors tab's load failures.
- Any folder under `~/.claude/skills/` that contains a `.claude-plugin/plugin.json` loads as a
  plugin in every session with no install step. The same layout at
  `<project>/.claude/skills/<name>/` loads for everyone in that repository. A root `SKILL.md`
  in such a plugin is also a personal skill, invoked as `/<name>` rather than `/<name>:<name>`.
- `claude plugin details <name>` prints the component inventory and a projected token cost.

## Marketplace

A marketplace is a repository or directory holding `.claude-plugin/marketplace.json`. It is a
catalogue, not a store: users add it once and install plugins from it by name.

```json
{
  "name": "my-marketplace",
  "description": "Plugins for my team",
  "owner": { "name": "Your Name" },
  "plugins": [
    {
      "name": "my-plugin",
      "source": "./plugins/my-plugin",
      "description": "Shown beside the plugin in /plugin"
    }
  ]
}
```

- `name`, `owner`, and `plugins` are required; each entry needs `name` and `source`.
- A relative `source` is written from the marketplace root (the directory containing
  `.claude-plugin/`), never from inside it, and may not contain `..`. A plugin held elsewhere
  uses a source object: `{"source": "github", "repo": "org/repo"}`, `{"source": "git-subdir",
  "url": "org/monorepo", "path": "tools/my-plugin"}`, or `url`, `archive`, `npm`, `command`;
  git sources take `ref` or `sha` to pin.
- The entry `name` must equal the manifest `name`. The entry name is the install id and the
  `enabledPlugins` key; the manifest name is the namespace prefix. When they differ,
  installing by the manifest name fails with "not found in marketplace".
- An entry may carry any manifest field; with the default `strict: true` its components are
  appended to the manifest's, and its `displayName` and `defaultEnabled` override the
  manifest's while the manifest's `version` wins.
- Reserved marketplace names (`claude-plugins-official` and the other Anthropic names) pass
  validation but are refused when added.

The loop, run from the marketplace's parent directory:

```bash
claude plugin validate ./my-marketplace                 # JSON, required fields, each relative-path plugin
claude plugin marketplace add ./my-marketplace          # or owner/repo, or a git URL once hosted
claude plugin install my-plugin@my-marketplace          # entry name @ marketplace name
claude plugin list                                      # Status: ✔ enabled
claude plugin marketplace remove my-marketplace         # removes it and uninstalls its plugins
```

In a session: `/plugin marketplace add <source>`, then `/plugin install <plugin>@<marketplace>`
opens the plugin's details for installing. A marketplace added from a local path reads the
plugin files in place, so edits apply at the next session or `/reload-plugins` without a
version change; users of a hosted marketplace get a cached copy and receive updates by the
marketplace's versioning. Codex also caches local sources; refresh its copy after each edit
(`references/plugins-codex.md`, *Test locally*).

## One repository, both tools

A repository can publish the same plugin to Claude Code and Codex: one plugin directory with
both manifests beside a shared `skills/`, and one catalogue per tool at the repository root.

```
repo/
├── .claude-plugin/
│   └── marketplace.json         # Claude Code catalogue; entry source "./plugins/my-plugin"
├── .agents/plugins/
│   └── marketplace.json         # Codex catalogue; source {"source": "local", "path": "./plugins/my-plugin"}
└── plugins/my-plugin/
    ├── .claude-plugin/plugin.json
    ├── .codex-plugin/plugin.json
    ├── skills/<name>/SKILL.md   # plus agents/openai.yaml per skill for Codex
    └── hooks/hooks.json         # if any; same shape on both tools
```

Both catalogues use the same marketplace `name` and plugin `name`, so the install id
`my-plugin@repo-name` reads the same on both tools. The plugin may instead sit at the
repository root, in which case `.claude-plugin/` holds both `plugin.json` and
`marketplace.json` and the Claude entry's `source` is `"./"`. Codex also reads
`.claude-plugin/marketplace.json` for compatibility but skips entries without its required
fields; `references/plugins-codex.md` (*Marketplace*) covers the Codex side.

## Install scopes and updates

Installing picks a scope: **user** (every project on this machine), **project** (committed
`.claude/settings.json`; each collaborator still installs locally), or **local** (this
repository, this user). Plugins load at startup; an enabled plugin is part of every session,
and each invocable skill's and agent's name and description cost context on every turn, so
weigh what a plugin adds before bundling marginal components. A cloud session does not load
local plugins.

## Evals

`claude plugin eval <path|name|plugin@marketplace>` runs a suite of cases with and without the
plugin and scores the difference. Cases live under `evals/` (or `experimental.evals` in the
manifest): one directory per case holding `prompt.md` (frontmatter `max_turns`,
`timeout_seconds`, `allowed_tools`, `model`; body is the user's request, phrased as a user
would type it, never naming the skill) and `graders/<name>.md`, each with a `type` of `llm`
(a PASS/FAIL rubric in the body), `regex`, `tool_used` (for example `tool: Skill` with an
`input_match` naming the skill), `tool_order`, `file_exists`, or `baseline`. `claude plugin
eval init` proposes and writes a suite; `--bare <case>` writes an empty template. Each run
starts in an empty working directory, so the prompt or a `case.yaml` setup supplies what the
task needs. Pair one grader on the result with one on the path (`tool_used`) so a case shows
both that the answer was right and that the plugin produced it. Keep `results/` out of git.

## Gotchas

- `.claude-plugin/` holds `plugin.json` (and `marketplace.json` at a marketplace root); every
  component lives at the plugin root.
- `--plugin-dir` at a marketplace root loads nothing and reports no error.
- A component path that does not exist loads nothing: the Errors tab shows
  `<component> path not found`.
- A `hooks` *file* wraps its event map in a top-level `"hooks"` key; an inline `hooks` object
  in the manifest is the bare event map. Mixing the two shapes fails to load.
- The `userConfig` dialog appears only when installing through `/plugin`; with `--plugin-dir`
  run `/plugin configure <name>`.
- Quote `${CLAUDE_PLUGIN_ROOT}` in shell-form hook commands, or use exec form with `args`.
- claude.ai and Cowork install the same plugin format but a different component subset, and
  refuse a plugin with a `bin/` directory.
