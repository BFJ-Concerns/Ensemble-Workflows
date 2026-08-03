import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const failedEnvelope = { partial: true, reason: "failed", completed: [] };

test("built CLI rejects every fail-loud return kind with its path and a salvage envelope", async () => {
  const scenarios = [
    { name: "function", body: `return { nested: { callback: () => 1 } };`, path: "return value.nested.callback is a function" },
    { name: "symbol", body: `return { nested: { marker: Symbol("estate") } };`, path: "return value.nested.marker is a symbol" },
    { name: "cycle", body: `const value = { nested: {} }; value.nested.self = value.nested; return value;`, path: "return value.nested.self closes a cycle" },
    { name: "bigint", body: `return { nested: { count: 10n } };`, path: "return value.nested.count is a BigInt" }
  ];

  for (const scenario of scenarios) {
    const result = await runWorkflow(scenario.name, scenario.body);
    assert.equal(result.code, 1, `${scenario.name}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), failedEnvelope);
    assert.equal(
      result.stderr,
      `WorkflowScriptError: workflow return value must be a JSON value: ${scenario.path}\n`
    );
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});

test("built CLI rejects workflow arguments before resolving or executing the child", async () => {
  const result = await runWorkflow(
    "workflow-arguments",
    `return await workflow({ scriptPath: "./absent-child.js" }, [{ nested: { callback: () => 1 } }]);`
  );

  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), failedEnvelope);
  assert.equal(
    result.stderr,
    "WorkflowScriptError: workflow() arguments must be a JSON value: args[0].nested.callback is a function\n"
  );
  assert.doesNotMatch(result.stderr, /could not read|absent-child|\n\s+at /);
});

test("built CLI routes clone and stringify disagreements through clean author errors", async () => {
  const scenarios = [
    {
      name: "prototype-tojson",
      body: `class Money { constructor() { this.cents = 100n; } toJSON() { return "1.00"; } } return { price: new Money() };`,
      path: "return value.price.cents is a BigInt"
    },
    {
      name: "self-recursing-tojson",
      body: `return { n: 1, toJSON() { return this; } };`,
      path: "return value.toJSON is a function"
    },
    {
      name: "boxed-bigint",
      body: `return Object(10n);`,
      path: "JSON.stringify rejected it"
    }
  ];

  for (const scenario of scenarios) {
    const result = await runWorkflow(scenario.name, scenario.body);
    assert.equal(result.code, 1, `${scenario.name}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), failedEnvelope);
    assert.match(result.stderr, /^WorkflowScriptError: workflow return value must be a JSON value:/);
    assert.match(result.stderr, new RegExp(escapeRegExp(scenario.path)));
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.doesNotMatch(result.stderr, /RangeError|\n\s+at /);
  }
});

test("built CLI preserves JSON's documented undefined and non-finite mappings", async () => {
  const noReturn = await runWorkflow("no-return", `log("completed without a return");`);
  assert.equal(noReturn.code, 0, noReturn.stderr);
  assert.equal(noReturn.stdout, "null\n");

  const mappings = await runWorkflow(
    "documented-mappings",
    `return { kept: "yes", omitted: undefined, remaining: budget.remaining("codex") };`
  );
  assert.equal(mappings.code, 0, mappings.stderr);
  assert.deepEqual(JSON.parse(mappings.stdout), { kept: "yes", remaining: null });
});

test("built CLI journeys independently kill each serialisability safeguard mutation", async () => {
  const bundle = await readFile(bundledCliPath, "utf8");
  const mutations = [
    {
      name: "raw-value-choice",
      before: `assertJsonSerialisable(result, "workflow return value", "return value");`,
      after: `assertJsonSerialisable(settlement.value, "workflow return value", "return value");`,
      body: `class Money { constructor() { this.cents = 100n; } toJSON() { return "1.00"; } } return { price: new Money() };`,
      killedBy(result: ProcessResult): void {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, "null\n");
      }
    },
    {
      name: "tojson-once-guard",
      before: `return findUnserialisable(toJson.call(value), path12, ancestors, false);`,
      after: `return findUnserialisable(toJson.call(value), path12, ancestors, true);`,
      body: `return { n: 1, toJSON() { return this; } };`,
      killedBy(result: ProcessResult): void {
        assert.equal(result.code, 1);
        assert.match(result.stderr, /RangeError: Maximum call stack size exceeded/);
        assert.match(result.stderr, /\n\s+at /);
      }
    },
    {
      name: "stringify-backstop",
      before: `  try {\n    JSON.stringify(value);\n  } catch (error) {\n    const message = error instanceof Error ? error.message : String(error);\n    throw new WorkflowScriptError(\`${"${label}"} must be a JSON value: JSON.stringify rejected it (${"${message}"})\`);\n  }`,
      after: `  JSON.stringify({});`,
      body: `return Object(10n);`,
      killedBy(result: ProcessResult): void {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, "null\n");
      }
    }
  ];

  for (const mutation of mutations) {
    assert.equal(bundle.split(mutation.before).length, 2, `${mutation.name}: mutation needle must occur exactly once`);
    const directory = await mkdtemp(path.join(tmpdir(), `ensemble-serialisability-mutation-${mutation.name}-`));
    const mutatedCli = path.join(directory, "ensemble.mjs");
    try {
      await writeFile(mutatedCli, bundle.replace(mutation.before, mutation.after));
      const result = await runWorkflow(mutation.name, mutation.body, mutatedCli);
      mutation.killedBy(result);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runWorkflow(name: string, body: string, cliPath = bundledCliPath): Promise<ProcessResult> {
  const directory = await mkdtemp(path.join(tmpdir(), `ensemble-serialisability-${name}-`));
  const script = path.join(directory, "workflow.js");
  try {
    await writeFile(script, `export const meta = { name: ${JSON.stringify(name)} };\n${body}\n`);
    return await runNode([cliPath, script], {
      ...process.env,
      ENSEMBLE_RUN_RECORD: "0",
      ENSEMBLE_STATUS: "0",
      XDG_DATA_HOME: path.join(directory, "data")
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
