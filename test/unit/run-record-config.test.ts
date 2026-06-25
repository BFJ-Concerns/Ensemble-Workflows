import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveRunRecordDir } from "../../src/run-record-config.js";

test("resolveRunRecordDir defaults to the persistent data home", () => {
  assert.equal(resolveRunRecordDir({ XDG_DATA_HOME: "/tmp/data-home" }), path.join("/tmp/data-home", "ensemble"));
});

test("resolveRunRecordDir relocates and disables like the status controls", () => {
  assert.equal(resolveRunRecordDir({ ENSEMBLE_RUN_RECORD_DIR: "/tmp/records" }), "/tmp/records");
  assert.equal(resolveRunRecordDir({ ENSEMBLE_RUN_RECORD: "off", ENSEMBLE_RUN_RECORD_DIR: "/tmp/records" }), null);
  assert.equal(resolveRunRecordDir({ ENSEMBLE_RUN_RECORD: "0" }), null);
  assert.equal(resolveRunRecordDir({ ENSEMBLE_RUN_RECORD: "false" }), null);
  assert.equal(resolveRunRecordDir({ ENSEMBLE_RUN_RECORD: "no" }), null);
});

