import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isLive } from "../../src/worker-scopes.js";
import { runNode } from "./estate-process.js";

const launcher = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const grouping of ["worker", "run"] as const) {
  for (const ending of ["throw", "timeout", "return", "exit"] as const) {
    test(`built opencode ${ending} stops a reparented command holding pipes with ${grouping} scope grouping`, async () => {
      await exercise({ ending, grouping });
    });
  }
}

test("built opencode cancellation without a manager bounds pipe waiting and reports its unconfirmed reach in the sentinel", async () => {
  await exercise({ ending: "throw", grouping: "worker", unavailable: true });
});

async function exercise({ ending, grouping, unavailable = false }: {
  ending: "throw" | "timeout" | "return" | "exit";
  grouping: "worker" | "run";
  unavailable?: boolean;
}): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-teardown-"));
  const fixture = path.join(directory, "opencode");
  const marker = path.join(directory, "command.pid");
  const ready = path.join(directory, "ready");
  const config = path.join(directory, "config/ensemble");
  let commandPid: number | undefined;
  try {
    await mkdir(config, { recursive: true });
    await writeFile(path.join(config, "config.json"), JSON.stringify({ schema_version: 1, opencode_models: { fixture: { provider_model: "fixture/model" } } }));
    await writeFile(fixture, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('fixture'); process.exit(0); }
// A separate session survives killing either the engine PID or its group.
// Its immediate parent exits before readiness, so the workflow sees it reparented.
const parent = spawn('sh', ['-c', 'setsid sleep infinity & echo $! > "$1"', 'sh', ${JSON.stringify(marker)}], { stdio: ['ignore', 'inherit', 'inherit'] });
parent.once('exit', () => {
  process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'command started' } }) + '\\n');
  writeFileSync(${JSON.stringify(ready)}, String(process.pid));
  ${ending === "exit" ? "process.exit(0);" : "setInterval(() => {}, 1000);"}
});
`);
    await chmod(fixture, 0o755);
    const workflow = path.join(directory, "workflow.js");
    await writeFile(workflow, `export const meta = { name: 'opencode-command-teardown' };
const fs = await import('node:fs/promises');
const pending = agent('fixture', { engine: 'opencode', model: 'fixture', maxAttempts: 1 });
// An uncaught engine setup failure must reach the driver, rather than hang readiness.
let early; pending.catch(error => { early = error; });
for (;;) {
  if (early) throw early;
  try {
    await fs.access(${JSON.stringify(ready)});
    const pid = Number((await fs.readFile(${JSON.stringify(marker)}, 'utf8')).trim());
    const stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[3]) === pid) break;
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 10));
}
${ending === "throw" ? "throw new Error('FIXTURE_THROW');" : ending === "timeout" ? "await new Promise(() => {});" : ending === "exit" ? "await pending; return 'finished';" : "return 'body returned';"}
`);
    const result = await runNode([
      launcher, ...(ending === "timeout" ? ["--timeout=15000"] : []), `--worker-scope=${grouping}`, workflow
    ], {
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: path.join(directory, "config"),
      ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"),
      ENSEMBLE_STATUS: "off",
      ...(unavailable ? { DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/no-bus`, XDG_RUNTIME_DIR: path.join(directory, "no-runtime") } : {})
    }, 60_000);
    commandPid = Number((await readFile(marker, "utf8")).trim());
    assert.ok(commandPid > 0, result.stderr);
    const announced = result.stderr.match(/^\[sentinel\] will write (.+) when the run ends$/m)?.[1];
    assert.ok(announced, result.stderr);
    const sentinel = JSON.parse(await readFile(announced, "utf8")) as {
      outcome: string; teardown_error: { message: string } | null; workers: { cut_short: number }
    };
    if (unavailable) {
      assert.equal(result.code, 1, result.stderr);
      assert.match(sentinel.teardown_error?.message ?? "", /cut short without a scope/);
      assert.equal(isLive(commandPid), true, "escaped command is precisely the unconfirmed reach");
    } else {
      assert.equal(sentinel.teardown_error, null, result.stderr);
      const after = await readFile(`/proc/${commandPid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      assert.ok(after === null || after.slice(after.lastIndexOf(")") + 2).startsWith("Z "), `sentinel must follow command termination: ${after}`);
      assert.equal(result.code, ending === "throw" || ending === "timeout" ? 1 : 0, result.stderr);
      assert.equal(sentinel.outcome, ending === "throw" ? "failed" : ending === "timeout" ? "timed-out" : "complete");
    }
    if (ending !== "exit") {
      assert.match(result.stderr, /\[teardown\] stopping workers and their commands/);
      assert.equal(sentinel.workers.cut_short, 1);
    }
  } finally {
    commandPid ??= Number(await readFile(marker, "utf8").catch(() => "0"));
    if (commandPid > 0 && isLive(commandPid)) process.kill(commandPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}
