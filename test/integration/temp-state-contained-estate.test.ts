import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import test from "node:test";

import { assertNotInsideSuiteSpawningTest, hermeticEstateEnvironment, SUITE_SPAWNING_TEST_MARKER } from "./estate-process.js";

const runnerPath = path.resolve("scripts/run-test-suite.mjs");
const thisTestPath = path.resolve("dist/test/integration/temp-state-contained-estate.test.js");
const unitTestPath = path.resolve("dist/test/unit/workflow-registry.test.js");
const integrationTestPath = path.resolve("dist/test/integration/fixture-schema-generated-once-estate.test.js");

if (process.env.ENSEMBLE_TEMP_STATE_ESTATE_CHILD === "hold") {
  const readyPath = requiredEnvironment("ENSEMBLE_TEMP_STATE_ESTATE_READY");
  const releasePath = requiredEnvironment("ENSEMBLE_TEMP_STATE_ESTATE_RELEASE");
  const finishedPath = requiredEnvironment("ENSEMBLE_TEMP_STATE_ESTATE_FINISHED");

  test("holds a real test-runner child alive for stale-root recovery observation", { timeout: 30_000 }, async () => {
    await writeFile(readyPath, "ready\n");
    try {
      await waitForFile(releasePath);
    } finally {
      await writeFile(finishedPath, "finished\n");
    }
  });
} else {
  test("the suite runner removes clean and killed state without reaping a live child cache", { timeout: 90_000 }, async (t) => {
    assertNotInsideSuiteSpawningTest();
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ensemble-temp-state-contained-estate-"));
    try {
      // Kill a suite parent during an active child test. The next suite must
      // remove the abandoned root only after that child has actually exited.
      const held = await startHeldSuite(temporaryRoot);
      await waitForFile(held.readyPath);
      held.process.kill("SIGKILL");
      const stopped = await held.result;
      assert.equal(stopped.signal, "SIGKILL", stopped.output);
      assert.ok((await schemaCaches(temporaryRoot)).length > 0, "the killed suite must leave an observable cache for recovery");

      await runAndRequireClean(temporaryRoot, unitTestPath);
      assert.ok((await schemaCaches(temporaryRoot)).length > 0, "recovery must retain a live child cache");

      await writeFile(held.releasePath, "release\n");
      await waitForFile(held.finishedPath);
      await runAndRequireClean(temporaryRoot, unitTestPath);
      assert.deepEqual(await ownedEntries(temporaryRoot), [], "recovery must remove state once the dead run has no live child");

      // Clean representative unit and integration suite exits leave no
      // suite-owned state in the isolated observer root.
      for (const testPath of [unitTestPath, integrationTestPath]) {
        const clean = runSuite(temporaryRoot, testPath);
        const result = await clean.result;
        assert.equal(result.code, 0, result.output);
        assert.deepEqual(await ownedEntries(temporaryRoot), [], `clean ${path.basename(testPath)} left owned state`);
      }
      t.diagnostic("clean unit and integration exits, killed-parent recovery, and live-child retention exercised through scripts/run-test-suite.mjs");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}

function runSuite(temporaryRoot: string, testPath: string, additions: NodeJS.ProcessEnv = {}): SuiteProcess {
  const child = spawn(process.execPath, [runnerPath, testPath], {
    // Node marks a test worker in its inherited environment. A nested
    // invocation is a new independent suite, not another worker of this one.
    env: hermeticEstateEnvironment({
      ...additions,
      TMPDIR: temporaryRoot,
      NODE_TEST_CONTEXT: undefined,
      [SUITE_SPAWNING_TEST_MARKER]: "temp-state-contained-estate.test"
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (output += chunk));
  return {
    process: child,
    result: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, output }));
    })
  };
}

async function startHeldSuite(temporaryRoot: string): Promise<SuiteProcess & { readyPath: string; releasePath: string; finishedPath: string }> {
  const controlDirectory = path.join(temporaryRoot, "control");
  await mkdir(controlDirectory);
  const readyPath = path.join(controlDirectory, "ready");
  const releasePath = path.join(controlDirectory, "release");
  const finishedPath = path.join(controlDirectory, "finished");
  return {
    ...runSuite(temporaryRoot, thisTestPath, {
      ENSEMBLE_TEMP_STATE_ESTATE_CHILD: "hold",
      ENSEMBLE_TEMP_STATE_ESTATE_READY: readyPath,
      ENSEMBLE_TEMP_STATE_ESTATE_RELEASE: releasePath,
      ENSEMBLE_TEMP_STATE_ESTATE_FINISHED: finishedPath
    }),
    readyPath,
    releasePath,
    finishedPath
  };
}

async function runAndRequireClean(temporaryRoot: string, testPath: string): Promise<void> {
  const result = await runSuite(temporaryRoot, testPath).result;
  assert.equal(result.code, 0, result.output);
}

async function ownedEntries(temporaryRoot: string): Promise<string[]> {
  return (await readdir(temporaryRoot)).filter((entry) => entry.startsWith("ensemble-"));
}

async function schemaCaches(temporaryRoot: string): Promise<string[]> {
  const caches: string[] = [];
  for (const entry of await ownedEntries(temporaryRoot)) {
    const candidate = path.join(temporaryRoot, entry);
    if (entry.startsWith("ensemble-codex-schema-")) caches.push(candidate);
    if (entry.startsWith("ensemble-test-suite-run-")) {
      for (const handoff of await readdir(candidate, { withFileTypes: true })) {
        if (!handoff.isDirectory() || !handoff.name.startsWith("ensemble-test-suite-")) continue;
        await collectSchemaCache(path.join(candidate, handoff.name), caches);
      }
    } else if (entry.startsWith("ensemble-test-suite-")) {
      await collectSchemaCache(candidate, caches);
    }
  }
  return caches;
}

async function collectSchemaCache(suiteRoot: string, caches: string[]): Promise<void> {
  const cache = path.join(suiteRoot, "schema-cache");
  try {
    await access(cache);
    caches.push(cache);
  } catch {
    // The root may have been removed by a concurrent finished suite.
  }
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`timed out waiting for ${file}`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} must be set for the held child`);
  return value;
}

interface SuiteProcess {
  process: ReturnType<typeof spawn>;
  result: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
}
