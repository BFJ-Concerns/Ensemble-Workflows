import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

// These destructive legs are parked separately from the ordinary live estate:
// they deliberately terminate paid workers and require enough provider
// throughput for worker text to arrive before the deadline.
const isLive = process.env.ENSEMBLE_LIVE === "1" && process.env.ENSEMBLE_LIVE_FAILURE_EVIDENCE === "1";
const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const scenario of [
  { engine: "claude", model: null, error: /ClaudePollTimeoutError/ },
  { engine: "opencode", model: "glm-5.2", error: /OpenCodeRunError/ }
] as const) {
  test(
    `live built CLI archives partial ${scenario.engine} text and reports its timeout cause`,
    { skip: !isLive, timeout: 180_000 },
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), `ensemble-live-${scenario.engine}-failure-`));
      const script = path.join(directory, "workflow.js");
      const recordStore = path.join(directory, "records");
      const token = `LIVE_${scenario.engine.toUpperCase()}_PARTIAL_${randomUUID()}`;
      const model = scenario.model === null ? "" : `model: ${JSON.stringify(scenario.model)},`;

      try {
        await writeFile(
          script,
          `
            export const meta = {
              name: ${JSON.stringify(`${scenario.engine}-failure-evidence`)},
              description: "Archive live worker text when the turn times out"
            };

            return await agent(
              ${JSON.stringify(
                `Begin your final answer immediately with ${token}. Then continue writing a detailed numbered analysis for at least two minutes without ending the answer.`
              )},
              {
                engine: ${JSON.stringify(scenario.engine)},
                ${model}
                label: ${JSON.stringify(`failure-evidence-${scenario.engine}`)},
                timeoutMs: 30_000,
                maxAttempts: 1
              }
            );
          `
        );

        const result = await runNode([bundledCliPath, script], {
          ...process.env,
          ENSEMBLE_RUN_RECORD: "1",
          ENSEMBLE_RUN_RECORD_DIR: recordStore,
          ENSEMBLE_STATUS: "0"
        });

        assert.equal(result.code, 1, result.stderr);
        assert.match(result.stderr, scenario.error);
        const agent = await recordedAgent(recordStore, `failure-evidence-${scenario.engine}`);
        assert.match(agent.attempts[0]?.raw_output ?? "", new RegExp(token));
        assert.match(agent.attempts[0]?.failure?.message ?? "", /30(?:000| seconds)|SIG(?:TERM|KILL)|timed? out/i);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
}

interface RecordedAgent {
  label: string | null;
  attempts: Array<{
    raw_output: string | null;
    failure: { kind: string; message: string } | null;
  }>;
}

async function recordedAgent(recordStore: string, label: string): Promise<RecordedAgent> {
  for (const entry of await readdir(recordStore, { recursive: true })) {
    if (!entry.endsWith("agent.json")) {
      continue;
    }
    const agent = JSON.parse(await readFile(path.join(recordStore, entry), "utf8")) as RecordedAgent;
    if (agent.label === label) {
      return agent;
    }
  }
  throw new Error(`No recorded agent with label ${label}`);
}

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}
