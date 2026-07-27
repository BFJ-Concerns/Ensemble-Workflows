#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runEnsembleCli } from "../cli.js";
import { nodeVersionError } from "../node-version.js";

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);

if (isMain) {
  const versionError = nodeVersionError();
  if (versionError !== null) {
    process.stderr.write(`${versionError}\n`);
    process.exitCode = 1;
  } else {
    const cwd = process.cwd();
    const exitCode = await runEnsembleCli(process.argv.slice(2), {
      cwd
    });
    process.exitCode = exitCode;
  }
}
