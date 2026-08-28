import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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
        tipCommit: "fake-tip",
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

test("a composed child's invocation is surfaced before the child runs, with source and args", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-workflow-invocation-"));
  const childPath = path.join(directory, "child.js");
  const childSource = `
      export const meta = { name: "recorded-child" };
      return await agent("recorded", { engine: "codex" });
    `;
  await writeFile(childPath, childSource);

  const invocations: Array<{ scriptPath: string; source: string; args: unknown }> = [];
  const order: string[] = [];
  const result = await runWorkflowScript({
    cwd: directory,
    filename: path.join(directory, "parent.js"),
    runtime: {
      ...runtime,
      agent: (prompt: string) => {
        order.push(`agent:${prompt}`);
        return Promise.resolve(`agent:${prompt}`);
      }
    } as typeof runtime,
    log: () => {},
    onWorkflowInvocation: (invocation) => {
      order.push("invocation-recorded");
      invocations.push(invocation);
    },
    source: `
      export const meta = { name: "recording-parent" };
      return await workflow({ scriptPath: "./child.js" }, ["carried"]);
    `
  });

  assert.equal(result.result, "agent:recorded");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]!.scriptPath, childPath);
  assert.equal(invocations[0]!.source, childSource);
  // Assert on the clone the way the real consumer does:
  // `RunRecordWriter.recordWorkflowInvocation` calls `structuredClone` on
  // exactly this value, so this tests what production sees.
  assert.deepEqual(structuredClone(invocations[0]!.args), ["carried"]);
  // Provenance-before-execution: the record exists before the child spends.
  assert.deepEqual(order, ["invocation-recorded", "agent:recorded"]);
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

test("pre-spawn workflow() author errors propagate out of the combinators from the real hook", async () => {
  // End-to-end through runWorkflowScript, not a hand-thrown class: the
  // raise sites themselves must produce the exempt family, or a fan-out of
  // identical author mistakes filters to a silent empty success.
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-combinator-author-errors-"));

  // A mistyped saved-workflow name inside parallel().
  await assert.rejects(
    () =>
      runWorkflowScript({
        cwd: directory,
        filename: path.join(directory, "fan-out-mistyped.js"),
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "fan-out-mistyped" };
          return await parallel([() => workflow("no-such-workflow", [])]);
        `
      }),
    /workflow\("no-such-workflow"\) was not found/
  );

  // A reference the hook cannot even narrow, inside pipeline().
  await assert.rejects(
    () =>
      runWorkflowScript({
        cwd: directory,
        filename: path.join(directory, "pipeline-bad-ref.js"),
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "pipeline-bad-ref" };
          return await pipeline([1], () => workflow(123, []));
        `
      }),
    /workflow\(\) expects a workflow name string/
  );

  // Non-JSON workflow() arguments inside parallel() — pre-spawn, so the
  // run fails rather than the slot nulling.
  await assert.rejects(
    () =>
      runWorkflowScript({
        cwd: directory,
        filename: path.join(directory, "fan-out-bad-args.js"),
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "fan-out-bad-args" };
          return await parallel([() => workflow({ scriptPath: "./absent.js" }, [() => 1])]);
        `
      }),
    /workflow\(\) arguments must be a JSON value/
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

test("a non-JSON return value fails settlement with the offending path named", async () => {
  // Settlement-time check: the value the body actually produced is judged
  // after the body resolves, not at load — a body can build any value it
  // likes as long as what crosses the printed-and-archived boundary is JSON.
  for (const scenario of [
    {
      name: "cycle",
      body: `const value = { name: "loop" };\nvalue.self = value;\nreturn value;`,
      offence: /return value\.self closes a cycle/
    },
    {
      name: "nested function",
      body: `return { results: [1, { callback: () => 2 }] };`,
      offence: /return value\.results\[1\]\.callback is a function/
    },
    {
      name: "bigint",
      body: `return 10n;`,
      offence: /return value is a BigInt/
    },
    {
      // structuredClone drops a *prototype* toJSON, so the normalised value
      // the CLI would stringify carries a bare BigInt — the check judges
      // that value, not the raw vm one, and fails loud instead of letting
      // stringify throw downstream into a silent null.
      name: "prototype toJSON lost in normalisation",
      body: `class Money { constructor() { this.cents = 100n; } toJSON() { return "1.00"; } }\nreturn { price: new Money() };`,
      offence: /return value\.price\.cents is a BigInt/
    },
    {
      // JSON.stringify accepts a self-returning toJSON (it consults toJSON
      // once), but the value still carries a function property, which is in
      // the fail-loud set — and the walk must reject it cleanly, not crash.
      name: "self-returning toJSON",
      body: `return { n: 1, toJSON() { return this; } };`,
      offence: /return value\.toJSON is a function/
    },
    {
      // A boxed BigInt has no enumerable properties for the walk to see;
      // the final stringify probe catches what the traversal cannot.
      name: "boxed bigint",
      body: `return Object(10n);`,
      offence: /JSON\.stringify rejected it/
    }
  ]) {
    await assert.rejects(
      () =>
        runWorkflowScript({
          filename: `unserialisable-${scenario.name}.js`,
          runtime,
          log: () => {},
          source: `export const meta = { name: "unserialisable" };\n${scenario.body}`
        }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowScriptError, `${scenario.name}: ${String(error)}`);
        assert.match(error.message, /workflow return value must be a JSON value/);
        assert.match(error.message, scenario.offence);
        return true;
      }
    );
  }
});

test("permitted JSON-adjacent returns still settle: undefined, Infinity, and toJSON", async () => {
  // The fail-loud set is functions, cycles, BigInt. JSON's documented
  // mappings stay allowed: no top-level return (undefined → null),
  // budget.remaining's Infinity (→ null), and a toJSON that yields JSON.
  const noReturn = await runWorkflowScript({
    filename: "no-return.js",
    runtime,
    log: () => {},
    source: `export const meta = { name: "no-return" };\nlog("ran");`
  });
  assert.equal(noReturn.result, undefined);

  const infinity = await runWorkflowScript({
    filename: "infinity.js",
    runtime,
    log: () => {},
    source: `export const meta = { name: "infinity" };\nreturn { remaining: budget.remaining("codex") };`
  });
  assert.deepEqual(infinity.result, { remaining: Number.POSITIVE_INFINITY });

  const toJson = await runWorkflowScript({
    filename: "tojson.js",
    runtime,
    log: () => {},
    source: `export const meta = { name: "tojson" };\nreturn { when: new Date(0) };`
  });
  assert.deepEqual(toJson.result, { when: new Date(0) });

  // A value acceptable *only* through toJSON: the raw object carries a BigInt
  // and a function, both fail-loud kinds, but stringify consults toJSON first
  // and never sees them. A walk that ignored the hook would reject this — so
  // this settling is what proves toJSON is honoured.
  const toJsonOnly = await runWorkflowScript({
    filename: "tojson-only.js",
    runtime,
    log: () => {},
    source: `export const meta = { name: "tojson-only" };\nreturn { secret: 10n, toJSON() { return "ok"; } };`
  });
  assert.equal(JSON.stringify(toJsonOnly.result), '"ok"');
});

test("non-JSON workflow() arguments fail before the child script is resolved", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-args-serialisable-"));
  // The child deliberately does not exist: if resolution ran before the
  // argument check, this call would fail with the could-not-read resolution
  // error instead — so the serialisability message is itself the proof of
  // ordering, not just of eventual rejection.
  await assert.rejects(
    () =>
      runWorkflowScript({
        cwd: directory,
        filename: path.join(directory, "parent.js"),
        runtime,
        log: () => {},
        source: `
          export const meta = { name: "args-parent" };
          return await workflow({ scriptPath: "./absent-child.js" }, [{ pick: (row) => row.id }]);
        `
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowScriptError);
      assert.match(error.message, /workflow\(\) arguments must be a JSON value/);
      assert.match(error.message, /args\[0\]\.pick is a function/);
      assert.doesNotMatch(error.message, /could not read/);
      return true;
    }
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

test("the body runs as ordinary Node: platform globals, timers, and the filesystem", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-full-node-"));
  const evidence = path.join(directory, "evidence.txt");
  await writeFile(evidence, "read-from-disk");

  const checks = await runWorkflowScript({
    filename: path.join(directory, "full-node.js"),
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "full-node" };

      // Waiting and inspecting the world are free in-script code: a sleep
      // through a real timer, and a file read through the platform.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const fs = await import("node:fs/promises");
      const onDisk = await fs.readFile(${JSON.stringify(evidence)}, "utf8");
      return {
        process: typeof process,
        buffer: typeof Buffer,
        fetch: typeof fetch,
        onDisk,
        date: typeof Date.now(),
        random: typeof Math.random()
      };
    `
  });

  assert.deepEqual(checks.result, {
    process: "object",
    buffer: "function",
    fetch: "function",
    onDisk: "read-from-disk",
    date: "number",
    random: "number"
  });
});

test("require, relative dynamic import, and import.meta resolve from the script's own path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-module-loading-"));
  await writeFile(path.join(directory, "helper.mjs"), "export const helper = \"relative-import\";\n");
  await writeFile(path.join(directory, "helper.cjs"), "module.exports = { helper: \"relative-require\" };\n");
  const scriptPath = path.join(directory, "loader.js");

  const result = await runWorkflowScript({
    filename: scriptPath,
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "loader" };

      const viaImport = (await import("./helper.mjs")).helper;
      const viaRequire = require("./helper.cjs").helper;
      const viaBuiltin = require("node:path").basename("/x/y.txt");
      return { viaImport, viaRequire, viaBuiltin, metaUrl: import.meta.url };
    `
  });

  const value = result.result as { viaImport: string; viaRequire: string; viaBuiltin: string; metaUrl: string };
  assert.equal(value.viaImport, "relative-import");
  assert.equal(value.viaRequire, "relative-require");
  assert.equal(value.viaBuiltin, "y.txt");
  // The body executes under the script's own URL (tagged with its content
  // hash), so import.meta and relative specifiers behave as if the module
  // sat at the script's path — not at a temp file or the harness's own
  // location.
  assert.ok(value.metaUrl.startsWith(`${pathToFileURL(scriptPath).href}?ensemble-workflow-body=`), value.metaUrl);
});

test("a changed body is never served stale, whatever the filename says", async () => {
  // One filename, two different sources: the content-hash URL tag moves
  // with the source, so the ESM module cache cannot serve the first body
  // to the second run — staleness is impossible by construction.
  const filename = "cache-check.js";
  const first = await runWorkflowScript({
    filename,
    runtime,
    log: () => {},
    source: `export const meta = { name: "cache-check" };\nreturn "first";`
  });
  const second = await runWorkflowScript({
    filename,
    runtime,
    log: () => {},
    source: `export const meta = { name: "cache-check" };\nreturn "second";`
  });
  assert.equal(first.result, "first");
  assert.equal(second.result, "second");
});

test("repeat invocations of one body reuse one module, with fresh bindings per run", async () => {
  // The bound: a long-lived library caller running the same workflow many
  // times retains one compiled module, not one per invocation — observed
  // through import.meta.url, which is the module's cache identity. Args
  // still arrive per call, because everything per-run rides the bindings.
  const filename = "cache-reuse.js";
  const source = `export const meta = { name: "cache-reuse" };\nreturn { url: import.meta.url, got: args };`;
  const first = await runWorkflowScript({ filename, runtime, log: () => {}, source, args: ["a"] });
  const second = await runWorkflowScript({ filename, runtime, log: () => {}, source, args: ["b"] });

  const firstValue = first.result as { url: string; got: unknown };
  const secondValue = second.result as { url: string; got: unknown };
  assert.equal(firstValue.url, secondValue.url, "same body, same path: one module identity");
  assert.deepEqual(firstValue.got, ["a"]);
  assert.deepEqual(secondValue.got, ["b"]);
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

test("the web-platform globals scripts already rely on remain available", async () => {
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

test("accepts this expressions that V8 resolves lexically", async () => {
  const result = await runWorkflowScript({
    filename: "lexical-this.js",
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "lexical-this" };

      class Matcher {
        static {
          this.parts = ["accepted"];
        }
      }

      return Matcher.parts;
    `
  });

  assert.deepEqual(result.result, ["accepted"]);
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

  // The unknown name sits *after* an agent call, which is exactly the
  // late-ReferenceError-after-paid-spend failure the load-time check
  // exists to prevent.
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "uses-undeclared.js",
        runtime: countingRuntime,
        log: () => {},
        source: `
          export const meta = { name: "uses-undeclared" };
          const found = await agent("survey", { engine: "codex" });
          return summariseFindings(found);
        `
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowScriptError);
      assert.match(error.message, /identifiers that are not defined: summariseFindings/);
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
    /identifiers that are not defined: agnet/
  );
});

test("an unsupported top-level export fails before any worker spawns", async () => {
  let agentCalls = 0;
  const countingRuntime: WorkflowRuntime = {
    ...runtime,
    async agent(prompt: string) {
      agentCalls += 1;
      return `agent:${prompt}`;
    }
  };

  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "unsupported-default-export.js",
        runtime: countingRuntime,
        log: () => {},
        source: `
          export const meta = { name: "unsupported-default-export" };
          await agent("must not start", { engine: "codex" });
          export default async function () { return "never"; }
        `
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowScriptError);
      assert.match(error.message, /unsupported top-level `export default`/);
      assert.match(error.message, /export const meta.*optional.*export const defaults.*executable body/s);
      assert.doesNotMatch(error.message, /Unexpected token/);
      return true;
    }
  );
  assert.equal(agentCalls, 0, "the export diagnostic must fire before any worker spawns");
});

test("a script exporting only meta and defaults still runs", async () => {
  const result = await runWorkflowScript({
    filename: "meta-and-defaults-only.js",
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "meta-and-defaults-only" };
      export const defaults = { codex: { effort: "low" } };
    `
  });

  assert.equal(result.result, undefined);
  assert.deepEqual(result.meta, { name: "meta-and-defaults-only" });
});

test("non-export top-level export property syntax remains V8's to execute", async () => {
  const scenarios = [
    {
      name: "optional property",
      body: `const parsed = JSON.parse('{"export": "value"}'); return parsed?.export;`,
      expected: "value"
    },
    {
      name: "operator continuation",
      body: `const obj = JSON.parse('{"export": 3}'); return obj.export * 2;`,
      expected: 6
    },
    {
      name: "ASI declaration continuation",
      body: `const obj = JSON.parse('{"export": 3}'); const value = obj.export\nconst next = value + 1; return next;`,
      expected: 4
    }
  ];

  for (const scenario of scenarios) {
    const result = await runWorkflowScript({
      filename: `v8-top-level-${scenario.name}.js`,
      runtime,
      log: () => {},
      source: `export const meta = { name: "v8-top-level-syntax" };\n${scenario.body}`
    });
    assert.equal(result.result, scenario.expected, scenario.name);
  }
});

test("an unsupported export after a template literal fails before any worker spawns", async () => {
  let agentCalls = 0;
  const countingRuntime: WorkflowRuntime = {
    ...runtime,
    async agent(prompt: string) {
      agentCalls += 1;
      return `agent:${prompt}`;
    }
  };

  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "template-before-export.js",
        runtime: countingRuntime,
        log: () => {},
        source: `
          export const meta = { name: "template-before-export" };
          const prompt = \`the answer is \${1 + 1}\`;
          await agent(prompt, { engine: "codex" });
          export default async function () { return "never"; }
        `
      }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowScriptError);
      assert.match(error.message, /unsupported top-level `export default`/);
      assert.doesNotMatch(error.message, /Unexpected token/);
      return true;
    }
  );
  assert.equal(agentCalls, 0, "the export diagnostic must fire before any worker spawns");
});

test("a typeof probe for an absent global passes the load-time check", async () => {
  const result = await runWorkflowScript({
    filename: "typeof-probe.js",
    runtime,
    log: () => {},
    source: `
      export const meta = { name: "typeof-probe" };
      // The defensive idiom: feature-probe, then use only what exists.
      const hasAbsent = typeof definitelyNotAGlobalAnywhere !== "undefined";
      const hasDecoder = typeof TextDecoder !== "undefined";
      return { hasAbsent, hasDecoder };
    `
  });
  assert.deepEqual(result.result, { hasAbsent: false, hasDecoder: true });
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

test("line comments between meta and defaults end at every JavaScript line terminator", async (t) => {
  const terminators = [
    ["LF", "\n"],
    ["lone CR", "\r"],
    ["CRLF", "\r\n"],
    ["LINE SEPARATOR", "\u2028"],
    ["PARAGRAPH SEPARATOR", "\u2029"]
  ] as const;

  for (const [name, terminator] of terminators) {
    await t.test(name, async () => {
      const result = await runWorkflowScript({
        filename: `comment-${name}.js`,
        runtime,
        log: () => {},
        source:
          'export const meta = { name: "comment-terminator" };' +
          `// Defaults follow${terminator}` +
          'export const defaults = { codex: { effort: "low" } };' +
          `return ${JSON.stringify(`${name} code ran`)};`
      });

      assert.equal(result.result, `${name} code ran`);
    });
  }
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

test("load-time defaults validation consults the runtime's own opencode registry", async () => {
  // A runtime whose opencode adapter carries an injected registry with an
  // extra model: load time must accept what dispatch would run…
  const injectedRegistry = {
    get: (model: string) =>
      model === "custom-model"
        ? {
            key: "custom-model",
            providerModel: "custom/custom-model",
            displayName: "Custom",
            provider: "custom",
            family: "custom",
            capabilities: { vision: false },
            billing: { mode: "self-hosted" as const }
          }
        : undefined,
    names: () => ["custom-model"]
  };
  const agentPrompts: string[] = [];
  const registryAwareRuntime = {
    ...runtime,
    openCodeModelRegistry: injectedRegistry,
    agent: (async (prompt: string) => {
      agentPrompts.push(prompt);
      return "ran";
    }) as unknown as WorkflowRuntime["agent"]
  };

  const accepted = await runWorkflowScript({
    filename: "injected-registry.js",
    runtime: registryAwareRuntime,
    log: () => {},
    source: `
      export const meta = { name: "injected-registry" };
      export const defaults = { opencode: { model: "custom-model" } };
      return await agent("go", { engine: "opencode" });
    `
  });
  assert.equal(accepted.result, "ran");
  assert.deepEqual(agentPrompts, ["go"]);

  // …and still reject before the body a model that registry does not carry.
  await assert.rejects(
    () =>
      runWorkflowScript({
        filename: "injected-registry-unknown.js",
        runtime: registryAwareRuntime,
        log: () => {},
        source: `
          export const meta = { name: "injected-registry-unknown" };
          export const defaults = { opencode: { model: "glm-5.2" } };
          return await agent("never", { engine: "opencode" });
        `
      }),
    /OpenCode model "glm-5.2" is not registered/
  );
});

test("EnsembleRuntime surfaces its opencode adapter's own registry", async () => {
  const { EnsembleRuntime } = await import("../../src/runtime.js");
  const { EngineRegistry, OpenCodeEngineAdapter } = await import("../../src/engines.js");
  const injectedRegistry = {
    get: () => undefined,
    names: () => ["injected-only"]
  };
  const runtime = new EnsembleRuntime({
    engines: new EngineRegistry([new OpenCodeEngineAdapter({ modelRegistry: injectedRegistry })]),
    defaultMaxAttempts: 1
  });
  try {
    // The getter chain (adapter → runtime) is what script loading consults;
    // identity, not shape, is the property — one registry object at both ends.
    assert.equal(runtime.openCodeModelRegistry, injectedRegistry);
  } finally {
    await runtime.close();
  }
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
