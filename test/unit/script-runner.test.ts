import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkflowTimeoutError, extractWorkflowSource, runWorkflowScript } from "../../src/script-runner.js";
import { TokenBudget } from "../../src/budget.js";

import type { WorkflowRuntime } from "../../src/hooks.js";
import type { EngineName } from "../../src/types.js";

const runtime: WorkflowRuntime = {
  budget: {
    spent: () => 0,
    remaining: () => Number.POSITIVE_INFINITY
  },
  worktrees: [],
  async agent(prompt: string) {
    return `agent:${prompt}`;
  },
  notePhase: () => {}
};

test("runs a script with hooks as globals and captures its return value", async () => {
  const logs: string[] = [];

  const result = await runWorkflowScript({
    filename: "workflow.js",
    runtime,
    args: ["left", "right"],
    log: (message) => logs.push(message),
    source: `
      export const meta = { name: "basic", description: "test" };

      phase("fan out");
      log(args.join(":"));
      const values = await parallel([
        () => agent("one", { engine: "codex" }),
        () => "plain"
      ]);
      return { values, remaining: budget.remaining("codex") };
    `
  });

  assert.deepEqual(result.meta, { name: "basic", description: "test" });
  assert.deepEqual(result.result, {
    values: ["agent:one", "plain"],
    remaining: Number.POSITIVE_INFINITY
  });
  assert.deepEqual(logs, ["[phase] fan out", "left:right"]);
});

test("exposes worktrees as a workflow-visible side channel", async () => {
  const worktreeRuntime: WorkflowRuntime = {
    ...runtime,
    worktrees: [
      {
        path: "/tmp/worktree",
        branch: "ensemble-workflows/example",
        baseCommit: "fake-base",
        changed: true,
        removed: false
      }
    ]
  };

  const result = await runWorkflowScript({
    filename: "worktrees.js",
    runtime: worktreeRuntime,
    log: () => {},
    source: `
      export const meta = { name: "worktrees" };

      return worktrees.map((worktree) => ({ path: worktree.path, changed: worktree.changed }));
    `
  });

  assert.deepEqual(result.result, [{ path: "/tmp/worktree", changed: true }]);
});

test("workflow({ scriptPath }) runs a saved child with supplied args", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-workflow-script-path-"));
  const child = path.join(directory, "child.js");
  await writeFile(
    child,
    `
      export const meta = { name: "child-by-path", description: "path child" };
      return { args, value: await agent("child-path", { engine: "codex" }) };
    `
  );

  const result = await runWorkflowScript({
    cwd: directory,
    filename: path.join(directory, "parent.js"),
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "parent" };
      return await workflow({ scriptPath: "./child.js" }, { id: 7 });
    `
  });

  assert.deepEqual(result.result, { args: { id: 7 }, value: "agent:child-path" });
});

test("workflow(name) resolves saved children from the project registry before the user registry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-workflow-name-"));
  const userData = await mkdtemp(path.join(tmpdir(), "ensemble-workflow-user-"));
  const projectRegistry = path.join(directory, ".claude", "ensemble", "workflows");
  const userRegistry = path.join(userData, "ensemble", "workflows");
  await mkdir(projectRegistry, { recursive: true });
  await mkdir(userRegistry, { recursive: true });
  await writeFile(
    path.join(userRegistry, "shared.js"),
    `
      export const meta = { name: "shared", description: "user child" };
      return "user";
    `
  );
  await writeFile(
    path.join(projectRegistry, "shared.js"),
    `
      export const meta = { name: "shared", description: "project child" };
      return "project";
    `
  );

  const result = await runWorkflowScript({
    cwd: directory,
    env: { XDG_DATA_HOME: userData },
    filename: path.join(directory, "parent.js"),
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "parent" };
      return await workflow("shared", ["from-name"]);
    `
  });

  assert.equal(result.result, "project");
});

test("child workflows share the parent budget ledger", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-workflow-budget-"));
  await writeFile(
    path.join(directory, "child.js"),
    `
      export const meta = { name: "budget-child" };
      await agent("spend", { engine: "codex" });
      return { remaining: budget.remaining("codex") };
    `
  );
  const budget = new TokenBudget({ codex: 5 });
  const spendingRuntime: WorkflowRuntime = {
    ...runtime,
    budget,
    async agent(_prompt: string, options: { engine?: EngineName }) {
      const engine = options.engine;
      assert.equal(engine, "codex");
      budget.assertCanStart(engine);
      budget.record(engine, tokenUsageEvent(5));
      return "spent";
    }
  };

  const result = await runWorkflowScript({
    cwd: directory,
    filename: path.join(directory, "parent.js"),
    runtime: spendingRuntime,
    log: () => {},
    source: `
      export const meta = { name: "parent" };
      const child = await workflow({ scriptPath: "./child.js" }, []);
      let blocked = false;
      try {
        await agent("again", { engine: "codex" });
      } catch (error) {
        blocked = /Token budget exhausted/.test(String(error?.message ?? error));
      }
      return { child, blocked, remaining: budget.remaining("codex") };
    `
  });

  assert.deepEqual(result.result, {
    child: { remaining: 0 },
    blocked: true,
    remaining: 0
  });
});

test("workflow() inside a child workflow throws the one-level nesting error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-workflow-nesting-"));
  await writeFile(path.join(directory, "grandchild.js"), `export const meta = { name: "grandchild" }; return "never";`);
  await writeFile(
    path.join(directory, "child.js"),
    `
      export const meta = { name: "child" };
      return await workflow({ scriptPath: "./grandchild.js" }, []);
    `
  );

  await assert.rejects(
    () =>
      runWorkflowScript({
        cwd: directory,
        filename: path.join(directory, "parent.js"),
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "parent" };
          return await workflow({ scriptPath: "./child.js" }, []);
        `
      }),
    /workflow\(\) cannot be called from inside a child workflow/
  );
});

test("workflow() fails loudly for unknown names and missing script paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-workflow-fail-loud-"));

  await assert.rejects(
    () =>
      runWorkflowScript({
        cwd: directory,
        filename: path.join(directory, "unknown-parent.js"),
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "parent" };
          return await workflow("missing-child", []);
        `
      }),
    /workflow\("missing-child"\) was not found/
  );

  await assert.rejects(
    () =>
      runWorkflowScript({
        cwd: directory,
        filename: path.join(directory, "missing-path-parent.js"),
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "parent" };
          return await workflow({ scriptPath: "./absent.js" }, []);
        `
      }),
    /workflow\(\{ scriptPath \}\) could not read/
  );
});

test("extracts multi-line meta with nested braces, comments, and strings", () => {
  const extracted = extractWorkflowSource(`
    export const meta = {
      name: "nested",
      description: "brace } inside a string",
      nested: {
        text: 'quote with { brace',
        template: \`literal { still text }\`
      },
      list: [{ ok: true }],
      // a comment with }
      block: /* a comment with { */ "done"
    };

    return "body";
  `);

  assert.match(extracted.metaSource, /description: "brace } inside a string"/);
  assert.match(extracted.bodySource, /return "body"/);
});

test("denies ambient Node, filesystem-shaped, and network globals while permitting Date and Math", async () => {
  const checks = await runWorkflowScript({
    filename: "sandbox.js",
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "sandbox" };

      return {
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        date: typeof Date.now(),
        random: typeof Math.random()
      };
    `
  });

  assert.deepEqual(checks.result, {
    process: "undefined",
    require: "undefined",
    fetch: "undefined",
    date: "number",
    random: "number"
  });

  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "dynamic-import.js",
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "import" };
          return await import("node:fs");
        `
      }),
    /dynamic import|importModuleDynamically|not supported|A dynamic import callback/
  );
});

test("times out runaway async scripts", async () => {
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "timeout.js",
        runtime,
        timeoutMs: 20,
        log: () => {},
        source: `
          export const meta = { name: "timeout" };
          return await new Promise(() => {});
        `
      }),
    WorkflowTimeoutError
  );
});

test("does not impose a default timeout when no timeout is configured", async () => {
  const delayedRuntime: WorkflowRuntime = {
    ...runtime,
    async agent(prompt: string) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return `agent:${prompt}`;
    }
  };

  const result = await runWorkflowScript({
    filename: "no-default-timeout.js",
    runtime: delayedRuntime,
    log: () => {},
    source: `
      export const meta = { name: "no-default-timeout" };
      return await agent("slow-but-finite", { engine: "codex" });
    `
  });

  assert.equal(result.result, "agent:slow-but-finite");
});

test("times out runaway synchronous scripts", async () => {
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "sync-timeout.js",
        runtime,
        timeoutMs: 20,
        log: () => {},
        source: `
          export const meta = { name: "sync-timeout" };
          while (true) {}
        `
      }),
    WorkflowTimeoutError
  );
});

function tokenUsageEvent(totalTokens: number): Parameters<TokenBudget["record"]>[1] {
  const usage = {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: totalTokens,
    reasoningOutputTokens: 0,
    totalTokens
  };
  return {
    threadId: "thread",
    turnId: "turn",
    last: usage,
    total: usage,
    raw: {}
  };
}

test("export const defaults supplies per-engine policy that call sites override", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const recordingRuntime: WorkflowRuntime = {
    ...runtime,
    agent: (async (prompt: string, options?: Record<string, unknown>) => {
      // Spread to normalise the realm: an unmerged options object arrives with
      // the sandbox's Object.prototype, which deepEqual treats as different.
      seen.push({ ...(options ?? {}) });
      return `agent:${prompt}`;
    }) as unknown as WorkflowRuntime["agent"]
  };

  const result = await runWorkflowScript({
    filename: "defaults.js",
    runtime: recordingRuntime,
    log: () => {},
    source: `
      export const meta = { name: "defaults", description: "test" };
      export const defaults = {
        claude: { model: "opus", effort: "medium" },
        codex: { effort: "low" }
      };

      await agent("uses claude defaults", { engine: "claude" });
      await agent("call site wins", { engine: "claude", model: "sonnet" });
      await agent("codex default effort", { engine: "codex" });
      await agent("untouched engine", { engine: "opencode", model: "glm-5.2" });
      return "ok";
    `
  });

  assert.equal(result.result, "ok");
  assert.deepEqual(seen[0], { engine: "claude", model: "opus", effort: "medium" });
  assert.deepEqual(seen[1], { engine: "claude", model: "sonnet", effort: "medium" });
  assert.deepEqual(seen[2], { engine: "codex", effort: "low" });
  assert.deepEqual(seen[3], { engine: "opencode", model: "glm-5.2" });
});

test("defaults with a non-engine key fail before the body runs", async () => {
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "bad-defaults.js",
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "bad-defaults" };
          export const defaults = { gemini: { model: "flash" } };
          return "never";
        `
      }),
    /defaults key "gemini" is not an engine/
  );
});

test("defaults with an unsupported option key fail loudly", async () => {
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "bad-defaults-option.js",
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "bad-defaults-option" };
          export const defaults = { claude: { schema: { type: "object" } } };
          return "never";
        `
      }),
    /defaults\.claude\.schema is not supported/
  );
});

test("a script with a defaults block still exposes its meta to registry readers", async () => {
  const { readWorkflowMeta } = await import("../../src/script-runner.js");
  const meta = readWorkflowMeta(`
    export const meta = { name: "with-defaults", description: "d" };
    export const defaults = { codex: { effort: "low" } };
    return "ok";
  `);
  assert.deepEqual(meta, { name: "with-defaults", description: "d" });
});
