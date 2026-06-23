import assert from "node:assert/strict";
import test from "node:test";

import { nodeVersionError, requiredNodeRange, satisfiesNodeRange } from "../../src/node-version.js";

test("requiredNodeRange is read from package metadata", () => {
  assert.equal(requiredNodeRange(), ">=24.14.0");
});

test("satisfiesNodeRange enforces the package's minimum Node version", () => {
  assert.equal(satisfiesNodeRange("24.13.9", ">=24.14.0"), false);
  assert.equal(satisfiesNodeRange("24.14.0", ">=24.14.0"), true);
  assert.equal(satisfiesNodeRange("25.0.0", ">=24.14.0"), true);
});

test("nodeVersionError names both detected and required versions", () => {
  assert.equal(nodeVersionError("24.14.0", ">=24.14.0"), null);
  assert.equal(nodeVersionError("24.13.9", ">=24.14.0"), "Ensemble requires Node >=24.14.0; detected Node 24.13.9.");
});
