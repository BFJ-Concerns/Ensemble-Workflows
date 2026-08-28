import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { hermeticEstateEnvironment } from "./estate-process.js";

const runnerPath = path.resolve("scripts/run-test-suite.mjs");
const unitTestPath = path.resolve("dist/test/unit/workflow-registry.test.js");

test("suite-root recovery distinguishes dead parent ownership, hand-off uncertainty, and child process-group liveness", { timeout: 90_000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ensemble-suite-root-ownership-stamped-estate-"));
  const heldChildren: HeldChild[] = [];
  try {
    const deadParentRoot = await createDeadParentPendingRoot(temporaryRoot);
    await Promise.all([runAndRequireClean(temporaryRoot), runAndRequireClean(temporaryRoot)]);
    await assertMissing(deadParentRoot, "recovery must reclaim a conclusively dead parent-owned root");

    const handoff = await createLiveUnstampedHandoffRoot(temporaryRoot);
    heldChildren.push(handoff.child);
    await runAndRequireClean(temporaryRoot);
    await access(handoff.root);

    const held = await createStampedHeldRoot(temporaryRoot);
    heldChildren.push(held.child);
    await Promise.all([runAndRequireClean(temporaryRoot), runAndRequireClean(temporaryRoot)]);
    await access(held.root);

    await writeFile(held.releasePath, "release\n");
    await held.exited;
    await runAndRequireClean(temporaryRoot);
    await assertMissing(held.root, "recovery must reclaim a stamped root once its child process group is dead");

    await requireOrphanedWrapperToStop(temporaryRoot);

    t.diagnostic("real suite-runner recovery reclaimed a dead parent-pending root, retained hand-off uncertainty and a live stamped child group, then reclaimed the stamped root after release; a real wrapper orphaned before owner-ready exited within its bound");
  } finally {
    await Promise.all(heldChildren.map(stopHeldChild));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function runSuite(temporaryRoot: string): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [runnerPath, unitTestPath], {
    env: hermeticEstateEnvironment({ TMPDIR: temporaryRoot, NODE_TEST_CONTEXT: undefined }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (output += chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
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

async function createLiveUnstampedHandoffRoot(temporaryRoot: string): Promise<{ root: string; child: HeldChild }> {
  const child = await createHeldChild(temporaryRoot);
  const parentProcessId = await createDeadProcessId();
  const root = await mkdtemp(path.join(temporaryRoot, `ensemble-test-suite-handoff-pending-parent-${parentProcessId}-`));
  return { root, child };
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

async function requireOrphanedWrapperToStop(temporaryRoot: string): Promise<void> {
  const interrupted = await interruptRunnerBeforeOwnerReady(temporaryRoot);
  try {
    assert.equal(interrupted.ownerReady, false, "the parent must die before publishing owner-ready");
    await waitForProcessExit(interrupted.wrapperProcessId, 2_500);
  } finally {
    await stopProcessGroup(interrupted.wrapperProcessId);
    await rm(interrupted.root, { recursive: true, force: true });
  }
}

async function interruptRunnerBeforeOwnerReady(temporaryRoot: string): Promise<{
  root: string;
  ownerReadyPath: string;
  ownerReady: boolean;
  wrapperProcessId: number;
}> {
  const testPausePath = path.join(temporaryRoot, "pause-after-child-spawn");
  const childProcessIdPath = `${testPausePath}.child-pid`;
  const runner = spawn(process.execPath, [runnerPath, unitTestPath], {
    env: hermeticEstateEnvironment({
      TMPDIR: temporaryRoot,
      NODE_TEST_CONTEXT: undefined,
      ENSEMBLE_SUITE_TEST_PAUSE_AFTER_CHILD_SPAWN_PATH: testPausePath
    }),
    stdio: "ignore"
  });
  assert.ok(runner.pid, "the real suite runner must have a process id");
  const root = await waitForHandoffRoot(temporaryRoot, runner.pid);
  const ownerReadyPath = path.join(root, "owner-ready");
  const wrapperProcessId = Number((await readFileAfterWait(childProcessIdPath)).trim());
  assert.ok(Number.isInteger(wrapperProcessId) && wrapperProcessId > 0, "the real suite wrapper must publish its process-group id before the test pause");
  runner.kill("SIGKILL");
  await new Promise<void>((resolve, reject) => {
    runner.once("error", reject);
    runner.once("exit", () => resolve());
  });
  const ownerReady = await fileExists(ownerReadyPath);
  return { root, ownerReadyPath, ownerReady, wrapperProcessId };
}

async function waitForHandoffRoot(temporaryRoot: string, parentProcessId: number): Promise<string> {
  const prefix = `ensemble-test-suite-handoff-pending-parent-${parentProcessId}-`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const entries = await readdir(temporaryRoot, { withFileTypes: true });
    const root = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(prefix));
    if (root !== undefined) return path.join(temporaryRoot, root.name);
    await delay(10);
  }
  assert.fail(`timed out waiting for a hand-off root owned by ${parentProcessId}`);
}

async function readFileAfterWait(target: string): Promise<string> {
  await waitForFile(target);
  return readFile(target, "utf8");
}

async function waitForProcessExit(processId: number, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!processExists(processId)) return;
    await delay(20);
  }
  assert.fail(`orphaned suite wrapper ${processId} outlived its 1 s owner-ready bound`);
}

async function stopProcessGroup(processGroup: number): Promise<void> {
  try {
    process.kill(-processGroup, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
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
