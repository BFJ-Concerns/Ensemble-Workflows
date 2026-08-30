import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { hermeticEstateEnvironment, runNode } from "./estate-process.js";

const runnerPath = path.resolve("scripts/run-test-suite.mjs");
const colouredFixturePath = path.resolve("test/fixtures/suite-runner/coloured-output.test.mjs");
const runnerStripPreloadPath = path.resolve("test/fixtures/suite-runner/strip-runner-output-preload.mjs");
const pipeHolderParentPath = path.resolve("test/fixtures/suite-runner/pipe-holder-parent.mjs");
const sgrSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`);
const completionGuardMilliseconds = 5_000;

test("suite runner observes SGR output, and the assertion rejects a runner-boundary colour suppression", async () => {
  const observed = await runNode([runnerPath, colouredFixturePath], { NODE_TEST_CONTEXT: undefined });
  assert.equal(observed.code, 0, observed.stderr);
  assertRunnerObservedSgr(observed.stdout, observed.stderr);
  assert.equal(
    (await readFile(runnerPath, "utf8")).includes("ansiSgrSequence"),
    false,
    "the runner must not retain a dormant ANSI-strip branch"
  );

  const suppressed = await runNode([runnerPath, colouredFixturePath], {
    NODE_OPTIONS: `--import=${runnerStripPreloadPath}`,
    NODE_TEST_CONTEXT: undefined
  });
  assert.equal(suppressed.code, 0, suppressed.stderr);
  assert.throws(
    () => assertRunnerObservedSgr(suppressed.stdout, suppressed.stderr),
    /expected the suite runner to receive an SGR sequence/
  );
});

test("suite runner delivers a descendant's trailing marker after its test child exits", async () => {
  await withPipeHolder(async (pipeHolder) => {
    const run = startSuite(pipeHolder);
    try {
      await waitForFile(pipeHolder.readyPath);
      await writeFile(pipeHolder.releasePath, "release\n");
      const result = await awaitCompletion(run.completed, "runner did not finish after its pipe holder was released");
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /SUITE_RUNNER_TRAILING_MARKER/);
    } finally {
      await releasePipeHolder(pipeHolder);
      await stopSuite(run);
    }
  });
});

test("suite runner bounds its close wait when a detached descendant retains its pipe", async () => {
  await withPipeHolder(async (pipeHolder) => {
    const run = startSuite(pipeHolder);
    try {
      await waitForFile(pipeHolder.readyPath);
      const result = await awaitCompletion(run.completed, "runner remained blocked on a descendant-held pipe");
      assert.equal(result.code, 0, result.output);
      assert.doesNotMatch(result.output, /SUITE_RUNNER_TRAILING_MARKER/);
    } finally {
      await releasePipeHolder(pipeHolder);
      await stopSuite(run);
    }
  });
});

function assertRunnerObservedSgr(stdout: string, stderr: string): void {
  assert.match(`${stdout}${stderr}`, sgrSequence, "expected the suite runner to receive an SGR sequence");
}

async function withPipeHolder(run: (pipeHolder: PipeHolder) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-suite-runner-robustness-"));
  const pipeHolder = {
    directory,
    readyPath: path.join(directory, "ready"),
    releasePath: path.join(directory, "release")
  };
  try {
    await run(pipeHolder);
  } finally {
    await releasePipeHolder(pipeHolder);
    await rm(directory, { recursive: true, force: true });
  }
}

interface PipeHolder {
  directory: string;
  readyPath: string;
  releasePath: string;
}

function startSuite(pipeHolder: PipeHolder) {
  const child = spawn(process.execPath, [runnerPath], {
    env: hermeticEstateEnvironment({
      ENSEMBLE_SUITE_PIPE_HOLDER_READY_PATH: pipeHolder.readyPath,
      ENSEMBLE_SUITE_PIPE_HOLDER_RELEASE_PATH: pipeHolder.releasePath,
      ENSEMBLE_SUITE_TEST_CHILD_PROGRAM: pipeHolderParentPath,
      NODE_TEST_CONTEXT: undefined
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

async function stopSuite(run: ReturnType<typeof startSuite>): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGTERM");
  await run.completed.catch(() => undefined);
}

async function releasePipeHolder(pipeHolder: PipeHolder): Promise<void> {
  await writeFile(pipeHolder.releasePath, "release\n");
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + completionGuardMilliseconds;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`timed out waiting for ${file}`);
}

async function awaitCompletion<T>(completion: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), completionGuardMilliseconds);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
