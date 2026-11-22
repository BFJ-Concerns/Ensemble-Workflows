import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import process from "node:process";

const controlPath = process.env.ENSEMBLE_WORKFLOW_TIMEOUT_CONTROL;
if (controlPath === undefined) throw new Error("workflow timeout control path is required");

// Count committed publications in the CLI process. File watchers can
// coalesce events, and write duration varies independently of batching.
let publications = 0;
const rename = fs.promises.rename;
fs.promises.rename = async function countManifestPublication(source, destination) {
  await rename(source, destination);
  if (path.basename(String(destination)) === "manifest.json") publications += 1;
};
syncBuiltinESMExports();

process.on("exit", () => fs.appendFileSync(controlPath, `manifest-publications:${publications}\n`));
