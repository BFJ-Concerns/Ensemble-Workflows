import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// The plugin is the `plugin/` directory: what Claude Code and Codex copy on
// install, and where opencode users link the skill from. Neither Codex nor
// opencode ships a validator, so these tests hold the shapes each tool reads.

const pluginRoot = "plugin";
const skillName = "ensemble-workflow";

type Json = Record<string, unknown>;
const readJson = (name: string): Json => JSON.parse(readFileSync(name, "utf8")) as Json;
const claudeManifest = readJson(path.join(pluginRoot, ".claude-plugin/plugin.json"));
const codexManifest = readJson(path.join(pluginRoot, ".codex-plugin/plugin.json"));
const claudeCatalogue = readJson(".claude-plugin/marketplace.json");
const codexCatalogue = readJson(".agents/plugins/marketplace.json");

test("the Claude Code and Codex manifests describe one plugin", () => {
  assert.match(String(claudeManifest.name), /^[a-z0-9]+(-[a-z0-9]+)*$/);
  for (const key of ["name", "version", "description", "homepage", "repository", "license"]) {
    assert.equal(codexManifest[key], claudeManifest[key], key);
  }
  // Claude Code refuses to load a plugin whose homepage is not a URL.
  assert.doesNotThrow(() => new URL(String(claudeManifest.homepage)));
});

test("each tool's catalogue offers the plugin by its manifest name from the plugin directory", () => {
  assert.equal(codexCatalogue.name, claudeCatalogue.name);

  const claudeEntries = claudeCatalogue.plugins as Json[];
  assert.equal(claudeEntries.length, 1);
  assert.equal(claudeEntries[0]!.name, claudeManifest.name);
  assert.equal(claudeEntries[0]!.source, `./${pluginRoot}`);

  // Codex skips, without an error, an entry that lacks any of these.
  const codexEntries = codexCatalogue.plugins as Json[];
  assert.equal(codexEntries.length, 1);
  const entry = codexEntries[0]!;
  assert.equal(entry.name, codexManifest.name);
  assert.deepEqual(entry.source, { source: "local", path: `./${pluginRoot}` });
  const policy = entry.policy as Json;
  assert.equal(typeof policy.installation, "string");
  assert.equal(typeof policy.authentication, "string");
  assert.equal(typeof entry.category, "string");
});

test("the Codex manifest's skills directory is the one that holds the skill and its launcher", () => {
  const skills = String(codexManifest.skills);
  assert.ok(skills.startsWith("./"), skills);
  const skillDirectory = path.join(pluginRoot, skills, skillName);
  assert.ok(existsSync(path.join(skillDirectory, "scripts/ensemble.mjs")), skillDirectory);
});

test("an install carries the skill and nothing else a tool would load", () => {
  // Either tool loads components by directory name at the plugin root, and
  // Claude Code puts a plugin's `bin/` on the session's PATH; the plugin
  // installs no PATH command, no hooks and no servers.
  assert.deepEqual(readdirSync(pluginRoot).sort(), [".claude-plugin", ".codex-plugin", "skills"]);
  assert.deepEqual(readdirSync(path.join(pluginRoot, "skills")), [skillName]);
  assert.deepEqual(readdirSync(path.join(pluginRoot, ".claude-plugin")), ["plugin.json"]);
  assert.deepEqual(readdirSync(path.join(pluginRoot, ".codex-plugin")), ["plugin.json"]);
});
