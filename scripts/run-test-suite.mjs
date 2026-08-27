import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const testGlob = process.argv[2] ?? "dist/test/**/*.test.js";
const temporaryRoot = tmpdir();
await recoverFinishedSuites(temporaryRoot);
const suiteDirectory = await mkdtemp(path.join(temporaryRoot, "ensemble-test-suite-"));
const schemaCacheDirectory = path.join(suiteDirectory, "schema-cache");
await mkdir(schemaCacheDirectory);
// The whole suite writes run records to a per-run temp store, so a test that
// forgets to isolate itself cannot pollute the durable archive by omission
// (22,127 fixture runs had accumulated there against ~4,200 real ones). An
// ENSEMBLE_RUN_RECORD_DIR already set by the invoker is a deliberate choice
// and wins; tests that set their own stores are likewise unaffected.
const recordStoreDirectory = path.join(suiteDirectory, "run-records");
await mkdir(recordStoreDirectory);
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
await writeFile(path.join(suiteDirectory, "owner.json"), `${JSON.stringify({ childProcessGroup: child.pid })}\n`);

let cleaning = false;
async function finish(code, signal) {
  if (cleaning) return;
  cleaning = true;
  if (signal !== null && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(suiteDirectory, { recursive: true, force: true });
  if (signal !== null) {
    process.kill(process.pid, signal);
  }
  process.exitCode = code ?? 1;
}

child.once("error", async (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  await finish(1, null);
});
child.once("exit", (code, signal) => void finish(code, signal));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void finish(null, signal);
  });
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
        const ownerPath = path.join(suiteDirectory, "owner.json");
        let owner;
        try {
          owner = JSON.parse(await readFile(ownerPath, "utf8"));
        } catch {
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
