import assert from "node:assert/strict";
import test from "node:test";

import { WorkflowTimeoutError, extractWorkflowSource, runWorkflowScript } from "../../src/script-runner.js";

import type { WorkflowRuntime } from "../../src/hooks.js";

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
