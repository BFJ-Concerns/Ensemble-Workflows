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
import { liveCodexOptions } from "./live-models.js";

import type { RuntimeEvent, TokenUsageEvent } from "../../src/types.js";

const isLive = process.env.ENSEMBLE_LIVE === "1";
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
  const runtime = await createRuntime({ concurrencyCaps: { codex: 2 }, defaultTurnTimeoutMs: 120_000 });
  try {
    const text = await runtime.agent("Reply with a short sentence.", { engine: "codex", ...liveCodexOptions() });
    // A text agent's value is the worker's reply, a string whatever it says;
    // null is the product's report that the agent failed.
    assert.equal(typeof text, "string", "the text agent failed");
    assert.ok(runtime.budget.spent("codex") > 0);
  } finally {
    await runtime.close();
  }
});

test("live outputSchema produces schema-conformant raw output under a conflicting prompt", liveOptions, async () => {
  const transport = await CodexAppServerTransport.start({
    cwd: process.cwd(),
    codexBin: "codex",
    requestTimeoutMs: 30_000,
    clientName: "ensemble-workflows-live-test",
    clientVersion: "0.0.0"
  });

  try {
    // The prompt asks for plain text; the outputSchema the transport sends is
    // what must win, whatever the worker would otherwise have written.
    const schemaThread = await transport.openThread({});
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
  const runtime = await createRuntime({ concurrencyCaps: { codex: 2 }, defaultTurnTimeoutMs: 120_000 });
  try {
    const result = await runtime.agent(
      "Return JSON for the provided schema. Use status schema_won, details.kind nested, and details.count 7.",
      { engine: "codex", ...liveCodexOptions(), schema: nestedSchema }
    );
    assert.equal(validateJsonSchema(result, nestedSchema).ok, true);
  } finally {
    await runtime.close();
  }
});

test("live one-process runtime runs at least eight turns concurrently", liveOptions, async () => {
  const runtime = await createRuntime({ concurrencyCaps: { codex: 8 }, defaultTurnTimeoutMs: 180_000 });
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
          `Think briefly about three reasons concurrent schedulers are useful, then reply with one sentence (request ${index}).`,
          { engine: "codex", ...liveCodexOptions() }
        )
      )
    );
    const wallMs = Date.now() - startedAt;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      assert.equal(typeof result, "string", `concurrent agent ${index} failed`);
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
    clientName: "ensemble-workflows-token-test",
    clientVersion: "0.0.0"
  });

  try {
    const threadId = await transport.openThread({});
    const first = await transport.runTurn(threadId, "Reply exactly FIRST_TOKEN_PROBE.", {
      timeoutMs: 120_000
    });
    const second = await transport.runTurn(threadId, "Reply exactly SECOND_TOKEN_PROBE.", {
      timeoutMs: 120_000
    });
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
    concurrencyCaps: { codex: 1 },
    budgetCeilings: { codex: 1 },
    defaultTurnTimeoutMs: 120_000
  });
  try {
    await runtime.agent("Reply exactly BUDGET_FIRST.", { engine: "codex", ...liveCodexOptions() });
    assert.ok(runtime.budget.spent("codex") >= 1);
    await assert.rejects(
      () => runtime.agent("Reply exactly BUDGET_SECOND.", { engine: "codex", ...liveCodexOptions() }),
      BudgetExceededError
    );
  } finally {
    await runtime.close();
  }
});

test("live worktree isolation gives autonomous writable agents separate git worktrees", liveOptions, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-isolation-"));
  const repo = path.join(directory, "repo");
  await mkdir(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "ensemble-workflows@example.invalid"]);
  await git(repo, ["config", "user.name", "Ensemble Workflows Test"]);
  await writeFile(path.join(repo, "README.md"), "temporary isolation fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);

  const runtime = await createRuntime({
    cwd: repo,
    concurrencyCaps: { codex: 2 },
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
    await runtime.agent("Do not create, edit, delete, or inspect files. Reply with the single word done.", {
      engine: "codex",
      ...liveCodexOptions(),
      isolation: "worktree"
    });
    assert.equal(runtime.worktrees.length, 1);
    assert.equal(runtime.worktrees[0]?.changed, false);
    assert.equal(runtime.worktrees[0]?.removed, true);
    await assert.rejects(() => access(runtime.worktrees[0]?.path ?? ""), /ENOENT/);

    // Each worker's own file in its own worktree is the evidence; their
    // replies are not asserted.
    await Promise.all([
      runtime.agent(
        "Use the shell to create agent-a.txt in the current working directory containing exactly A_ONLY, then git add it and commit it with message 'commit agent a'. Do not create agent-b.txt. Then reply with the single word done.",
        { engine: "codex", ...liveCodexOptions(), isolation: "worktree" }
      ),
      runtime.agent(
        "Use the filesystem tools to create a file named agent-b.txt in the current working directory containing exactly B_ONLY. Do not create agent-a.txt. Then reply with the single word done.",
        { engine: "codex", ...liveCodexOptions(), isolation: "worktree" }
      )
    ]);

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
    const branchHead = (await execFileAsync("git", ["rev-parse", aWorktree.branch], { cwd: repo })).stdout.trim();
    assert.notEqual(branchHead, aWorktree.baseCommit);
    const committedContent = (
      await execFileAsync("git", ["show", `${aWorktree.branch}:agent-a.txt`], { cwd: repo })
    ).stdout.trim();
    assert.equal(committedContent, "A_ONLY");
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
