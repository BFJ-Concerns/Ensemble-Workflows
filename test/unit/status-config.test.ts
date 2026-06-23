import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveStatusDir } from "../../src/status-config.js";

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

  assert.equal(resolveStatusDir({ ENSEMBLE_STATUS_DIR: explicit }, cwd), explicit);
  assert.equal(resolveStatusDir({ ENSEMBLE_STATUS: "off", ENSEMBLE_STATUS_DIR: explicit }, cwd), null);
  assert.equal(resolveStatusDir({ ENSEMBLE_STATUS: "0" }, cwd), null);
  assert.equal(resolveStatusDir({ ENSEMBLE_STATUS: "false" }, cwd), null);
  assert.equal(resolveStatusDir({ ENSEMBLE_STATUS: "no" }, cwd), null);
});
