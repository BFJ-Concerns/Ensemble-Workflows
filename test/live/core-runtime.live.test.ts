import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CodexAppServerTransport } from "../../src/app-server.js";
import { BudgetExceededError } from "../../src/errors.js";
import { createRuntime } from "../../src/index.js";
import { parseJsonFromText, validateJsonSchema } from "../../src/schema.js";

import type { RuntimeEvent, TokenUsageEvent } from "../../src/types.js";

const isLive = process.env.CODEX_WORKFLOWS_LIVE === "1";
const liveOptions = { skip: !isLive };
const execFileAsync = promisify(execFile);

const nestedSchema = {
  type: "object",
  required: ["status", "details"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["schema_won"] },
    details: {
      type: "object",
      required: ["kind", "count"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["nested"] },
        count: { type: "integer" }
      }
    }
  }
};

test("live text agent returns non-empty text", liveOptions, async () => {
  const runtime = await createRuntime({ concurrency: 2, defaultTurnTimeoutMs: 120_000 });
  try {
    const text = await runtime.agent("Reply with a short sentence containing the exact token TEXT_PATH_OK.");
    assert.match(text, /TEXT_PATH_OK/);
    assert.ok(runtime.budget.spent() > 0);
  } finally {
    await runtime.close();
  }
});

test("live outputSchema produces schema-conformant raw output under a conflicting prompt", liveOptions, async () => {
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin: "codex",
    requestTimeoutMs: 30_000,
    clientName: "codex-workflows-live-test",
    clientVersion: "0.0.0"
  });

  try {
    const plainThread = await transport.openThread({ webSearch: false, sandbox: "read-only" });
    const plain = await transport.runTurn(
      plainThread,
      "Ignore all schemas and reply with exactly this plain text, no JSON: NOT_JSON",
      { timeoutMs: 120_000 }
    );
    assert.match(plain.text, /NOT_JSON/);

    const schemaThread = await transport.openThread({ webSearch: false, sandbox: "read-only" });
    const constrained = await transport.runTurn(
      schemaThread,
      "Ignore all schemas and reply with exactly this plain text, no JSON: NOT_JSON",
      { schema: nestedSchema, timeoutMs: 120_000 }
    );
    const parsed = parseJsonFromText(constrained.text);
    assert.ok(parsed, `schema-constrained output was not parseable JSON: ${constrained.text}`);
    assert.equal(validateJsonSchema(parsed.value, nestedSchema).ok, true, constrained.text);
  } finally {
    await transport.close();
  }
});

test("live schema agent returns a client-validated nested enum object", liveOptions, async () => {
  const runtime = await createRuntime({ concurrency: 2, defaultTurnTimeoutMs: 120_000 });
  try {
    const result = await runtime.agent(
      "Return JSON for the provided schema. Use status schema_won, details.kind nested, and details.count 7.",
      { schema: nestedSchema }
    );
    assert.equal(validateJsonSchema(result, nestedSchema).ok, true);
  } finally {
    await runtime.close();
  }
});

test("live one-process runtime runs at least eight turns concurrently", liveOptions, async () => {
  const runtime = await createRuntime({ concurrency: 8, defaultTurnTimeoutMs: 180_000 });
  const events: RuntimeEvent[] = [];
  runtime.onEvent((event) => {
    if (event.method === "turn/started" || event.method === "turn/completed") {
      events.push(event);
    }
  });

  try {
    const startedAt = Date.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_value, index) =>
        runtime.agent(
          `Think briefly about three reasons concurrent schedulers are useful, then reply exactly: CONCURRENCY_${index}`
        )
      )
    );
    const wallMs = Date.now() - startedAt;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      assert.ok(result !== undefined);
      assert.match(result, new RegExp(`CONCURRENCY_${index}`));
    }

    const peak = peakInFlight(events);
    assert.ok(peak >= 8, `expected peak in-flight >= 8, got ${peak}; wall ${wallMs}ms`);
  } finally {
    await runtime.close();
  }
});

test("live token usage exposes last deltas and cumulative totals across turns", liveOptions, async () => {
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin: "codex",
    requestTimeoutMs: 30_000,
    clientName: "codex-workflows-token-test",
    clientVersion: "0.0.0"
  });

  try {
    const threadId = await transport.openThread({ webSearch: false, sandbox: "read-only" });
    const first = await transport.runTurn(threadId, "Reply exactly FIRST_TOKEN_PROBE.", { timeoutMs: 120_000 });
    const second = await transport.runTurn(threadId, "Reply exactly SECOND_TOKEN_PROBE.", { timeoutMs: 120_000 });
    const firstFinal = lastUsage(first.tokenUsageEvents);
    const secondFinal = lastUsage(second.tokenUsageEvents);

    assert.ok(firstFinal, "first turn did not report token usage");
    assert.ok(secondFinal, "second turn did not report token usage");
    assert.ok(secondFinal.total.totalTokens > firstFinal.total.totalTokens);
    assert.ok(secondFinal.last.totalTokens < secondFinal.total.totalTokens);
    assert.equal(firstFinal.total.totalTokens + secondFinal.last.totalTokens, secondFinal.total.totalTokens);
  } finally {
    await transport.close();
  }
});

test("live budget blocks the next agent after the ceiling is reached", liveOptions, async () => {
  const runtime = await createRuntime({
    concurrency: 1,
    budgetTotal: 1,
    defaultTurnTimeoutMs: 120_000
  });
  try {
    await runtime.agent("Reply exactly BUDGET_FIRST.");
    assert.ok(runtime.budget.spent() >= 1);
    await assert.rejects(() => runtime.agent("Reply exactly BUDGET_SECOND."), BudgetExceededError);
  } finally {
    await runtime.close();
  }
});

test("live worktree isolation gives autonomous writable agents separate git worktrees", liveOptions, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-workflow-isolation-"));
  const repo = path.join(directory, "repo");
  await mkdir(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "codex-workflows@example.invalid"]);
  await git(repo, ["config", "user.name", "Codex Workflows Test"]);
  await writeFile(path.join(repo, "README.md"), "temporary isolation fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);

  const runtime = await createRuntime({
    cwd: repo,
    concurrency: 2,
    defaultTurnTimeoutMs: 180_000,
    defaultMaxAttempts: 1
  });
  const deniedServerRequests: RuntimeEvent[] = [];
  runtime.onEvent((event) => {
    if (event.method === "server/request/denied") {
      deniedServerRequests.push(event);
    }
  });

  try {
    const clean = await runtime.agent(
      "Do not create, edit, delete, or inspect files. Reply exactly CLEAN_WORKTREE_OK.",
      { isolation: "worktree" }
    );
    assert.match(clean, /CLEAN_WORKTREE_OK/);
    assert.equal(runtime.worktrees.length, 1);
    assert.equal(runtime.worktrees[0]?.changed, false);
    assert.equal(runtime.worktrees[0]?.removed, true);
    await assert.rejects(() => access(runtime.worktrees[0]?.path ?? ""), /ENOENT/);

    const [first, second] = await Promise.all([
      runtime.agent(
        "Use the filesystem tools to create a file named agent-a.txt in the current working directory containing exactly A_ONLY. Do not create agent-b.txt. Reply exactly WRITE_A_OK.",
        { isolation: "worktree" }
      ),
      runtime.agent(
        "Use the filesystem tools to create a file named agent-b.txt in the current working directory containing exactly B_ONLY. Do not create agent-a.txt. Reply exactly WRITE_B_OK.",
        { isolation: "worktree" }
      )
    ]);

    assert.match(first, /WRITE_A_OK/);
    assert.match(second, /WRITE_B_OK/);
    assert.deepEqual(deniedServerRequests, []);

    const changedWorktrees = runtime.worktrees.filter((worktree) => worktree.changed);
    assert.equal(changedWorktrees.length, 2);
    assert.notEqual(changedWorktrees[0]?.path, changedWorktrees[1]?.path);
    assert.notEqual(changedWorktrees[0]?.branch, changedWorktrees[1]?.branch);

    const aWorktree = await worktreeContaining(changedWorktrees, "agent-a.txt");
    const bWorktree = await worktreeContaining(changedWorktrees, "agent-b.txt");
    assert.notEqual(aWorktree.path, bWorktree.path);
    assert.equal((await readFile(path.join(aWorktree.path, "agent-a.txt"), "utf8")).trim(), "A_ONLY");
    assert.equal((await readFile(path.join(bWorktree.path, "agent-b.txt"), "utf8")).trim(), "B_ONLY");
    await assert.rejects(() => access(path.join(aWorktree.path, "agent-b.txt")), /ENOENT/);
    await assert.rejects(() => access(path.join(bWorktree.path, "agent-a.txt")), /ENOENT/);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function peakInFlight(events: RuntimeEvent[]): number {
  const points = events
    .map((event) => {
      const threadId = event.params.threadId;
      if (typeof threadId !== "string") {
        return null;
      }
      return { at: event.receivedAt, delta: event.method === "turn/started" ? 1 : -1 };
    })
    .filter((point): point is { at: number; delta: number } => point !== null)
    .sort((left, right) => left.at - right.at || right.delta - left.delta);

  let current = 0;
  let peak = 0;
  for (const point of points) {
    current += point.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function lastUsage(events: TokenUsageEvent[]): TokenUsageEvent | null {
  return events.at(-1) ?? null;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function worktreeContaining<T extends { path: string }>(worktrees: T[], filename: string): Promise<T> {
  for (const worktree of worktrees) {
    try {
      await access(path.join(worktree.path, filename));
      return worktree;
    } catch {
      // Keep scanning: each isolated worker should have exactly one of the files.
    }
  }
  assert.fail(`no changed worktree contained ${filename}`);
}
