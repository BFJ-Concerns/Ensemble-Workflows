import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const testGlob = process.argv[2] ?? "dist/test/**/*.test.js";
const schemaCacheDirectory = await mkdtemp(path.join(tmpdir(), "ensemble-codex-schema-"));
// The whole suite writes run records to a per-run temp store, so a test that
// forgets to isolate itself cannot pollute the durable archive by omission
// (22,127 fixture runs had accumulated there against ~4,200 real ones). An
// ENSEMBLE_RUN_RECORD_DIR already set by the invoker is a deliberate choice
// and wins; tests that set their own stores are likewise unaffected.
const recordStoreDirectory = await mkdtemp(path.join(tmpdir(), "ensemble-test-run-records-"));
const child = spawn(process.execPath, ["--test", testGlob], {
  env: {
    ENSEMBLE_RUN_RECORD_DIR: recordStoreDirectory,
    ...process.env,
    ENSEMBLE_CODEX_SCHEMA_CACHE_DIRECTORY: schemaCacheDirectory
  },
  stdio: "inherit"
});

let cleaning = false;
async function finish(code, signal) {
  if (cleaning) return;
  cleaning = true;
  await rm(schemaCacheDirectory, { recursive: true, force: true });
  await rm(recordStoreDirectory, { recursive: true, force: true });
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
    child.kill(signal);
    void finish(null, signal);
  });
}
