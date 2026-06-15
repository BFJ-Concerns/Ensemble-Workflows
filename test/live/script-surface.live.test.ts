import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
          schema: {
            type: "object",
            required: ["point"],
            additionalProperties: false,
            properties: { point: { type: "string" } }
          }
        }),
        () => agent("Reply with exactly one short JSON object: {\\"point\\":\\"beta\\"}", {
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
