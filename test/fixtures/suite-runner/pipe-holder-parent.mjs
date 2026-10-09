import { spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
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
// The test reads the PID as soon as the marker exists, so the marker must
// appear complete: write it beside the final path, then rename it into place.
const readyPath = process.env.ENSEMBLE_SUITE_PIPE_HOLDER_READY_PATH;
await writeFile(`${readyPath}.partial`, `${descendant.pid}\n`);
await rename(`${readyPath}.partial`, readyPath);
process.exit(0);
