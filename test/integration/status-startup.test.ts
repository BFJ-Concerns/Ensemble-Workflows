import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { hermeticEstateEnvironment, runNode } from "./estate-process.js";

const bundle = path.resolve("plugin/skills/ensemble-workflow/scripts/ensemble.mjs");

test("concurrent runs publish supervision before FIFO source delivery and names before body entry", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-status-startup-"));
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

test("stdin script paths preserve piped and redirected workflow source", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-status-stdin-"));
  const source = `export const meta = { name: "stdin-source" }; return "🦊 café";`;
  try {
    await mkdir(path.join(directory, "status"));
    const alias = path.join(directory, "workflow.mjs");
    await symlink("/dev/stdin", alias);
    const inputPath = path.join(directory, "input.mjs");
    await writeFile(inputPath, source);
    for (const script of ["/dev/stdin", "/dev/fd/0", alias]) {
      for (const inputKind of ["pipe", "file"]) {
        const input = inputKind === "file" ? await open(inputPath, "r") : null;
        try {
          const result = spawnSync(
            input === null ? "/bin/sh" : process.execPath,
            input === null
              ? ["-c", 'cat "$1" | "$2" "$3" "$4"', "stdin-workflow", inputPath, process.execPath, bundle, script]
              : [bundle, script],
            {
              cwd: directory,
              env: hermeticEstateEnvironment({
                XDG_CONFIG_HOME: path.join(directory, "config"),
                ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"),
                ENSEMBLE_STATUS_DIR: path.join(directory, "status")
              }),
              encoding: "utf8",
              timeout: 60_000,
              stdio: [input?.fd ?? "pipe", "pipe", "pipe"]
            }
          );
          assert.ifError(result.error);
          assert.equal(result.status, 0, `${script} (${inputKind}): ${result.stderr}`);
          assert.equal(JSON.parse(result.stdout), "🦊 café");
          assert.match(result.stderr, /\[status-file\]/);
        } finally {
          await input?.close();
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inherited descriptor paths retain the launcher's files and pipes", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-status-descriptors-"));
  try {
    await mkdir(path.join(directory, "status"));
    const input = path.join(directory, "workflow.mjs");
    await writeFile(input, 'export const meta = { name: "descriptor-source" }; return 42;');
    const alias = path.join(directory, "alias.mjs");
    await symlink("/dev/fd/5", alias);
    for (const script of ["/dev/fd/5", "/dev/fd/7", "/dev/fd/9", "/dev/fd/30", "/proc/self/fd/5", alias]) {
      const descriptor = /fd\/(\d+)$/.exec(script)?.[1] ?? "5";
      for (const delivery of ["file", "pipe"]) {
        // Bash supplies real inherited descriptors; Node's stdio pipes are sockets.
        const command = delivery === "file"
          ? 'exec "$1" "$2" "$3" ' + descriptor + '<"$4"'
          : 'cat "$4" | { exec ' + descriptor + '<&0; exec "$1" "$2" "$3"; }';
        const result = spawnSync("/bin/bash", ["-c", command, "descriptor-workflow", process.execPath, bundle, script, input], {
          cwd: directory,
          env: hermeticEstateEnvironment({
            XDG_CONFIG_HOME: path.join(directory, "config"),
            ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"),
            ENSEMBLE_STATUS_DIR: path.join(directory, "status")
          }),
          encoding: "utf8",
          timeout: 60_000
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${script} (${delivery}): ${result.stderr}`);
        assert.equal(JSON.parse(result.stdout), 42);
      }
    }
    // A descriptor naming a directory can itself contain a descriptor alias.
    await symlink("/dev/fd/7", path.join(directory, "nested-alias.mjs"));
    const nested = spawnSync("/bin/bash", ["-c",
      'exec 5<"$3" 7<"$4"; exec "$1" "$2" /dev/fd/5/nested-alias.mjs',
      "directory-descriptor-workflow", process.execPath, bundle, directory, input], {
      cwd: directory,
      env: hermeticEstateEnvironment({
        XDG_CONFIG_HOME: path.join(directory, "config"),
        ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"),
        ENSEMBLE_STATUS_DIR: path.join(directory, "status")
      }),
      encoding: "utf8",
      timeout: 60_000
    });
    assert.ifError(nested.error);
    assert.equal(nested.status, 0, nested.stderr);
    assert.equal(JSON.parse(nested.stdout), 42);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a directory script path is rejected before supervision starts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-status-path-"));
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
  for (const sourceKind of ["FIFO", "stdin", "descriptor"]) {
    for (const recording of [true, false]) {
      test(`${signal} settles a ${sourceKind}-blocked source read with recording ${recording ? "on" : "off"}`, { timeout: 90_000 }, async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "ensemble-status-interrupt-"));
        const fifo = path.join(directory, "workflow.mjs");
        execFileSync("mkfifo", [fifo]);
        const stdin = sourceKind !== "FIFO" ? await open(fifo, "r+") : null;
        const stdio: ("ignore" | "pipe" | number)[] = [stdin?.fd ?? "ignore", "pipe", "pipe"];
        if (sourceKind === "descriptor") {
          stdio[0] = "ignore";
          stdio.push("ignore", "ignore", stdin!.fd);
        }
        const child = spawn(process.execPath, [bundle, sourceKind === "FIFO" ? fifo : sourceKind === "stdin" ? "/dev/stdin" : "/dev/fd/5"], {
          cwd: directory,
          env: hermeticEstateEnvironment({
            XDG_CONFIG_HOME: path.join(directory, "config"),
            XDG_DATA_HOME: path.join(directory, "data"),
            ENSEMBLE_RUN_RECORD: recording ? "1" : "0",
            ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records")
          }),
          signal: AbortSignal.timeout(60_000),
          stdio
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
          if (recording && sourceKind === "FIFO") feeder = await open(fifo, "w");
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
          await stdin?.close();
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }
}
