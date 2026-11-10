import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { resolveAmbientSettings } from "../../src/ambient-settings.js";
import { readProcessStartTicks } from "../../src/process-owner-evidence.js";
import { executablePath, hermeticEstateEnvironment } from "../integration/estate-process.js";

const exec = promisify(execFile);

/** Private clients and daemon; no command can address the operator's config. */
export async function installDeliveryClients(
  directory: string,
  pause: boolean,
  executables?: { claude: string; tmux: string }
): Promise<{ bin: string; env: NodeJS.ProcessEnv; dispose: () => Promise<void> }> {
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  // Resolve once: shared symlink changes cannot switch this journey's clients.
  const claude = await realpath(executables?.claude ?? await executablePath("claude"));
  const tmux = await realpath(executables?.tmux ?? await executablePath("tmux"));
  const config = path.join(directory, "claude-config");
  const xdg = path.join(directory, "config");
  await mkdir(config, { mode: 0o700 });
  await mkdir(path.join(xdg, "ensemble"), { recursive: true });
  await writeFile(path.join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
  await writeFile(path.join(config, "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }), { mode: 0o600 });
  const workerEnvironment = resolveAmbientSettings({ env: process.env, cwd: process.cwd() }).workerEnvironment;
  const clientPath = bin + path.delimiter + process.env.PATH;
  // Keep machine authentication in private settings, never diagnostics or argv.
  await writeFile(path.join(xdg, "ensemble", "config.json"), JSON.stringify({
    schema_version: 1,
    worker_environment: {
      ...workerEnvironment,
      claude: { ...workerEnvironment.claude, CLAUDE_CONFIG_DIR: config, PATH: clientPath }
    }
  }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    PATH: clientPath, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: xdg,
    NODE_TEST_CONTEXT: undefined
  };
  const state = path.join(directory, "attach.json");
  const events = path.join(directory, "pause.jsonl");
  const stopped = path.join(directory, "stopped.json");
  const ownerModule = new URL("../../src/process-owner-evidence.js", import.meta.url).href;
  const common = `
    import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { readProcessStartTicks } from ${JSON.stringify(ownerModule)};
    const statePath = ${JSON.stringify(state)};
    const eventsPath = ${JSON.stringify(events)};
    const stoppedPath = ${JSON.stringify(stopped)};
    async function identity(pid) {
      const start = await readProcessStartTicks('/proc', pid);
      if (start === null) return null;
      try {
        const status = readFileSync('/proc/' + pid + '/status', 'utf8');
        return { pid, start, state: /^State:\\s+(\\S)/m.exec(status)?.[1] };
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
        throw error;
      }
    }
    async function current(owner) {
      const observed = await identity(owner.pid);
      return observed?.start === owner.start ? observed : null;
    }
    async function resume() {
      if (!existsSync(stoppedPath)) return;
      const owner = JSON.parse(readFileSync(stoppedPath, 'utf8'));
      if (await current(owner)) {
        process.kill(owner.pid, 'SIGCONT');
        appendFileSync(eventsPath, JSON.stringify({ event: 'resumed', ...owner }) + '\\n');
      }
      unlinkSync(stoppedPath);
    }
  `;
  await writeFile(path.join(bin, "claude"), `#!${process.execPath}
    import { spawn } from 'node:child_process';
    ${common}
    const args = process.argv.slice(2);
    const child = spawn(${JSON.stringify(claude)}, args, { stdio: 'inherit' });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
    if (args[0] === 'attach' && child.pid) {
      const owner = await identity(child.pid);
      if (owner) writeFileSync(statePath, JSON.stringify(owner));
    }
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      process.on(signal, async () => {
        try { if (args[0] === 'attach') await resume(); }
        finally { child.kill(signal); }
      });
    }
  `, { mode: 0o755 });
  await writeFile(path.join(bin, "tmux"), `#!${process.execPath}
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    ${common}
    const args = process.argv.slice(2);
    const command = [...args];
    while (command[0] === '-S' || command[0] === '-f') command.splice(0, 2);
    const literal = command[0] === 'send-keys' && command.includes('-l');
    const pause = ${JSON.stringify(pause)};
    // Stop before the first byte and retain the pause across every batch.
    // Only submission or cleanup may release the accumulated input.
    if (pause && literal && !existsSync(stoppedPath)) {
      const owner = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.ok(await current(owner), 'owned attach client exited before the pause');
      process.kill(owner.pid, 'SIGSTOP');
      const deadline = Date.now() + 5000;
      let observed;
      do {
        observed = await current(owner);
        if (observed?.state === 'T') break;
        await delay(5);
      } while (Date.now() < deadline);
      assert.equal(observed?.state, 'T', 'attach reader did not stop');
      writeFileSync(stoppedPath, JSON.stringify({ ...owner, units: 0, sends: 0 }));
      appendFileSync(eventsPath, JSON.stringify({ event: 'stopped-before-send', ...observed }) + '\\n');
    }
    if (pause && !literal) await resume();
    const owner = pause && literal ? JSON.parse(readFileSync(stoppedPath, 'utf8')) : null;
    const before = owner ? await current(owner) : null;
    const result = spawnSync(${JSON.stringify(tmux)}, args, { stdio: 'inherit', timeout: 15000 });
    if (owner) {
      const after = await current(owner);
      assert.equal(before?.state, 'T', 'reader resumed before a literal send');
      assert.equal(after?.state, 'T', 'reader resumed during a literal send');
      const payload = command.at(-1);
      // Count actual forwarded UTF-16 units, decoding records where present;
      // raw slices retain their literal length for discrimination runs.
      const units = payload.replace(/\\x1b\\[0;0;(\\d+);1;0;1_/g,
        (_, unit) => String.fromCharCode(Number(unit))).length;
      if (result.status === 0) { owner.units += units; owner.sends += 1; }
      writeFileSync(stoppedPath, JSON.stringify(owner));
      appendFileSync(eventsPath, JSON.stringify({ event: 'send-while-stopped', pid: owner.pid,
        before: before.state, after: after.state, exit: result.status,
        bytes: Buffer.byteLength(payload), units }) + '\\n');
    }
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  `, { mode: 0o755 });
  return {
    bin, env,
    dispose: async () => {
      await resumeDeliveryClient(directory);
      await exec(claude, ["daemon", "stop", "--any"], {
        env: hermeticEstateEnvironment(env), timeout: 30_000, maxBuffer: 1024 * 1024
      });
    }
  };
}

/** Resume only the recorded process with its original kernel identity. */
export async function resumeDeliveryClient(directory: string): Promise<void> {
  let owner: { pid: number; start: string };
  try {
    owner = JSON.parse(await readFile(path.join(directory, "attach.json"), "utf8")) as typeof owner;
    if (await readProcessStartTicks("/proc", owner.pid) === owner.start) {
      process.kill(owner.pid, "SIGCONT");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH") throw error;
  }
}
