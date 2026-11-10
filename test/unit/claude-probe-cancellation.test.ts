import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeCliControlPlane } from "../../src/claude-control-plane.js";
import type { RuntimeEvent } from "../../src/types.js";
import { isLive } from "../../src/worker-scopes.js";
import { waitForCondition } from "../wait-for-condition.js";

for (const stalled of ["open", "poll", "stop", "close", "dispatch-open", "dispatch-roster"] as const) {
  test(`a registered probe cancels a stalled ${stalled} command and bounds cleanup`, { timeout: 30_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), `claude-probe-${stalled}-`));
    const bin = path.join(dir, "claude.mjs");
    const argv = path.join(dir, "argv");
    const tmux = path.join(dir, "tmux.mjs");
    const valveClosed = path.join(dir, "valve-closed");
    const submitted = path.join(dir, "submitted");
    const opening = path.join(dir, "opening");
    const blocked = path.join(dir, "blocked");
    const release = path.join(dir, "release");
    const removed = path.join(dir, "removed");
    const events: RuntimeEvent[] = [];
    let settingsDir: string | null = null;
    await writeFile(bin, `#!/usr/bin/env node
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      if (args[0] === "--bg") writeFileSync(${JSON.stringify(argv)}, JSON.stringify(args));
      const launch = existsSync(${JSON.stringify(argv)}) ? JSON.parse(readFileSync(${JSON.stringify(argv)}, "utf8")) : null;
      const stuck = ${JSON.stringify(stalled)};
      if ((args[0] === "agents" && stuck === "dispatch-roster" && existsSync(${JSON.stringify(opening)}) && !existsSync(${JSON.stringify(removed)})) ||
          (args[0] === "agents" && stuck === "poll" && existsSync(${JSON.stringify(submitted)}) && !existsSync(${JSON.stringify(removed)})) ||
          (args[0] === "stop" && (stuck === "stop" || stuck === "close"))) {
        writeFileSync(${JSON.stringify(blocked)}, String(process.pid));
        while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (args[0] === "agents") console.log(JSON.stringify(launch && !existsSync(${JSON.stringify(removed)}) ? [{
        id: "registered-probe", sessionId: "probe-session", name: launch[launch.indexOf("--name") + 1],
        kind: "background", pid: process.pid, state: "done", status: "idle", cwd: ${JSON.stringify(dir)}
      }] : []));
      if (args[0] === "rm") writeFileSync(${JSON.stringify(removed)}, "");
    `);
    await chmod(bin, 0o755);
    await writeFile(tmux, `#!/usr/bin/env node
      import { existsSync, writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      if (args.includes("new-session")) {
        writeFileSync(${JSON.stringify(blocked)}, String(process.pid));
        while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
        process.exit(1);
      }
      if (args.includes("kill-server")) writeFileSync(${JSON.stringify(valveClosed)}, "");
    `);
    await chmod(tmux, 0o755);
    class SubmittedProbe extends ClaudeCliControlPlane {
      override async steer(handle: Parameters<ClaudeCliControlPlane["steer"]>[0], prompt: string) {
        const args = JSON.parse(await readFile(argv, "utf8")) as string[];
        const file = args[args.indexOf("--settings") + 1]!;
        settingsDir = path.dirname(file);
        const settings = JSON.parse(await readFile(file, "utf8")) as { env: { ANTHROPIC_BASE_URL: string } };
        if (stalled === "dispatch-roster") await writeFile(opening, "");
        if (stalled === "open" || stalled === "dispatch-open" || stalled === "dispatch-roster") return super.steer(handle, prompt);
        await fetch(`${settings.env.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: "POST", headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.fixture" },
          body: JSON.stringify({ tools: [{ name: "Read" }], messages: [{ role: "user", content: prompt }] })
        });
        await writeFile(submitted, "");
        return { submitted: true as const };
      }
    }
    const plane = new SubmittedProbe({
      claudeBin: bin, tmuxBin: tmux, valveAttachSettleMs: 0, reclaimTimeoutMs: 5_000, commandBounds: { stopGraceMs: 50, drainMs: 50 }, reapGraceMs: 0,
      workerEnv: { CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "0", CLAUDE_CODE_USE_FOUNDRY: "0" },
      onEvent: event => events.push(event)
    });
    const abort = new AbortController();
    const reason = new Error("registered probe deadline");
    let outcome: { error: unknown } | { value: unknown } | undefined;
    const pending = (stalled.startsWith("dispatch-")
      ? plane.dispatch({ cwd: dir, name: "ordinary-worker", prompt: "ordinary", signal: abort.signal })
      : plane.probeToolSurface({ cwd: dir, permissionDenyRules: [], settingsEnv: {}, signal: abort.signal }))
      .then(value => { outcome = { value }; }, error => { outcome = { error }; });
    let backstop: NodeJS.Timeout | undefined;
    try {
      await waitForCondition(() => access(blocked).then(() => true, () => false), `the ${stalled} command to stall`, 10_000);
      const pid = Number(await readFile(blocked, "utf8"));
      if (stalled === "close") {
        let closed = false;
        const closing = plane.close().then(() => { closed = true; });
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(closed, false, "close returned while the probe still owned its session teardown");
        await writeFile(release, "");
        await closing;
      } else {
        abort.abort(reason);
      }
      await Promise.race([pending, new Promise<void>(resolve => { backstop = setTimeout(resolve, 7_000); })]);
      const settledWithoutRelease = outcome !== undefined;
      // Let a broken implementation finish too: this is a controlled gate,
      // not a permanent leaked native process in a failing regression.
      await writeFile(release, "");
      await pending;
      assert.equal(settledWithoutRelease, true, `the probe still awaited the stalled ${stalled} command after its bound`);
      if (stalled === "stop" || stalled === "close") {
        assert.ok(outcome && "value" in outcome, "cleanup cancellation replaced an established surface");
        assert.equal((outcome.value as { cliVersion: string }).cliVersion, "2.1.fixture");
      } else if (stalled.startsWith("dispatch-")) {
        assert.ok(outcome && "error" in outcome, "ordinary opening cancellation did not settle");
        assert.deepEqual(Object.getOwnPropertyNames(reason), ["stack", "message"], "cancellation reason was mutated");
      } else {
        assert.ok(outcome && "error" in outcome && outcome.error === reason);
      }
      await waitForCondition(() => !isLive(pid), `the stalled ${stalled} command to end`, 5_000);
      if (stalled === "open" || stalled === "dispatch-open") await access(valveClosed);
      if (stalled === "stop") {
        assert.equal(events.at(-1)?.method, "claude/launchUnreclaimed");
        assert.match(String(events.at(-1)?.params.reason), /probe.*cleanup.*not confirmed/);
        assert.ok(settingsDir && await access(settingsDir).then(() => true, () => false), "unconfirmed cleanup discarded settings");
      }
    } finally {
      if (backstop !== undefined) clearTimeout(backstop);
      await writeFile(release, "");
      await pending;
      await plane.close();
      if (settingsDir !== null) await rm(settingsDir, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
}
