import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { hermeticEstateEnvironment } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const recordingFixturePath = path.resolve("test/fixtures/codex/recording-app-server.mjs");
const scopeProperties = ["-p", "TasksMax=60", "-p", "MemoryMax=500M", "-p", "MemorySwapMax=0"];
let scopeCounter = 0;

test("built CLI schema fixture fails closed on every recursive executable ingress without process growth", { timeout: 45_000 }, async (t) => {
  const estate = await createEstate("recursion");
  try {
    const symlinkPath = path.join(estate.directory, "schema-codex-link");
    await symlink(recordingFixturePath, symlinkPath);
    const wrapperPath = path.join(estate.directory, "schema-codex-wrapper");
    await writeExecutable(wrapperPath, `#!/bin/sh\nexec ${shellQuote(recordingFixturePath)} "$@"\n`);
    const markerStrippingWrapperPath = path.join(estate.directory, "schema-codex-marker-stripping-wrapper");
    await writeExecutable(
      markerStrippingWrapperPath,
      `#!/bin/sh\nexec /usr/bin/env -u ENSEMBLE_CODEX_SCHEMA_VALIDATOR_ACTIVE ${shellQuote(recordingFixturePath)} "$@"\n`
    );
    const noExecWrapperPath = path.join(estate.directory, "schema-codex-no-exec-wrapper");
    await writeExecutable(
      noExecWrapperPath,
      `#!/bin/sh\n/usr/bin/env -u ENSEMBLE_CODEX_SCHEMA_VALIDATOR_ACTIVE ${shellQuote(recordingFixturePath)} "$@"\n`
    );
    const environmentPassedWrapperPath = path.join(estate.directory, "schema-codex-environment-passed-wrapper");
    await writeExecutable(
      environmentPassedWrapperPath,
      `#!/bin/sh\nENSEMBLE_RECURSIVE_FIXTURE=${shellQuote(recordingFixturePath)} /usr/bin/env -u ENSEMBLE_CODEX_SCHEMA_VALIDATOR_ACTIVE /bin/sh -c '"$ENSEMBLE_RECURSIVE_FIXTURE" "$@"' fixture-wrapper "$@"\n`
    );
    const generationWrapperPath = path.join(estate.directory, "schema-codex-generation-wrapper");
    await writeExecutable(
      generationWrapperPath,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "codex-cli 0.146.0"\n  exit 0\nfi\nexec ${shellQuote(recordingFixturePath)} "$@"\n`
    );

    // The ingress that defeated three successive guards: it answers --version
    // itself (so it reaches the generation hop rather than exiting 2 there) AND
    // strips the inherited marker on the way in (so the marker leg cannot fire),
    // while the identity leg cannot fire either because the configured command
    // resolves to this shim rather than to the fixture. Only a by-construction
    // refusal inside the fixture stops it, which is why it is a permanent case.
    const combinedShimPath = path.join(estate.directory, "schema-codex-combined-shim");
    await writeExecutable(
      combinedShimPath,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "codex-cli 0.146.0"\n  exit 0\nfi\nexec /usr/bin/env -u ENSEMBLE_CODEX_SCHEMA_VALIDATOR_ACTIVE ${shellQuote(recordingFixturePath)} "$@"\n`
    );

    const cases = [
      { name: "direct absolute path", command: recordingFixturePath, diagnostic: "refusal" },
      { name: "symlink", command: symlinkPath, diagnostic: "refusal" },
      { name: "relative path", command: path.relative(process.cwd(), recordingFixturePath), diagnostic: "refusal" },
      { name: "PATH lookup", command: "schema-codex", pathEntry: recordingFixturePath, diagnostic: "refusal" },
      { name: "fixture through wrapper", command: wrapperPath, diagnostic: "version-exit" },
      { name: "fixture through marker-stripping wrapper", command: markerStrippingWrapperPath, diagnostic: "version-exit" },
      { name: "fixture through marker-stripping no-exec wrapper", command: noExecWrapperPath, diagnostic: "version-exit" },
      { name: "fixture path passed through environment", command: environmentPassedWrapperPath, diagnostic: "version-exit" },
      // Now caught by the fixture's own generate-json-schema refusal rather than
      // by the identity check: the by-construction guard fires first, before the
      // validator is imported at all.
      { name: "schema-generation argument through wrapper", command: generationWrapperPath, diagnostic: "generation-refusal" },
      { name: "marker-stripping shim reaching schema generation", command: combinedShimPath, diagnostic: "generation-refusal" }
    ];

    for (const ingress of cases) {
      await t.test(ingress.name, async () => {
        if (ingress.pathEntry !== undefined) {
          await symlink(ingress.pathEntry, path.join(estate.binDirectory, ingress.command));
        }
        const result = await runInBoundedScope(
          [process.execPath, bundledCliPath, estate.workflow],
          {
            ...estate.environment,
            ENSEMBLE_CODEX_SCHEMA_CLI: ingress.command
          }
        );

        t.diagnostic(JSON.stringify({ ingress: ingress.name, ...result }));
        // The fixture's refusal kills the app-server at dispatch: a
        // dispatched worker's failure, so the run completes on the script's
        // null and the refusal is legible on the failure notice.
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, "null\n");
        assert.match(result.stderr, /\[codex\] agent 1 failed after 1 attempt — Codex app-server exited/);
        if (ingress.diagnostic === "refusal") {
          assert.match(result.stderr, /Codex fixture schema validation refused to execute itself recursively/);
        } else if (ingress.diagnostic === "generation-refusal") {
          assert.match(
            result.stderr,
            /Codex fixture refused to generate protocol schemas: a recording fixture is never a schema source/
          );
        } else {
          assert.match(result.stderr, /Codex fixture schema command exited with code 2 signal null/);
        }
        // Assert the path against the diagnostic line alone, never the whole of
        // stderr: Node prints the fixture's own path in the stack frames of any
        // failure originating in that file, so matching stderr wholesale passed
        // even with the diagnostic's path half deleted (proved by mutation).
        if (ingress.diagnostic === "refusal") {
          const refusalLine = result.stderr
            .split("\n")
            .find((line) => line.includes("refused to execute itself recursively"));
          assert.ok(refusalLine, "no refusal diagnostic line in stderr");
          assert.match(refusalLine, new RegExp(escapeRegExp(ingress.command)));
        } else {
          assert.match(result.stderr, new RegExp(escapeRegExp(ingress.command)));
        }
        assert.ok(result.peakProcesses <= 5, `unexpected process fan-out: ${result.peakProcesses}`);
        assert.ok(result.peakTasks < 60, `scope reached its task cap: ${result.peakTasks}`);
        assert.ok(result.peakMemoryBytes < 500 * 1024 * 1024, `scope reached its memory cap: ${result.peakMemoryBytes}`);
      });
    }
  } finally {
    await estate.cleanup();
  }
});

test("timed-out schema fixture child leaves no process-group descendants", { timeout: 45_000 }, async (t) => {
  const estate = await createEstate("descendant-cleanup");
  const processRecord = path.join(estate.directory, "processes.json");
  const timeoutControl = path.join(estate.directory, "timeout-control");
  const descendant = path.join(estate.directory, "descendant.mjs");
  const hangingCodex = path.join(estate.directory, "hanging-codex");
  const hangingCodexPayload = path.join(estate.directory, "hanging-codex.mjs");
  await writeFile(descendant, "setInterval(() => {}, 1000);\n");
  await writeFile(timeoutControl, "");
  await writeFile(
    hangingCodexPayload,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.146.0\\n");
  process.exit(0);
}
const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });
const fields = readFileSync("/proc/self/stat", "utf8").split(" ");
appendFileSync(${JSON.stringify(processRecord)}, JSON.stringify({ pid: process.pid, pgid: Number(fields[4]), childPid: child.pid, args }) + "\\n");
setInterval(() => {}, 1000);
`
  );
  await writeExecutable(
    hangingCodex,
    `#!/bin/sh
pid=$$
pgid=$(/usr/bin/ps -o pgid= -p "$pid" | /usr/bin/tr -d ' ')
if [ "$pid" != "$pgid" ]; then
  exec /usr/bin/setsid ${shellQuote(process.execPath)} ${shellQuote(hangingCodexPayload)} "$@"
fi
exec ${shellQuote(process.execPath)} ${shellQuote(hangingCodexPayload)} "$@"
`
  );

  const scoped = startBoundedScope(
    [process.execPath, bundledCliPath, estate.workflow],
    {
      ...estate.environment,
      ENSEMBLE_CODEX_SCHEMA_CLI: hangingCodex,
      ENSEMBLE_CODEX_SCHEMA_COMMAND_TIMEOUT_MS: "30000",
      ENSEMBLE_CODEX_SCHEMA_TIMEOUT_CONTROL: timeoutControl
    }
  );

  const processGroups = new Set<number>();
  try {
    const record = await waitForJsonLine(processRecord);
    processGroups.add(record.pgid);
    assert.doesNotThrow(
      () => process.kill(record.childPid, 0),
      `recorded descendant ${record.childPid} was not live before the schema-command timeout`
    );
    await appendFile(timeoutControl, "release\n");
    const result = await withDeadline(scoped.result, 45_000, "fixture-driving CLI did not time out").catch(async (error: unknown) => {
      await killScopeMain(scoped.unit);
      const survivors = await processGroupMembers(record.pgid);
      t.diagnostic(JSON.stringify({ timedOutDriver: true, processGroup: record.pgid, survivors }));
      assert.deepEqual(survivors, [], "fixture descendants survived after the immediate child exited");
      throw error;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const records = await readJsonLines(processRecord);
    for (const entry of records) {
      processGroups.add(entry.pgid);
    }
    const observations = await Promise.all([...processGroups].map(async (group) => ({
      processGroup: group,
      survivors: await processGroupMembers(group)
    })));
    t.diagnostic(JSON.stringify({ recorded: records, observations, result }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "null\n");
    assert.match(result.stderr, /\[codex\] agent 1 failed after 1 attempt — Codex app-server exited/);
    assert.match(result.stderr, /Codex fixture schema command timed out after 30000ms/);
    for (const observation of observations) {
      assert.deepEqual(observation.survivors, []);
    }
  } finally {
    for (const group of processGroups) {
      killProcessGroup(group);
      await waitForEmptyProcessGroup(group);
    }
    await killScope(scoped.unit);
    await scoped.result.catch(() => undefined);
    await estate.cleanup();
  }
});

test("built CLI fails closed when the schema command produces no usable schema", { timeout: 15_000 }, async (t) => {
  const estate = await createEstate("empty-schema");
  const emptySchemaCodex = path.join(estate.directory, "empty-schema-codex");
  await writeExecutable(
    emptySchemaCodex,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli 0.146.0"
fi
exit 0
`
  );

  try {
    const result = await runInBoundedScope(
      [process.execPath, bundledCliPath, estate.workflow],
      {
        ...estate.environment,
        ENSEMBLE_CODEX_SCHEMA_CLI: emptySchemaCodex
      }
    );

    t.diagnostic(JSON.stringify(result));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "null\n");
    assert.match(result.stderr, /\[codex\] agent 1 failed after 1 attempt — Codex app-server exited/);
    assert.match(result.stderr, /Codex fixture schema command produced no usable protocol schema/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  } finally {
    await estate.cleanup();
  }
});

interface Estate {
  directory: string;
  binDirectory: string;
  workflow: string;
  environment: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

interface ScopeResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  peakProcesses: number;
  peakTasks: number;
  peakMemoryBytes: number;
}

async function createEstate(name: string): Promise<Estate> {
  const directory = await mkdtemp(path.join(tmpdir(), `ensemble-schema-${name}-estate-`));
  const binDirectory = path.join(directory, "bin");
  const workflow = path.join(directory, "workflow.js");
  await chmod(recordingFixturePath, 0o755);
  await mkdir(binDirectory);
  await symlink(recordingFixturePath, path.join(binDirectory, "codex"));
  await writeFile(
    workflow,
    `export const meta = { name: ${JSON.stringify(name)}, description: "schema fixture estate" };
return await agent("return one word", { engine: "codex", maxAttempts: 1 });
`
  );
  return {
    directory,
    binDirectory,
    workflow,
    // Declared overrides only — startBoundedScope composes the hermetic base.
    environment: {
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_STATE_HOME: path.join(directory, "state")
    },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

function startBoundedScope(command: string[], env: NodeJS.ProcessEnv): {
  unit: string;
  result: Promise<ScopeResult>;
} {
  scopeCounter += 1;
  const unit = `ensemble-schema-${process.pid}-${scopeCounter}.scope`;
  const child = spawn(
    "/usr/bin/systemd-run",
    ["--user", "--scope", "--quiet", `--unit=${unit}`, ...scopeProperties, ...command],
    { cwd: process.cwd(), env: hermeticEstateEnvironment(env), stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const metrics = observeScope(unit, child);
  const result = new Promise<ScopeResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", async (code, signal) => {
      const observed = await metrics;
      resolve({ code, signal, stdout, stderr, ...observed });
    });
  });
  return { unit, result };
}

async function runInBoundedScope(command: string[], env: NodeJS.ProcessEnv): Promise<ScopeResult> {
  const scoped = startBoundedScope(command, env);
  return await scoped.result;
}

async function observeScope(unit: string, child: ReturnType<typeof spawn>): Promise<{
  peakProcesses: number;
  peakTasks: number;
  peakMemoryBytes: number;
}> {
  const uid = process.getuid?.();
  assert.notEqual(uid, undefined, "cgroup scope observation requires Linux process credentials");
  const scopeDirectory = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`;
  let peakProcesses = 0;
  let peakTasks = 0;
  let peakMemoryBytes = 0;
  let containmentTriggered = false;
  let finished = false;
  child.once("exit", () => (finished = true));
  while (!finished) {
    try {
      const [processes, tasks, memory] = await Promise.all([
        readFile(path.join(scopeDirectory, "cgroup.procs"), "utf8"),
        readFile(path.join(scopeDirectory, "pids.current"), "utf8"),
        readFile(path.join(scopeDirectory, "memory.current"), "utf8")
      ]);
      peakProcesses = Math.max(peakProcesses, processes.trim().split("\n").filter(Boolean).length);
      peakTasks = Math.max(peakTasks, Number(tasks.trim()));
      peakMemoryBytes = Math.max(peakMemoryBytes, Number(memory.trim()));
      if (peakTasks >= 60 && !containmentTriggered) {
        containmentTriggered = true;
        void killScope(unit);
      }
    } catch {
      // The scope directory appears asynchronously and vanishes when its final process exits.
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return { peakProcesses, peakTasks, peakMemoryBytes };
}

async function waitForJsonLine(file: string): Promise<{ pid: number; pgid: number; childPid: number; args: string[] }> {
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    try {
      const line = (await readFile(file, "utf8")).split("\n").find(Boolean);
      if (line !== undefined) {
        return JSON.parse(line) as { pid: number; pgid: number; childPid: number; args: string[] };
      }
    } catch {
      // The executable creates the record after it has spawned its descendant.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`process record never appeared: ${file}`);
}

async function readJsonLines(file: string): Promise<Array<{ pid: number; pgid: number; childPid: number; args: string[] }>> {
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; pgid: number; childPid: number; args: string[] });
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function processGroupMembers(pgid: number): Promise<Array<{ pid: number; command: string }>> {
  const result = await runProcess("/usr/bin/ps", ["-eo", "pid=,pgid=,comm="]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match === null || Number(match[2]) !== pgid) {
      return [];
    }
    return [{ pid: Number(match[1]), command: match[3]! }];
  });
}

async function waitForEmptyProcessGroup(pgid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await processGroupMembers(pgid)).length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(await processGroupMembers(pgid), []);
}

async function killScopeMain(unit: string): Promise<void> {
  await runProcess("/usr/bin/systemctl", ["--user", "kill", "--kill-whom=main", "--signal=SIGKILL", unit]);
}

async function killScope(unit: string): Promise<void> {
  await runProcess("/usr/bin/systemctl", ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit]);
}

function killProcessGroup(pgid: number): void {
  const ownGroup = Number(readFileSyncForProcessGroup());
  assert.notEqual(pgid, ownGroup, `refusing to kill the test runner's own process group ${pgid}`);
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function readFileSyncForProcessGroup(): string {
  const fields = readFileSync("/proc/self/stat", "utf8").split(" ");
  return fields[4] ?? "";
}

async function runProcess(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: hermeticEstateEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeExecutable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents);
  await chmod(file, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
