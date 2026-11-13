import { chmodSync, writeFileSync } from "node:fs";
import process from "node:process";

const writeStderr = process.stderr.write.bind(process.stderr);

process.stderr.write = (chunk, ...args) => {
  // The sentinel is announced after configuration validation, before the
  // first status write. Deny publication at that boundary so the reporter
  // is exercised without making the run's configuration invalid.
  if (String(chunk).startsWith("[sentinel] will write ")) {
    chmodSync(process.env.ENSEMBLE_STATUS_DIR, 0o500);
  }
  if (String(chunk).includes("[status]")) {
    writeFileSync(`${process.env.ENSEMBLE_STATUS_DIR}.reporter-threw`, "ESTATE_THROWING_STATUS_REPORTER\n");
    throw new Error("ESTATE_THROWING_STATUS_REPORTER");
  }
  return writeStderr(chunk, ...args);
};
