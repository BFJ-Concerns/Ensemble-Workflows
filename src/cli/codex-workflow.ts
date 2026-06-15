#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCodexWorkflowCli } from "../cli.js";

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);

if (isMain) {
  const exitCode = await runCodexWorkflowCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
