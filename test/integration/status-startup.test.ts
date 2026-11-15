import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { hermeticEstateEnvironment, runNode } from "./estate-process.js";

const bundle = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

test("concurrent runs publish supervision before FIFO source delivery and names before body entry", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp("/mnt/ai-data/scratch/ensemble-status-startup-");
  const statusDir = path.join(directory, "status");
  await mkdir(statusDir);
  const children: ReturnType<typeof spawn>[] = [];
  const completions: Promise<unknown>[] = [];
  try {
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const source = path.join(directory, `workflow-${index}.mjs`);
      execFileSync("mkfifo", [source]);
      const child = spawn(process.execPath, [bundle, source], {
        cwd: directory,
        env: hermeticEstateEnvironment({
          XDG_CONFIG_HOME: path.join(directory, "config"),
          ENSEMBLE_RUN_RECORD: index % 2 === 0 ? "1" : "0",
          ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"),
          ENSEMBLE_STATUS_DIR: statusDir
        }),
        stdio: ["ignore", "pipe", "pipe"]
      });
      children.push(child);
      const closed = once(child, "close");
      completions.push(closed);
      let stderr = "";
      let stdout = "";
      const announced = Promise.withResolvers<{ run_id: string; status_path: string }>();
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
        const line = /\[status-file\] (\{[^\n]+\})\n/.exec(stderr);
        if (line !== null) announced.resolve(JSON.parse(line[1]!));
      });
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      const announcement = await Promise.race([announced.promise, closed.then(() => {
        throw new Error(`launcher closed before status announcement: ${stderr}`);
      })]);
      // There is no writer at this FIFO yet: the source cannot have been read.
      assert.match(stderr, /\[sentinel\] will write .+completion-sentinel\.json/);
      const initial = JSON.parse(await readFile(announcement.status_path, "utf8"));
      assert.equal(initial.workflow, null);
      assert.deepEqual(initial.agents, []);
      assert.equal(initial.pid, child.pid);
      assert.ok(announcement.run_id.endsWith(`:${initial.runId}`));
      assert.equal(child.exitCode, null);
      const name = `startup-${index}`;
      await writeFile(source, `export const meta = { name: ${JSON.stringify(name)} };
        return (() => {
          const fs = require("node:fs");
          const directory = ${JSON.stringify(statusDir)};
          const own = fs.readdirSync(directory).filter(name => name.endsWith(".local.json"))
            .flatMap(name => { try { return [JSON.parse(fs.readFileSync(directory + "/" + name, "utf8"))]; } catch { return []; } })
            .find(snapshot => snapshot.pid === process.pid);
          if (!own) throw new Error("own status missing at body entry");
          return { workflow: own.workflow, agents: own.agents };
        })();`);
      const [code] = await closed;
      assert.equal(code, 0, stderr);
      assert.deepEqual(JSON.parse(stdout), { workflow: name, agents: [] });
      await assert.rejects(readFile(announcement.status_path), { code: "ENOENT" });
    }));
    assert.deepEqual(await readdir(statusDir), []);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled(completions);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a directory script path is rejected before supervision starts", async () => {
  const directory = await mkdtemp("/mnt/ai-data/scratch/ensemble-status-path-");
  try {
    const status = path.join(directory, "status");
    await mkdir(status);
    const result = await runNode([bundle, directory], {
      XDG_CONFIG_HOME: path.join(directory, "config"),
      ENSEMBLE_STATUS_DIR: status,
      ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records")
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^No run was started and nothing was recorded\. WorkflowScriptReadError:/);
    assert.match(result.stderr, /the path is a directory, not a script file/);
    assert.doesNotMatch(result.stderr, /\[(?:status-file|sentinel|run-record)\]/);
    assert.deepEqual(await readdir(status), []);
    await assert.rejects(readdir(path.join(directory, "records")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const recording of [true, false]) {
    test(`${signal} settles a FIFO-blocked source read with recording ${recording ? "on" : "off"}`, { timeout: 90_000 }, async () => {
      const directory = await mkdtemp("/mnt/ai-data/scratch/ensemble-status-interrupt-");
      const fifo = path.join(directory, "workflow.mjs");
      execFileSync("mkfifo", [fifo]);
      const child = spawn(process.execPath, [bundle, fifo], {
        cwd: directory,
        env: hermeticEstateEnvironment({
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_DATA_HOME: path.join(directory, "data"),
          ENSEMBLE_RUN_RECORD: recording ? "1" : "0",
          ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records")
        }),
        signal: AbortSignal.timeout(60_000),
        stdio: ["ignore", "pipe", "pipe"]
      });
      const closed = once(child, "close");
      let stdout = "";
      let stderr = "";
      const announced = Promise.withResolvers<string>();
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
        const line = /\[status-file\] (\{[^\n]+\})\n/.exec(stderr);
        if (line !== null) announced.resolve(JSON.parse(line[1]!).status_path);
      });
      let feeder: Awaited<ReturnType<typeof open>> | null = null;
      try {
        const statusPath = await Promise.race([announced.promise, closed.then(() => {
          throw new Error(`launcher closed before status announcement: ${stderr}`);
        })]);
        const sentinelPath = /\[sentinel\] will write (.+) when the run ends/.exec(stderr)?.[1];
        assert.ok(sentinelPath, stderr);
        assert.equal(JSON.parse(await readFile(statusPath, "utf8")).workflow, null);
        // With recording on, the writer-open handshake proves the reader has
        // opened the FIFO and is waiting for bytes. With recording off, leave
        // the FIFO without a writer to cover interruption during open too.
        if (recording) feeder = await open(fifo, "w");
        // Never deliver source: settlement must come from the caught signal.
        assert.equal(child.kill(signal), true);
        const [code, terminatingSignal] = await closed;
        const expectedCode = signal === "SIGINT" ? 130 : 143;
        assert.equal(terminatingSignal, null, stderr);
        assert.equal(code, expectedCode, stderr);
        assert.deepEqual(JSON.parse(stdout), {
          partial: true, reason: "interrupted",
          error: { kind: "WorkflowInterruptedError", message: `Workflow interrupted by ${signal}` },
          completed: []
        });
        const sentinel = JSON.parse(await readFile(sentinelPath, "utf8"));
        assert.equal(sentinel.outcome, "interrupted");
        assert.equal(sentinel.exit_code, expectedCode);
        assert.deepEqual(sentinel.manifest, { unavailable: recording ? "recording-start-failed" : "recording-disabled" });
        await assert.rejects(readFile(statusPath), { code: "ENOENT" });
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await Promise.allSettled([closed]);
        await feeder?.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
