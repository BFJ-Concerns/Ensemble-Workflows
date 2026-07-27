import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRuntime } from "../../src/index.js";

import type { AgentOptions, EngineName } from "../../src/types.js";

const isLive = process.env.ENSEMBLE_LIVE === "1";

test(
  "live per-call cwd places Codex, Claude, and opencode workers in the same requested directory",
  { skip: !isLive, timeout: 900_000 },
  async () => {
    const markerDir = await mkdtemp(path.join(tmpdir(), "ensemble-uniform-cwd-"));
    const marker = `UNIFORM_CWD_${randomUUID()}`;
    await writeFile(path.join(markerDir, "marker.txt"), marker);
    const runtime = await createRuntime({
      cwd: process.cwd(),
      concurrencyCaps: { codex: 1, claude: 1, opencode: 1 },
      defaultTurnTimeoutMs: 420_000,
      defaultMaxAttempts: 1
    });

    const engines: Array<{ name: EngineName; model?: string }> = [
      { name: "codex" },
      { name: "claude" },
      { name: "opencode", model: "glm-5.2" }
    ];

    try {
      for (const engine of engines) {
        const options: AgentOptions & { schema?: undefined } = {
          engine: engine.name,
          cwd: markerDir,
          ...(engine.model !== undefined ? { model: engine.model } : {})
        };
        const result = await runtime.agent(
          "Read marker.txt from your current working directory using your tools. Return the file's exact contents.",
          options
        );
        assert.match(result, new RegExp(marker), `${engine.name} did not return the marker read from its cwd`);
      }
    } finally {
      await runtime.close();
      await rm(markerDir, { recursive: true, force: true });
    }
  }
);
