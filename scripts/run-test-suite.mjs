import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const testGlob = process.argv[2] ?? "dist/test/**/*.test.js";
const temporaryRoot = tmpdir();
await recoverFinishedSuites(temporaryRoot);
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
const child = spawn(process.execPath, ["--test", testGlob], {
  env: {
    ENSEMBLE_RUN_RECORD_DIR: recordStoreDirectory,
    ...process.env,
    TMPDIR: suiteDirectory,
    ENSEMBLE_CODEX_SCHEMA_CACHE_DIRECTORY: schemaCacheDirectory
  },
  stdio: "inherit",
  // A killed suite parent can leave its test process behind. Giving that
  // process group a durable identity lets a later suite distinguish a live
  // cache owner from abandoned state before it removes anything.
  detached: true
});
const childExit = new Promise((resolve, reject) => {
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
    await childExit.catch(() => undefined);
  }
  await rm(suiteDirectory, { recursive: true, force: true });
  if (signal !== null) {
    process.kill(process.pid, signal);
  }
  process.exitCode = code ?? 1;
}

childExit.then(([code, signal]) => void finish(code, signal)).catch(async (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  await finish(1, null);
});

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
            // stamp. This is deliberately unrecoverable until a later owner
            // cleans it, rather than risking removal of a live suite.
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
