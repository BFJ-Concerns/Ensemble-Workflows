import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// These destructive legs are separate from the ordinary live estate: each
// observes text from the real worker transport before terminating that worker.
const isLive = process.env.ENSEMBLE_LIVE === "1" && process.env.ENSEMBLE_LIVE_FAILURE_EVIDENCE === "1";
const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const scenario of [
  { engine: "claude", model: null, error: /EmptyAgentOutputError: worker left the roster/ },
  { engine: "opencode", model: "glm-5.2", error: /OpenCodeRunError/ }
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
      let env: NodeJS.ProcessEnv = {
        ...process.env,
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore,
        ENSEMBLE_STATUS: "0"
      };
      let terminateWorker: () => Promise<void>;

      try {
        if (scenario.engine === "claude") {
          terminateWorker = async () => stopClaudeWorkerAfterText(token, startedAt);
        } else {
          const observer = path.join(directory, "opencode-stream.jsonl");
          const wrapperDirectory = path.join(directory, "bin");
          await setupOpenCodeObserver(wrapperDirectory, observer);
          env = { ...env, PATH: `${wrapperDirectory}:${env.PATH ?? ""}` };
          terminateWorker = async () => stopOpenCodeWorkerAfterText(observer, token, directory);
        }

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

async function setupOpenCodeObserver(wrapperDirectory: string, observer: string): Promise<void> {
  const realOpenCode = (await execFileOutput("which", ["opencode"])).stdout.trim();
  assert.ok(realOpenCode.length > 0, "opencode was not found on PATH");
  await mkdir(wrapperDirectory, { recursive: true });
  const wrapper = path.join(wrapperDirectory, "opencode");
  const fifo = path.join(path.dirname(observer), "opencode-stream.fifo");
  await writeFile(
    wrapper,
    `#!/usr/bin/env bash\nset -o pipefail\nworker=\ntrap '[[ -n "$worker" ]] && kill -TERM "$worker" 2>/dev/null || true' TERM INT\nmkfifo ${shellQuote(fifo)}\n${shellQuote(realOpenCode)} "$@" > ${shellQuote(fifo)} &\nworker=$!\nprintf '%s\\n' "$worker" > ${shellQuote(path.join(path.dirname(observer), "opencode-worker.pid"))}\ntee -a ${shellQuote(observer)} < ${shellQuote(fifo)}\nwait "$worker"\nstatus=$?\nrm -f ${shellQuote(fifo)}\nexit "$status"\n`
  );
  await chmod(wrapper, 0o755);
}

async function stopOpenCodeWorkerAfterText(observer: string, token: string, directory: string): Promise<void> {
  await waitForFileContaining(observer, token);
  const pid = Number.parseInt(await readFile(path.join(directory, "opencode-worker.pid"), "utf8"), 10);
  assert.ok(Number.isSafeInteger(pid) && pid > 1, "opencode observer did not record a valid worker PID");
  process.kill(pid, "SIGTERM");
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

async function waitForFileContaining(file: string, token: string): Promise<void> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    try {
      const events = parsedJsonLines(await readFile(file, "utf8"));
      if (events.some((event) => isOpenCodeTextEventContaining(event, token))) {
        return;
      }
    } catch {
      // The observer file appears only after opencode emits its first event.
    }
    await delay(250);
  }
  throw new Error(`The live opencode stream did not contain ${token}`);
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

function isOpenCodeTextEventContaining(event: unknown, token: string): boolean {
  if (typeof event !== "object" || event === null || !("part" in event)) {
    return false;
  }
  const part = event.part;
  return (
    "type" in event &&
    event.type === "text" &&
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string" &&
    part.text.includes(token)
  );
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
