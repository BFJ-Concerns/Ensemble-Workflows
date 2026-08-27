import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { harnessVersion } from "../../src/harness-version.js";

test("an unbundled run reads the harness version from package.json", () => {
  // The bundle inlines the version at build time; everywhere else the
  // fallback must agree with the single source of truth.
  const declared = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
  assert.equal(harnessVersion(), declared);
  assert.notEqual(harnessVersion(), "0.0.0");
});
