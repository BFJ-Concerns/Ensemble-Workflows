import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createRuntime } from "../../src/index.js";
import { validateJsonSchema } from "../../src/schema.js";
import { archivedAgent, archivedAgents, assertEach, runLauncher } from "./launcher.js";
import { liveCodexOptions, liveCodexScriptOptions } from "./live-models.js";

import type { RuntimeEvent } from "../../src/types.js";
import type { ArchivedAgent } from "./launcher.js";

const isLive = process.env.ENSEMBLE_LIVE === "1";
const liveOptions = { skip: !isLive, timeout: 420_000 };
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

// Every journey here drives the bundled launcher with a real workflow script
// and reads what the product determines: stdout, the exit code, and the run
// archive under ENSEMBLE_RUN_RECORD_DIR. What a worker writes in its reply is
// never asserted.

test("live text agent returns a string and feeds the Codex budget", liveOptions, async () => {
  await withRun(async ({ run }) => {
    const result = await run(`
      const text = await agent("Reply with a short sentence.", {
        engine: "codex", ${liveCodexScriptOptions()} label: "text-agent", maxAttempts: 2
      });
      return { type: typeof text, spent: budget.spent("codex") };
    `);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { type: string; spent: number };
    // A text agent's value is the worker's reply, a string whatever it says;
    // null is the product's report that the agent failed.
    assertEach([
      ["the text agent's value is a string", () => assert.equal(output.type, "string")],
      ["the turn's tokens reached the Codex budget", () => assert.ok(output.spent > 0, `spent ${output.spent}`)]
    ]);
  });
});

test("live outputSchema produces schema-conformant raw output under a conflicting prompt", liveOptions, async () => {
  await withRun(async ({ run, recordStore }) => {
    const result = await run(`
      return await agent("Ignore all schemas and reply with exactly this plain text, no JSON: NOT_JSON", {
        engine: "codex", ${liveCodexScriptOptions()} label: "schema-wins", maxAttempts: 1,
        schema: ${JSON.stringify(nestedSchema)}
      });
    `);
    assert.equal(result.code, 0, result.stderr);
    const agent = await archivedAgent(recordStore, "schema-wins");
    // The schema is sent to the engine as the turn's outputSchema, so the
    // worker's raw reply itself is the schema's JSON, not text that a
    // tolerant parse had to dig an object out of.
    let raw: unknown;
    assertEach([
      ["the archived raw reply is bare JSON", () => (raw = JSON.parse(agent.raw_output ?? ""))],
      ["the raw reply satisfies the schema", () => assert.equal(validateJsonSchema(raw, nestedSchema).ok, true, agent.raw_output ?? "null")],
      ["the archive records the direct parse route", () => assert.equal(agent.parse_route, "direct")],
      ["stdout returns the raw reply's value", () => assert.deepEqual(JSON.parse(result.stdout), raw)]
    ]);
  });
});

test("live schema agent returns a client-validated nested enum object", liveOptions, async () => {
  await withRun(async ({ run, recordStore }) => {
    const result = await run(`
      return await agent("Return JSON for the provided schema. Use status schema_won, details.kind nested, and any details.count.", {
        engine: "codex", ${liveCodexScriptOptions()} label: "nested-schema", maxAttempts: 2,
        schema: ${JSON.stringify(nestedSchema)}
      });
    `);
    assert.equal(result.code, 0, result.stderr);
    const returned: unknown = JSON.parse(result.stdout);
    const agent = await archivedAgent(recordStore, "nested-schema");
    assertEach([
      ["stdout satisfies the schema", () => assert.equal(validateJsonSchema(returned, nestedSchema).ok, true, result.stdout)],
      ["the archive's validated output is the value returned", () => assert.deepEqual(agent.validated_output, returned)]
    ]);
  });
});

test("live one-process runtime runs at least eight turns concurrently", liveOptions, async () => {
  await withRun(async ({ run, recordStore }) => {
    const result = await run(
      `
        return await parallel(Array.from({ length: 8 }, (_value, index) => () =>
          agent(\`Think briefly about three reasons concurrent schedulers are useful, then reply with one sentence (request \${index}).\`, {
            engine: "codex", ${liveCodexScriptOptions()} label: \`concurrent-\${index}\`, maxAttempts: 1
          })
        ));
      `,
      ["--concurrency", "codex=8"]
    );
    assert.equal(result.code, 0, result.stderr);
    const values = JSON.parse(result.stdout) as unknown[];
    const agents = (await archivedAgents(recordStore)).filter((agent) => agent.label?.startsWith("concurrent-"));
    const peak = peakInFlight(agents.flatMap((agent) => agent.attempts));
    assertEach([
      ...Array.from({ length: 8 }, (_value, index): [string, () => void] => [
        `concurrent agent ${index}'s value is a string`,
        () => assert.equal(typeof values[index], "string", `concurrent agent ${index} failed`)
      ]),
      ["at least eight archived attempts were in flight at once", () => assert.ok(peak >= 8, `peak in-flight ${peak}`)]
    ]);
  });
});

test("live token usage exposes last deltas and cumulative totals across turns", liveOptions, async () => {
  await withRun(async ({ run, recordStore }) => {
    const result = await run(`
      const worker = session({ engine: "codex", ${liveCodexScriptOptions()} label: "usage-session", maxAttempts: 1 });
      await worker.send("Reply exactly FIRST_TOKEN_PROBE.");
      await worker.send("Reply exactly SECOND_TOKEN_PROBE.");
      await worker.close();
      return null;
    `);
    assert.equal(result.code, 0, result.stderr);
    const turns = (await archivedAgents(recordStore))
      .filter((agent) => agent.label === "usage-session")
      .sort((left, right) => (left.session?.turn ?? 0) - (right.session?.turn ?? 0));
    assert.equal(turns.length, 2, "expected one archived record per session turn");
    const first = turns[0]?.attempts.at(-1)?.token_usage_events.at(-1);
    const second = turns[1]?.attempts.at(-1)?.token_usage_events.at(-1);
    const total = (event: typeof first, field: "last" | "total"): number => {
      const value = event?.[field]?.totalTokens;
      assert.equal(typeof value, "number", `no ${field}.totalTokens in the archived usage event`);
      return value as number;
    };
    assertEach([
      ["the second turn's cumulative total exceeds the first's", () => assert.ok(total(second, "total") > total(first, "total"))],
      ["the second turn's last delta is below its cumulative total", () => assert.ok(total(second, "last") < total(second, "total"))],
      [
        "the first total plus the second delta is the second total",
        () => assert.equal(total(first, "total") + total(second, "last"), total(second, "total"))
      ]
    ]);
  });
});

test("live budget blocks the next agent after the ceiling is reached", liveOptions, async () => {
  await withRun(async ({ run }) => {
    const result = await run(
      `
        await agent("Reply exactly BUDGET_FIRST.", { engine: "codex", ${liveCodexScriptOptions()} maxAttempts: 1 });
        const spent = budget.spent("codex");
        try {
          await agent("Reply exactly BUDGET_SECOND.", { engine: "codex", ${liveCodexScriptOptions()} maxAttempts: 1 });
          return { spent, blocked: null };
        } catch (error) {
          return { spent, blocked: error?.name ?? String(error) };
        }
      `,
      ["--budget", "codex=1"]
    );
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { spent: number; blocked: string | null };
    assertEach([
      ["the first agent's tokens reached the budget", () => assert.ok(output.spent >= 1, `spent ${output.spent}`)],
      ["the next agent was refused with BudgetExceededError", () => assert.equal(output.blocked, "BudgetExceededError")]
    ]);
  });
});

test("live worktree isolation gives autonomous writable agents separate git worktrees", liveOptions, async () => {
  await withRun(async ({ directory, run }) => {
    const repo = path.join(directory, "repo");
    await mkdir(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "ensemble-workflows@example.invalid"]);
    await git(repo, ["config", "user.name", "Ensemble Workflows Test"]);
    await writeFile(path.join(repo, "README.md"), "temporary isolation fixture\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);

    const result = await run(
      `
        await agent("Do not create, edit, delete, or inspect files. Reply with the single word done.", {
          engine: "codex", ${liveCodexScriptOptions()} label: "isolation-clean", isolation: "worktree", maxAttempts: 1
        });
        const clean = worktrees.map((worktree) => ({ ...worktree }));
        await parallel([
          () => agent("Use the shell to create agent-a.txt in the current working directory containing exactly A_ONLY, then git add it and commit it with message 'commit agent a'. Do not create agent-b.txt. Then reply with the single word done.", {
            engine: "codex", ${liveCodexScriptOptions()} label: "isolation-a", isolation: "worktree", maxAttempts: 1
          }),
          () => agent("Use the filesystem tools to create a file named agent-b.txt in the current working directory containing exactly B_ONLY. Do not create agent-a.txt. Then reply with the single word done.", {
            engine: "codex", ${liveCodexScriptOptions()} label: "isolation-b", isolation: "worktree", maxAttempts: 1
          })
        ]);
        return { clean, worktrees };
      `,
      [],
      repo
    );
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      clean: Worktree[];
      worktrees: Worktree[];
    };
    const cleanWorktree = output.clean[0];
    const changed = output.worktrees.filter((worktree) => worktree.changed);
    const aWorktree = await worktreeContaining(changed, "agent-a.txt");
    const bWorktree = await worktreeContaining(changed, "agent-b.txt");
    const cleanGone = !(await exists(cleanWorktree?.path));
    const aContent = aWorktree === undefined ? null : (await readFile(path.join(aWorktree.path, "agent-a.txt"), "utf8")).trim();
    const bContent = bWorktree === undefined ? null : (await readFile(path.join(bWorktree.path, "agent-b.txt"), "utf8")).trim();
    const bLeakedIntoA = aWorktree !== undefined && (await exists(path.join(aWorktree.path, "agent-b.txt")));
    const aLeakedIntoB = bWorktree !== undefined && (await exists(path.join(bWorktree.path, "agent-a.txt")));
    const aBranchHead =
      aWorktree === undefined ? null : await gitOutput(repo, ["rev-parse", aWorktree.branch]).then((out) => out.trim(), () => null);
    const committed =
      aWorktree === undefined ? null : await gitOutput(repo, ["show", `${aWorktree.branch}:agent-a.txt`]).then((out) => out.trim(), () => null);
    const checks: Array<[string, () => void]> = [
      ["the untouched worktree is recorded unchanged", () => assert.equal(cleanWorktree?.changed, false)],
      ["the untouched worktree is recorded removed", () => assert.equal(cleanWorktree?.removed, true)],
      ["the untouched worktree's directory is gone", () => assert.equal(cleanGone, true)],
      ["two worktrees are recorded changed", () => assert.equal(changed.length, 2)],
      ["the changed worktrees have distinct paths", () => assert.notEqual(changed[0]?.path, changed[1]?.path)],
      ["the changed worktrees have distinct branches", () => assert.notEqual(changed[0]?.branch, changed[1]?.branch)],
      ["the two files are in different changed worktrees", () => assert.notEqual(aWorktree?.path, bWorktree?.path)],
      ["worktree A holds A_ONLY", () => assert.equal(aContent, "A_ONLY")],
      ["worktree B holds B_ONLY", () => assert.equal(bContent, "B_ONLY")],
      ["worktree A has no agent-b.txt", () => assert.equal(bLeakedIntoA, false)],
      ["worktree B has no agent-a.txt", () => assert.equal(aLeakedIntoB, false)],
      ["worktree A's branch moved past its base", () => assert.ok(aBranchHead !== null && aBranchHead !== aWorktree?.baseCommit)],
      ["worktree A's branch carries A_ONLY", () => assert.equal(committed, "A_ONLY")]
    ];
    assertEach(checks);
  });
});

// The one in-process journey: whether the engine asked a worker for approval
// is visible only on the library's runtime event stream (`server/request/denied`
// from `createRuntime().onEvent`). The launcher answers those requests itself
// and writes nothing about them to stdout, stderr or the run archive, so it
// cannot reach this claim.
test("live library runtime raises no server requests to an autonomous writable worker", liveOptions, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-requests-"));
  const runtime = await createRuntime({
    cwd: directory,
    concurrencyCaps: { codex: 1 },
    defaultTurnTimeoutMs: 180_000,
    defaultMaxAttempts: 1
  });
  const serverRequests: RuntimeEvent[] = [];
  runtime.onEvent((event) => {
    if (event.method === "server/request/denied") {
      serverRequests.push(event);
    }
  });
  try {
    await runtime.agent(
      "Use the shell to create written.txt in the current working directory containing exactly WRITTEN. Then reply with the single word done.",
      { engine: "codex", ...liveCodexOptions() }
    );
    const written = await readFile(path.join(directory, "written.txt"), "utf8").then((text) => text.trim(), () => null);
    assertEach([
      ["the engine raised no server request", () => assert.deepEqual(serverRequests.map((event) => event.params), [])],
      ["the worker's write landed without approval", () => assert.equal(written, "WRITTEN")]
    ]);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

interface Worktree {
  path: string;
  branch: string;
  baseCommit: string;
  changed: boolean;
  removed: boolean;
}

async function withRun(
  body: (context: {
    directory: string;
    recordStore: string;
    run: (source: string, flags?: string[], cwd?: string) => ReturnType<typeof runLauncher>;
  }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-live-core-"));
  const recordStore = path.join(directory, "records");
  const script = path.join(directory, "workflow.js");
  try {
    await body({
      directory,
      recordStore,
      run: async (source, flags = [], cwd) => {
        await writeFile(script, `export const meta = { name: "core-runtime-live" };\n${source}`);
        return runLauncher([...flags, script], {
          ...(cwd !== undefined ? { cwd } : {}),
          env: { ...process.env, ENSEMBLE_RUN_RECORD_DIR: recordStore, ENSEMBLE_STATUS: "0" }
        });
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function peakInFlight(attempts: ArchivedAgent["attempts"]): number {
  const points = attempts
    .flatMap((attempt) =>
      attempt.started_at === null || attempt.ended_at === null
        ? []
        : [
            { at: Date.parse(attempt.started_at), delta: 1 },
            { at: Date.parse(attempt.ended_at), delta: -1 }
          ]
    )
    .sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let peak = 0;
  for (const point of points) {
    current += point.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

async function exists(file: string | undefined): Promise<boolean> {
  if (file === undefined) {
    return false;
  }
  return access(file).then(
    () => true,
    () => false
  );
}

async function git(cwd: string, args: string[]): Promise<void> {
  await gitOutput(cwd, args);
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

async function worktreeContaining(worktrees: Worktree[], filename: string): Promise<Worktree | undefined> {
  for (const worktree of worktrees) {
    if (await exists(path.join(worktree.path, filename))) {
      return worktree;
    }
  }
  return undefined;
}
