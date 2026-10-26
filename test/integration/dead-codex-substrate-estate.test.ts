import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertSalvageEnvelope, runProcess } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

test("an app-server exit or closed stdin yields a handled refusal", { timeout: 180_000 }, async () => {
  for (const mode of ["exit-at-start", "close-stdin-before-exit", "approval-after-stdin-close"] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-dead-codex-"));
    const binDirectory = path.join(directory, "bin");
    const codexBin = path.join(binDirectory, "codex");
    const workflow = path.join(directory, "workflow.js");
    try {
      await mkdir(binDirectory);
      await writeFile(codexBin, `#!/usr/bin/env node
import { closeSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] === "app-server") writeFileSync(process.env.ENSEMBLE_DEAD_CODEX_PID_PATH, String(process.pid));
if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.0.0-dead-substrate\\n");
} else if (process.argv[2] !== "app-server") {
  process.exitCode = 2;
} else if (${JSON.stringify(mode)} === "exit-at-start") {
  process.stderr.write("fake app-server exited before startup\\n");
  process.exitCode = 73;
} else {
  process.stdin.on("error", () => undefined);
  const reader = createInterface({ input: process.stdin });
  reader.once("line", (line) => {
    const request = JSON.parse(line);
    reader.close();
    process.stdin.destroy();
    closeSync(0);
    process.stderr.write("fake app-server closed stdin before exit\\n");
    // The client cannot issue thread/start until it receives this response;
    // close stdin first so no write can slip through an open pipe.
    process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
    if (${JSON.stringify(mode)} === "approval-after-stdin-close") {
      process.stdout.write(JSON.stringify({ id: 999, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" } }) + "\\n");
    }
    // Stay alive beyond the client's stdin-close grace. The transport
    // must settle this live child and reap it during shutdown.
    setInterval(() => undefined, 1_000);
  });
}
`);
      await chmod(codexBin, 0o755);
      await writeFile(workflow, 'export const meta = { name: "dead-codex-substrate" };\nreturn await agent("never served", { engine: "codex", identity: true });\n');

      for (let attempt = 1; attempt <= (mode === "approval-after-stdin-close" ? 1 : 10); attempt += 1) {
        const pidPath = path.join(directory, `app-server-${attempt}.pid`);
        const result = await runProcess(process.execPath, [bundledCliPath, workflow], {
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          XDG_DATA_HOME: path.join(directory, `data-${attempt}`),
          ENSEMBLE_RUN_RECORD: "1",
          ENSEMBLE_STATUS: "0",
          ENSEMBLE_DEAD_CODEX_PID_PATH: pidPath
        }, 15_000);
        assert.equal(result.code, 1, `${mode} run ${attempt}: ${result.stderr}`);
        assert.ok(result.stdout.trim().length > 0, `${mode} run ${attempt}: missing failure envelope on stdout; stderr:\n${result.stderr}`);
        const envelope = assertSalvageEnvelope(result.stdout, "failed");
        assert.equal(envelope.error.kind, "CodexSubstrateRefusedError", `${mode} run ${attempt}: ${result.stderr}`);
        assert.doesNotMatch(result.stderr, /(?:write EPIPE|Unhandled 'error' event|unhandledRejection)/);
        if (mode === "exit-at-start") {
          assert.match(result.stderr, /codex app-server exited with code 73 signal null/);
        } else {
          assert.match(result.stderr, /codex app-server stdin closed unexpectedly/);
        }
        const pid = Number(await readFile(pidPath, "utf8"));
        assert.ok(Number.isInteger(pid) && pid > 0);
        await assertProcessReaped(pid);
        const announced = result.stderr.match(/\[sentinel\] will write (\S+) when the run ends/);
        assert.ok(announced, `${mode} run ${attempt}: ${result.stderr}`);
        const sentinel = JSON.parse(await readFile(announced[1]!, "utf8")) as { outcome: string; exit_code: number };
        assert.deepEqual({ outcome: sentinel.outcome, exit_code: sentinel.exit_code }, { outcome: "failed", exit_code: 1 });
        const manifest = JSON.parse(await readFile(path.join(path.dirname(announced[1]!), "manifest.json"), "utf8")) as {
          status: string;
          result: { exit_code: number | null };
        };
        assert.deepEqual({ status: manifest.status, exit_code: manifest.result.exit_code }, { status: "failed", exit_code: 1 });
        if (mode !== "exit-at-start") {
          assert.match(result.stderr, /fake app-server closed stdin before exit/);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function assertProcessReaped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (/\) [ZX] /.test(stat)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`app-server child ${pid} remained alive after transport shutdown`);
}
