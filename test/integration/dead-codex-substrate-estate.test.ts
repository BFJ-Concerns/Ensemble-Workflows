import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertSalvageEnvelope, runProcess } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

test("a dead Codex app-server always yields a handled refusal across write and exit orderings", { timeout: 60_000 }, async () => {
  for (const mode of ["exit-at-start", "close-stdin-before-exit"] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), "ensemble-dead-codex-"));
    const binDirectory = path.join(directory, "bin");
    const codexBin = path.join(binDirectory, "codex");
    const workflow = path.join(directory, "workflow.js");
    try {
      await mkdir(binDirectory);
      await writeFile(codexBin, `#!/usr/bin/env node
import { closeSync } from "node:fs";
import { createInterface } from "node:readline";
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
    process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n", () => {
      reader.close();
      closeSync(0);
      process.stderr.write("fake app-server closed stdin before exit\\n");
      setTimeout(() => { process.exitCode = 73; }, 750);
    });
  });
}
`);
      await chmod(codexBin, 0o755);
      await writeFile(workflow, 'export const meta = { name: "dead-codex-substrate" };\nreturn await agent("never served", { engine: "codex", identity: true });\n');

      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const result = await runProcess(process.execPath, [bundledCliPath, workflow], {
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          XDG_DATA_HOME: path.join(directory, `data-${attempt}`),
          ENSEMBLE_RUN_RECORD: "1",
          ENSEMBLE_STATUS: "0"
        }, 15_000);
        assert.equal(result.code, 1, `${mode} run ${attempt}: ${result.stderr}`);
        assert.ok(result.stdout.trim().length > 0, `${mode} run ${attempt}: missing failure envelope on stdout; stderr:\n${result.stderr}`);
        const envelope = assertSalvageEnvelope(result.stdout, "failed");
        assert.equal(envelope.error.kind, "CodexSubstrateRefusedError", `${mode} run ${attempt}: ${result.stderr}`);
        assert.doesNotMatch(result.stderr, /(?:write EPIPE|Unhandled 'error' event|unhandledRejection)/);
        assert.match(result.stderr, /codex app-server exited with code 73 signal null/);
        const announced = result.stderr.match(/\[sentinel\] will write (\S+) when the run ends/);
        assert.ok(announced, `${mode} run ${attempt}: ${result.stderr}`);
        const sentinel = JSON.parse(await readFile(announced[1]!, "utf8")) as { outcome: string; exit_code: number };
        assert.deepEqual({ outcome: sentinel.outcome, exit_code: sentinel.exit_code }, { outcome: "failed", exit_code: 1 });
        const manifest = JSON.parse(await readFile(path.join(path.dirname(announced[1]!), "manifest.json"), "utf8")) as {
          status: string;
          result: { exit_code: number | null };
        };
        assert.deepEqual({ status: manifest.status, exit_code: manifest.result.exit_code }, { status: "failed", exit_code: 1 });
        if (mode === "close-stdin-before-exit") {
          assert.match(result.stderr, /fake app-server closed stdin before exit/);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
