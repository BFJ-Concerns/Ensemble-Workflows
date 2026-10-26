# Plugins on Codex

A Codex plugin bundles skills, MCP servers, hooks, and app connectors under a manifest, and
is installed from a marketplace catalogue in a repository or a local directory. Checked
against Codex CLI 0.162.1 and OpenAI's plugin documentation; the CLI (`codex plugin --help`)
is the first source of truth when they disagree.

## Layout

```
my-plugin/
├── .codex-plugin/
│   └── plugin.json          # the Codex manifest
├── skills/
│   └── <name>/
│       ├── SKILL.md
│       └── agents/openai.yaml   # optional per-skill interface and policy
├── .mcp.json                # optional: {"mcpServers": {...}}
├── .app.json                # optional: {"apps": {...}} for registered MCP app mappings
├── hooks/
│   └── hooks.json           # optional lifecycle hooks (see hooks.md)
├── scripts/
└── assets/                  # icons, logos, screenshots referenced by the interface block
```

Only `plugin.json` goes inside `.codex-plugin/`; every other resource stays at the root. The
portable form of the same package puts `plugin.json` and `mcp.json` at the root instead
(schema `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`), with the Codex-specific
settings under `extensions["com.openai"]`; a root manifest with that block replaces the
`.codex-plugin/` overlay entirely rather than merging with it. The scaffold Codex's own
plugin creator writes uses the `.codex-plugin/` form, and that is the form to author unless
publishing to the public directory demands the portable one.

## Manifest

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What the plugin provides",
  "author": { "name": "Your Name" },
  "homepage": "https://…",
  "repository": "https://…",
  "license": "MIT",
  "keywords": ["discovery", "tags"],
  "skills": "./skills/",
  "interface": {
    "displayName": "My Plugin",
    "shortDescription": "One line shown in the directory",
    "longDescription": "A paragraph on what it does and when to use it.",
    "developerName": "Your Name",
    "category": "Developer Tools",
    "capabilities": ["Read", "Write"],
    "defaultPrompt": ["A request a user might type to start.", "Another."]
  }
}
```

- `name` is the stable identifier (kebab-case) and the component namespace.
- `skills` names the directory to scan; the scaffold sets `"./skills/"` and skill folders not
  on that path are not discovered. Paths start with `./` and stay inside the plugin root.
- `hooks` may name a file, several files, or inline hook objects; an explicit value
  *replaces* `hooks/hooks.json` rather than adding to it.
- `interface` carries presentation for the plugins directory: the fields above plus
  `brandColor` (hex), `logo` and `composerIcon` (image paths under `./assets/`),
  `screenshots`, `websiteURL`, `privacyPolicyURL`, `termsOfServiceURL`. Keep
  `shortDescription` and `defaultPrompt` consistent with the bundled skills' descriptions.
- MCP servers are declared in `.mcp.json` under `mcpServers`. Writing a server, its transport,
  or its authentication is outside this skill; the vendor's plugin documentation owns it.
- Field names are case-sensitive.

## Marketplace

Codex reads marketplace catalogues from `$REPO_ROOT/.agents/plugins/marketplace.json` (per
repository), `~/.agents/plugins/marketplace.json` (personal), and, for compatibility,
`$REPO_ROOT/.claude-plugin/marketplace.json`.

```json
{
  "name": "my-marketplace",
  "interface": { "displayName": "My Plugins" },
  "plugins": [
    {
      "name": "my-plugin",
      "source": { "source": "local", "path": "./plugins/my-plugin" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Developer Tools"
    }
  ]
}
```

- `name` is required and is the `@marketplace` half of every install id.
- Every entry needs `name`, `source`, `policy.installation` (`AVAILABLE`,
  `INSTALLED_BY_DEFAULT`, or `NOT_AVAILABLE`), `policy.authentication` (`ON_INSTALL` or on
  first use), and `category`. An entry missing one is skipped, not fatal to the catalogue.
- `source.path` is relative to the marketplace root (the repository or directory root), not
  to `.agents/plugins/`.
- When a repository also carries a Claude Code catalogue at `.claude-plugin/marketplace.json`,
  Codex reads that too, but its entries lack `policy` and `category` and are skipped. Which
  file wins when both list the same plugin is undocumented, so give Codex its own complete
  catalogue and keep the two in step; `references/plugins-claude-code.md` (*One repository,
  both tools*) shows the combined tree. Other source types: `url` (a repository whose root is the plugin),
  `git-subdir` (`url`, `path`, `ref` or `sha`), `npm` (`package`, optional `version`,
  `registry`).

## Install and enable

```bash
codex plugin marketplace add owner/repo          # GitHub shorthand; owner/repo@ref or --ref pins
codex plugin marketplace add <git URL>           # HTTPS or SSH; --sparse PATH for a subdirectory
codex plugin marketplace add ./local-marketplace # a local directory
codex plugin marketplace list | upgrade [name] | remove <name>
codex plugin list                                # plugins the configured marketplaces offer
codex plugin add my-plugin@my-marketplace        # or: codex plugin add my-plugin --marketplace my-marketplace
codex plugin remove my-plugin@my-marketplace
```

In a session, `/plugins` browses configured marketplaces and installs. For every source type,
local paths included, `codex plugin add` copies the plugin into
`~/.codex/plugins/cache/<marketplace>/<plugin>/<manifest version>/`. Sessions load the bundled
skills from that cache, listing each as `<plugin>:<name>`.

Enablement is recorded in `config.toml`, keyed by install id:

```toml
[plugins."my-plugin@my-marketplace"]
enabled = true
```

User choices live in `~/.codex/config.toml`; a trusted project's `.codex/config.toml` can set
the same key and overrides the user setting. `enabled = false` disables without uninstalling.
Per-server policy for a plugin's MCP servers sits under
`[plugins."my-plugin".mcp_servers.<server>]`.

A plugin's skills and tools become available only in a **new** session or chat after install.

## Test locally

1. Put the plugin under a directory that holds a marketplace file listing it with a `local`
   source, or point the repository's own `.agents/plugins/marketplace.json` at it.
2. `codex plugin marketplace add ./that-directory`, then `codex plugin add <plugin>@<marketplace>`.
3. Start a fresh `codex` session. `/skills` should list each bundled skill as
   `<plugin>:<name>` with its description intact; the user names it by that listed name.
4. If the plugin carries hooks, review and trust them with `/hooks` — enabling a plugin does
   not trust its hooks, and untrusted hooks are skipped silently.
5. After editing the source, `codex plugin remove <plugin>@<marketplace>` then `codex plugin
   add <plugin>@<marketplace>` again, and start a fresh session: the install is a copy taken
   at `add`, so a listing or probe run without this step exercises the pre-edit text.
   `codex plugin marketplace upgrade <name>` refreshes Git marketplace snapshots only and
   refuses a local-path marketplace.

Codex ships no validator for plugin files, so read the manifest and marketplace back against
the shapes above, and treat a skill missing from `/skills` as a layout or `skills` path
problem first.

## Gotchas

- Hooks are manual-install only on Codex desktop, not trusted by default, and a plugin that
  carries them is not eligible for the public directory; hook scripts must exist locally,
  so a web install does not deploy them.
- Hook commands may use `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`; `CLAUDE_PLUGIN_ROOT` and
  `CLAUDE_PLUGIN_DATA` are also set for compatibility. No substitution of these variables in a
  skill body is documented for Codex, so a skill body refers to its bundled files by paths
  relative to the skill directory.
- Submission to the public directory has requirements of its own (a remote MCP endpoint among
  them) that this skill does not cover.
- Workspace-managed plugins ignore the local `enabled` setting; admins control them.
- Plugins are not supported in the IDE extension.
