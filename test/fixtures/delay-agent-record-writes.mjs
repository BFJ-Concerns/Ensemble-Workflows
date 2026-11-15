import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";

const writeFile = fs.promises.writeFile;
// With the workflow-timeout release preload, the first delayed agent-record
// write marks the run ready: the deadline then lands while dispatch records
// are still being written, however long the script took to load.
const controlPath = process.env.ENSEMBLE_WORKFLOW_TIMEOUT_CONTROL;
let readyMarked = false;

fs.promises.writeFile = async function delayAgentRecordWrite(file, ...args) {
  if (path.basename(String(file)).startsWith(".agent.json")) {
    if (controlPath !== undefined && !readyMarked) {
      readyMarked = true;
      fs.appendFileSync(controlPath, "ready\n");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return writeFile.call(this, file, ...args);
};

syncBuiltinESMExports();
