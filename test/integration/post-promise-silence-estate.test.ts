import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const appServerFixturePath = path.resolve("test/fixtures/codex/post-promise-app-server.mjs");
const deadlineAcceleratorPath = path.resolve(
  "test/fixtures/codex/accelerate-post-promise-deadline.mjs"
);

interface Action {
  type: "deadline" | "delta" | "promise" | "mcp-progress" | "approval" | "success" | "silence";
  text?: string;
  diagnostic?: string;
  afterMs?: number;
  requireDisarm?: boolean;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

test("built consumer terminalises permanent silence after a retry promise with its evidence intact", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run(
      [[
        { type: "delta", text: "PARTIAL_BEFORE_SILENCE" },
        { type: "promise", diagnostic: "PROMISE_ABANDONED_41" },
        { type: "deadline" },
        { type: "silence" }
      ]],
      1
    );

    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(result.stderr, /AppServerRetryPromiseBrokenError/);
    assert.match(result.stderr, /silent for 900000ms after a promised retry/);
    assert.match(result.stderr, /PROMISE_ABANDONED_41/);

    const attempts = await fixture.attempts();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, "failed");
    assert.equal(attempts[0]?.raw_output, "PARTIAL_BEFORE_SILENCE");
    assert.match(attempts[0]?.failure?.message ?? "", /PROMISE_ABANDONED_41/);
  });
});

test("built consumer continues after a post-promise delta disarms the silence deadline", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([
      abandonedAttempt("DELTA_FIRST_ATTEMPT"),
      [
        { type: "promise", diagnostic: "DELTA_RECOVERY_PROMISE" },
        { type: "delta", text: "recovery-in-progress", afterMs: 10 },
        { type: "deadline", requireDisarm: true },
        { type: "success", text: "delta-recovered", afterMs: 100 }
      ]
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"delta-recovered"\n`);
    assert.equal((await fixture.attempts()).length, 2);
  });
});

test("built consumer returns a recovered answer when the app-server keeps its retry promise", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([
      abandonedAttempt("SUCCESS_FIRST_ATTEMPT"),
      [
        { type: "promise", diagnostic: "KEPT_PROMISE_52" },
        { type: "success", text: "promise-kept", afterMs: 20 }
      ]
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"promise-kept"\n`);
    const attempts = await fixture.attempts();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]?.status, "complete");
  });
});

test("built consumer rejects promise and MCP-progress alternation at the bounded count", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const alternating = [{ type: "delta", text: "PARTIAL_BEFORE_HEARTBEATS" } as Action];
    for (let index = 0; index < 5; index += 1) {
      alternating.push({ type: "promise", diagnostic: `ALTERNATING_PROMISE_${index}` });
      alternating.push({ type: "mcp-progress" });
    }
    alternating.push({ type: "promise", diagnostic: "ALTERNATING_PROMISE_5" });
    alternating.push({ type: "deadline" });
    alternating.push({ type: "silence" });

    const result = await fixture.run([alternating], 1);

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /AppServerRetryPromiseBrokenError/);
    assert.doesNotMatch(result.stderr, /silent for 900000ms after a promised retry/);
    assert.match(result.stderr, /ALTERNATING_PROMISE_5/);
    const attempts = await fixture.attempts();
    assert.equal(attempts[0]?.raw_output, "PARTIAL_BEFORE_HEARTBEATS");
  });
});

test("built consumer answers a turn-scoped request and continues after it disarms the deadline", { timeout: 45_000 }, async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run([
      abandonedAttempt("APPROVAL_FIRST_ATTEMPT"),
      [
        { type: "promise", diagnostic: "APPROVAL_RECOVERY_PROMISE" },
        { type: "approval", afterMs: 10 },
        { type: "deadline", requireDisarm: true },
        { type: "success", text: "approval-request-handled", afterMs: 100 }
      ]
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"approval-request-handled"\n`);
    const denial = (await fixture.messages()).find(
      (message) => message.id === 10_001 && message.result?.decision === "denied"
    );
    assert.equal(denial?.result?.reason, "Ensemble workers run with approvalPolicy never");
  });
});

function abandonedAttempt(partialText: string): Action[] {
  return [
    { type: "delta", text: partialText },
    { type: "promise", diagnostic: `ABANDONED_${partialText}` },
    { type: "deadline" },
    { type: "silence" }
  ];
}

interface RecordedAttempt {
  status: string;
  raw_output: string | null;
  failure: { message?: string } | null;
}

interface RecordedMessage {
  id?: number;
  result?: { decision?: string; reason?: string };
}

async function withFixture(run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-post-promise-estate-"));
  const binDirectory = path.join(directory, "bin");
  const fakeCodex = path.join(binDirectory, "codex");
  const capturePath = path.join(directory, "codex-input.jsonl");
  const deadlineControlPath = path.join(directory, "deadline-control");
  const recordStore = path.join(directory, "records");
  const workflow = path.join(directory, "workflow.js");
  await mkdir(binDirectory);
  await writeFile(capturePath, "");
  await writeFile(deadlineControlPath, "");
  await writeFile(fakeCodex, `#!/usr/bin/env node\nimport ${JSON.stringify(appServerFixturePath)};\n`);
  await chmod(fakeCodex, 0o755);

  return {
    run: async (scenarios: Action[][], maxAttempts = 2): Promise<ProcessResult> => {
      await writeFile(
        workflow,
        `
          export const meta = { name: "post-promise-silence-estate" };
          return await agent("exercise post-promise lifecycle", {
            engine: "codex",
            maxAttempts: ${maxAttempts}
          });
        `
      );
      return runNode(
        ["--import", deadlineAcceleratorPath, bundledCliPath, workflow],
        {
          ...process.env,
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          ENSEMBLE_POST_PROMISE_CAPTURE: capturePath,
          ENSEMBLE_POST_PROMISE_DEADLINE_CONTROL: deadlineControlPath,
          ENSEMBLE_POST_PROMISE_SCENARIOS: JSON.stringify(scenarios),
          ENSEMBLE_POST_PROMISE_DEADLINE_MS: "60",
          ENSEMBLE_RUN_RECORD: "1",
          ENSEMBLE_RUN_RECORD_DIR: recordStore,
          ENSEMBLE_STATUS: "0",
          XDG_DATA_HOME: path.join(directory, "data")
        },
        45_000
      );
    },
    attempts: async (): Promise<RecordedAttempt[]> => {
      const pathToAgent = await findOnlyFile(recordStore, "agent.json");
      const agent = JSON.parse(await readFile(pathToAgent, "utf8")) as { attempts: RecordedAttempt[] };
      return agent.attempts;
    },
    messages: async (): Promise<RecordedMessage[]> =>
      (await readFile(capturePath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedMessage),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function findOnlyFile(root: string, basename: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const matches = entries.filter((entry) => path.basename(entry) === basename);
  assert.equal(matches.length, 1, `expected one ${basename}, found ${matches.length}`);
  return path.join(root, matches[0] ?? "");
}

async function runNode(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
