import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

test("source symlinks retain relative traversal and loop errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-source-reader-links-"));
  try {
    await mkdir(path.join(directory, "nested"));
    const source = 'export const meta = { name: "links" }; return 42;';
    await writeFile(path.join(directory, "workflow.js"), source);
    await symlink("../workflow.js", path.join(directory, "nested", "relative.js"));
    await symlink("nested/relative.js", path.join(directory, "chain.js"));
    assert.equal(await readWorkflowSource(path.join(directory, "chain.js"), new AbortController().signal), source);
    await symlink("loop.js", path.join(directory, "loop.js"));
    await assert.rejects(readWorkflowSource(path.join(directory, "loop.js"), new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof WorkflowScriptReadError);
      assert.equal((error.cause as NodeJS.ErrnoException).code, "ELOOP");
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
