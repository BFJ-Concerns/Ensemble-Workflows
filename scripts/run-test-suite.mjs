import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const schemaCacheDirectory = await mkdtemp(path.join(tmpdir(), "ensemble-codex-schema-"));
const child = spawn(process.execPath, ["--test", "dist/test/**/*.test.js"], {
  env: { ...process.env, ENSEMBLE_CODEX_SCHEMA_CACHE_DIRECTORY: schemaCacheDirectory },
  stdio: "inherit"
});

let cleaning = false;
async function finish(code, signal) {
  if (cleaning) return;
  cleaning = true;
  await rm(schemaCacheDirectory, { recursive: true, force: true });
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
