import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { isRunScopedEnvironmentVariable } from "../../src/ambient-settings.js";
import type { WorkflowHooks } from "../../src/hooks.js";
import type { AgentOptions, EngineName, LiteralWorkerSessionOptions } from "../../src/types.js";

// The skill's text ships beside the launcher it describes. These tests hold
// what a machine can check of that: the text loads on each tool, and every
// flag, variable, engine, option and hook it names is one this launcher has.
// What the text teaches is prose, and is not judged here.

const skillDirectory = "plugin/skills/ensemble-workflow";
const launcherPath = path.join(skillDirectory, "scripts/ensemble.mjs");
const referenceNames = readdirSync(path.join(skillDirectory, "references")).sort();
const skillFile = readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
const pages = new Map<string, string>([
  ["SKILL.md", skillFile],
  ...referenceNames.map((name): [string, string] => [
    `references/${name}`,
    readFileSync(path.join(skillDirectory, "references", name), "utf8")
  ])
]);
const wholeText = [...pages.values()].join("\n");
const page = (name: string): string => {
  const text = pages.get(name);
  assert.ok(text !== undefined, `the skill has no ${name}`);
  return text;
};

// Each record must name every member of its type to compile, so an engine,
// option or hook added to the runtime fails the build here until the skill
// is checked for it.
const engines = Object.keys({
  codex: true, claude: true, opencode: true, agy: true, zcode: true
} satisfies Record<EngineName, true>);
const agentOptions = Object.keys({
  engine: true, target: true, schema: true, model: true, effort: true, fallback: true, cwd: true,
  isolation: true, timeoutMs: true, maxAttempts: true, label: true, phase: true, identity: true,
  strip: true, lean: true
} satisfies Record<keyof AgentOptions, true>);
const sessionOptions = Object.keys({
  engine: true, target: true, model: true, effort: true, fallback: true, cwd: true,
  isolation: true, timeoutMs: true, maxAttempts: true, label: true, phase: true,
  strip: true, lean: true, identity: true, stalenessMark: true
} satisfies Record<keyof LiteralWorkerSessionOptions, true>);
const hooks = Object.keys({
  agent: true, session: true, hold: true, workflow: true, parallel: true, pipeline: true, phase: true,
  log: true, tally: true, lookupDispatch: true, budget: true, worktrees: true, args: true
} satisfies Record<keyof WorkflowHooks, true>);

const flagPattern = /(?<![\w/-])--[a-z][a-z0-9-]*/g;
const flagsIn = (text: string): Set<string> => new Set(text.match(flagPattern) ?? []);

function launcherHelp(): string {
  return [[], ["agent"], ["workflows"], ["holds"], ["holds", "answer"]].map((command) => {
    const result = spawnSync(process.execPath, [launcherPath, ...command, "--help"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${command.join(" ")} --help: ${result.stderr}`);
    return result.stdout;
  }).join("\n");
}

function frontmatter(): Map<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(skillFile);
  assert.ok(match, "SKILL.md opens with a frontmatter block on its first line");
  return new Map(match[1]!.split("\n").map((line): [string, string] => {
    const colon = line.indexOf(":");
    assert.ok(colon > 0, `frontmatter line is not "key: value": ${line}`);
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
}

function interfaceField(name: string): string {
  const yaml = readFileSync(path.join(skillDirectory, "agents/openai.yaml"), "utf8");
  const match = new RegExp(`^  ${name}: "(.+)"$`, "m").exec(yaml);
  assert.ok(match, `agents/openai.yaml has no interface.${name}`);
  return match[1]!;
}

test("the skill has the frontmatter required by Claude Code, Codex and opencode", () => {
  const fields = frontmatter();
  // Codex requires both keys, and lists the skill by `name`; opencode does
  // not advertise a skill that has no description.
  assert.equal(fields.get("name"), path.basename(skillDirectory));
  const description = fields.get("description") ?? "";
  assert.ok(description.length > 0, "description is empty");
  // The description is a single-line plain YAML scalar.
  const indicators = "-?:,[]{}#&*!|>'\"%@`";
  assert.ok(!indicators.includes(description[0]!), "description starts with a YAML indicator");
  assert.doesNotMatch(description, /:(?:[ \t]|$)|[ \t]#/, "description contains a YAML mapping or comment marker");
  // Claude Code cuts a listed description off at 1,536 characters.
  assert.ok(description.length <= 1536, `description is ${description.length} characters`);
});

test("nothing in SKILL.md is rewritten or run when Claude Code loads it", () => {
  // Claude Code runs a backtick-wrapped command that follows an exclamation
  // mark, and substitutes argument placeholders, before the model reads the body.
  assert.doesNotMatch(skillFile, /(^|\s)!`/m);
  assert.doesNotMatch(skillFile, /\$ARGUMENTS|\$\d/);
  assert.doesNotMatch(wholeText, /\$\{CLAUDE_[A-Z_]+\}/, "only Claude Code substitutes its plugin variables");
});

test("every file the skill links to ships with it, and every reference is linked from SKILL.md", () => {
  for (const [name, text] of pages) {
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(target!)) continue;
      const resolved = path.join(skillDirectory, path.dirname(name), target!);
      assert.ok(existsSync(resolved), `${name} links to ${target}, which the skill does not hold`);
    }
  }
  for (const name of referenceNames) {
    assert.ok(skillFile.includes(`](references/${name})`), `SKILL.md never links references/${name}`);
  }
});

test("the skill runs the launcher by its path and teaches no command on PATH", () => {
  assert.ok(existsSync(launcherPath));
  assert.ok(skillFile.includes("`scripts/ensemble.mjs`"), "SKILL.md says where the launcher is");
  const shellLines = [...wholeText.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap(([, block]) => block!.split("\n"));
  assert.ok(shellLines.some((line) => line.startsWith("node <launcher> ")));
  for (const line of shellLines) {
    assert.doesNotMatch(line, /^\s*ensemble(\s|$)/, `a command runs a bare ensemble: ${line}`);
  }
});

test("the flags the skill names and the flags the launcher's help names are the same", () => {
  // Flags of other tools that the text names when it explains an engine.
  const otherTools = new Set(["--dangerously-skip-permissions"]);
  const offered = flagsIn(launcherHelp());
  const named = flagsIn(wholeText);
  assert.deepEqual([...named].filter((flag) => !offered.has(flag) && !otherTools.has(flag)), [], "named by the skill, unknown to the launcher");
  assert.deepEqual([...offered].filter((flag) => !named.has(flag)), [], "offered by the launcher, absent from the skill");
});

test("the launcher reports the package version", () => {
  const result = spawnSync(process.execPath, [launcherPath, "--version"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  assert.equal(result.stdout.trim(), version);
});

test("every ENSEMBLE_ variable the skill names is a run setting", () => {
  const named = new Set(wholeText.match(/ENSEMBLE_[A-Z0-9_]+/g) ?? []);
  assert.ok(named.size > 0);
  const concurrencyPrefix = "ENSEMBLE_CONCURRENCY_";
  const concurrencySettings = new Set(engines.map((engine) => `${concurrencyPrefix}${engine.toUpperCase()}`));
  // The runtime withholds the entire concurrency namespace from child
  // processes. Only the known engines have settings in that namespace.
  const unknown = [...named].filter((variable) => variable.startsWith(concurrencyPrefix)
    ? !concurrencySettings.has(variable)
    : !isRunScopedEnvironmentVariable(variable));
  assert.deepEqual(unknown, [], "named by the skill, unknown as a run setting");
});

test("the skill covers every engine, agent() option and script hook the runtime has", () => {
  const engineTable = /\n## Engines\n([\s\S]*?)\n## /.exec(skillFile)?.[1] ?? "";
  const engineReference = page("references/engines.md");
  for (const engine of engines) {
    assert.ok(engineTable.includes(`| \`${engine}\` |`), `SKILL.md's engine table has no row for ${engine}`);
    assert.ok(engineReference.includes(`\n## \`${engine}\`\n`), `references/engines.md has no section for ${engine}`);
  }
  const scriptApi = page("references/script-api.md");
  const optionTable = /\n## `agent\(\)` options\n([\s\S]*?)\n## /.exec(scriptApi)?.[1] ?? "";
  for (const option of agentOptions) {
    assert.match(optionTable, new RegExp(`^\\|[^|]*\`${option}\`[^|]*\\|`, "m"), `the agent() option table has no row for ${option}`);
  }
  const references = referenceNames.map((name) => page(`references/${name}`)).join("\n");
  const hookTable = /\nThe hooks a body can call:\n([\s\S]*?)\n\n[A-Z]/.exec(skillFile)?.[1] ?? "";
  for (const hook of hooks) {
    assert.match(hookTable, new RegExp(`^\\|[^|]*\`${hook}[\`(]`, "m"), `SKILL.md's hook table has no row for ${hook}`);
    assert.match(references, new RegExp(`\`${hook}[\`(.]`), `no reference names ${hook}`);
  }
});

test("the skill names every session() creation option", () => {
  const reference = page("references/sessions-and-holds.md");
  const creationOptions = /^- \*\*Fixed at creation:\*\* ([\s\S]*?)(?=^- )/m.exec(reference)?.[1] ?? "";
  for (const option of sessionOptions) {
    assert.ok(creationOptions.includes(`\`${option}\``), `references/sessions-and-holds.md omits the session() creation option ${option}`);
  }
});

test("the skill names nothing that belongs to one machine", () => {
  const product = JSON.parse(readFileSync("package.json", "utf8")) as { homepage: string };
  const ownUrls = ["https://json-schema.org/", new URL(product.homepage).origin + new URL(product.homepage).pathname];
  for (const [url] of wholeText.matchAll(/https?:\/\/[^\s"'`)>]+/g)) {
    assert.ok(ownUrls.some((own) => url.startsWith(own)), `the skill names the address ${url}`);
  }
  assert.doesNotMatch(wholeText, /(^|[\s`"'(=:])\/(home|Users|mnt|srv)\//m, "a path on one machine");
  assert.doesNotMatch(wholeText, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, "a network address");
});

test("Codex's listing of the plugin and of its skill make one promise", () => {
  const manifest = JSON.parse(readFileSync("plugin/.codex-plugin/plugin.json", "utf8")) as {
    interface: { shortDescription: string; defaultPrompt: string[] };
  };
  assert.equal(manifest.interface.shortDescription, interfaceField("short_description"));
  assert.ok(interfaceField("display_name").length > 0);
  // The skill's own prompt opens by naming the skill, which a plugin's
  // starter prompt has no need to; the request after it is the same.
  const prefix = `Use $${path.basename(skillDirectory)} to `;
  const skillPrompt = interfaceField("default_prompt");
  assert.ok(skillPrompt.startsWith(prefix), skillPrompt);
  const request = skillPrompt.slice(prefix.length);
  assert.deepEqual(manifest.interface.defaultPrompt, [request[0]!.toUpperCase() + request.slice(1)]);
});
