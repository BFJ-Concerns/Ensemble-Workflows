import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { executablePath } from "../integration/estate-process.js";

/** Test-owned clients only: the daemon and its worker processes are never signalled. */
export async function installDeliveryClients(directory: string, pause: boolean): Promise<string> {
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  // Resolve once: a change to the operator's shared symlink must not change
  // this journey's dispatch and attach executables halfway through a turn.
  const claude = await realpath(await executablePath("claude"));
  const tmux = await realpath(await executablePath("tmux"));
  const state = path.join(directory, "attach.json");
  const events = path.join(directory, "pause.jsonl");
  const stopped = path.join(directory, "stopped.json");
  const common = `
    import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
    const statePath = ${JSON.stringify(state)};
    const eventsPath = ${JSON.stringify(events)};
    const stoppedPath = ${JSON.stringify(stopped)};
    function identity(pid) {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid, start: fields[19], state: fields[0] };
    }
    function current(owner) {
      try {
        const observed = identity(owner.pid);
        return observed.start === owner.start ? observed : null;
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
        throw error;
      }
    }
    function resume() {
      if (!existsSync(stoppedPath)) return;
      const owner = JSON.parse(readFileSync(stoppedPath, 'utf8'));
      if (current(owner)) {
        process.kill(owner.pid, 'SIGCONT');
        appendFileSync(eventsPath, JSON.stringify({ event: 'resumed', pid: owner.pid }) + '\\n');
      }
    }
  `;
  await writeFile(path.join(bin, "claude"), `#!${process.execPath}
    import { spawn } from 'node:child_process';
    ${common}
    const args = process.argv.slice(2);
    const child = spawn(${JSON.stringify(claude)}, args, { stdio: 'inherit' });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    if (args[0] === 'attach' && child.pid) {
      writeFileSync(statePath, JSON.stringify(identity(child.pid)));
    }
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      process.on(signal, () => { if (args[0] === 'attach') resume(); child.kill(signal); });
    }
    child.on('exit', code => { process.exitCode = code ?? 1; });
  `, { mode: 0o755 });
  await writeFile(path.join(bin, "tmux"), `#!${process.execPath}
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    ${common}
    const args = process.argv.slice(2);
    const command = [...args];
    while (command[0] === '-S' || command[0] === '-f') command.splice(0, 2);
    const literal = command[0] === 'send-keys' && command.includes('-l');
    const paused = ${JSON.stringify(pause)} && existsSync(stoppedPath);
    // The second send runs while the reader is stopped. Enter and cleanup
    // must always unstick it, including a base delivery with only one batch.
    if (paused && !literal) resume();
    const before = paused && literal ? current(JSON.parse(readFileSync(stoppedPath, 'utf8'))) : null;
    const result = spawnSync(${JSON.stringify(tmux)}, args, { stdio: 'inherit', timeout: 15000 });
    if (literal && ${JSON.stringify(pause)}) {
      if (!existsSync(stoppedPath) && result.status === 0) {
        const owner = JSON.parse(readFileSync(statePath, 'utf8'));
        assert.ok(current(owner), 'owned attach client exited before the pause');
        process.kill(owner.pid, 'SIGSTOP');
        const deadline = Date.now() + 5000;
        let observed;
        do {
          observed = current(owner);
          if (observed?.state === 'T') break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        } while (Date.now() < deadline);
        assert.equal(observed?.state, 'T', 'attach reader did not stop');
        writeFileSync(stoppedPath, JSON.stringify(owner));
        appendFileSync(eventsPath, JSON.stringify({ event: 'stopped-after-send', pid: owner.pid, state: observed.state }) + '\\n');
      } else if (before?.state === 'T') {
        const after = current(JSON.parse(readFileSync(stoppedPath, 'utf8')));
        appendFileSync(eventsPath, JSON.stringify({ event: 'send-while-stopped', pid: before.pid,
          before: before.state, after: after?.state, exit: result.status, bytes: Buffer.byteLength(command.at(-1)) }) + '\\n');
        resume();
      }
    }
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  `, { mode: 0o755 });
  return bin;
}

/** Resume only the recorded process with its original kernel identity. */
export async function resumeDeliveryClient(directory: string): Promise<void> {
  let owner: { pid: number; start: string };
  try {
    owner = JSON.parse(await readFile(path.join(directory, "attach.json"), "utf8")) as typeof owner;
    const stat = await readFile(`/proc/${owner.pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === owner.start) {
      process.kill(owner.pid, "SIGCONT");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH") throw error;
  }
}
