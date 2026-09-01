import assert from "node:assert/strict";
import { access, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { assertNotInsideSuiteSpawningTest, hermeticEstateEnvironment, SUITE_SPAWNING_TEST_MARKER } from "./estate-process.js";

const runnerPath = path.resolve("scripts/run-test-suite.mjs");
const unitTestPath = path.resolve("dist/test/unit/workflow-registry.test.js");

test("suite-root recovery bounds unstamped hand-off retention and preserves stamped child process-group liveness", { timeout: 90_000 }, async (t) => {
  assertNotInsideSuiteSpawningTest();
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ensemble-suite-root-ownership-stamped-estate-"));
  const heldChildren: HeldChild[] = [];
  try {
    const deadParentRoot = await createDeadParentPendingRoot(temporaryRoot);
    await Promise.all([runAndRequireClean(temporaryRoot), runAndRequireClean(temporaryRoot)]);
    await assertMissing(deadParentRoot, "recovery must reclaim a conclusively dead parent-owned root");

    const staleHandoffRoot = await createUnstampedHandoffRoot(temporaryRoot);
    await agePastUnstampedHandoffRetention(staleHandoffRoot);
    await runAndRequireClean(temporaryRoot);
    await assertMissing(staleHandoffRoot, "recovery must reclaim a stale unstamped hand-off root");

    const freshHandoffRoot = await createUnstampedHandoffRoot(temporaryRoot);
    await runAndRequireClean(temporaryRoot);
    await access(freshHandoffRoot);

    const held = await createStampedHeldRoot(temporaryRoot);
    heldChildren.push(held.child);
    await Promise.all([runAndRequireClean(temporaryRoot), runAndRequireClean(temporaryRoot)]);
    await access(held.root);

    await writeFile(held.releasePath, "release\n");
    await held.exited;
    await runAndRequireClean(temporaryRoot);
    await assertMissing(held.root, "recovery must reclaim a stamped root once its child process group is dead");

    await requirePausedLiveRunnerToExecuteTests(temporaryRoot);

    t.diagnostic("real suite-runner recovery reclaimed dead parent-owned and stale unstamped hand-off roots, retained a fresh unstamped root and a live stamped child group, then reclaimed the stamped root after release; a live parent paused after child spawn still ran tests and reported a non-zero test count");
  } finally {
    await Promise.all(heldChildren.map(stopHeldChild));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function startSuite(temporaryRoot: string, environment: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [runnerPath, unitTestPath], {
    env: hermeticEstateEnvironment({
      TMPDIR: temporaryRoot,
      NODE_TEST_CONTEXT: undefined,
      [SUITE_SPAWNING_TEST_MARKER]: "suite-root-ownership-stamped-estate.test",
      ...environment
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (output += chunk));
  return {
    child,
    completed: new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    })
  };
}

function runSuite(temporaryRoot: string): Promise<{ code: number | null; output: string }> {
  return startSuite(temporaryRoot).completed;
}

async function runAndRequireClean(temporaryRoot: string): Promise<void> {
  const result = await runSuite(temporaryRoot);
  assert.equal(result.code, 0, result.output);
}

async function createDeadParentPendingRoot(temporaryRoot: string): Promise<string> {
  const parentProcessId = await createDeadProcessId();
  return mkdtemp(path.join(temporaryRoot, `ensemble-test-suite-pending-parent-${parentProcessId}-`));
}

async function createDeadProcessId(): Promise<number> {
  const parent = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    parent.once("error", reject);
    parent.once("exit", () => resolve());
  });
  assert.ok(parent.pid, "the finished parent must have had a process id");
  assert.throws(() => process.kill(parent.pid!, 0), { code: "ESRCH" });
  return parent.pid;
}

interface HeldChild {
  processGroup: number;
  releasePath: string;
  exited: Promise<void>;
}

async function createUnstampedHandoffRoot(temporaryRoot: string): Promise<string> {
  const parentProcessId = await createDeadProcessId();
  return mkdtemp(path.join(temporaryRoot, `ensemble-test-suite-handoff-pending-parent-${parentProcessId}-`));
}

async function agePastUnstampedHandoffRetention(root: string): Promise<void> {
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1_000);
  await utimes(root, threeHoursAgo, threeHoursAgo);
}

async function createStampedHeldRoot(temporaryRoot: string): Promise<{ root: string; child: HeldChild; releasePath: string; exited: Promise<void> }> {
  const child = await createHeldChild(temporaryRoot);
  const parentProcessId = await createDeadProcessId();
  const root = await mkdtemp(path.join(temporaryRoot, `ensemble-test-suite-handoff-pending-parent-${parentProcessId}-`));
  await writeFile(path.join(root, "owner.json"), `${JSON.stringify({ childProcessGroup: child.processGroup })}\n`);
  return { root, child, releasePath: child.releasePath, exited: child.exited };
}

async function createHeldChild(temporaryRoot: string): Promise<HeldChild> {
  const controlDirectory = await mkdtemp(path.join(temporaryRoot, "control-"));
  const readyPath = path.join(controlDirectory, "ready");
  const releasePath = path.join(controlDirectory, "release");
  const child = spawn(process.execPath, ["-e", heldChildProgram], {
    detached: true,
    env: { ...process.env, READY_PATH: readyPath, RELEASE_PATH: releasePath },
    stdio: "ignore"
  });
  assert.ok(child.pid, "the detached child must have a process-group id");
  await waitForFile(readyPath);
  return {
    processGroup: child.pid,
    releasePath,
    exited: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    })
  };
}

async function stopHeldChild(child: HeldChild): Promise<void> {
  await writeFile(child.releasePath, "release\n").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await Promise.race([child.exited, delay(1_000)]);
  try {
    process.kill(-child.processGroup, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await child.exited;
}

async function requirePausedLiveRunnerToExecuteTests(temporaryRoot: string): Promise<void> {
  const testPausePath = path.join(temporaryRoot, "pause-live-parent-after-child-spawn");
  const run = startSuite(temporaryRoot, { ENSEMBLE_SUITE_TEST_PAUSE_AFTER_CHILD_SPAWN_PATH: testPausePath });
  try {
    await waitForFile(`${testPausePath}.child-pid`);
    await delay(1_250);
    assert.equal(run.child.exitCode, null, "the live suite parent must remain in the test-only hand-off pause");
    await writeFile(testPausePath, "release\n");
    const result = await run.completed;
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /(?:^|\n)# tests [1-9]\d*(?:\n|$)/, `a successful suite must report executing at least one test:\n${result.output}`);
  } finally {
    await writeFile(testPausePath, "release\n").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGTERM");
    await run.completed.catch(() => undefined);
  }
}

const heldChildProgram = `
  import { access, writeFile } from "node:fs/promises";
  await writeFile(process.env.READY_PATH, "ready\\n");
  while (true) {
    try {
      await access(process.env.RELEASE_PATH);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
`;

async function assertMissing(target: string, message: string): Promise<void> {
  await assert.rejects(access(target), { code: "ENOENT" }, message);
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
