import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertNotInsideSuiteSpawningTest, runNode, runProcess, SUITE_SPAWNING_TEST_MARKER } from "./estate-process.js";

test("a rebuild removes tests and modules whose sources were deleted", async () => {
  assertNotInsideSuiteSpawningTest();
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-build-output-"));
  try {
    for (const entry of ["package.json", "tsconfig.json", "THIRD_PARTY_NOTICES", "src", "scripts"]) {
      await cp(path.resolve(entry), path.join(directory, entry), { recursive: true });
    }
    await symlink(path.resolve("node_modules"), path.join(directory, "node_modules"), "dir");
    await mkdir(path.join(directory, "skills/ensemble-workflow/Base/scripts"), { recursive: true });
    await mkdir(path.join(directory, "test/unit"), { recursive: true });
    const removedModule = path.join(directory, "src/withdrawn.ts");
    const removedTest = path.join(directory, "test/unit/withdrawn.test.ts");
    await writeFile(removedModule, "export const message = 'withdrawn test executed';\n");
    await writeFile(removedTest, "import { message } from '../../src/withdrawn.js';\nthrow new Error(message);\n");
    await writeFile(path.join(directory, "test/unit/current.test.ts"), "import test from 'node:test';\ntest('current source executes', () => {});\n");

    const firstBuild = await runProcess("npm", ["--prefix", directory, "run", "build"], {}, 60_000);
    assert.equal(firstBuild.code, 0, firstBuild.stdout + firstBuild.stderr);
    assert.ok((await readdir(path.join(directory, "dist/test/unit"))).includes("withdrawn.test.js"));
    assert.ok((await readdir(path.join(directory, "dist/src"))).includes("withdrawn.js"));

    await rm(removedTest);
    await rm(removedModule);
    const rebuild = await runProcess("npm", ["--prefix", directory, "run", "build"], {}, 60_000);
    assert.equal(rebuild.code, 0, rebuild.stdout + rebuild.stderr);
    const result = await runNode([
      "scripts/run-test-suite.mjs", path.join(directory, "dist/test/**/*.test.js")
    ], {
      NODE_TEST_CONTEXT: undefined,
      [SUITE_SPAWNING_TEST_MARKER]: "build-output-clean.test"
    }, 30_000);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 1\b/);
    assert.match(result.stdout, /current source executes/);
    for (const output of await readdir(path.join(directory, "dist/test/unit"))) {
      assert.ok(!output.startsWith("withdrawn.test."), output);
    }
    for (const output of await readdir(path.join(directory, "dist/src"))) {
      assert.ok(!output.startsWith("withdrawn."), output);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
