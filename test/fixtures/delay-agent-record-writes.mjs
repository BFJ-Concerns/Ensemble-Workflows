import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout } from "node:timers";

const writeFile = fs.promises.writeFile;

fs.promises.writeFile = async function delayAgentRecordWrite(file, ...args) {
  if (path.basename(String(file)).startsWith(".agent.json")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return writeFile.call(this, file, ...args);
};

syncBuiltinESMExports();
