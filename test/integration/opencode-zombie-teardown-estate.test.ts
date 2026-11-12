import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runProcess } from "./estate-process.js";

const launcher = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

// This parent adopts orphaned descendants but deliberately leaves them
// unreaped until the launcher has finished. The test never depends on PID 1's
// reaping speed, and a zombie cannot hold a pipe or execute a command.
const UNREAPING_PARENT = `import ctypes, json, os, pathlib, signal, subprocess, sys, time
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
marker = pathlib.Path(sys.argv[1])
live_threads = sys.argv[2] == 'live-threads'
child = subprocess.Popen(sys.argv[3:], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    observed_thread_leader = False
    if live_threads:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                pid = int(marker.read_text().strip())
                stat = pathlib.Path('/proc/' + str(pid) + '/stat').read_text()
                fields = stat[stat.rfind(')') + 2:].split()
                if fields[0] == 'Z' and int(fields[17]) > 1:
                    observed_thread_leader = True
                    break
            except FileNotFoundError:
                pass
            if child.poll() is not None:
                raise RuntimeError('fixture ended before its exited thread leader was observed')
            time.sleep(0.01)
        if not observed_thread_leader:
            raise RuntimeError('fixture did not expose an exited leader with live threads')
    stdout, stderr = child.communicate(timeout=45)
    pid = int(marker.read_text().strip())
    try:
        stat = pathlib.Path('/proc/' + str(pid) + '/stat').read_text()
        fields = stat[stat.rfind(')') + 2:].split()
        state, group = fields[0], int(fields[2])
    except FileNotFoundError:
        state, group = 'gone', None
    print(json.dumps({'code': child.returncode, 'stdout': stdout, 'stderr': stderr, 'descendant_state': state, 'descendant_group': group, 'observed_thread_leader': observed_thread_leader}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    if marker.exists():
        try:
            pid = int(marker.read_text().strip())
            stat = pathlib.Path('/proc/' + str(pid) + '/stat').read_text()
            fields = stat[stat.rfind(')') + 2:].split()
            # We have not reaped our adopted children, so their IDs stay
            # allocated until the waitpid below. Never signal a reused ID.
            if int(fields[1]) == os.getpid():
                os.kill(pid, signal.SIGKILL)
        except (FileNotFoundError, ProcessLookupError):
            pass
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0: break
        except ChildProcessError: break
`;

for (const liveThreads of [false, true]) {
  test(liveThreads ? "a no-manager opencode timeout stops live threads after their leader has exited" : "a no-manager opencode timeout with an unreaped zombie keeps a handled run complete", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-opencode-zombie-"));
    const config = path.join(directory, "config/ensemble");
    const marker = path.join(directory, "descendant.pid");
    try {
      await mkdir(config, { recursive: true });
      await writeFile(path.join(config, "config.json"), JSON.stringify({ schema_version: 1, opencode_models: { fixture: { provider_model: "fixture/model" } } }));
      const fixture = path.join(directory, "opencode");
      await writeFile(fixture, liveThreads ? `#!/usr/bin/env python3
import ctypes, os, pathlib, signal, sys, threading, time
if '--version' in sys.argv:
    print('fixture')
    sys.exit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
def work():
    while True:
        time.sleep(1)
threading.Thread(target=work).start()
pathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))
# The native main thread exits while the worker thread keeps executing.
ctypes.CDLL(None).pthread_exit(None)
` : `#!/usr/bin/env python3
import os, pathlib, signal, sys
if '--version' in sys.argv:
    print('fixture')
    sys.exit(0)
# Retain the child ourselves through SIGTERM. The group's SIGKILL ends this
# parent without a waitpid, so the outer subreaper necessarily adopts its zombie.
signal.signal(signal.SIGTERM, signal.SIG_IGN)
pid = os.fork()
if pid == 0:
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    os.execlp('sleep', 'sleep', '120')
pathlib.Path(${JSON.stringify(marker)}).write_text(str(pid))
while True:
    signal.pause()
`);
      await chmod(fixture, 0o755);
      const workflow = path.join(directory, "workflow.js");
      await writeFile(workflow, `export const meta = { name: 'zombie-opencode-timeout' };
const answer = await agent('fixture', { engine: 'opencode', model: 'fixture', timeoutMs: 5000, maxAttempts: 1 });
return { handled: answer === null };
`);
      const driven = await runProcess("python3", ["-c", UNREAPING_PARENT, marker, liveThreads ? "live-threads" : "zombie-only", process.execPath, launcher, workflow], {
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: path.join(directory, "config"),
        ENSEMBLE_RUN_RECORD_DIR: path.join(directory, "records"), ENSEMBLE_STATUS: "off",
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/no-bus`, XDG_RUNTIME_DIR: path.join(directory, "no-runtime")
      }, 60_000);
      assert.equal(driven.code, 0, driven.stderr);
      const result = JSON.parse(driven.stdout) as { code: number; stdout: string; stderr: string; descendant_state: string; descendant_group: number | null; observed_thread_leader: boolean };
      assert.equal(result.observed_thread_leader, liveThreads);
      assert.equal(result.descendant_state, liveThreads ? "gone" : "Z", liveThreads ? "live threads must end before teardown finishes" : "the parent must retain the terminated descendant through teardown");
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { handled: true });
      assert.match(result.stderr, /stopped a command and could not establish.*cut short without a scope/);
      assert.doesNotMatch(result.stderr, /outlived SIGTERM|failed to end cleanly/);
      const sentinelPath = result.stderr.match(/^\[sentinel\] will write (.+) when the run ends$/m)?.[1];
      assert.ok(sentinelPath);
      const sentinel = JSON.parse(await readFile(sentinelPath, "utf8")) as { outcome: string; teardown_error: unknown };
      assert.equal(sentinel.outcome, "complete");
      assert.equal(sentinel.teardown_error, null);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

}
