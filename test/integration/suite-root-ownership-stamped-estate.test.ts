import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  try {
    const deadParentRoot = await createDeadParentPendingRoot(temporaryRoot);
    await Promise.all([runAndRequireClean(temporaryRoot), runAndRequireClean(temporaryRoot)]);
    await assertMissing(deadParentRoot, "recovery must reclaim a conclusively dead parent-owned root");

    const handoffRoot = await mkdtemp(path.join(temporaryRoot, "ensemble-test-suite-handoff-pending-parent-unknown-"));
    await runAndRequireClean(temporaryRoot);
    await access(handoffRoot);

    const held = await createStampedHeldRoot(temporaryRoot);
    await Promise.all([runAndRequireClean(temporaryRoot), runAndRequireClean(temporaryRoot)]);
    await access(held.root);

    await writeFile(held.releasePath, "release\n");
    await held.exited;
    await runAndRequireClean(temporaryRoot);
    await assertMissing(held.root, "recovery must reclaim a stamped root once its child process group is dead");

    t.diagnostic("real suite-runner recovery reclaimed a dead parent-pending root, retained hand-off uncertainty and a live stamped child group, then reclaimed the stamped root after release");
  } finally {
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
  const parent = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    parent.once("error", reject);
    parent.once("exit", () => resolve());
  });
  assert.ok(parent.pid, "the finished parent must have had a process id");
  assert.throws(() => process.kill(parent.pid!, 0), { code: "ESRCH" });
  return mkdtemp(path.join(temporaryRoot, `ensemble-test-suite-pending-parent-${parent.pid}-`));
}

async function createStampedHeldRoot(temporaryRoot: string): Promise<{ root: string; releasePath: string; exited: Promise<void> }> {
  const controlDirectory = await mkdtemp(path.join(temporaryRoot, "control-"));
  const readyPath = path.join(controlDirectory, "ready");
  const releasePath = path.join(controlDirectory, "release");
  const child = spawn(process.execPath, ["-e", heldChildProgram], {
    detached: true,
    env: { ...process.env, READY_PATH: readyPath, RELEASE_PATH: releasePath },
    stdio: "ignore"
  });
  assert.ok(child.pid, "the detached child must have a process-group id");
  const root = await mkdtemp(path.join(temporaryRoot, "ensemble-test-suite-complete-"));
  await writeFile(path.join(root, "owner.json"), `${JSON.stringify({ childProcessGroup: child.pid })}\n`);
  await waitForFile(readyPath);
  return {
    root,
    releasePath,
    exited: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    })
  };
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
