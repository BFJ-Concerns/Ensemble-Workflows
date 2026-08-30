import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AmbientConfigError, resolveStatusDir } from "../../src/ambient-settings.js";

test("resolveStatusDir uses the cwd .claude directory only when it already exists", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-status-config-"));
  assert.equal(resolveStatusDir({}, cwd), null);

  const localClaude = path.join(cwd, ".claude");
  await mkdir(localClaude);
  assert.equal(resolveStatusDir({}, cwd), localClaude);
});

test("resolveStatusDir does not treat a cwd .claude file as an opt-in directory", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-status-config-"));
  await writeFile(path.join(cwd, ".claude"), "not a directory");

  assert.equal(resolveStatusDir({}, cwd), null);
});

test("resolveStatusDir keeps the environment controls", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-status-config-"));
  const explicit = path.join(cwd, "custom-status");

  // An explicitly named directory that does not exist fails loud — the
  // operator asked for observability, so publishing nothing at exit 0 is
  // the failure to avoid, not a fallback. Only the *default* .claude location
  // opts out by absence (the tests above).
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
});
