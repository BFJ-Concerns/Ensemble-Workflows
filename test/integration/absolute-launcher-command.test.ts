import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { hermeticEstateEnvironment } from "./estate-process.js";

test("printed launcher commands run from another directory through relative and symlink paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-command-path-"));
  try {
    const home = path.join(directory, "launcher's $tools `bin`", "nested".repeat(20));
    const elsewhere = path.join(directory, "elsewhere");
    await Promise.all([mkdir(home, { recursive: true }), mkdir(elsewhere)]);
    const bundle = path.join(home, "ensemble.mjs");
    await copyFile(path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs"), bundle);
    await chmod(bundle, 0o755);
    const shim = path.join(home, "ensemble");
    await symlink(bundle, shim);
    for (const launcher of [bundle, shim]) {
      const result = spawnSync(process.execPath, [path.relative(directory, launcher), "--help"], {
        cwd: directory, encoding: "utf8", env: hermeticEstateEnvironment()
      });
      assert.equal(result.status, 0, result.stderr);
      const command = result.stdout.split("\n")[0]?.replace(/^Usage: /, "");
      assert.ok(command?.includes(home.replaceAll("'", "'\"'\"'")), result.stdout);
      assert.ok(command?.endsWith(launcher === bundle ? "ensemble.mjs'" : "ensemble'"));
      for (const argv of [["--help"], ["agent", "--help"], ["workflows", "--help"], ["holds", "--help"], ["holds", "answer", "--help"]]) {
        const help = spawnSync(process.execPath, [launcher, ...argv], {
          cwd: elsewhere, encoding: "utf8", env: hermeticEstateEnvironment()
        });
        assert.equal(help.status, 0, help.stderr);
        assert.equal(help.stdout.split("\n")[0], `Usage: ${command}`);
        for (const line of help.stdout.split("\n")) {
          assert.ok(line.length <= 80 || line.includes(command!), line);
        }
      }
      const replay = spawnSync("/bin/sh", ["-c", `${command} --version`], {
        cwd: elsewhere, encoding: "utf8", env: hermeticEstateEnvironment()
      });
      assert.equal(replay.status, 0, replay.stderr);
      assert.match(replay.stdout, /^\d+\.\d+\.\d+/);
      const diagnostic = spawnSync(process.execPath, [launcher, "agent", "prompt"], {
        cwd: elsewhere, encoding: "utf8", env: hermeticEstateEnvironment()
      });
      assert.equal(diagnostic.status, 2);
      assert.equal(diagnostic.stderr, `${command} agent requires --engine\n`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
