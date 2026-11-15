import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkflowScriptReadError } from "../../src/errors.js";
import { readWorkflowSource } from "../../src/workflow-source-reader.js";

test("the source reader preserves large UTF-8 source across pipe chunks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-source-reader-"));
  try {
    const file = path.join(directory, "workflow.js");
    const source = "// 🦊 café\n".repeat(150_000);
    await writeFile(file, source);
    assert.equal(await readWorkflowSource(file, new AbortController().signal), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a source read failure retains the named filesystem diagnostic", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-source-reader-error-"));
  try {
    const file = path.join(directory, "missing.js");
    await assert.rejects(readWorkflowSource(file, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof WorkflowScriptReadError);
      assert.equal(error.message, `Could not read workflow script ${file}: no file exists at this path`);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
