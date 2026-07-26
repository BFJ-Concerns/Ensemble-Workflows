import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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

test("live CLI gives default Codex workers network and denies it when requested", { skip: !isLive, timeout: 240_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-network-"));
  const script = path.join(directory, "workflow.js");
  const recordStore = path.join(directory, "records");
  const defaultPath = `/default-${randomUUID()}`;
  const blockedPath = `/blocked-${randomUUID()}`;
  const defaultReceipt = `NETWORK_DEFAULT_${randomUUID()}`;
  const blockedReceipt = `NETWORK_BLOCKED_${randomUUID()}`;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === defaultPath) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(defaultReceipt);
      return;
    }
    if (request.url === blockedPath) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(blockedReceipt);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const defaultUrl = `http://127.0.0.1:${address.port}${defaultPath}`;
    const blockedUrl = `http://127.0.0.1:${address.port}${blockedPath}`;

    await writeFile(
      script,
      `
        export const meta = {
          name: "codex-network-posture",
          description: "Live proof of Codex worker-shell reachability under both network postures"
        };

        const resultSchema = {
          type: "object",
          required: ["attempted", "exitCode", "httpStatus", "body"],
          additionalProperties: false,
          properties: {
            attempted: { type: "boolean", enum: [true] },
            exitCode: { type: "integer" },
            httpStatus: { type: "integer" },
            body: { type: "string" }
          }
        };

        const defaultUrl = ${JSON.stringify(defaultUrl)};
        const blockedUrl = ${JSON.stringify(blockedUrl)};
        const instruction = (url) =>
          "Use the shell tool to run this command exactly once: " +
          "curl --silent --show-error --max-time 10 --write-out '\\\\n%{http_code}' " + url + ". " +
          "Do not infer or invent its result. Return attempted true, the tool exit code as exitCode, " +
          "the final curl status line as integer httpStatus (000 becomes 0), and preceding stdout as body.";

        phase("network-default");
        const defaultResult = await agent(instruction(defaultUrl), {
          engine: "codex",
          label: "network-default",
          schema: resultSchema,
          maxAttempts: 1
        });

        phase("network-blocked");
        const blockedResult = await agent(instruction(blockedUrl), {
          engine: "codex",
          network: false,
          label: "network-blocked",
          schema: resultSchema,
          maxAttempts: 1
        });

        return { defaultResult, blockedResult };
      `
    );

    const cliPath = path.resolve("dist/src/cli/ensemble.js");
    const result = await runNode([cliPath, script], {
      env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: recordStore }
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /\[phase\] network-default/);
    assert.match(result.stderr, /\[phase\] network-blocked/);
    const parsed = JSON.parse(result.stdout) as {
      defaultResult: NetworkProbeResult;
      blockedResult: NetworkProbeResult;
    };
    assert.deepEqual(parsed.defaultResult, {
      attempted: true,
      exitCode: 0,
      httpStatus: 200,
      body: defaultReceipt
    });
    assert.equal(parsed.blockedResult.attempted, true);
    assert.notEqual(parsed.blockedResult.exitCode, 0);
    assert.equal(parsed.blockedResult.httpStatus, 0);

    assert.equal(requests.filter((requestPath) => requestPath === defaultPath).length, 1);
    assert.equal(requests.filter((requestPath) => requestPath === blockedPath).length, 0);

    const defaultCommand = await recordedCommand(recordStore, "network-default", defaultUrl);
    assert.equal(defaultCommand.exitCode, 0);
    assert.match(defaultCommand.aggregatedOutput ?? "", new RegExp(defaultReceipt));

    const blockedCommand = await recordedCommand(recordStore, "network-blocked", blockedUrl);
    assert.notEqual(blockedCommand.exitCode, 0);
    assert.doesNotMatch(blockedCommand.aggregatedOutput ?? "", new RegExp(blockedReceipt));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

interface NetworkProbeResult {
  attempted: true;
  exitCode: number;
  httpStatus: number;
  body: string;
}

interface RecordedCommand {
  command: string;
  exitCode: number | null;
  aggregatedOutput: string | null;
}

async function recordedCommand(recordStore: string, label: string, url: string): Promise<RecordedCommand> {
  const entries = await readdir(recordStore, { recursive: true });
  for (const entry of entries.filter((candidate) => candidate.endsWith("agent.json"))) {
    const agentPath = path.join(recordStore, entry);
    const agent = JSON.parse(await readFile(agentPath, "utf8")) as {
      label: string | null;
      transcripts: Array<{ path: string }>;
    };
    if (agent.label !== label) {
      continue;
    }
    const archiveDirectory = path.resolve(path.dirname(agentPath), "../..");
    for (const transcript of agent.transcripts) {
      const events = (await readFile(path.join(archiveDirectory, transcript.path), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method?: string; params?: { item?: RecordedCommand & { type?: string } } });
      const completed = events.find(
        (event) =>
          event.method === "item/completed" &&
          event.params?.item?.type === "commandExecution" &&
          event.params.item.command.includes(url)
      )?.params?.item;
      if (completed !== undefined) {
        return completed;
      }
    }
  }
  throw new Error(`No completed command execution for ${label} and ${url}`);
}

async function runNode(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: options.env ?? process.env });
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
