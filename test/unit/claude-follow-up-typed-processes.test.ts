import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { executablePath, hermeticEstateEnvironment } from "../integration/estate-process.js";
import { installDeliveryClients } from "../live/claude-follow-up-typed-processes.js";
import { PASTE_PROMOTION_UTF16_UNITS } from "../live/claude-follow-up-typed-prompts.js";

const exec = promisify(execFile);

// A terminal reader observes real tmux output; it does not emulate Claude's
// parser. Only the separate live journey can prove input classification.
async function terminalClient(directory: string): Promise<string> {
  const file = path.join(directory, "terminal-client");
  await writeFile(file, `#!${process.execPath}
    import { writeFileSync, appendFileSync } from 'node:fs';
    const observed = {
      config: process.env.CLAUDE_CONFIG_DIR,
      xdg: process.env.XDG_CONFIG_HOME,
      testContext: process.env.NODE_TEST_CONTEXT
    };
    if (process.argv[2] === 'attach') {
      process.stdin.setRawMode(true);
      process.stdin.on('data', data => appendFileSync(${JSON.stringify(path.join(directory, "input"))}, data));
      writeFileSync(${JSON.stringify(path.join(directory, "ready"))}, 'ready');
      process.stdin.resume();
    } else if (process.argv[2] === 'daemon') {
      writeFileSync(${JSON.stringify(path.join(directory, "daemon-stop.json"))}, JSON.stringify(observed));
    } else {
      console.log(JSON.stringify(observed));
    }
  `, { mode: 0o755 });
  return file;
}

async function waitForFile(file: string, minimum = 1): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (true) {
    const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (text.length >= minimum) return text;
    assert.ok(Date.now() < deadline, `timed out waiting for ${path.basename(file)}`);
    await delay(10);
  }
}

test("delivery clients scope daemon calls to a private config without Node test context", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "delivery-private-config-"));
  let clients: Awaited<ReturnType<typeof installDeliveryClients>> | undefined;
  try {
    clients = await installDeliveryClients(directory, false, {
      claude: await terminalClient(directory), tmux: await executablePath("tmux")
    });
    const env = hermeticEstateEnvironment(clients.env);
    const observed = JSON.parse((await exec(path.join(clients.bin, "claude"), ["agents", "--json"], { env })).stdout);
    assert.deepEqual(observed, {
      config: path.join(directory, "claude-config"), xdg: path.join(directory, "config")
    });
    await clients.dispose();
    clients = undefined;
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "daemon-stop.json"), "utf8")), observed,
      "daemon cleanup addressed a different configuration");
  } finally {
    try { await clients?.dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("the delivery pause accumulates multiple real tmux sends above the paste threshold until submit", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "delivery-paused-client-"));
  // A short owned socket root keeps Unix socket paths below the kernel cap.
  const socketRoot = await mkdtemp(path.join(tmpdir(), "fs-"));
  let clients: Awaited<ReturnType<typeof installDeliveryClients>> | undefined;
  try {
    const tmux = await executablePath("tmux");
    clients = await installDeliveryClients(directory, true, { claude: await terminalClient(directory), tmux });
    const env = hermeticEstateEnvironment({ ...clients.env, SHELL: "/bin/sh" });
    const socket = path.join(socketRoot, "tmux.sock");
    const send = async (...args: string[]): Promise<void> => {
      await exec(path.join(clients!.bin, "tmux"), ["-S", socket, ...args], { env, timeout: 20_000 });
    };
    try {
      await send("-f", "/dev/null", "new-session", "-d", "-s", "delivery",
        `${path.join(clients.bin, "claude")} attach owned`);
      await waitForFile(path.join(directory, "ready"));
      await waitForFile(path.join(directory, "attach.json"));
      const payloads = Array.from({ length: 6 }, (_, index) => String(index).repeat(200));
      for (const payload of payloads) await send("send-keys", "-t", "delivery", "-l", "--", payload);
      await send("send-keys", "-t", "delivery", "Enter");
      const expected = payloads.join("") + "\r";
      assert.equal(await waitForFile(path.join(directory, "input"), expected.length), expected);
      const events = (await readFile(path.join(directory, "pause.jsonl"), "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as { event: string; before?: string; after?: string; units?: number; sends?: number });
      const resumed = events.filter((event) => event.event === "resumed");
      assert.equal(resumed.length, 1, "the reader resumed between literal sends");
      assert.ok((resumed[0]?.units ?? 0) > PASTE_PROMOTION_UTF16_UNITS, "pause never accumulated the paste threshold");
      assert.equal(resumed[0]?.sends, payloads.length);
      const sends = events.filter((event) => event.event === "send-while-stopped");
      assert.equal(sends.length, payloads.length);
      assert.ok(sends.every((event) => event.before === "T" && event.after === "T"));
    } finally {
      await send("kill-server").catch((error: { code?: number }) => {
        if (error.code !== 1) throw error;
      });
    }
  } finally {
    try { await clients?.dispose(); }
    finally {
      await rm(directory, { recursive: true, force: true });
      await rm(socketRoot, { recursive: true, force: true });
      console.log(JSON.stringify({ removedSocketRoot: socketRoot }));
    }
  }
});
