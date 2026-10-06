import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { liveOpenCodeModel } from "./live-models.js";

// These destructive legs are separate from the ordinary live estate: each
// observes text from the real worker transport before terminating that worker.
const isLive = process.env.ENSEMBLE_LIVE === "1" && process.env.ENSEMBLE_LIVE_FAILURE_EVIDENCE === "1";
const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

for (const scenario of [
  { engine: "claude", model: null, error: /claude-poll-timeout: worker left the roster/ },
  // An opencode run failure consumes its (single) attempt, so exhaustion
  // surfaces the engine diagnostic on the failure notice.
  ...(liveOpenCodeModel !== undefined
    ? [{ engine: "opencode", model: liveOpenCodeModel, error: /opencode run failed/ }]
    : [])
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
      const prompt =
        scenario.engine === "claude"
          ? `Say ${token} on its own line, then in the same turn use the Bash tool to run sleep 120. After the command returns, continue with a detailed numbered analysis.`
          : `Output ${token} immediately on its own line, then write a detailed numbered analysis. Keep expanding the analysis for at least two minutes without ending the answer.`;
      let env: NodeJS.ProcessEnv = {
        ...process.env,
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore,
        ENSEMBLE_STATUS: "0"
      };
      let terminateWorker: () => Promise<void>;
      let observedWorkerText = token;

      try {
        if (scenario.engine === "claude") {
          const existingSessions = new Set((await claudeRoster()).map((entry) => entry.sessionId));
          terminateWorker = async () => stopClaudeWorkerAfterText(token, existingSessions);
        } else {
          const observer = path.join(directory, "opencode-stream.jsonl");
          const wrapperDirectory = path.join(directory, "bin");
          await setupOpenCodeObserver(wrapperDirectory, observer);
          env = { ...env, PATH: `${wrapperDirectory}:${env.PATH ?? ""}` };
          terminateWorker = async () => {
            observedWorkerText = await stopOpenCodeWorkerAfterText(observer, directory);
          };
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
                prompt
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

        // The script returned its worker's null, so the run itself
        // completed; the failure is announced on stderr and archived.
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stderr, scenario.error);
        const agent = await recordedAgent(recordStore, `failure-evidence-${scenario.engine}`);
        assert.ok(
          (agent.attempts[0]?.raw_output ?? "").includes(observedWorkerText),
          "The archived attempt omitted text observed from the live worker"
        );
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

interface ClaudeRosterEntry {
  id: string;
  sessionId: string;
  name: string | null;
  cwd: string | null;
}

async function stopClaudeWorkerAfterText(token: string, existingSessions: ReadonlySet<string>): Promise<void> {
  const worker = await waitForNewClaudeWorker(existingSessions);
  const transcript = await waitForClaudeTranscript(worker.sessionId);
  await waitForFileContaining(
    transcript,
    (events) => events.some((event) => isClaudeAssistantTextContaining(event, token)) && !isClaudeTurnComplete(events)
  );
  await execFileOutput("claude", ["stop", worker.id]);
}

async function claudeRoster(): Promise<ClaudeRosterEntry[]> {
  const roster = JSON.parse((await execFileOutput("claude", ["agents", "--json", "--all"])).stdout) as unknown;
  assert.ok(Array.isArray(roster), "Claude roster was not an array");
  return roster.flatMap((entry): ClaudeRosterEntry[] => {
    if (typeof entry !== "object" || entry === null || !("sessionId" in entry) || typeof entry.sessionId !== "string") {
      return [];
    }
    const id = "id" in entry && typeof entry.id === "string" && entry.id.length > 0 ? entry.id : entry.sessionId;
    const name = "name" in entry && typeof entry.name === "string" ? entry.name : null;
    const cwd = "cwd" in entry && typeof entry.cwd === "string" ? entry.cwd : null;
    return [{ id, sessionId: entry.sessionId, name, cwd }];
  });
}

async function waitForNewClaudeWorker(existingSessions: ReadonlySet<string>): Promise<ClaudeRosterEntry> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const worker = (await claudeRoster()).find(
      (entry) =>
        !existingSessions.has(entry.sessionId) && entry.name?.startsWith("ensemble-") === true && entry.cwd === process.cwd()
    );
    if (worker !== undefined) {
      return worker;
    }
    await delay(500);
  }
  throw new Error("No new live Claude worker registered");
}

async function waitForClaudeTranscript(sessionId: string): Promise<string> {
  const projectsRoot = path.join(homedir(), ".claude", "projects");
  const filename = `${sessionId}.jsonl`;
  const projectDirectories = await readdir(projectsRoot, { withFileTypes: true });
  const candidates = projectDirectories
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsRoot, entry.name, filename));
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        await readFile(candidate, "utf8");
        return candidate;
      } catch {
        // The exact session transcript has not appeared in this project directory yet.
      }
    }
    await delay(250);
  }
  throw new Error(`No transcript appeared for live Claude worker ${sessionId}`);
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

function isClaudeTurnComplete(entries: unknown[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "assistant") {
      continue;
    }
    if (!("message" in entry) || typeof entry.message !== "object" || entry.message === null) {
      return false;
    }
    const message = entry.message;
    const stopReason = "stop_reason" in message ? message.stop_reason : null;
    return typeof stopReason === "string" && stopReason !== "tool_use";
  }
  return false;
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

async function setupOpenCodeObserver(wrapperDirectory: string, observer: string): Promise<void> {
  const realOpenCode = (await execFileOutput("which", ["opencode"])).stdout.trim();
  assert.ok(realOpenCode.length > 0, "opencode was not found on PATH");
  await mkdir(wrapperDirectory, { recursive: true });
  const wrapper = path.join(wrapperDirectory, "opencode");
  const fifo = path.join(path.dirname(observer), "opencode-stream.fifo");
  const killedMarker = path.join(path.dirname(observer), "opencode-worker-killed");
  await writeFile(
    wrapper,
    `#!/usr/bin/env bash\nset -o pipefail\nworker=\nkilled=\ntrap '[[ -n "$worker" ]] && kill -TERM "$worker" 2>/dev/null || true' TERM INT\nmkfifo ${shellQuote(fifo)}\n${shellQuote(realOpenCode)} "$@" > ${shellQuote(fifo)} &\nworker=$!\nprintf '%s\\n' "$worker" > ${shellQuote(path.join(path.dirname(observer), "opencode-worker.pid"))}\nwhile IFS= read -r line; do\n  printf '%s\\n' "$line" | tee -a ${shellQuote(observer)}\n  if [[ -z "$killed" && "$line" == *'"type":"text"'* ]]; then\n    kill -TERM "$worker" 2>/dev/null || true\n    killed=1\n    : > ${shellQuote(killedMarker)}\n  fi\ndone < ${shellQuote(fifo)}\nwait "$worker"\nstatus=$?\nrm -f ${shellQuote(fifo)}\nexit "$status"\n`
  );
  await chmod(wrapper, 0o755);
}

async function stopOpenCodeWorkerAfterText(observer: string, directory: string): Promise<string> {
  let observedText = "";
  await waitForFileContaining(observer, (events) => {
    const textIndex = events.findIndex((event) => {
      const text = openCodeTextOf(event);
      if (text === null) {
        return false;
      }
      observedText = text;
      return true;
    });
    return textIndex >= 0 && !events.slice(textIndex + 1).some(isOpenCodeStepFinish);
  });
  await waitForFile(path.join(directory, "opencode-worker-killed"));
  return observedText;
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(file, "utf8");
      return;
    } catch {
      await delay(25);
    }
  }
  throw new Error(`Expected live-worker signal file ${file} did not appear`);
}

async function waitForFileContaining(file: string, matches: (events: unknown[]) => boolean): Promise<void> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    try {
      if (matches(parsedJsonLines(await readFile(file, "utf8")))) {
        return;
      }
    } catch {
      // Observer files and live transcripts appear asynchronously.
    }
    await delay(100);
  }
  throw new Error(`Live worker output in ${file} did not reach the required pre-completion state`);
}

function openCodeTextOf(event: unknown): string | null {
  if (
    typeof event !== "object" ||
    event === null ||
    !("type" in event) ||
    event.type !== "text" ||
    !("part" in event) ||
    typeof event.part !== "object" ||
    event.part === null ||
    !("type" in event.part) ||
    event.part.type !== "text" ||
    !("text" in event.part) ||
    typeof event.part.text !== "string" ||
    event.part.text.length === 0
  ) {
    return null;
  }
  return event.part.text;
}

function isOpenCodeStepFinish(event: unknown): boolean {
  return typeof event === "object" && event !== null && "type" in event && event.type === "step_finish";
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
