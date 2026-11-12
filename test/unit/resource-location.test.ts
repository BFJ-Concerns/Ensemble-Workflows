import assert from "node:assert/strict";
import test from "node:test";

import { launchEnvironment, writtenEnvironment } from "../../src/engine-environment.js";
import {
  declaredDirectory,
  defaultDirectory,
  fixedDirectory,
  readSetting,
  settingToChange
} from "../../src/resource-location.js";

test("a reading keeps the value as written and records a base only for a relative value", () => {
  assert.deepEqual(readSetting("CODEX_HOME", "state/codex", "/work"), {
    setting: "CODEX_HOME", value: "state/codex", resolvedAgainst: "/work"
  });
  assert.deepEqual(readSetting("CODEX_HOME", "/srv/codex", "/work"), {
    setting: "CODEX_HOME", value: "/srv/codex", resolvedAgainst: null
  });
});

test("a declared directory is the reading's value against its base, and its own setting moves it", () => {
  const relative = declaredDirectory(readSetting("XDG_DATA_HOME", "data", "/placed/worker"), "opencode");
  assert.equal(relative.path, "/placed/worker/data/opencode");
  assert.deepEqual(relative.location, {
    kind: "declared", reading: { setting: "XDG_DATA_HOME", value: "data", resolvedAgainst: "/placed/worker" }
  });
  assert.equal(settingToChange(relative.location), "XDG_DATA_HOME");

  const absolute = declaredDirectory(readSetting("XDG_DATA_HOME", "/srv/data", "/placed/worker"), "opencode");
  assert.equal(absolute.path, "/srv/data/opencode");
});

test("a default directory names the setting that would place it, and the reading its rule starts from", () => {
  const chosen = { rule: "$HOME/.codex", movedBy: "CODEX_HOME" };
  const fromHome = defaultDirectory(chosen, readSetting("HOME", "home", "/run/base"), ".codex");
  assert.equal(fromHome.path, "/run/base/home/.codex");
  assert.deepEqual(fromHome.location, {
    kind: "default", rule: "$HOME/.codex", movedBy: "CODEX_HOME",
    from: { setting: "HOME", value: "home", resolvedAgainst: "/run/base" }
  });
  assert.equal(settingToChange(fromHome.location), "CODEX_HOME");

  const builtIn = defaultDirectory({ rule: "/tmp", movedBy: "TMPDIR" }, "/tmp");
  assert.equal(builtIn.path, "/tmp");
  assert.deepEqual(builtIn.location, { kind: "default", rule: "/tmp", movedBy: "TMPDIR", from: null });
});

test("a fixed directory has no setting to change", () => {
  const fixed = fixedDirectory("/tmp/cc-daemon-<uid>/<config hash>", "/tmp/cc-daemon-1000/31fe4a63");
  assert.equal(fixed.path, "/tmp/cc-daemon-1000/31fe4a63");
  assert.deepEqual(fixed.location, { kind: "fixed", rule: "/tmp/cc-daemon-<uid>/<config hash>" });
  assert.equal(settingToChange(fixed.location), null);
});

test("the written environment keeps a relative Claude config directory that the launch makes absolute", () => {
  const declared = { CLAUDE_CONFIG_DIR: "relative-home" };
  const inherited = { HOME: "/home/someone", ENSEMBLE_RUN_RECORD_DIR: "/records" };
  const written = writtenEnvironment("claude", declared, inherited);
  assert.deepEqual(written, { HOME: "/home/someone", CLAUDE_CONFIG_DIR: "relative-home" });
  const launched = launchEnvironment("claude", declared, inherited);
  assert.equal(launched.CLAUDE_CONFIG_DIR, `${process.cwd()}/relative-home`);
  assert.equal(launched.HOME, written.HOME);
  assert.equal(launched.ENSEMBLE_RUN_RECORD_DIR, undefined);
});

test("the written environment of the other engines is the launch environment", () => {
  const declared = { CODEX_HOME: "relative-home" };
  const inherited = { HOME: "/home/someone", ENSEMBLE_RUN_RECORD_DIR: "/records" };
  assert.deepEqual(writtenEnvironment("codex", declared, inherited), launchEnvironment("codex", declared, inherited));
  assert.deepEqual(writtenEnvironment("opencode", declared, inherited), launchEnvironment("opencode", declared, inherited));
});
