import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const validVersion = (value) => typeof value === "string" && value === value.trim() && versionPattern.test(value);
const readJson = (name) => JSON.parse(readFileSync(path.join(root, name), "utf8"));
const writeJson = (name, value) => writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);

function check(tag) {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  if (!validVersion(pkg.version)) throw new Error("package.json version must be x.y.z without leading zeroes");
  const reported = execFileSync(process.execPath, [launcher, "--version"], { encoding: "utf8" }).trim();
  for (const [name, value] of [
    ["package-lock.json", lock.version],
    ["package-lock.json root package", lock.packages?.[""]?.version],
    ["launcher --version", reported]
  ]) {
    if (value !== pkg.version) throw new Error(`${name} reports ${value}; package.json reports ${pkg.version}`);
  }
  if (tag !== undefined && tag !== `v${pkg.version}`) {
    throw new Error(`release tag ${tag} must be v${pkg.version}`);
  }
  return pkg.version;
}

try {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (extra.length > 0) throw new Error("too many arguments");
  if (command === "check") {
    process.stdout.write(`${check(argument)}\n`);
  } else if (command === "bump") {
    const version = argument ?? process.env.RELEASE_VERSION;
    if (!validVersion(version)) {
      throw new Error("bump needs an x.y.z version without leading zeroes (argument or RELEASE_VERSION)");
    }
    const pkg = readJson("package.json");
    const lock = readJson("package-lock.json");
    if (!lock.packages?.[""]) throw new Error("package-lock.json is missing the root package");
    pkg.version = lock.version = lock.packages[""].version = version;
    writeJson("package.json", pkg);
    writeJson("package-lock.json", lock);
    execFileSync(process.execPath, [path.join(root, "scripts/build-skill.mjs")], { cwd: root, stdio: "inherit" });
    process.stdout.write(`${check()}\n`);
  } else {
    throw new Error("usage: node scripts/release-version.mjs check [v<x.y.z>] | bump [<x.y.z>]");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
