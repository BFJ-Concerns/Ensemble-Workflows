import process from "node:process";

const writeStderr = process.stderr.write.bind(process.stderr);

process.stderr.write = (chunk, ...args) => {
  if (String(chunk).includes("[status]")) {
    throw new Error("ESTATE_THROWING_STATUS_REPORTER");
  }
  return writeStderr(chunk, ...args);
};
