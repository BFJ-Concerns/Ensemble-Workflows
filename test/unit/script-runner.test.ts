import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WorkflowScriptError,
  WorkflowTimeoutError,
  extractWorkflowSource,
  runWorkflowScript
} from "../../src/script-runner.js";
import { TokenBudget } from "../../src/budget.js";
import { FallbackModelUnsupportedError, OpenCodeModelNotRegisteredError } from "../../src/errors.js";

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
    /uses dynamic import\(\), which the sandbox does not provide/
  );
});

test("binds the script's own meta read-only in the body", async () => {
  const result = await runWorkflowScript({
    filename: "meta-read.js",
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "meta-read", description: "reads itself", task: { id: "t-1" } };
      return { name: meta.name, task: meta.task.id };
    `
  });
  assert.deepEqual(result.result, { name: "meta-read", task: "t-1" });

  // Strict-mode body + frozen binding: a write throws rather than silently
  // diverging from what the archive recorded.
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "meta-write.js",
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "meta-write" };
          meta.name = "something else";
          return meta.name;
        `
      }),
    /Cannot assign to read only property/
  );

  // Wholesale rebinding is the other route to the same divergence: the
  // binding itself is locked, not just the object it points at.
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "meta-rebind.js",
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "meta-rebind" };
          meta = { name: "impostor" };
          return meta.name;
        `
      }),
    /Cannot assign to read only property|Assignment to constant/
  );
});

test("a cyclic meta loads read-only instead of overflowing the stack", async () => {
  // A self-referential getter is the one way an object literal can produce a
  // cycle, and structuredClone preserves it — the freeze must tolerate that
  // rather than recurse without termination.
  const result = await runWorkflowScript({
    filename: "meta-cycle.js",
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "meta-cycle", get self() { return this; } };
      return meta.self.self.name;
    `
  });
  assert.equal(result.result, "meta-cycle");
});

test("binds the enumerated side-effect-free platform globals", async () => {
  const result = await runWorkflowScript({
    filename: "platform-globals.js",
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "platform-globals" };

      const bytes = new TextEncoder().encode("abc").length;
      const round = new TextDecoder().decode(new TextEncoder().encode("xyz"));
      const clone = structuredClone({ nested: { ok: true } });
      const host = new URL("https://example.test/path?q=1").host;
      const q = new URLSearchParams("a=1&b=2").get("b");
      const b64 = btoa("hi");
      const back = atob(b64);
      const uuid = crypto.randomUUID().length;
      const digest = (await crypto.subtle.digest("SHA-256", new TextEncoder().encode("x"))).byteLength;
      return { bytes, round, clone: clone.nested.ok, host, q, b64, back, uuid, digest };
    `
  });
  assert.deepEqual(result.result, {
    bytes: 3,
    round: "xyz",
    clone: true,
    host: "example.test",
    q: "2",
    b64: "aGk=",
    back: "hi",
    uuid: 36,
    digest: 32
  });
});

test("an unknown free identifier fails at load, before any worker spawns", async () => {
  let agentCalls = 0;
  const countingRuntime: WorkflowRuntime = {
    ...runtime,
    async agent(prompt: string) {
      agentCalls += 1;
      return `agent:${prompt}`;
    }
  };

  // Buffer is the documented absence; the reference sits *after* an agent
  // call, which is exactly the late-ReferenceError-after-paid-spend failure
  // the load-time check exists to prevent.
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "uses-buffer.js",
        runtime: countingRuntime,
        log: () => {},
        source: `
          export const meta = { name: "uses-buffer" };
          const found = await agent("survey", { engine: "codex" });
          return Buffer.byteLength(found);
        `
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowScriptError);
      assert.match(error.message, /identifiers the sandbox does not provide: Buffer/);
      return true;
    }
  );
  assert.equal(agentCalls, 0, "the load-time check must fire before any worker spawns");

  // A typo'd hook is the other common shape; the diagnostic names it.
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "typo.js",
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "typo" };
          return await agnet("x", { engine: "codex" });
        `
      }),
    /identifiers the sandbox does not provide: agnet/
  );

  // Dynamic import introduces no free identifier, so it needs its own
  // load-time rejection — after an agent call it would otherwise be the
  // paid-work-then-fail path.
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "dynamic-import-late.js",
        runtime: countingRuntime,
        log: () => {},
        source: `
          export const meta = { name: "dynamic-import-late" };
          const found = await agent("survey", { engine: "codex" });
          const fs = await import("node:fs");
          return fs.readFileSync ? "reached" : found;
        `
      }),
    /uses dynamic import\(\), which the sandbox does not provide/
  );
  assert.equal(agentCalls, 0, "the import() rejection must also fire before any worker spawns");
});

test("a typeof probe for an absent global passes the load-time check", async () => {
  const result = await runWorkflowScript({
    filename: "typeof-probe.js",
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "typeof-probe" };
      // The defensive idiom: feature-probe, then use only what exists.
      const hasBuffer = typeof Buffer !== "undefined";
      const hasDecoder = typeof TextDecoder !== "undefined";
      return { hasBuffer, hasDecoder };
    `
  });
  assert.deepEqual(result.result, { hasBuffer: false, hasDecoder: true });
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

test("comments between meta and defaults preserve the defaults block", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const recordingRuntime: WorkflowRuntime = {
    ...runtime,
    agent: (async (_prompt: string, options?: Record<string, unknown>) => {
      seen.push({ ...(options ?? {}) });
      return "done";
    }) as unknown as WorkflowRuntime["agent"]
  };

  const result = await runWorkflowScript({
    filename: "commented-defaults.js",
    runtime: recordingRuntime,
    log: () => {},
    source: `
      export const meta = { name: "commented-defaults" };
      // Defaults remain the optional second export.
      /* Both comment forms are valid in the gap. */
      export const defaults = { codex: { effort: "low" } };

      // A later "export const defaults =" mention is only prose.
      await agent("uses defaults", { engine: "codex" });
      return "ok";
    `
  });

  assert.equal(result.result, "ok");
  assert.deepEqual(seen, [{ engine: "codex", effort: "low" }]);
});

test("a misplaced defaults export reports the workflow shape", async () => {
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "misplaced-defaults.js",
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "misplaced-defaults" };
          const reason = "defaults declared late";
          export const defaults = { codex: { effort: "low" } };
          return reason;
        `
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowScriptError);
      assert.match(error.message, /`export const defaults` must follow `meta`/);
      assert.doesNotMatch(error.message, /Unexpected token/);
      return true;
    }
  );
});

test("nested templates may contain child workflow defaults as template text", async () => {
  const result = await runWorkflowScript({
    filename: "nested-template-child.js",
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "nested-template-child" };
      const CHILD = \`
      export const meta = { name: "child" };
      \${ \`
      export const defaults = { codex: { effort: "low" } };
      \` }
      return 1;
      \`;
      return CHILD;
    `
  });

  assert.ok(typeof result.result === "string");
  assert.match(result.result, /export const defaults = \{ codex:/);
});

test("odd quotes in regex literals do not hide a misplaced defaults export", async (t) => {
  for (const pattern of ["/it's/", '/say "hi/', "/[']/"]) {
    await t.test(pattern, async () => {
      await assert.rejects(
        () =>
          runWorkflowScript({
            filename: "regex-before-misplaced-defaults.js",
            runtime,
            log: () => {},
            source: `
              export const meta = { name: "regex-before-misplaced-defaults" };
              ${pattern};
              export const defaults = { codex: { effort: "low" } };
              return "never";
            `
          }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowScriptError);
          assert.match(error.message, /`export const defaults` must follow `meta`/);
          assert.doesNotMatch(error.message, /Unexpected token/);
          return true;
        }
      );
    });
  }
});

test("an inconclusive defaults placement check preserves the underlying syntax error", async () => {
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "inconclusive-defaults-placement.js",
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "inconclusive-defaults-placement" };
          // export const defaults = { codex: { effort: "low" } };
          const broken = ;
        `
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowScriptError);
      assert.match(error.message, /defaults.*placement could not be checked/i);
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    }
  );
});

test("child workflow defaults stay lexical and call sites still override them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-child-defaults-"));
  const child = path.join(directory, "child.js");
  await writeFile(
    child,
    `
      export const meta = { name: "child-defaults" };
      export const defaults = {
        claude: { model: "child-model", fallbackModel: "child-fallback" }
      };

      await agent("child default", { engine: "claude" });
      await agent("child override", { engine: "claude", model: "call-model" });
      return "child";
    `
  );

  const seen: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const recordingRuntime: WorkflowRuntime = {
    ...runtime,
    agent: (async (prompt: string, options?: Record<string, unknown>) => {
      seen.push({ prompt, options: { ...(options ?? {}) } });
      return `agent:${prompt}`;
    }) as unknown as WorkflowRuntime["agent"]
  };

  const result = await runWorkflowScript({
    filename: path.join(directory, "parent.js"),
    runtime: recordingRuntime,
    log: () => {},
    source: `
      export const meta = { name: "parent-defaults" };
      export const defaults = {
        claude: { model: "parent-model", effort: "low" }
      };

      await agent("parent default", { engine: "claude" });
      return await workflow({ scriptPath: "./child.js" }, []);
    `
  });

  assert.equal(result.result, "child");
  assert.deepEqual(seen, [
    {
      prompt: "parent default",
      options: { engine: "claude", model: "parent-model", effort: "low" }
    },
    {
      prompt: "child default",
      options: { engine: "claude", model: "child-model", fallbackModel: "child-fallback" }
    },
    {
      prompt: "child override",
      options: { engine: "claude", model: "call-model", fallbackModel: "child-fallback" }
    }
  ]);
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

test("engine-incompatible defaults fail before the body runs", async () => {
  const logs: string[] = [];
  let agentCalls = 0;
  const lateRejectingRuntime: WorkflowRuntime = {
    ...runtime,
    agent: (async () => {
      agentCalls += 1;
      throw new FallbackModelUnsupportedError("codex");
    }) as unknown as WorkflowRuntime["agent"]
  };

  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "codex-fallback-default.js",
        runtime: lateRejectingRuntime,
        log: (message) => logs.push(message),
        source: `
          export const meta = { name: "codex-fallback-default" };
          export const defaults = { codex: { fallbackModel: "sonnet" } };
          log("body ran");
          return await agent("never", { engine: "codex" });
        `
      }),
    /fallbackModel is not supported on the codex engine/
  );
  assert.deepEqual(logs, []);
  assert.equal(agentCalls, 0);
});

test("an unregistered opencode model in defaults fails before the body runs", async () => {
  const logs: string[] = [];
  let agentCalls = 0;
  const lateRejectingRuntime: WorkflowRuntime = {
    ...runtime,
    agent: (async () => {
      agentCalls += 1;
      throw new OpenCodeModelNotRegisteredError("glm-later", ["glm-5.2"]);
    }) as unknown as WorkflowRuntime["agent"]
  };

  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "unknown-opencode-default.js",
        runtime: lateRejectingRuntime,
        log: (message) => logs.push(message),
        source: `
          export const meta = { name: "unknown-opencode-default" };
          export const defaults = { opencode: { model: "glm-later" } };
          log("body ran");
          return await agent("never", { engine: "opencode" });
        `
      }),
    /OpenCode model "glm-later" is not registered/
  );
  assert.deepEqual(logs, []);
  assert.equal(agentCalls, 0);
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
