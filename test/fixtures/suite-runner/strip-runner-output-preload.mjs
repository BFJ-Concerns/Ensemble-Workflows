import process from "node:process";

const ansiSgrSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

if (process.argv[1]?.endsWith("scripts/run-test-suite.mjs")) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => write(String(chunk).replace(ansiSgrSequence, ""), ...rest);
}
