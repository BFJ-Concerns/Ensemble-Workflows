import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readWorkflowMeta } from "../../src/script-runner.js";
import { listSavedWorkflows, resolveWorkflowReference, WorkflowResolutionError } from "../../src/workflow-registry.js";

test("name resolution failure names saved workflows it had to skip", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-registry-notes-"));
  const userData = await mkdtemp(path.join(tmpdir(), "ensemble-registry-notes-user-"));
  const projectRegistry = path.join(cwd, ".claude", "ensemble", "workflows");
  await mkdir(projectRegistry, { recursive: true });
  // A saved workflow whose meta cannot be parsed: without a note in the error,
  // "not found" sends the author hunting in the wrong place.
  await writeFile(path.join(projectRegistry, "broken.js"), `return "not a workflow";`);

  await assert.rejects(
    () =>
      resolveWorkflowReference("missing-name", {
        cwd,
        env: { XDG_DATA_HOME: userData },
        readMeta: readWorkflowMeta
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowResolutionError);
      assert.match(error.message, /was not found/);
      assert.match(error.message, /skipped unreadable saved workflows: .*broken\.js/);
      return true;
    }
  );
});

test("name resolution stays quiet when nothing was skipped", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-registry-clean-"));
  const userData = await mkdtemp(path.join(tmpdir(), "ensemble-registry-clean-user-"));

  await assert.rejects(
    () =>
      resolveWorkflowReference("missing-name", {
        cwd,
        env: { XDG_DATA_HOME: userData },
        readMeta: readWorkflowMeta
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowResolutionError);
      assert.doesNotMatch(error.message, /skipped unreadable/);
      return true;
    }
  );
});

test("saved workflows with V8-valid export property expressions remain listed", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ensemble-registry-export-property-"));
  const userData = await mkdtemp(path.join(tmpdir(), "ensemble-registry-export-property-user-"));
  const projectRegistry = path.join(cwd, ".claude", "ensemble", "workflows");
  await mkdir(projectRegistry, { recursive: true });
  await writeFile(
    path.join(projectRegistry, "property.js"),
    `export const meta = { name: "property", description: "V8-valid property access" };
     const obj = { export: 3 };
     const doubled = obj.export * 2;
     return doubled;`
  );

  const listing = await listSavedWorkflows({ cwd, env: { XDG_DATA_HOME: userData }, readMeta: readWorkflowMeta });

  assert.deepEqual(listing.entries.map((entry) => entry.name), ["property"]);
  assert.deepEqual(listing.notes, []);
});
