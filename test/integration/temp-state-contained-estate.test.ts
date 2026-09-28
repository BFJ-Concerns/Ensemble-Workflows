import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    let held: Awaited<ReturnType<typeof startHeldSuite>> | undefined;
    let foreign: Awaited<ReturnType<typeof startHeldSuite>> | undefined;
    try {
      // Kill a suite parent during an active child test. The next suite must
      // remove the abandoned root only after that child has actually exited.
      held = await startHeldSuite(temporaryRoot);
      await waitForFile(held.readyPath);
      const heldHandoff = await suiteHandoffForProcess(temporaryRoot, requiredPid(held));
      assert.ok(heldHandoff, "the held suite must have its own hand-off root");
      const heldGroup = await childProcessGroup(heldHandoff);
      held.process.kill("SIGKILL");
      const stopped = await held.result;
      assert.equal(stopped.signal, "SIGKILL", stopped.output);
      const abandonedRoot = path.dirname(heldHandoff);
      await access(path.join(heldHandoff, "schema-cache"));

      // A second, unrelated suite owns a live root in the same TMPDIR. Its
      // state is visible to recovery but cannot decide this fixture's result.
      foreign = await startHeldSuite(temporaryRoot, "foreign-control");
      await waitForFile(foreign.readyPath);
      const foreignHandoff = await suiteHandoffForProcess(temporaryRoot, requiredPid(foreign));
      assert.ok(foreignHandoff, "the foreign suite must have its own hand-off root");
      const foreignGroup = await childProcessGroup(foreignHandoff);
      const foreignRoot = path.dirname(foreignHandoff);

      await runAndRequireClean(temporaryRoot, unitTestPath);
      await access(path.join(heldHandoff, "schema-cache"));
      await access(foreignRoot);

      await writeFile(held.releasePath, "release\n");
      await waitForFile(held.finishedPath);
      await waitForProcessGroupExit(heldGroup);
      await runAndRequireClean(temporaryRoot, unitTestPath);
      await assertMissing(abandonedRoot, "recovery must remove state once the dead run has no live child");
      await access(foreignRoot);

      // Clean representative unit and integration suite exits leave no
      // suite-owned state in the isolated observer root.
      for (const testPath of [unitTestPath, integrationTestPath]) {
        const clean = runSuite(temporaryRoot, testPath);
        const result = await clean.result;
        assert.equal(result.code, 0, result.output);
        assert.equal(await suiteHandoffForProcess(temporaryRoot, requiredPid(clean)), null, `clean ${path.basename(testPath)} left owned state`);
      }
      await writeFile(foreign.releasePath, "release\n");
      await waitForFile(foreign.finishedPath);
      await waitForProcessGroupExit(foreignGroup);
      assert.equal((await foreign.result).code, 0);
      await runAndRequireClean(temporaryRoot, unitTestPath);
      await assertMissing(foreignRoot, "recovery must remove the foreign root after its child exits");
      t.diagnostic("clean unit and integration exits, killed-parent recovery, and live-child retention exercised through scripts/run-test-suite.mjs");
    } finally {
      if (held !== undefined) {
        await writeFile(held.releasePath, "release\n");
        if (held.process.exitCode === null && held.process.signalCode === null) held.process.kill("SIGKILL");
        await held.result.catch(() => undefined);
      }
      if (foreign !== undefined) {
        await writeFile(foreign.releasePath, "release\n");
        await foreign.result.catch(() => undefined);
      }
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

async function startHeldSuite(temporaryRoot: string, controlName = "control"): Promise<SuiteProcess & { readyPath: string; releasePath: string; finishedPath: string }> {
  const controlDirectory = path.join(temporaryRoot, controlName);
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

function requiredPid(suite: SuiteProcess): number {
  assert.ok(suite.process.pid !== undefined && suite.process.pid > 0, "suite runner must have a process ID");
  return suite.process.pid;
}

async function suiteHandoffForProcess(temporaryRoot: string, pid: number): Promise<string | null> {
  for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("ensemble-test-suite-run-")) continue;
    const namespace = path.join(temporaryRoot, entry.name);
    let handoffs;
    try {
      handoffs = await readdir(namespace, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const handoff = handoffs.find((child) => child.isDirectory() && child.name.startsWith(`ensemble-test-suite-handoff-pending-parent-${pid}-`));
    if (handoff) return path.join(namespace, handoff.name);
  }
  return null;
}

async function childProcessGroup(handoff: string): Promise<number> {
  const ownerPath = path.join(handoff, "owner.json");
  await waitForFile(ownerPath);
  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { childProcessGroup?: number };
  assert.ok(Number.isInteger(owner.childProcessGroup) && (owner.childProcessGroup ?? 0) > 0, "suite owner must identify its child process group");
  return owner.childProcessGroup!;
}

async function waitForProcessGroupExit(pgid: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    assert.ok(Date.now() < deadline, `suite child process group ${pgid} remained alive after its finished marker`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function assertMissing(candidate: string, message: string): Promise<void> {
  try {
    await access(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assert.fail(message);
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
