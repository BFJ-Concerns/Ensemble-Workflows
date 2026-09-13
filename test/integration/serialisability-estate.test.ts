import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertSalvageEnvelope, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

function withoutSentinelAnnouncement(stderr: string): string {
  const announcement = /^\[sentinel\] will write \S+\/completion-sentinel\.json when the run ends\n/gm;
  const matches = stderr.match(announcement) ?? [];
  assert.equal(matches.length, 1, `expected exactly one completion-sentinel announcement, got:\n${stderr}`);
  return stderr.replace(announcement, "");
}

for (const scenario of [
  { name: "function", body: `return { nested: { callback: () => 1 } };`, path: "return value.nested.callback is a function" },
  { name: "symbol", body: `return { nested: { marker: Symbol("estate") } };`, path: "return value.nested.marker is a symbol" },
  { name: "cycle", body: `const value = { nested: {} }; value.nested.self = value.nested; return value;`, path: "return value.nested.self closes a cycle" },
  { name: "bigint", body: `return { nested: { count: 10n } };`, path: "return value.nested.count is a BigInt" }
]) {
  test(`built CLI rejects ${scenario.name} returns with their path and a salvage envelope`, async () => {
    const result = await runWorkflow(scenario.name, scenario.body);
    assert.equal(result.code, 1, `${scenario.name}: ${result.stderr}`);
    const envelope = assertSalvageEnvelope(result.stdout, "failed");
    // The envelope names what ended the run, as the diagnostic does.
    assert.deepEqual(envelope.error, {
      kind: "WorkflowScriptError",
      message: `workflow return value must be a JSON value: ${scenario.path}`
    });
    const diagnostic = withoutSentinelAnnouncement(result.stderr);
    assert.equal(
      diagnostic,
      `WorkflowScriptError: workflow return value must be a JSON value: ${scenario.path}\n`
    );
    assert.doesNotMatch(diagnostic, /\n\s+at /);
  });
}

test("built CLI rejects workflow arguments before resolving or executing the child", async () => {
  const result = await runWorkflow(
    "workflow-arguments",
    `return await workflow({ scriptPath: "./absent-child.js" }, [{ nested: { callback: () => 1 } }]);`
  );

  assert.equal(result.code, 1, result.stderr);
  assertSalvageEnvelope(result.stdout, "failed");
  const diagnostic = withoutSentinelAnnouncement(result.stderr);
  assert.equal(
    diagnostic,
    "WorkflowScriptError: workflow() arguments must be a JSON value: args[0].nested.callback is a function\n"
  );
  assert.doesNotMatch(diagnostic, /could not read|absent-child|\n\s+at /);
});

for (const scenario of [
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
]) {
  test(`built CLI routes the ${scenario.name} disagreement through a clean author error`, async () => {
    const result = await runWorkflow(scenario.name, scenario.body);
    assert.equal(result.code, 1, `${scenario.name}: ${result.stderr}`);
    assertSalvageEnvelope(result.stdout, "failed");
    const diagnostic = withoutSentinelAnnouncement(result.stderr);
    assert.match(diagnostic, /^WorkflowScriptError: workflow return value must be a JSON value:/);
    assert.match(diagnostic, new RegExp(escapeRegExp(scenario.path)));
    assert.equal(diagnostic.trim().split("\n").length, 1);
    assert.doesNotMatch(diagnostic, /RangeError|\n\s+at /);
  });
}

test("built CLI maps no return to JSON null", async () => {
  const noReturn = await runWorkflow("no-return", `log("completed without a return");`);
  assert.equal(noReturn.code, 0, noReturn.stderr);
  assert.equal(noReturn.stdout, "null\n");
});

test("built CLI preserves JSON's documented undefined and non-finite mappings", async () => {
  const mappings = await runWorkflow(
    "documented-mappings",
    `return { kept: "yes", omitted: undefined, remaining: budget.remaining("codex") };`
  );
  assert.equal(mappings.code, 0, mappings.stderr);
  assert.deepEqual(JSON.parse(mappings.stdout), { kept: "yes", remaining: null });
});

test("built CLI journeys independently kill each serialisability safeguard mutation", async () => {
  const bundle = await readFile(bundledCliPath, "utf8");
  const identifier = String.raw`[A-Za-z_$][\w$]*`;
  const rawValueChoice = exactlyOneMatch(
    bundle,
    "raw-value-choice",
    new RegExp(
      String.raw`const (?<result>${identifier}) = (?<normalise>${identifier})\((?<settlement>${identifier})\.value\);\n` +
        String.raw`  if \((?<depth>${identifier}) === 0\) \{\n` +
        String.raw`    (?<assertion>(?<assertionFn>${identifier})\(\k<result>, "workflow return value", "return value"\);)`
    )
  );
  const toJsonOnceGuard = exactlyOneMatch(
    bundle,
    "tojson-once-guard",
    new RegExp(
      String.raw`const (?<toJson>${identifier}) = (?<value>${identifier})\.toJSON;\n` +
        String.raw`  if \((?<honour>${identifier}) && typeof \k<toJson> === "function"\) \{\n` +
        String.raw`    (?<guard>return (?<walk>${identifier})\(\k<toJson>\.call\(\k<value>\), (?<path>${identifier}), (?<ancestors>${identifier}), false\);)`
    )
  );
  const stringifyBackstop = exactlyOneMatch(
    bundle,
    "stringify-backstop",
    new RegExp(
      String.raw`(?<backstop>  try \{\n    JSON\.stringify\((?<value>${identifier})\);\n` +
        String.raw`  \} catch \((?<error>${identifier})\) \{\n` +
        String.raw`    const (?<message>${identifier}) = \k<error> instanceof Error \? \k<error>\.message : String\(\k<error>\);\n` +
        String.raw`    throw new (?<scriptError>${identifier})\(` +
        String.raw`\`\$\{(?<label>${identifier})\} must be a JSON value: JSON\.stringify rejected it \(\$\{\k<message>\}\)\`\);\n  \})`
    )
  );
  const rawAssertion = captured(rawValueChoice, "assertion");
  const assertionFunction = captured(rawValueChoice, "assertionFn");
  const settlement = captured(rawValueChoice, "settlement");
  const toJsonGuard = captured(toJsonOnceGuard, "guard");
  const backstop = captured(stringifyBackstop, "backstop");
  const mutations = [
    {
      name: "raw-value-choice",
      before: rawAssertion,
      after: `${assertionFunction}(${settlement}.value, "workflow return value", "return value");`,
      body: `class Money { constructor() { this.cents = 100n; } toJSON() { return "1.00"; } } return { price: new Money() };`,
      killedBy(result: ProcessResult): void {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, "null\n");
      }
    },
    {
      name: "tojson-once-guard",
      before: toJsonGuard,
      after: toJsonGuard.replace(/false\);$/, "true);"),
      body: `return { n: 1, toJSON() { return this; } };`,
      killedBy(result: ProcessResult): void {
        assert.equal(result.code, 1);
        assert.match(result.stderr, /RangeError: Maximum call stack size exceeded/);
        assert.match(result.stderr, /\n\s+at /);
      }
    },
    {
      name: "stringify-backstop",
      before: backstop,
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

interface StructuralMatch extends RegExpMatchArray {
  groups: Record<string, string>;
}

function exactlyOneMatch(bundle: string, name: string, pattern: RegExp): StructuralMatch {
  const matches = [...bundle.matchAll(new RegExp(pattern, "g"))];
  assert.equal(matches.length, 1, `${name}: mutation needle must occur exactly once`);
  const match = matches[0];
  assert.ok(match?.groups, `${name}: mutation needle must capture its emitted identifiers`);
  return match as StructuralMatch;
}

function captured(match: StructuralMatch, name: string): string {
  const value = match.groups[name];
  assert.ok(value, `mutation needle must capture ${name}`);
  return value;
}

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
      ENSEMBLE_RUN_RECORD: "0",
      ENSEMBLE_STATUS: "0",
      XDG_DATA_HOME: path.join(directory, "data")
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
