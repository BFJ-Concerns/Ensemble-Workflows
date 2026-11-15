import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { CodexAppServerTransport } from "../../src/app-server.js";

for (const repeated of [false, true]) {
  test(`Codex model discovery ${repeated ? "refuses a repeated cursor" : "reads hidden models and every page"}`, async () => {
    const directory = await mkdtemp("/mnt/ai-data/scratch/ensemble-effort-list-");
    let transport: CodexAppServerTransport | undefined;
    try {
      const bin = path.join(directory, "codex.mjs");
      await writeFile(bin, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "model/list") {
    if (request.params.includeHidden !== true) process.exit(2);
    const next = request.params.cursor === "next";
    result = { data: [{ model: next ? "second" : "first", isDefault: next,
      supportedReasoningEfforts: [{ reasoningEffort: "none" }, { reasoningEffort: "ultra" }] }],
      nextCursor: next && !${repeated} ? null : "next" };
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`);
      await chmod(bin, 0o700);
      transport = await CodexAppServerTransport.start({ cwd: directory, codexBin: bin, requestTimeoutMs: 30_000,
        startupHandshakeTimeoutMs: 30_000, clientName: "effort-test", clientVersion: "0" });
      if (repeated) await assert.rejects(transport.listModels(), /repeated the cursor/);
      else assert.deepEqual(await transport.listModels(), [
        { model: "first", isDefault: false, supportedReasoningEfforts: ["none", "ultra"] },
        { model: "second", isDefault: true, supportedReasoningEfforts: ["none", "ultra"] }
      ]);
    } finally {
      await transport?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
