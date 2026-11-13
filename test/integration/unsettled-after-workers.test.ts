import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertSalvageEnvelope, executablePath, findOnlyFile, runNode } from "./estate-process.js";

const launcher = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const engine of ["codex", "claude", "opencode"] as const) {
  for (const parallel of [false, true]) {
    for (const deadline of [false, true]) {
      test(`${engine} finishes before an unsettled ${parallel ? "Promise.all" : "sequential await"}, ${deadline ? "with" : "without"} a deadline`, async () => {
        const fixture = await createFixture(engine);
        try {
          const call = `agent("answer", { engine: ${JSON.stringify(engine)}, ${engine === "opencode" ? 'model: "fixture",' : ""} maxAttempts: 1 })`;
          const worker = `${call}.then(value => { if (value !== "worker-ok") throw new Error("worker failed: " + value); log("WORKER_FINISHED"); })`;
          await writeFile(fixture.script, `export const meta = { name: "unsettled-after-worker" };
${parallel ? `await Promise.all([${worker}, new Promise(() => {})]);` : `await ${worker}; await new Promise(() => {});`}`);
          const result = await runNode([launcher, ...(deadline ? ["--timeout=180000"] : []), fixture.script], fixture.env, 60_000);
          assert.match(result.stderr, /WORKER_FINISHED/);
          assert.equal(result.code, 1, result.stderr);
          const envelope = assertSalvageEnvelope(result.stdout, "failed", [{ id: 1, engine, label: null, phase: null, output: "worker-ok" }]);
          assert.equal(envelope.error.kind, "WorkflowUnsettledError");
          assert.equal(envelope.completed.length, 1);
          const manifest = JSON.parse(await readFile(await findOnlyFile(fixture.records, "manifest.json"), "utf8"));
          assert.equal(manifest.status, "failed");
          assert.deepEqual(manifest.error, envelope.error);
          const agent = JSON.parse(await readFile(await findOnlyFile(fixture.records, "agent.json"), "utf8"));
          assert.equal(agent.status, "complete");
          const sentinel = JSON.parse(await readFile(await findOnlyFile(fixture.records, "completion-sentinel.json"), "utf8"));
          assert.equal(sentinel.outcome, "failed");
          assert.equal(sentinel.exit_code, 1);
          const status = result.stderr.match(/\[status-file\] (.+)/);
          assert.ok(status, result.stderr);
          await assert.rejects(readFile(JSON.parse(status[1]!).status_path), { code: "ENOENT" });
          if (engine === "claude") {
            assert.deepEqual(JSON.parse(await readFile(fixture.env.ENSEMBLE_FAKE_CLAUDE_STATE!, "utf8")).sessions, []);
          }
        } finally {
          await rm(fixture.directory, { recursive: true, force: true });
        }
      });
    }
  }
}

test("an idle Codex transport can serve another turn after script-owned asynchronous work", async () => {
  const fixture = await createFixture("codex");
  try {
    await writeFile(fixture.script, `export const meta = { name: "codex-follow-up" };
const held = session({ engine: "codex" });
const first = await held.send("first");
await new Promise(resolve => setTimeout(resolve, 50));
const second = await held.send("second");
const third = await agent("third", { engine: "codex" });
return [first, second, third];`);
    const result = await runNode([launcher, fixture.script], fixture.env, 60_000);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["worker-ok", "worker-ok", "worker-ok"]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixture(engine: "codex" | "claude" | "opencode") {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-unsettled-worker-"));
  const bin = path.join(directory, "bin");
  const records = path.join(directory, "records");
  const config = path.join(directory, "config");
  await mkdir(bin);
  await mkdir(path.join(directory, "status"));
  await mkdir(path.join(directory, "home"));
  await mkdir(path.join(config, "ensemble"), { recursive: true });
  await writeFile(path.join(config, "ensemble", "config.json"), JSON.stringify({
    schema_version: 1, opencode_models: { fixture: { provider_model: "fixture/model" } }
  }));
  const executables = engine === "codex" ? {
    codex: `import ${JSON.stringify(path.resolve("test/fixtures/codex/recording-app-server.mjs"))};`
  } : engine === "claude" ? {
    claude: `import ${JSON.stringify(path.resolve("test/fixtures/claude/blocked-worker-cli.mjs"))};`,
    tmux: `import ${JSON.stringify(path.resolve("test/fixtures/claude/prompt-editor-tmux.mjs"))};`
  } : {
    opencode: `console.log(JSON.stringify({ type: "text", part: { type: "text", text: "worker-ok" } }));`
  };
  for (const [name, body] of Object.entries(executables)) {
    await writeFile(path.join(bin, name), `#!/usr/bin/env node\n${body}\n`);
    await chmod(path.join(bin, name), 0o755);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: path.join(directory, "home"),
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: path.join(directory, "data"),
    ENSEMBLE_RUN_RECORD_DIR: records,
    ENSEMBLE_RUN_RECORD: "1",
    ENSEMBLE_STATUS: "1",
    ENSEMBLE_STATUS_DIR: path.join(directory, "status"),
    ENSEMBLE_FAKE_CLAUDE_STATE: path.join(directory, "roster.json"),
    ENSEMBLE_FAKE_CLAUDE_COMPLETE: "1",
    ...(engine === "codex" ? { ENSEMBLE_CODEX_SCHEMA_CLI: await executablePath("codex") } : {})
  };
  return { directory, records, script: path.join(directory, "workflow.js"), env };
}
