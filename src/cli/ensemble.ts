#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runEnsembleCli } from "../cli.js";
import { resolveStatusDir } from "../status-config.js";

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);

if (isMain) {
  // Resolve the status side-channel once at the edge, so the run that publishes
  // the snapshot and a `--statusline` invocation read the same directory.
  const exitCode = await runEnsembleCli(process.argv.slice(2), {
    statusDir: resolveStatusDir(process.env, homedir())
  });
  process.exitCode = exitCode;
}
