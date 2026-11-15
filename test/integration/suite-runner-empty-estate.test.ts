import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertNotInsideSuiteSpawningTest, runNode, SUITE_SPAWNING_TEST_MARKER } from "./estate-process.js";

const runnerPath = path.resolve("scripts/run-test-suite.mjs");

test("suite runner refuses a pattern that names no test file before any test process starts", async () => {
  assertNotInsideSuiteSpawningTest();
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-empty-suite-estate-"));
  const emptyTree = path.join(directory, "empty");
  const pattern = path.join(emptyTree, "**/*.test.js");
  try {
    await mkdir(emptyTree);
    const result = await runNode([runnerPath, pattern], {
      NODE_TEST_CONTEXT: undefined,
      FORCE_COLOR: "3",
      [SUITE_SPAWNING_TEST_MARKER]: "suite-runner-empty-estate.test"
    });

    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.startsWith(`Suite runner refused to start: no test file matches ${JSON.stringify(pattern)} `), result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("suite runner runs every pattern it is given, and refuses the whole run when one names no file", async () => {
  assertNotInsideSuiteSpawningTest();
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-multi-pattern-suite-estate-"));
  try {
    const patterns = [];
    for (const name of ["first", "second"]) {
      await mkdir(path.join(directory, name));
      await writeFile(
        path.join(directory, name, `${name}.test.js`),
        `import test from "node:test";\ntest("${name} pattern ran", () => {});\n`
      );
      patterns.push(path.join(directory, name, "*.test.js"));
    }
    const environment = {
      NODE_TEST_CONTEXT: undefined,
      [SUITE_SPAWNING_TEST_MARKER]: "suite-runner-empty-estate.test"
    };

    const both = await runNode([runnerPath, ...patterns], environment);
    assert.equal(both.code, 0, both.stderr);
    assert.match(both.stdout, /^ok \d+ - first pattern ran$/m);
    assert.match(both.stdout, /^ok \d+ - second pattern ran$/m);
    assert.match(both.stdout, /^# pass 2$/m);

    const missing = path.join(directory, "missing", "*.test.js");
    const refused = await runNode([runnerPath, ...patterns, missing], environment);
    assert.equal(refused.code, 1, refused.stderr);
    assert.equal(refused.stdout, "", "no pattern runs when one is refused");
    assert.match(refused.stderr, /no test file matches/);
    assert.ok(refused.stderr.includes(JSON.stringify(missing)), refused.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("suite runner withholds the invoking shell's run settings from the tests it runs", async () => {
  assertNotInsideSuiteSpawningTest();
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-suite-run-settings-estate-"));
  try {
    const invokerStore = path.join(directory, "invoker-records");
    await writeFile(path.join(directory, "settings.test.js"), `import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
test("the invoker's run settings are absent", () => {
  for (const name of ["ENSEMBLE_HOLD_SCOPE", "ENSEMBLE_CALLER_IDENTITY", "ENSEMBLE_STATUS_DIR", "ENSEMBLE_AGENT_CEILING", "ENSEMBLE_CONCURRENCY_CLAUDE"]) {
    assert.equal(process.env[name], undefined, name);
  }
  assert.notEqual(process.env.ENSEMBLE_RUN_RECORD_DIR, ${JSON.stringify(invokerStore)});
  assert.ok(process.env.ENSEMBLE_RUN_RECORD_DIR.startsWith(tmpdir()), "the suite's own record store");
  assert.equal(process.env.ENSEMBLE_LIVE_CODEX_MODEL, "kept-for-live-legs");
});
`);
    const result = await runNode([runnerPath, path.join(directory, "settings.test.js")], {
      NODE_TEST_CONTEXT: undefined,
      [SUITE_SPAWNING_TEST_MARKER]: "suite-runner-empty-estate.test",
      ENSEMBLE_HOLD_SCOPE: "invoking-build-run",
      ENSEMBLE_CALLER_IDENTITY: "invoking-lead",
      ENSEMBLE_STATUS_DIR: path.join(directory, "invoker-status"),
      ENSEMBLE_AGENT_CEILING: "1",
      ENSEMBLE_CONCURRENCY_CLAUDE: "1",
      ENSEMBLE_RUN_RECORD_DIR: invokerStore,
      ENSEMBLE_LIVE_CODEX_MODEL: "kept-for-live-legs"
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^# pass 1$/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
