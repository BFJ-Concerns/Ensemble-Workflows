import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeCliControlPlane } from "../../src/claude-control-plane.js";

test("dispatch streams a multi-megabyte prompt byte-exactly instead of placing it on argv", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ensemble-claude-control-plane-"));
  try {
    const receivedPath = path.join(dir, "received-prompt.txt");
    const argvPath = path.join(dir, "dispatch-argv.json");
    const stubPath = path.join(dir, "claude-stub.mjs");
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const name = "large-prompt-probe";
    await writeFile(
      stubPath,
      `#!/usr/bin/env node
        import { writeFile } from "node:fs/promises";
        const args = process.argv.slice(2);
        if (args[0] === "--bg") {
          const chunks = [];
          for await (const chunk of process.stdin) chunks.push(chunk);
          await writeFile(${JSON.stringify(receivedPath)}, Buffer.concat(chunks));
          await writeFile(${JSON.stringify(argvPath)}, JSON.stringify(args));
          process.exit(0);
        }
        if (args[0] === "agents" && args[1] === "--json") {
          process.stdout.write(JSON.stringify([{
            id: "large-1",
            sessionId: ${JSON.stringify(sessionId)},
            name: ${JSON.stringify(name)},
            kind: "background",
            cwd: ${JSON.stringify(dir)},
            status: "busy",
            state: "working"
          }]));
          process.exit(0);
        }
        process.exit(0);
      `
    );
    await chmod(stubPath, 0o755);

    // Repeated non-ASCII text catches accidental character/byte conversions as
    // well as proving the payload is comfortably beyond ordinary argv limits.
    const prompt = `${"diff --git a/old b/new\n+résumé → exact bytes\n".repeat(60_000)}TAIL\n`;
    assert.ok(Buffer.byteLength(prompt) > 2 * 1024 * 1024);

    const controlPlane = new ClaudeCliControlPlane({
      claudeBin: stubPath,
      projectsDir: dir,
      dispatchTimeoutMs: 1_000
    });
    const handle = await controlPlane.dispatch({ prompt, name, cwd: dir });

    assert.equal(handle.sessionId, sessionId);
    assert.equal(await readFile(receivedPath, "utf8"), prompt);
    const dispatchArgv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
    assert.ok(!dispatchArgv.includes(prompt));
    assert.ok(dispatchArgv.every((argument) => Buffer.byteLength(argument) < 1024));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
