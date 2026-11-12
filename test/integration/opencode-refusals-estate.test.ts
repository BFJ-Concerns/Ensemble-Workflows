import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { hermeticEstateEnvironment, findOnlyFile } from "./estate-process.js";

const execFileAsync = promisify(execFile);
const launcher = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const versionExitCode of [0, 1]) {
  test(`a refused relative opencode home leaves launcher cwd untouched after version query exit ${versionExitCode}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-refusal-"));
    try {
      const launchCwd = path.join(directory, "launcher");
      const repo = path.join(directory, "repo");
      const bin = path.join(directory, "bin");
      const config = path.join(directory, "config", "ensemble");
      for (const dir of [launchCwd, repo, bin, config]) await mkdir(dir, { recursive: true });
      await writeFile(path.join(repo, "blocked"), "not a directory");
      for (const args of [
        ["init", "--quiet"], ["add", "blocked"],
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]
      ]) await execFileAsync("git", args, { cwd: repo });
      const script = path.join(directory, "workflow.js");
      await writeFile(script, `export const meta = { name: 'opencode refusal' };\nreturn await agent('hello', { engine: 'opencode', model: 'registered', cwd: ${JSON.stringify(repo)}, isolation: 'worktree' });`);
      await writeFile(path.join(config, "config.json"), JSON.stringify({
        schema_version: 1,
        opencode_models: { registered: { provider_model: "fixture/model" } }
      }));
      // opencode 1.18.4 initialises these directories even for --version.
      // Keep the fixture deterministic and prove no run command was reached.
      await writeFile(path.join(bin, "opencode"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(${JSON.stringify(path.join(directory, "calls"))}, process.argv.slice(2).join(' ') + '\\n');
for (const suffix of ['log', 'repos']) fs.mkdirSync(path.join(process.env.XDG_DATA_HOME, 'opencode', suffix), { recursive: true });
if (process.argv[2] !== '--version') process.exit(99);
console.log('fixture-opencode-version');
process.exit(${versionExitCode});
`);
      await chmod(path.join(bin, "opencode"), 0o755);
      const env = hermeticEstateEnvironment({
        HOME: directory,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: path.dirname(config), XDG_DATA_HOME: "blocked",
        XDG_STATE_HOME: path.join(directory, "state"), XDG_CACHE_HOME: path.join(directory, "cache"),
        ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"), ENSEMBLE_STATUS: "0"
      });
      let stdout = "";
      try {
        await execFileAsync(process.execPath, [launcher, script], { cwd: launchCwd, env, timeout: 30_000 });
        assert.fail("the opencode data home should have been refused");
      } catch (error) {
        const result = error as Error & { code: number; stdout: string; stderr: string };
        assert.equal(result.code, 1, result.stderr);
        stdout = result.stdout;
      }
      const envelope = JSON.parse(stdout) as { partial: boolean; error: { message: string } };
      assert.equal(envelope.partial, true);
      assert.match(envelope.error.message, /opencode data \(from XDG_DATA_HOME\): ENOTDIR/);
      const checked = /cannot create entries in ([^;]+?), the opencode/.exec(envelope.error.message)?.[1];
      assert.ok(checked, envelope.error.message);
      assert.ok(checked.startsWith(`${repo}.ensemble-workflows-worktrees/`), checked);
      assert.ok(checked.endsWith("/blocked/opencode"), checked);
      assert.deepEqual(await readdir(launchCwd), []);
      assert.equal(await readFile(path.join(directory, "calls"), "utf8"), "--version\n");
      const manifestPath = await findOnlyFile(path.join(directory, "records"), "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { environment: { tools: { opencode: string | null } } };
      assert.equal(manifest.environment.tools.opencode, versionExitCode === 0 ? "fixture-opencode-version" : null);
      assert.ok(!(await readdir(path.dirname(manifestPath))).some((name) => name.startsWith(".opencode-version-")));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("the launcher names the configuration repair for an unregistered opencode model", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-model-refusal-"));
  try {
    const config = path.join(directory, "custom config", "ensemble", "config.json");
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, JSON.stringify({
      schema_version: 1,
      opencode_models: { registered: { provider_model: "fixture/model" } }
    }));
    try {
      await execFileAsync(process.execPath, [launcher, "agent", "--engine", "opencode", "--model", "unregistered-first-model", "hello"], {
        cwd: directory,
        env: hermeticEstateEnvironment({
          XDG_CONFIG_HOME: path.join(directory, "custom config"), ENSEMBLE_RUN_RECORD: "0", ENSEMBLE_STATUS: "0",
          ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records")
        }),
        timeout: 30_000
      });
      assert.fail("the unregistered model should have been refused");
    } catch (error) {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1, result.stderr);
      const envelope = JSON.parse(result.stdout) as { partial: boolean; error: { message: string } };
      assert.equal(envelope.partial, true);
      for (const diagnostic of [envelope.error.message, result.stderr]) {
        assert.ok(diagnostic.includes('"unregistered-first-model" is not registered'), diagnostic);
        assert.ok(diagnostic.includes('expected one of "registered"'), diagnostic);
        assert.ok(diagnostic.includes(`opencode_models in the machine configuration (${config})`), diagnostic);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
