import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

// Suites nest legitimately exactly once: a gate-run suite contains estate
// tests that each spawn this runner over a single leaf test file, and no leaf
// spawns the runner again. A runner starting at depth 2 or beyond therefore
// means a suite is running inside a suite-spawned suite — the signature of a
// recursive spawn storm (a child that resolved to the whole suite glob rather
// than its intended leaf), which multiplies process trees exponentially and
// has taken down the host. Refuse before creating any state or process.
const inheritedSuiteDepth = Number(process.env.ENSEMBLE_SUITE_RUNNER_DEPTH ?? "0");
if (!Number.isInteger(inheritedSuiteDepth) || inheritedSuiteDepth < 0 || inheritedSuiteDepth >= 2) {
  process.stderr.write(
    `Suite runner refused to start: ENSEMBLE_SUITE_RUNNER_DEPTH=${process.env.ENSEMBLE_SUITE_RUNNER_DEPTH} — a suite is already running inside a suite-spawned suite, so another runner here is a recursive spawn storm, not a legitimate estate child\n`
  );
  process.exit(1);
}

const testGlob = process.argv[2] ?? "dist/test/**/*.test.js";
const ansiSgrSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
// A descendant can retain the test process's output pipe after that process
// exits. Keep accepting its final output, but do not let that inherited pipe
// hold the gate open indefinitely.
const childCloseGraceMilliseconds = 1_000;
// A suite should complete in minutes, not hours. Keep an unstamped hand-off
// root for two hours so a recovery never races its owner, while ensuring a
// wrapper killed between hand-off and stamping cannot leak the directory forever.
const unstampedHandoffRetentionMilliseconds = 2 * 60 * 60 * 1_000;
// A gate invocation owns a private hand-off namespace. Recovery scans the
// shared temporary root for abandoned namespaces, but its ownership checks
// retain every live or indeterminate hand-off so concurrent suites cannot
// reclaim one another's state.
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ensemble-test-suite-run-"));
await recoverFinishedSuites(tmpdir());
const pendingSuiteDirectory = await mkdtemp(path.join(temporaryRoot, pendingSuitePrefix(process.pid)));
await mkdir(path.join(pendingSuiteDirectory, "schema-cache"));
// The whole suite writes run records to a per-run temp store, so a test that
// forgets to isolate itself cannot pollute the durable archive by omission
// (22,127 fixture runs had accumulated there against ~4,200 real ones). An
// ENSEMBLE_RUN_RECORD_DIR already set by the invoker is a deliberate choice
// and wins; tests that set their own stores are likewise unaffected.
await mkdir(path.join(pendingSuiteDirectory, "run-records"));
const suiteDirectory = path.join(temporaryRoot, handoffSuiteName(path.basename(pendingSuiteDirectory)));
// The move makes the pre-spawn hand-off explicit. A later recovery can reclaim
// a dead parent-owned pending root, but must retain this indeterminate state:
// spawn may have succeeded even when its child ownership stamp was not written.
await rename(pendingSuiteDirectory, suiteDirectory);
const schemaCacheDirectory = path.join(suiteDirectory, "schema-cache");
const recordStoreDirectory = path.join(suiteDirectory, "run-records");
// Test-only: estates that need to coordinate a real runner child can install
// a direct child without changing the runner they exercise. The explicit
// context marker prevents an ambient variable from replacing the gate child.
const suiteTestChildProgram =
  process.env.ENSEMBLE_SUITE_TEST_CONTEXT === "1" ? process.env.ENSEMBLE_SUITE_TEST_CHILD_PROGRAM : undefined;
const child = spawn(
  process.execPath,
  suiteTestChildProgram === undefined ? ["--test", "--test-reporter=tap", testGlob] : [suiteTestChildProgram],
  {
  env: {
    ENSEMBLE_RUN_RECORD_DIR: recordStoreDirectory,
    ...process.env,
    TMPDIR: suiteDirectory,
    ENSEMBLE_CODEX_SCHEMA_CACHE_DIRECTORY: schemaCacheDirectory,
    ENSEMBLE_SUITE_RUNNER_DEPTH: String(inheritedSuiteDepth + 1)
  },
  stdio: ["inherit", "pipe", "pipe"],
  // A killed suite parent can leave its test process behind. Giving that
  // process group a durable identity lets a later suite distinguish a live
  // cache owner from abandoned state before it removes anything.
    detached: true
  }
);
let childOutput = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  childOutput += chunk;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  childOutput += chunk;
  process.stderr.write(chunk);
});
const childClosed = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (...result) => resolve(result));
});
const childExited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (...result) => resolve(result));
});
let completeSetup;
const setupComplete = new Promise((resolve) => {
  completeSetup = resolve;
});

let cleaning = false;
async function finish(code, signal) {
  if (cleaning) return;
  cleaning = true;
  await setupComplete;
  if (signal !== null && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    await childClosed.catch(() => undefined);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
  if (signal !== null) {
    process.kill(process.pid, signal);
  }
  process.exitCode = code ?? 1;
}

childExited.then(async ([code, signal]) => {
  const streamsClosed = await waitForChildStreamsOrGrace();
  if (!streamsClosed) {
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  const tapOutput = childOutput.replace(ansiSgrSequence, "");
  if (code === 0 && /(?:^|\n)# tests 0(?:\n|$)/.test(tapOutput)) {
    process.stderr.write("Test suite matched no tests\n");
    return finish(1, signal);
  }
  return finish(code, signal);
}).catch(async (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  await finish(1, null);
});

async function waitForChildStreamsOrGrace() {
  let graceTimer;
  try {
    return await Promise.race([
      childClosed.then(() => true),
      new Promise((resolve) => {
        graceTimer = setTimeout(() => resolve(false), childCloseGraceMilliseconds);
      })
    ]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void finish(null, signal);
  });
}

const testPausePath = process.env.ENSEMBLE_SUITE_TEST_PAUSE_AFTER_CHILD_SPAWN_PATH;
try {
  if (testPausePath !== undefined) {
    await writeFile(`${testPausePath}.child-pid`, `${child.pid}\n`);
    const testPauseDeadline = Date.now() + 20_000;
    let testPauseReleased = false;
    while (Date.now() < testPauseDeadline) {
      try {
        await readFile(testPausePath);
        testPauseReleased = true;
        break;
      } catch {
        await delay(10);
      }
    }
    if (!testPauseReleased) throw new Error("timed out waiting for the suite hand-off test pause");
  }
  await writeFile(path.join(suiteDirectory, "owner.json"), `${JSON.stringify({ childProcessGroup: child.pid })}\n`);
} finally {
  completeSetup();
}

async function recoverFinishedSuites(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("ensemble-test-suite-"))
      .map(async (entry) => {
        const suiteDirectory = path.join(directory, entry.name);
        if (entry.name.startsWith("ensemble-test-suite-run-")) {
          await recoverSuiteNamespace(suiteDirectory);
          return;
        }
        const pendingParentProcess = pendingParentProcessId(entry.name);
        if (pendingParentProcess !== null) {
          if (await processIsDead(pendingParentProcess)) {
            await rm(suiteDirectory, { recursive: true, force: true });
          }
          return;
        }
        const ownerPath = path.join(suiteDirectory, "owner.json");
        let owner;
        try {
          owner = JSON.parse(await readFile(ownerPath, "utf8"));
        } catch {
          if (isHandoffSuite(entry.name)) {
            // The detached child may exist without its durable process-group
            // stamp. Retain a plausibly live hand-off, but bound the leak from
            // a wrapper that died before it could write the ownership record.
            if (await directoryAgeMilliseconds(suiteDirectory) > unstampedHandoffRetentionMilliseconds) {
              await rm(suiteDirectory, { recursive: true, force: true });
            }
            return;
          }
          // A root without our complete ownership record might be a suite in
          // the small creation window. Leave it for its owner or a later pass.
          return;
        }
        if (!Number.isInteger(owner.childProcessGroup) || owner.childProcessGroup <= 0) return;
        try {
          process.kill(-owner.childProcessGroup, 0);
          return;
        } catch (error) {
          if (error?.code !== "ESRCH") return;
        }
        await rm(suiteDirectory, { recursive: true, force: true });
      })
  );
}

async function recoverSuiteNamespace(namespace) {
  let entries;
  try {
    entries = await readdir(namespace, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  // An empty namespace can belong to a wrapper that has just created its
  // private root. Only remove it after this pass actually saw hand-off state;
  // that makes cleanup safe across the root-creation window.
  const sawSuiteState = entries.some((entry) => entry.isDirectory() && entry.name.startsWith("ensemble-test-suite-"));
  await recoverFinishedSuites(namespace);
  if (!sawSuiteState) return;
  try {
    if ((await readdir(namespace)).length === 0) await rm(namespace, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function directoryAgeMilliseconds(directory) {
  const { mtimeMs } = await stat(directory);
  return Date.now() - mtimeMs;
}

function pendingSuitePrefix(parentProcess) {
  return `ensemble-test-suite-pending-parent-${parentProcess}-`;
}

function handoffSuiteName(pendingName) {
  return `ensemble-test-suite-handoff-${pendingName.slice("ensemble-test-suite-".length)}`;
}

function pendingParentProcessId(name) {
  const match = /^ensemble-test-suite-pending-parent-([1-9]\d*)-/.exec(name);
  return match === null ? null : Number(match[1]);
}

function isHandoffSuite(name) {
  return name.startsWith("ensemble-test-suite-handoff-");
}

async function processIsDead(processId) {
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}
