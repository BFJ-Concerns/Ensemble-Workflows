import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { RunRecordWriter } from "../../src/run-record.js";

test("the archived Claude version probe withholds run settings and preserves other environment", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "ensemble-version-env-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const bin = path.join(scratch, "bin");
  await mkdir(bin);
  const runSettings = [
    "ENSEMBLE_WORKER_SCOPE", "ENSEMBLE_AGENT_CEILING", "ENSEMBLE_RUN_RECORD",
    "ENSEMBLE_RUN_RECORD_DIR", "ENSEMBLE_CALLER_IDENTITY", "ENSEMBLE_STATUS",
    "ENSEMBLE_STATUS_DIR", "ENSEMBLE_HOLD_SCOPE", "ENSEMBLE_CONCURRENCY_CLAUDE",
    "ENSEMBLE_CONCURRENCY_CODEX", "ENSEMBLE_CONCURRENCY_OPENCODE",
    "ENSEMBLE_CONCURRENCY_FUTURE"
  ];
  const inherited = {
    PATH: bin,
    HOME: path.join(scratch, "home"),
    CLAUDE_CONFIG_DIR: path.join(scratch, "claude-home"),
    ENSEMBLE_VERSION_PROBE_TEST: "preserved"
  };
  const changes = { ...Object.fromEntries(runSettings.map((name) => [name, "run-value"])), ...inherited };
  const original = new Map(Object.keys(changes).map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const names = [...runSettings, ...Object.keys(inherited)];
  for (const tool of ["git", "codex", "claude", "opencode"]) {
    const executable = path.join(bin, tool);
    await writeFile(executable, `#!${process.execPath}
if (process.argv[2] === "--version") {
  if (${JSON.stringify(tool)} === "claude") {
    const selected = Object.fromEntries(${JSON.stringify(names)}.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
    require("node:fs").writeFileSync(${JSON.stringify(path.join(scratch, "claude-env.json"))}, JSON.stringify(selected));
  }
  console.log(${JSON.stringify(`${tool} fixture-version`)});
} else {
  process.exitCode = 1;
}
`);
    await chmod(executable, 0o755);
  }
  Object.assign(process.env, changes);
  const writer = await RunRecordWriter.start({
    storeDir: path.join(scratch, "store"), cwd: scratch, runUuid: "version-env",
    workflowPath: path.join(scratch, "workflow.js"), workflowSource: "return true;",
    args: [], cliFlags: { jsonArgs: false }
  });
  await writer.finish({ status: "complete", exitCode: 0, result: true });
  assert.deepEqual(JSON.parse(await readFile(path.join(scratch, "claude-env.json"), "utf8")), inherited);
  const manifest = JSON.parse(await readFile(path.join(writer.archiveDir, "manifest.json"), "utf8")) as {
    environment: { tools: Record<string, string> };
  };
  assert.equal(manifest.environment.tools.claude, "claude fixture-version");
  for (const name of runSettings) assert.equal(process.env[name], "run-value", `${name} in parent`);
});
