import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

try {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (extra.length > 0) throw new Error("too many arguments");
  if (command === "digest" && argument === undefined) {
    process.stdout.write(`${digest(readFileSync(path.join(root, "skills/ensemble-workflow/Base/scripts/ensemble.mjs")))}\n`);
  } else if (command === "read") {
    const tag = argument ?? process.env.RELEASE_TAG;
    if (typeof tag !== "string" || tag !== tag.trim() || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
      throw new Error("read needs a v<x.y.z> tag (argument or RELEASE_TAG)");
    }
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const repo = /^git\+https:\/\/github\.com\/(.+?)\.git$/.exec(pkg.repository?.url ?? "")?.[1];
    if (!repo) throw new Error("package.json must name a GitHub repository.url");
    const gh = (...args) => execFileSync("gh", [...args, "--repo", repo], { maxBuffer: 64 * 1024 * 1024 });
    const release = JSON.parse(gh("release", "view", tag, "--json", "tagName,isDraft").toString("utf8"));
    if (release.isDraft !== false || release.tagName !== tag) throw new Error(`${tag} is not a published release`);
    const download = (name) => gh("release", "download", tag, "--pattern", name, "--output", "-");
    const hash = digest(download("ensemble.mjs"));
    if (download("SHA256SUMS").toString("utf8") !== `${hash}  ensemble.mjs\n`) {
      throw new Error(`${tag} SHA256SUMS does not match its launcher`);
    }
    process.stdout.write(`${hash}\n`);
  } else {
    throw new Error("usage: node scripts/release-artifact.mjs digest | read [v<x.y.z>]");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
