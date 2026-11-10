import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { TestContext } from "node:test";

const launcherPath = "skills/ensemble-workflow/Base/scripts/ensemble.mjs";

async function checkout(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ensemble-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["scripts", "package.json", "package-lock.json", "THIRD_PARTY_NOTICES", "src", launcherPath]) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.resolve(name), target, { recursive: true });
  }
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  return root;
}

function run(root: string, script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    // Commands resolve their checkout from the script, regardless of cwd.
    cwd: path.dirname(root),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000
  });
}

test("the version check rejects stale metadata and launcher reports without rebuilding", async (t) => {
  const root = await checkout(t);
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
  const lockPath = path.join(root, "package-lock.json");
  const originalLock = await readFile(lockPath, "utf8");
  const versionCheck = (...args: string[]) => run(root, "release-version.mjs", ["check", ...args]);
  const good = versionCheck(`v${pkg.version}`);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout, `${pkg.version}\n`);
  assert.equal(versionCheck("v99.99.99").status, 1);
  assert.equal(versionCheck(pkg.version).status, 1);

  for (const surface of ["lock", "root"]) {
    const lock = JSON.parse(originalLock) as { version: string; packages: Record<string, { version: string }> };
    if (surface === "lock") lock.version = "99.99.99";
    else lock.packages[""]!.version = "99.99.99";
    await writeFile(lockPath, JSON.stringify(lock));
    const result = versionCheck();
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /package-lock.json.*reports 99.99.99/);
  }
  await writeFile(lockPath, originalLock);
  const launcher = path.join(root, launcherPath);
  await writeFile(launcher, "console.log('99.99.99');\n");
  const stale = versionCheck();
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /launcher --version reports 99.99.99/);
  assert.equal(await readFile(launcher, "utf8"), "console.log('99.99.99');\n");
});

test("bumping rebuilds a portable launcher and agrees with package and lockfile versions", async (t) => {
  const root = await checkout(t);
  const result = run(root, "release-version.mjs", ["bump"], { RELEASE_VERSION: "2.3.4" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "2.3.4\n");
  const checked = run(root, "release-version.mjs", ["check", "v2.3.4"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout, "2.3.4\n");
  const portable = path.join(root, "portable.mjs");
  await cp(path.join(root, launcherPath), portable);
  const reported = spawnSync(process.execPath, [portable, "--version"], { encoding: "utf8" });
  assert.equal(reported.status, 0, reported.stderr);
  assert.equal(reported.stdout, "2.3.4\n");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")) as {
    version: string; packages: Record<string, { version: string }>;
  };
  assert.equal(pkg.version, "2.3.4");
  assert.equal(lock.version, "2.3.4");
  assert.equal(lock.packages[""]!.version, "2.3.4");
});

test("invalid release versions are refused before any files change", async (t) => {
  const root = await checkout(t);
  const before = await readFile(path.join(root, "package.json"), "utf8");
  for (const version of ["v1.2.3", "01.2.3", "1.2", "1.2.3-beta.1", "1.2.3\n"]) {
    const result = run(root, "release-version.mjs", ["bump", version]);
    assert.equal(result.status, 1, version);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(path.join(root, "package.json"), "utf8"), before);
  }
});

test("release read-back hashes downloaded bytes and rejects drafts, missing assets and corrupt checksums", async (t) => {
  const root = await checkout(t);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const bytes = Buffer.from("published launcher\n\u0000\ufffd");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(bin, "gh"), `#!${process.execPath}
import process from 'node:process';
const args = process.argv.slice(2);
if (args.at(-2) !== '--repo' || args.at(-1) !== 'BFJ-Concerns/Ensemble-Workflows') process.exit(8);
if (process.env.RELEASE_TEST_MODE === 'absent') process.exit(1);
if (args[1] === 'view') {
  process.stdout.write(JSON.stringify({ tagName: args[2], isDraft: process.env.RELEASE_TEST_MODE === 'draft' }));
} else if (args[1] === 'download') {
  const name = args[args.indexOf('--pattern') + 1];
  if (process.env.RELEASE_TEST_MODE === 'missing') process.exit(1);
  process.stdout.write(name === 'ensemble.mjs' ? Buffer.from('${bytes.toString("base64")}', 'base64') :
    (process.env.RELEASE_TEST_MODE === 'corrupt' ? 'corrupt checksum' : '${hash}  ensemble.mjs\\n'));
} else process.exit(9);
`, { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, RELEASE_TAG: "v2.3.4" };
  const good = run(root, "release-artifact.mjs", ["read"], env);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout, `${hash}\n`);
  const local = run(root, "release-artifact.mjs", ["digest"]);
  assert.equal(local.status, 0, local.stderr);
  assert.equal(local.stdout, `${createHash("sha256").update(await readFile(path.join(root, launcherPath))).digest("hex")}\n`);
  for (const mode of ["draft", "absent", "missing", "corrupt"]) {
    const result = run(root, "release-artifact.mjs", ["read"], { ...env, RELEASE_TEST_MODE: mode });
    assert.equal(result.status, 1, mode);
    assert.equal(result.stdout, "", mode);
  }
});
