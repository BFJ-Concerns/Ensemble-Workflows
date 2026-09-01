import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { hermeticEstateEnvironment, runNode } from "./estate-process.js";

const runnerPath = path.resolve("scripts/run-test-suite.mjs");
const colouredEmptySuiteChildPath = path.resolve("test/fixtures/suite-runner/coloured-empty-suite-child.mjs");
const pipeHolderParentPath = path.resolve("test/fixtures/suite-runner/pipe-holder-parent.mjs");
const completionGuardMilliseconds = 5_000;
const promptExitMilliseconds = 500;

test("suite runner ignores an ambient direct-child override outside its test context", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-suite-runner-ambient-child-"));
  try {
    const childProgram = path.join(directory, "empty-child.mjs");
    await writeFile(childProgram, "");
    const result = await runNode([runnerPath, path.join(directory, "empty/**/*.test.js")], {
      ENSEMBLE_SUITE_TEST_CHILD_PROGRAM: childProgram,
      NODE_TEST_CONTEXT: undefined
    });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Test suite matched no tests/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("suite runner rejects an SGR-coloured empty-suite summary from its guarded direct child", async () => {
  const result = await runNode([runnerPath, colouredEmptySuiteChildPath], {
    ENSEMBLE_SUITE_TEST_CHILD_PROGRAM: colouredEmptySuiteChildPath,
    ENSEMBLE_SUITE_TEST_CONTEXT: "1",
    NODE_TEST_CONTEXT: undefined
  });
  assert.equal(result.code, 1, result.stderr);
  const payload = "\u001B[32m# tests 0\u001B[39m\n";
  assert.equal(result.stdout, payload, "expected the runner to preserve the coloured empty-suite payload byte-for-byte");
  assert.match(result.stderr, /Test suite matched no tests/);
});

test("suite runner does not mistake a non-SGR CSI sequence for an empty-suite summary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-suite-runner-non-sgr-"));
  try {
    const childProgram = path.join(directory, "non-sgr-empty-suite-child.mjs");
    const payload = "\u001B[?m# tests 0\n";
    await writeFile(childProgram, `import process from "node:process"; process.stdout.write(${JSON.stringify(payload)});`);
    const result = await runNode([runnerPath, childProgram], {
      ENSEMBLE_SUITE_TEST_CHILD_PROGRAM: childProgram,
      ENSEMBLE_SUITE_TEST_CONTEXT: "1",
      NODE_TEST_CONTEXT: undefined
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, payload);
    assert.doesNotMatch(result.stderr, /Test suite matched no tests/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("suite runner delivers a descendant's trailing marker after its test child exits", async () => {
  await withPipeHolder(async (pipeHolder) => {
    const run = startSuite(pipeHolder);
    try {
      await waitForFile(pipeHolder.readyPath);
      await writeFile(pipeHolder.releasePath, "release\n");
      const releasedAt = Date.now();
      const result = await awaitCompletion(run.completed, "runner did not finish after its pipe holder was released");
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /SUITE_RUNNER_TRAILING_MARKER/);
      assert.ok(Date.now() - releasedAt < promptExitMilliseconds, "runner waited for its full close grace after streams closed normally");
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

test("concurrent suite runners keep their hand-off state in separate namespaces", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-suite-runner-concurrent-"));
  const childProgram = path.join(directory, "successful-child.mjs");
  const firstPause = path.join(directory, "first-pause");
  const secondPause = path.join(directory, "second-pause");
  await writeFile(childProgram, "");
  const first = startPausedSuite(directory, firstPause, childProgram);
  try {
    await waitForFile(`${firstPause}.child-pid`);
    const [firstNamespace] = await suiteNamespaces(directory);
    assert.ok(firstNamespace, "the first suite needs a private namespace before the second recovery scan starts");
    const firstHandoff = await onlyHandoffDirectory(path.join(directory, firstNamespace));

    // Starting the second runner exercises its real shared-root recovery pass
    // while the first wrapper is paused after spawning its child but before it
    // can write owner.json. That pre-stamp hand-off must remain untouched.
    const second = startPausedSuite(directory, secondPause, childProgram);
    try {
      await waitForFile(`${secondPause}.child-pid`);
      await access(firstHandoff);
      const namespaces = await suiteNamespaces(directory);
      assert.equal(namespaces.length, 2);
      assert.ok(namespaces.includes(firstNamespace));
      assert.ok(namespaces.every((name) => name.startsWith("ensemble-test-suite-run-")));

      await Promise.all([writeFile(firstPause, "release\n"), writeFile(secondPause, "release\n")]);
      const [firstResult, secondResult] = await Promise.all([
        awaitCompletion(first.completed, "first concurrent suite did not finish"),
        awaitCompletion(second.completed, "second concurrent suite did not finish")
      ]);
      assert.equal(firstResult.code, 0, firstResult.output);
      assert.equal(secondResult.code, 0, secondResult.output);
      assert.deepEqual(await suiteNamespaces(directory), [], "each completed runner must remove only its own namespace");
    } finally {
      await writeFile(secondPause, "release\n");
      await stopSuite(second);
    }
  } finally {
    await writeFile(firstPause, "release\n");
    await stopSuite(first);
    await rm(directory, { recursive: true, force: true });
  }
});

async function suiteNamespaces(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("ensemble-test-suite-run-"))
    .map((entry) => entry.name);
}

async function onlyHandoffDirectory(namespace: string): Promise<string> {
  const handoffs = (await readdir(namespace, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("ensemble-test-suite-handoff-"));
  assert.equal(handoffs.length, 1, "the paused suite must expose exactly one pre-stamp hand-off directory");
  return path.join(namespace, handoffs[0]!.name);
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
  const child = spawn(process.execPath, [runnerPath, pipeHolderParentPath], {
    env: hermeticEstateEnvironment({
      ENSEMBLE_SUITE_PIPE_HOLDER_READY_PATH: pipeHolder.readyPath,
      ENSEMBLE_SUITE_PIPE_HOLDER_RELEASE_PATH: pipeHolder.releasePath,
      ENSEMBLE_SUITE_TEST_CHILD_PROGRAM: pipeHolderParentPath,
      ENSEMBLE_SUITE_TEST_CONTEXT: "1",
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

function startPausedSuite(temporaryDirectory: string, pausePath: string, childProgram: string) {
  const child = spawn(process.execPath, [runnerPath, childProgram], {
    env: hermeticEstateEnvironment({
      TMPDIR: temporaryDirectory,
      ENSEMBLE_SUITE_TEST_CHILD_PROGRAM: childProgram,
      ENSEMBLE_SUITE_TEST_CONTEXT: "1",
      ENSEMBLE_SUITE_TEST_PAUSE_AFTER_CHILD_SPAWN_PATH: pausePath,
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
