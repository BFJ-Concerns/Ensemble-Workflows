import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const descendant = spawn(process.execPath, [path.join(fixtureDirectory, "pipe-holder-descendant.mjs")], {
  detached: true,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"]
});
descendant.unref();
await writeFile(process.env.ENSEMBLE_SUITE_PIPE_HOLDER_READY_PATH, `${descendant.pid}\n`);
process.exit(0);
