import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AmbientConfigError, resolveStatusDir } from "../../src/ambient-settings.js";

test("resolveStatusDir prefers an existing .claude directory and otherwise uses the data home", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-status-config-"));
  try {
    const env = { XDG_CONFIG_HOME: path.join(cwd, "config"), XDG_DATA_HOME: path.join(cwd, "data") };
    assert.equal(resolveStatusDir(env, cwd), path.join(cwd, "data", "ensemble", "status"));

    const localClaude = path.join(cwd, ".claude");
    await mkdir(localClaude);
    assert.equal(resolveStatusDir(env, cwd), localClaude);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolveStatusDir falls back to the data home when .claude is a file", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-status-config-"));
  try {
    await writeFile(path.join(cwd, ".claude"), "not a directory");

    assert.equal(resolveStatusDir({ XDG_CONFIG_HOME: path.join(cwd, "config"), XDG_DATA_HOME: path.join(cwd, "data") }, cwd), path.join(cwd, "data", "ensemble", "status"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolveStatusDir keeps the environment controls", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-status-config-"));
  try {
    const explicit = path.join(cwd, "custom-status");

    // An explicitly named directory that does not exist fails loud — the
    // operator asked for observability, so publishing nothing at exit 0 is
    // the failure to avoid. Automatic data-home directory creation belongs to
    // the CLI; explicit directories must already exist.
    assert.throws(
      () => resolveStatusDir({ ENSEMBLE_STATUS_DIR: explicit }, cwd),
      (error: unknown) => {
        assert.ok(error instanceof AmbientConfigError);
        assert.match(error.message, /custom-status/);
        assert.match(error.message, /ENSEMBLE_STATUS_DIR/);
        return true;
      }
    );
    await mkdir(explicit);
    assert.equal(resolveStatusDir({ ENSEMBLE_STATUS_DIR: explicit }, cwd), explicit);
    assert.equal(resolveStatusDir({ ENSEMBLE_STATUS: "off", ENSEMBLE_STATUS_DIR: explicit }, cwd), null);
    assert.equal(resolveStatusDir({ ENSEMBLE_STATUS: "0" }, cwd), null);
    assert.equal(resolveStatusDir({ ENSEMBLE_STATUS: "false" }, cwd), null);
    assert.equal(resolveStatusDir({ ENSEMBLE_STATUS: "no" }, cwd), null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
