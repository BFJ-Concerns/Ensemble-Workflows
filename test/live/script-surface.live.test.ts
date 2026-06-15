import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const isLive = process.env.ENSEMBLE_LIVE === "1";
const liveOptions = { skip: !isLive };

test("live CLI runs a fan-out then compiler workflow and splits stdout from stderr", liveOptions, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = {
        name: "fan-out-compiler",
        description: "Live proof that the CLI drives the script surface"
      };

      phase("draft");
      const drafts = await parallel([
        () => agent("Reply with exactly one short JSON object: {\\"point\\":\\"alpha\\"}", {
          engine: "codex",
          schema: {
            type: "object",
            required: ["point"],
            additionalProperties: false,
            properties: { point: { type: "string" } }
          }
        }),
        () => agent("Reply with exactly one short JSON object: {\\"point\\":\\"beta\\"}", {
          engine: "codex",
          schema: {
            type: "object",
            required: ["point"],
            additionalProperties: false,
            properties: { point: { type: "string" } }
          }
        })
      ]);

      phase("compile");
      const compiled = await agent(
        "Return JSON with count 2 and summary containing LIVE_WORKFLOW_OK. Inputs: " + JSON.stringify(drafts),
        {
          engine: "codex",
          schema: {
            type: "object",
            required: ["count", "summary"],
            additionalProperties: false,
            properties: {
              count: { type: "integer" },
              summary: { type: "string" }
            }
          }
        }
      );

      return { drafts: drafts.filter(Boolean), compiled };
    `
  );

  const cliPath = path.resolve("dist/src/cli/ensemble.js");
  const result = await runNode([cliPath, script]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /\[phase\] draft/);
  assert.match(result.stderr, /\[phase\] compile/);
  const parsed = JSON.parse(result.stdout) as {
    drafts: unknown[];
    compiled: { count: number; summary: string };
  };
  assert.equal(parsed.drafts.length, 2);
  assert.equal(parsed.compiled.count, 2);
  assert.match(parsed.compiled.summary, /LIVE_WORKFLOW_OK/);
});

test("live CLI runs Codex findings through Claude verification", { skip: !isLive, timeout: 420_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-cross-engine-"));
  const script = path.join(directory, "workflow.js");

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "codex-finds-claude-verifies",
          description: "Live proof that Ensemble can verify one engine with another"
        };

        const findingSchema = {
          type: "object",
          required: ["token", "risk"],
          additionalProperties: false,
          properties: {
            token: { type: "string", enum: ["LIVE_CROSS_FIND"] },
            risk: { type: "string" }
          }
        };

        const verificationSchema = {
          type: "object",
          required: ["token", "accepted", "checkedBy"],
          additionalProperties: false,
          properties: {
            token: { type: "string", enum: ["LIVE_CROSS_VERIFY"] },
            accepted: { type: "boolean", enum: [true] },
            checkedBy: { type: "string", enum: ["claude"] }
          }
        };

        phase("find");
        const finding = await agent(
          "Return exactly one JSON object matching the schema: token LIVE_CROSS_FIND and risk cross-engine-contract.",
          { engine: "codex", schema: findingSchema, maxAttempts: 1 }
        );

        phase("verify");
        const verification = await agent(
          "Verify this Codex finding is structurally valid and relevant to cross-engine verification. " +
            "Return JSON with token LIVE_CROSS_VERIFY, accepted true, and checkedBy claude. Finding: " +
            JSON.stringify(finding),
          { engine: "claude", schema: verificationSchema, maxAttempts: 2 }
        );

        return { finding, verification };
      `
    );

    const cliPath = path.resolve("dist/src/cli/ensemble.js");
    const result = await runNode([cliPath, script]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /\[phase\] find/);
    assert.match(result.stderr, /\[phase\] verify/);
    const parsed = JSON.parse(result.stdout) as {
      finding: { token: string; risk: string };
      verification: { token: string; accepted: boolean; checkedBy: string };
    };
    assert.deepEqual(parsed.finding, { token: "LIVE_CROSS_FIND", risk: "cross-engine-contract" });
    assert.deepEqual(parsed.verification, {
      token: "LIVE_CROSS_VERIFY",
      accepted: true,
      checkedBy: "claude"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runNode(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
