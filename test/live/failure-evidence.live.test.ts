import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// These destructive legs are separate from the ordinary live estate: each
// observes text from the real worker transport before terminating that worker.
const isLive = process.env.ENSEMBLE_LIVE === "1" && process.env.ENSEMBLE_LIVE_FAILURE_EVIDENCE === "1";
const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const scenario of [
  { engine: "claude", model: null, error: /EmptyAgentOutputError: worker left the roster/ }
] as const) {
  test(
    `live built CLI archives observed partial ${scenario.engine} text and reports its termination cause`,
    { skip: !isLive, timeout: 300_000 },
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), `ensemble-live-${scenario.engine}-failure-`));
      const script = path.join(directory, "workflow.js");
      const recordStore = path.join(directory, "records");
      const token = `LIVE_${scenario.engine.toUpperCase()}_PARTIAL_${randomUUID()}`;
      const model = scenario.model === null ? "" : `model: ${JSON.stringify(scenario.model)},`;
      const startedAt = Date.now();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore,
        ENSEMBLE_STATUS: "0"
      };
      let terminateWorker: () => Promise<void>;

      try {
        terminateWorker = async () => stopClaudeWorkerAfterText(token, startedAt);

        await writeFile(
          script,
          `
            export const meta = {
              name: ${JSON.stringify(`${scenario.engine}-failure-evidence`)},
              description: "Archive live worker text when the turn times out"
            };

            return await agent(
              ${JSON.stringify(
                `Write a detailed numbered analysis headed ${token}. Keep expanding the analysis for at least two minutes without ending the answer.`
              )},
              {
                engine: ${JSON.stringify(scenario.engine)},
                ${model}
                label: ${JSON.stringify(`failure-evidence-${scenario.engine}`)},
                timeoutMs: 180_000,
                maxAttempts: 1
              }
            );
          `
        );

        const result = await runNode([bundledCliPath, script], env, terminateWorker);

        assert.equal(result.code, 1, result.stderr);
        assert.match(result.stderr, scenario.error);
        const agent = await recordedAgent(recordStore, `failure-evidence-${scenario.engine}`);
        assert.match(agent.attempts[0]?.raw_output ?? "", new RegExp(token));
        assert.match(agent.attempts[0]?.failure?.message ?? "", /left the roster|SIG(?:TERM|KILL)|exit code|terminated/i);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
}

test.skip(
  "live opencode partial-text retention cannot be observed before turn completion",
  {
    skip: "opencode run emits step_start before completion, but emits the answer as one completed text part at turn end"
  },
  () => undefined
);

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

function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  terminateWorker: () => Promise<void>
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
    void terminateWorker().catch((error: unknown) => {
      child.kill("SIGTERM");
      reject(error);
    });
  });
}

async function stopClaudeWorkerAfterText(token: string, startedAt: number): Promise<void> {
  const transcript = await waitForRecentFileContaining(path.join(homedir(), ".claude", "projects"), token, startedAt);
  const sessionId = path.basename(transcript, ".jsonl");
  const roster = JSON.parse((await execFileOutput("claude", ["agents", "--json", "--all"])).stdout) as unknown;
  assert.ok(Array.isArray(roster), "Claude roster was not an array");
  const worker = roster.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && entry.sessionId === sessionId
  );
  assert.ok(worker !== undefined, `Claude worker ${sessionId} was absent after its text was observed`);
  const id = typeof worker.id === "string" && worker.id.length > 0 ? worker.id : sessionId;
  await execFileOutput("claude", ["stop", id]);
}

async function waitForRecentFileContaining(root: string, token: string, startedAt: number): Promise<string> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    for (const entry of await readdir(root, { recursive: true })) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }
      const candidate = path.join(root, entry);
      try {
        const metadata = await stat(candidate);
        if (
          metadata.mtimeMs >= startedAt - 1_000 &&
          parsedJsonLines(await readFile(candidate, "utf8")).some((entry) =>
            isClaudeAssistantTextContaining(entry, token)
          )
        ) {
          return candidate;
        }
      } catch {
        // Transcripts can be replaced while the live worker is writing them.
      }
    }
    await delay(500);
  }
  throw new Error(`No recent live transcript contained ${token}`);
}

function isClaudeAssistantTextContaining(entry: unknown, token: string): boolean {
  if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "assistant") {
    return false;
  }
  if (!("message" in entry) || typeof entry.message !== "object" || entry.message === null) {
    return false;
  }
  const message = entry.message;
  if (!("content" in message) || !Array.isArray(message.content)) {
    return false;
  }
  return message.content.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string" &&
      part.text.includes(token)
  );
}

function parsedJsonLines(text: string): unknown[] {
  const values: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // Ignore a line observed while it is still being appended.
    }
  }
  return values;
}

function execFileOutput(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${file} ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
