import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { CodexAppServerTransport } from "../../src/app-server.js";
import { TurnTimeoutError } from "../../src/errors.js";
import { RunProgress } from "../../src/progress.js";
import { STATUS_FILENAME, StatusFileWriter } from "../../src/status-file.js";
import { executablePath, findOnlyFile, hermeticEstateEnvironment, runNode, runProcess } from "./estate-process.js";

import type { BudgetView } from "../../src/progress.js";
import type { EngineName } from "../../src/types.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const turnTimeoutAcceleratorPath = path.resolve("test/fixtures/codex/accelerate-turn-timeout.mjs");
const delayedAgentWritePreloadPath = path.resolve("test/fixtures/delay-agent-record-writes.mjs");
// This only catches a wedged fixture process. It is not a product deadline and
// must leave room for the gate's many process estates to contend for the host.
const estateProcessHangGuardMs = 30_000;

test("hostile ambient ENSEMBLE_ and colour variables never reach an estate child", async () => {
  // The self-arming journey for the hermetic spawn environment: hostile
  // values are exported into THIS process — the ambient position — not
  // passed as overrides, so the assertion below can only hold if the
  // shared helper's strip removes them. The ENSEMBLE_ values are chosen
  // malformed on purpose: inherited by the child, each fails ambient
  // resolution loudly, replacing the exact usage stream this test pins.
  const hostile: Record<string, string> = {
    FORCE_COLOR: "3",
    NO_COLOR: "1",
    ENSEMBLE_AGENT_CEILING: "banana",
    ENSEMBLE_CONCURRENCY_CODEX: "several",
    ENSEMBLE_RUN_RECORD: "maybe"
  };
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(hostile)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const result = await runNode([bundledCliPath]);

    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Usage: ensemble [--json-args '<json>|@file'] [--budget engine=N] [--agent-ceiling N|null] [--concurrency engine=N] [--timeout ms] [--strip capability] [--caller-identity <identity>] <script.js> [args...]\n" +
      "       ensemble agent --engine <engine> [--model <model>] [--effort <effort>] [--fallback-model <model>]\n" +
      "                      [--label <label>] [--phase <phase>] [--cwd <path>]\n" +
      "                      [--isolation worktree] [--identity] [--schema '<json>|@file'] [--max-attempts N] [--strip capability] [--task <identity>] [--caller-identity <identity>]\n" +
      "                      [--budget engine=N] [--agent-ceiling N|null] [--concurrency engine=N] [--timeout ms] [prompt]\n" +
      "       ensemble workflows\n" +
      "       ensemble holds [--json]\n");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

function withoutSentinelAnnouncement(stderr: string): string {
  const announcement = /^\[sentinel\] will write \S+\/completion-sentinel\.json when the run ends\n/gm;
  const matches = stderr.match(announcement) ?? [];
  assert.equal(matches.length, 1, `expected exactly one completion-sentinel announcement, got:\n${stderr}`);
  return stderr.replace(announcement, "");
}

class UnboundedBudget implements BudgetView {
  readonly ceilings: Partial<Record<EngineName, number | null>> = {};

  spent(): number {
    return 0;
  }

  remaining(): number {
    return Number.POSITIVE_INFINITY;
  }
}

test("built CLI salvages a top-level failure with its recorder enabled by default", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-process-estate-"));
  const script = path.join(directory, "workflow.js");
  const dataHome = path.join(directory, "data");
  const expectedEnvelope = {
    partial: true,
    reason: "failed",
    completed: []
  };

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "top-level-failure-salvage",
          description: "Built CLI failure-envelope proof"
        };
        throw new Error("ESTATE_TOP_LEVEL_FAILURE");
      `
    );

    const env: NodeJS.ProcessEnv = { XDG_DATA_HOME: dataHome, ENSEMBLE_RUN_RECORD_DIR: undefined };

    const cliPath = path.resolve("dist/src/cli/ensemble.js");
    const result = await runNode([cliPath, script], env);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `${JSON.stringify(expectedEnvelope)}\n`, result.stderr);
    assert.match(result.stderr, /Error: ESTATE_TOP_LEVEL_FAILURE/);

    const manifestPath = await findOnlyFile(dataHome, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      status: string;
      result: { archive_path: string | null; exit_code: number | null };
    };
    assert.equal(manifest.status, "failed");
    assert.deepEqual(manifest.result, {
      archive_path: "result.json",
      exit_code: 1
    });

    const recordedResult = JSON.parse(await readFile(path.join(path.dirname(manifestPath), "result.json"), "utf8")) as {
      status: string;
      exit_code: number;
      value: unknown;
    };
    assert.equal(recordedResult.status, "failed");
    assert.equal(recordedResult.exit_code, 1);
    assert.deepEqual(recordedResult.value, expectedEnvelope);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("built CLI sends unrestricted posture on every Codex turn", async () => {
  const fixture = await createProcessFixture("unrestricted-posture");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "record-codex-posture",
          description: "Record the policy received by the final Codex protocol consumer"
        };
        return await agent("return a receipt object", {
          engine: "codex",
          maxAttempts: 2,
          schema: {
            type: "object",
            required: ["receipt"],
            additionalProperties: false,
            properties: {
              receipt: { type: "string" }
            }
          }
        });
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `null\n`);
    const messages = await fixture.messages();
    const threadStarts = messages.filter((message) => message.method === "thread/start");
    assert.equal(threadStarts.length, 2);
    for (const threadStart of threadStarts) {
      assert.equal(threadStart.params?.sandbox, "danger-full-access");
      assert.equal(Object.hasOwn(threadStart.params ?? {}, "config"), false);
    }
    const turnStarts = messages.filter((message) => message.method === "turn/start");
    assert.equal(turnStarts.length, 2);
    for (const turnStart of turnStarts) {
      assert.deepEqual(turnStart.params?.sandboxPolicy, { type: "dangerFullAccess" });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI round-trips Unicode line separators to the final Codex protocol consumer", async () => {
  const fixture = await createProcessFixture("unicode-line-separators");
  const prompt = "before\u2028between\u2029after";

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "unicode-line-separator-round-trip",
          description: "Final protocol consumer reconstructs both JSON-valid Unicode separators"
        };
        return await agent(${JSON.stringify(prompt)}, {
          engine: "codex",
          maxAttempts: 1
        });
      `
    );

    const result = await fixture.runWithEnv({ ENSEMBLE_FAKE_CODEX_UNICODE_LINES: "1" });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"worker-ok"\n`);
    const turnStart = (await fixture.messages()).find((message) => message.method === "turn/start");
    assert.equal(turnStart?.params?.input?.[0]?.text, prompt);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI rejects a removed agent option with its removal reason", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-removed-option-"));
  const script = path.join(directory, "workflow.js");

  try {
    await writeFile(
      script,
      `
        export const meta = { name: "removed-option" };
        await agent("must never run", { engine: "codex", sandbox: "read-only" });
      `
    );

    const cliPath = path.resolve("dist/src/cli/ensemble.js");
    const result = await runNode([cliPath, script], { ENSEMBLE_RUN_RECORD: "off" });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(result.stderr, /RemovedAgentOptionError: agent\(\) option "sandbox" was removed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("built CLI fails loud when an explicitly configured status directory is missing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-status-estate-"));
  const script = path.join(directory, "workflow.js");
  const statusDir = path.join(directory, "not-opted-in");

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "status-publication-opt-in",
          description: "Process proof that a named-but-missing status directory cannot silently publish nothing"
        };
        return { completed: true };
      `
    );
    const env = isolatedEnvironment(directory);
    delete env.ENSEMBLE_STATUS;
    env.ENSEMBLE_STATUS_DIR = statusDir;

    const result = await runNode([bundledCliPath, script], env);

    // The operator named a directory and it is unusable: exit 2 with the
    // cause, never a successful run that published no observability.
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Configured status directory does not exist or is not a directory/);
    assert.match(result.stderr, /ENSEMBLE_STATUS_DIR/);
    await assert.rejects(() => readdir(statusDir), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("built CLI shuts down cleanly when its status reporter throws", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-status-reporter-estate-"));
  const script = path.join(directory, "workflow.js");
  const statusTarget = path.join(directory, "status-target");

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "throwing-status-reporter",
          description: "Process proof that observability cannot take shutdown down"
        };
        return { completed: true };
      `
    );
    // A real directory the writer cannot write into: publication resolves
    // (the explicit directory exists), every snapshot write fails, and the
    // "[status]" error report is what the preload turns into a throwing
    // reporter — the journey this test exists for.
    await mkdir(statusTarget, { mode: 0o500 });
    const env = isolatedEnvironment(directory);
    delete env.ENSEMBLE_STATUS;
    env.ENSEMBLE_STATUS_DIR = statusTarget;
    const preload = path.resolve("test/fixtures/status/throwing-reporter-preload.mjs");
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim();

    const result = await runNode([bundledCliPath, script], env);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `{"completed":true}\n`);
    assert.equal(withoutSentinelAnnouncement(result.stderr), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("built CLI accepts a comment between meta and defaults", async () => {
  const fixture = await createProcessFixture("commented-defaults");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "commented-defaults",
          description: "Comments may separate the two workflow policy exports"
        };
        // The model policy remains adjacent in meaning even with an explanation.
        export const defaults = {
          codex: { model: "gpt-estate-recorder" }
        };
        return await agent("run after commented defaults", {
          engine: "codex",
          maxAttempts: 1
        });
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"worker-ok"\n`);
    assert.doesNotMatch(result.stderr, /SyntaxError/);
    assert.equal((await fixture.messages()).filter((message) => message.method === "thread/start").length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI executes code after every JavaScript line-comment terminator", async (t) => {
  const terminators = [
    ["lf", "\n"],
    ["lone-cr", "\r"],
    ["crlf", "\r\n"],
    ["line-separator", "\u2028"],
    ["paragraph-separator", "\u2029"]
  ] as const;

  for (const [name, terminator] of terminators) {
    await t.test(name, async () => {
      const fixture = await createProcessFixture(`comment-${name}`);

      try {
        await writeFile(
          fixture.script,
          'export const meta = {' +
            ` name: ${JSON.stringify(`comment-${name}`)},` +
            ' description: "Every JavaScript line terminator ends a line comment"' +
            ' };' +
            `// Defaults follow${terminator}` +
            'export const defaults = { codex: { effort: "low" } };' +
            `return ${JSON.stringify(`${name}-code-ran`)};`
        );

        const result = await fixture.run();

        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, `${JSON.stringify(`${name}-code-ran`)}\n`);
        assert.equal(withoutSentinelAnnouncement(result.stderr), "");
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("built CLI defers awkward valid workflow bodies to V8 without false shape rejection", async () => {
  const fixture = await createProcessFixture("awkward-valid-workflow");

  try {
    await writeFile(
      fixture.script,
      String.raw`
        export const meta = {
          name: "awkward-valid-workflow",
          description: "Valid parser-edge syntax must not resemble a misplaced defaults export"
        };

        async function* syntaxTraps() {
          yield /https?:\/\/[^"'{}[\]]+/u;
          yield /export\s+const\s+defaults\s*=\s*\{/u;
        }

        class Matcher {
          #defaultsLike = "export const defaults = { codex: {} }";
          static parts;
          static {
            this.parts = ["export", /const/u, "defaults"];
          }
          matches(pattern) {
            return pattern.test(this.#defaultsLike);
          }
        }

        const matcher = new Matcher();
        const results = [];
        for await (const pattern of syntaxTraps()) {
          results.push(matcher.matches(pattern));
        }
        const computed = {
          ["export const defaults = {"]: { accepted: true }
        };

        return {
          results,
          staticParts: Matcher.parts.map(String),
          computed: computed?.["export const defaults = {"]?.accepted ?? false,
          division: 81 / 9 / 3
        };
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      results: [false, true],
      staticParts: ["export", "/const/u", "defaults"],
      computed: true,
      division: 3
    });
    assert.doesNotMatch(result.stderr, /defaults.*follow.*meta|SyntaxError/i);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI rejects a tuning flag after the script path and names the pass-through escape", async () => {
  const fixture = await createProcessFixture("misordered-tuning-flag");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "misordered-tuning-flag",
          description: "Known tuning flags retain their meaning or fail at the author boundary"
        };
        return args;
      `
    );

    const result = await fixture.runArgs([fixture.script, "--json-args", '{"value":true}']);

    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--json-args/);
    assert.match(result.stderr, /--/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI propagates removed options from parallel when a sibling succeeds", async () => {
  const fixture = await createProcessFixture("parallel-option-rejection");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "parallel-option-rejection",
          description: "Rejected options escape fan-out when another sibling succeeds"
        };
        return await parallel([
          async () => ({ status: "sibling-ok" }),
          () => agent("removed option", {
            engine: "codex",
            sandbox: "read-only",
            maxAttempts: 1
          })
        ]);
      `
    );

    const result = await fixture.run();

    assert.equal(
      result.code,
      1,
      `expected removed option to fail the process\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const envelope = JSON.parse(result.stdout) as {
      partial: boolean;
      reason: string;
      completed: unknown[];
    };
    assert.equal(envelope.partial, true);
    assert.equal(envelope.reason, "failed");
    assert.ok(Array.isArray(envelope.completed));
    assert.match(result.stderr, /sandbox[\s\S]*removed/i);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI terminalises an abandoned parallel sibling in the sealed archive", async () => {
  const fixture = await createProcessFixture("parallel-abandoned-record");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "parallel-abandoned-record",
          description: "A run timeout abandons siblings while their dispatch records are still writing"
        };
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await parallel([
          ...Array.from({ length: 16 }, (_, index) => () => agent("wait in the recorder", {
            engine: "codex",
            label: "abandoned-sibling-" + index,
            maxAttempts: 1
          }))
        ]);
      `
    );

    const result = await fixture.runArgsWithEnv(
      ["--timeout=20", "--concurrency=codex=1", fixture.script],
      {
        ENSEMBLE_RUN_RECORD: "1",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${delayedAgentWritePreloadPath}`.trim()
      },
      estateProcessHangGuardMs
    );

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Workflow timed out/i);
    const agents = await readArchivedAgentsInSeparateProcess(fixture.dataHome);
    const abandoned = agents.find((agent) => agent.label === "abandoned-sibling-15");
    assert.ok(abandoned, "expected the separately-read archive to contain the abandoned sibling");
    // This is the discriminating assertion: before run-end finalisation, this
    // exact sibling remained in-progress with no attempts after sealing.
    assert.equal(abandoned.status, "abandoned", JSON.stringify(agents.map((agent) => [agent.label, agent.status])));
    assert.deepEqual(abandoned.attempts, []);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI rejects an unrecognised option before opening that worker", async () => {
  const fixture = await createProcessFixture("unknown-option-rejection");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "unknown-option-rejection",
          description: "Typoed agent options fail before thread creation"
        };
        return await agent("must not open a worker", {
          engine: "codex",
          typoedLabel: "mistake",
          maxAttempts: 1
        });
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(result.stderr, /unrecognised agent\(\) option[\s\S]*typoedLabel/i);
    const messages = await fixture.messages();
    assert.equal(messages.filter((message) => message.method === "thread/start").length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI reports an author error without Codex on PATH", async () => {
  // The lazy-substrate journey: validation needs no engine substrate, so an
  // author error must surface cleanly on a machine with no codex binary at
  // all — this is also what CI (no codex in the container) exercises.
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-no-codex-validation-estate-"));
  const emptyBinDirectory = path.join(directory, "bin");
  const script = path.join(directory, "workflow.js");

  try {
    await mkdir(emptyBinDirectory);
    await writeFile(
      script,
      `
        export const meta = {
          name: "unknown-option-without-codex",
          description: "Author errors do not require an unused engine substrate"
        };
        return await agent("must not open a worker", {
          engine: "codex",
          typoedLabel: "mistake",
          maxAttempts: 1
        });
      `
    );
    const env = isolatedEnvironment(directory);
    env.PATH = emptyBinDirectory;

    const result = await runNode([bundledCliPath, script], env);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(result.stderr, /unrecognised agent\(\) option[\s\S]*typoedLabel/i);
    assert.doesNotMatch(result.stderr, /spawn codex ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("built CLI rejects harness-owned invalid values before worker creation with clean diagnostics", async () => {
  const diagnostics: string[] = [];
  for (const scenario of [
    { option: "isolation", value: "wroktree" },
    { option: "timeoutMs", value: 0 },
    { option: "maxAttempts", value: 1.5 }
  ] as const) {
    const fixture = await createProcessFixture(`invalid-${scenario.option}`);

    try {
      await writeFile(
        fixture.script,
        `
          export const meta = {
            name: "invalid-${scenario.option}",
            description: "Harness-owned values fail at the author boundary"
          };
          return await agent("must not open a worker", {
            engine: "codex",
            ${scenario.option}: ${JSON.stringify(scenario.value)}
          });
        `
      );

      const result = await fixture.run();

      assert.equal(result.code, 1);
      assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
      assert.match(result.stderr, new RegExp(scenario.option));
      assert.ok(result.stderr.includes(JSON.stringify(scenario.value)));
      diagnostics.push(result.stderr);
      assert.equal((await fixture.messages()).filter((message) => message.method === "thread/start").length, 0);
    } finally {
      await fixture.cleanup();
    }
  }
  assert.equal(
    diagnostics.every((diagnostic) => !/\n\s+at /.test(diagnostic)),
    true,
    diagnostics.join("\n--- next rejection ---\n")
  );
});

test("built CLI rejects a per-turn timeout above Node's faithful timer limit before worker creation", async () => {
  const fixture = await createProcessFixture("oversized-turn-timeout");
  const timeoutMs = 2_147_483_648;
  const maximumTimeoutMs = 2_147_483_647;

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "oversized-turn-timeout",
          description: "Unfaithful host timer values fail at the author boundary"
        };
        return await agent("must not open a worker", {
          engine: "codex",
          timeoutMs: ${timeoutMs}
        });
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(result.stderr, /timeoutMs/);
    assert.match(result.stderr, new RegExp(String(timeoutMs)));
    assert.match(result.stderr, new RegExp(String(maximumTimeoutMs)));
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.equal((await fixture.messages()).filter((message) => message.method === "thread/start").length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI rejects a per-turn timeout above Node's timer limit on every affected engine", async () => {
  for (const engine of ["codex", "opencode"]) {
    const fixture = await createProcessFixture(`oversized-${engine}-timeout-rejection`);

    try {
      await writeFile(
        fixture.script,
        `
          export const meta = {
            name: "oversized-${engine}-timeout-rejection",
            description: "Unrepresentable turn deadlines fail before worker creation"
          };
          return await agent("must not open a worker", {
            engine: "${engine}",
            timeoutMs: 1000000000000,
            maxAttempts: 1
          });
        `
      );

      const result = await fixture.run();

      assert.equal(result.code, 1);
      assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
      assert.equal(
        withoutSentinelAnnouncement(result.stderr),
        'InvalidAgentOptionValueError: Invalid agent() option "timeoutMs" value 1000000000000; expected a positive integer no greater than 2147483647\n'
      );
      const messages = await fixture.messages();
      assert.equal(messages.filter((message) => message.method === "thread/start").length, 0);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("built CLI keeps a stack for an ordinary workflow-body error", async () => {
  const fixture = await createProcessFixture("ordinary-workflow-error-stack");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "ordinary-workflow-error-stack",
          description: "Workflow bugs retain their debugging trace"
        };
        throw new Error("ordinary workflow bug");
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(withoutSentinelAnnouncement(result.stderr), /^Error: ordinary workflow bug\n\s+at /);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI falls back to an ordinary error's name and message when its stack is empty", async () => {
  const fixture = await createProcessFixture("ordinary-workflow-error-empty-stack");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "ordinary-workflow-error-empty-stack",
          description: "An empty stack cannot erase an ordinary workflow error"
        };
        const error = new Error("stackless error");
        error.stack = "";
        throw error;
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.equal(withoutSentinelAnnouncement(result.stderr), "Error: stackless error\n");
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI does not trust a stack field on a thrown non-Error object", async () => {
  const fixture = await createProcessFixture("ordinary-workflow-non-error-stack");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "ordinary-workflow-non-error-stack",
          description: "Non-Error values cannot masquerade as runtime stacks"
        };
        throw { message: "real problem", stack: "not actually a stack trace" };
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    const diagnostic = withoutSentinelAnnouncement(result.stderr);
    assert.equal(diagnostic, "[object Object]\n");
    assert.doesNotMatch(diagnostic, /not actually a stack trace/);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI still collapses ordinary parallel and pipeline errors to null", async () => {
  const fixture = await createProcessFixture("ordinary-combinator-errors");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "ordinary-combinator-errors",
          description: "The option rejection exemption stays narrower than ordinary script failures"
        };
        const parallelResult = await parallel([
          () => { throw new Error("ordinary parallel bug"); },
          () => agent("parallel sibling", { engine: "codex", maxAttempts: 1 })
        ]);
        const pipelineResult = await pipeline(["bad", "good"], async (_previous, item) => {
          if (item === "bad") {
            throw new Error("ordinary pipeline bug");
          }
          return await agent("pipeline sibling", { engine: "codex", maxAttempts: 1 });
        });
        return { parallelResult, pipelineResult };
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      parallelResult: [null, "worker-ok"],
      pipelineResult: [null, "worker-ok"]
    });
    assert.match(result.stderr, /parallel thunk 0 failed: Error: ordinary parallel bug/);
    assert.match(result.stderr, /pipeline item 0 stage 0 failed: Error: ordinary pipeline bug/);
    const messages = await fixture.messages();
    assert.equal(messages.filter((message) => message.method === "turn/start").length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI logs a parallel thunk error at the author's exact source position", async () => {
  const fixture = await createProcessFixture("parallel-author-frame");

  try {
    await writeFile(
      fixture.script,
      [
        'export const meta = { name: "parallel-author-frame" };',
        "",
        "await parallel([",
        '  () => { throw new Error("PARALLEL_AUTHOR_FRAME"); }',
        "]);",
        "return null;",
        ""
      ].join("\n")
    );

    const result = await fixture.run();

    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stderr.includes(`${fixture.script}:4:`), result.stderr);
    assert.doesNotMatch(result.stderr, /ensemble-workflow-body/, result.stderr);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI propagates a computed removed option from pipeline", async () => {
  const fixture = await createProcessFixture("pipeline-option-rejection", "sandbox");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "pipeline-computed-option-rejection",
          description: "Per-call validation covers options computed from worker output"
        };
        const optionName = await agent("return sandbox", {
          engine: "codex",
          maxAttempts: 1
        });
        return await pipeline(["item"], async () => {
          const options = { engine: "codex", maxAttempts: 1 };
          options[optionName] = "read-only";
          return await agent("computed removed option", options);
        });
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 1);
    assert.equal(
      result.stdout,
      `{"partial":true,"reason":"failed","completed":[{"id":1,"engine":"codex","label":null,"phase":null,"output":"sandbox"}]}\n`
    );
    assert.match(result.stderr, /sandbox[\s\S]*removed/i);
    const messages = await fixture.messages();
    assert.equal(messages.filter((message) => message.method === "turn/start").length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI propagates malformed schemas from both combinators before opening a worker", async () => {
  for (const scenario of [
    {
      name: "parallel",
      body: `return await parallel([
        () => agent("invalid parallel schema", {
          engine: "codex",
          schema: { type: "definitely-not-json-schema" }
        })
      ]);`
    },
    {
      name: "pipeline",
      body: `return await pipeline(["item"], () => agent("invalid pipeline schema", {
        engine: "codex",
        schema: { type: "definitely-not-json-schema" }
      }));`
    }
  ]) {
    const fixture = await createProcessFixture(`${scenario.name}-schema-author-error`);

    try {
      await writeFile(
        fixture.script,
        `
          export const meta = {
            name: "${scenario.name}-schema-author-error",
            description: "Pre-spawn schema errors escape ${scenario.name}"
          };
          ${scenario.body}
        `
      );

      const result = await fixture.run();

      assert.equal(result.code, 1);
      assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
      assert.match(result.stderr, /InvalidAgentSchemaError/);
      assert.equal((await fixture.messages()).filter((message) => message.method === "thread/start").length, 0);
    } finally {
      await fixture.cleanup();
    }
  }
});

test("status artefact sweep removes dead owners without touching a live run or lookalike", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-status-sweep-estate-"));
  const target = path.join(directory, STATUS_FILENAME);
  const decoyProgram = "setInterval(() => {}, 1_000)";
  const deadOwner = spawn(process.execPath, ["-e", ""], { env: hermeticEstateEnvironment() });
  const deadPid = deadOwner.pid;
  assert.ok(deadPid !== undefined);
  await new Promise<void>((resolve, reject) => {
    deadOwner.once("error", reject);
    deadOwner.once("exit", () => resolve());
  });

  const liveOwner = spawn(process.execPath, ["-e", decoyProgram], { env: hermeticEstateEnvironment() });
  const livePid = liveOwner.pid;
  assert.ok(livePid !== undefined);
  await new Promise<void>((resolve, reject) => {
    liveOwner.once("error", reject);
    liveOwner.once("spawn", () => resolve());
  });

  const staleTmp = `${target}.${deadPid}.1.tmp`;
  const staleRemove = `${target}.${deadPid}.00000000-0000-4000-8000-000000000001.remove`;
  const liveTmp = `${target}.${livePid}.1.tmp`;
  const liveRemove = `${target}.${livePid}.00000000-0000-4000-8000-000000000002.remove`;
  const lookalike = `${target}.${deadPid}.1.tmp.backup`;
  const postStartupTmp = `${target}.${deadPid}.2.tmp`;

  try {
    const staleSnapshot = `${JSON.stringify({ runId: "dead-run", pid: deadPid, state: "running" })}\n`;
    const liveSnapshot = `${JSON.stringify({ runId: "live-run", pid: livePid, state: "running" })}\n`;
    await Promise.all([
      writeFile(staleTmp, staleSnapshot),
      writeFile(staleRemove, staleSnapshot),
      writeFile(liveTmp, liveSnapshot),
      writeFile(liveRemove, liveSnapshot),
      writeFile(lookalike, "not a status artefact\n")
    ]);

    const progress = new RunProgress({ runId: "sweeper-run", budget: new UnboundedBudget() });
    const writer = new StatusFileWriter({ progress, dir: directory });
    await waitForFile(target);
    await writeFile(postStartupTmp, staleSnapshot);
    await writer.close();

    const survivors = new Set(await readdir(directory));
    assert.equal(survivors.has(path.basename(staleTmp)), false);
    assert.equal(survivors.has(path.basename(staleRemove)), false);
    assert.equal(survivors.has(path.basename(liveTmp)), true);
    assert.equal(survivors.has(path.basename(liveRemove)), true);
    assert.equal(survivors.has(path.basename(lookalike)), true);
    assert.equal(survivors.has(path.basename(postStartupTmp)), true);
  } finally {
    liveOwner.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      liveOwner.once("exit", () => resolve());
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test("built CLI recovers nested valid JSON through an unparseable balanced region", async () => {
  const fixture = await createProcessFixture("nested-json", `Findings: { see below ["a","b"] }`);
  const recordStore = path.join(path.dirname(fixture.script), "records");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "nested-json-recovery",
          description: "Final CLI consumer sees nested valid JSON in messy worker prose"
        };
        return await agent("return the findings", {
          engine: "codex",
          maxAttempts: 1,
          schema: {
            type: "array",
            items: { type: "string" }
          }
        });
      `
    );

    const result = await fixture.runWithEnv({
      ENSEMBLE_RUN_RECORD: "1",
      ENSEMBLE_RUN_RECORD_DIR: recordStore
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `["a","b"]\n`);
    assert.equal((await loadOnlyAgentRecord(recordStore)).parse_route, "array-fallback");
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI recovers a later answer after prose with an unmatched brace", async () => {
  const fixture = await createProcessFixture(
    "unmatched-brace-json",
    'The template said "use {placeholder" here. Final answer: {"answer":"recovered"}',
  );

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "unmatched-brace-json-recovery",
          description: "Final CLI consumer finds a later answer after realistic unmatched-brace prose"
        };
        return await agent("return the final answer", {
          engine: "codex",
          maxAttempts: 1,
          schema: {
            type: "object",
            required: ["answer"],
            additionalProperties: false,
            properties: {
              answer: { type: "string", enum: ["recovered"] }
            }
          }
        });
      `,
    );

    const result = await fixture.run();

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `{"answer":"recovered"}\n`);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI fails loudly for an unparseable machine config before opening a worker", async () => {
  const fixture = await createProcessFixture("unparseable-machine-config");
  const configHome = path.join(path.dirname(fixture.script), "config");
  const configFile = path.join(configHome, "ensemble", "config.json");

  try {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, `{"schema_version": 1,`);
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "unparseable-machine-config",
          description: "Invalid ambient configuration must stop before worker admission"
        };
        return await agent("must not start", { engine: "codex", maxAttempts: 1 });
      `,
    );

    const result = await fixture.runWithEnv({ XDG_CONFIG_HOME: configHome });

    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /config\.json/);
    assert.match(result.stderr, /parse|JSON/i);
    assert.equal((await fixture.messages()).filter((message) => message.method === "thread/start").length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI names an unknown machine-config key and its source before opening a worker", async () => {
  const fixture = await createProcessFixture("unknown-machine-config-key");
  const configHome = path.join(path.dirname(fixture.script), "config");
  const configFile = path.join(configHome, "ensemble", "config.json");

  try {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify({ schema_version: 1, maxAgent: 2 }));
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "unknown-machine-config-key",
          description: "Unknown ambient configuration must identify the key and file"
        };
        return await agent("must not start", { engine: "codex", maxAttempts: 1 });
      `,
    );

    const result = await fixture.runWithEnv({ XDG_CONFIG_HOME: configHome });

    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /maxAgent/);
    assert.match(result.stderr, /config\.json/);
    assert.equal((await fixture.messages()).filter((message) => message.method === "thread/start").length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI treats an absent machine config as silent and normal", async () => {
  const fixture = await createProcessFixture("absent-machine-config", "config-default-ok");
  const configHome = path.join(path.dirname(fixture.script), "missing-config-home");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "absent-machine-config",
          description: "No ambient config file falls through without a diagnostic"
        };
        return await agent("use built-in settings", { engine: "codex", maxAttempts: 1 });
      `,
    );

    const result = await fixture.runWithEnv({ XDG_CONFIG_HOME: configHome });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"config-default-ok"\n`);
    assert.doesNotMatch(withoutSentinelAnnouncement(result.stderr), /config/i);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI can lift a machine agent ceiling for one run without editing the config file", async () => {
  const fixture = await createProcessFixture("unbounded-machine-ceiling", "unbounded-ok");
  const directory = path.dirname(fixture.script);
  const configHome = path.join(directory, "config");
  const configFile = path.join(configHome, "ensemble", "config.json");
  const recordStore = path.join(directory, "records");
  const configSource = JSON.stringify({ schema_version: 1, agent_ceiling: 1 });

  try {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, configSource);
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "unbounded-machine-ceiling",
          description: "A one-run override restores unbounded cross-worker admission"
        };
        return await parallel([
          () => agent("first barrier worker", { engine: "codex", maxAttempts: 1 }),
          () => agent("second barrier worker", { engine: "codex", maxAttempts: 1 })
        ]);
      `,
    );

    const result = await fixture.runArgsWithEnv(
      ["--agent-ceiling=null", fixture.script],
      {
        XDG_CONFIG_HOME: configHome,
        ENSEMBLE_FAKE_CODEX_BARRIER: "2",
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore,
      },
      5_000,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `["unbounded-ok","unbounded-ok"]\n`);
    assert.equal(
      (await fixture.messages()).filter((message) => message.method === "turn/start").length,
      2,
    );
    assert.equal(await readFile(configFile, "utf8"), configSource);

    const manifestPath = await findOnlyFile(recordStore, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      concurrency: {
        agent_ceiling: { value: number | null; layer: string };
      };
    };
    assert.deepEqual(manifest.concurrency.agent_ceiling, {
      value: null,
      layer: "flag",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("ensemble agent stdout matches an equivalent one-call workflow", async () => {
  const workerOutput = {
    token: "SINGLE_AGENT_EQUIVALENCE",
    count: 7
  };
  const fixture = await createProcessFixture("single-agent-equivalence", JSON.stringify(workerOutput));
  const prompt = "Return the fixed equivalence object.";
  const schema = {
    type: "object",
    required: ["token", "count"],
    additionalProperties: false,
    properties: {
      token: { type: "string", enum: ["SINGLE_AGENT_EQUIVALENCE"] },
      count: { type: "integer", enum: [7] }
    }
  };

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "one-call-script-equivalence",
          description: "Reference path for the single-agent CLI return contract"
        };
        return await agent(${JSON.stringify(prompt)}, {
          engine: "codex",
          maxAttempts: 1,
          schema: ${JSON.stringify(schema)}
        });
      `
    );

    const scripted = await fixture.run();
    const direct = await fixture.runArgs([
      "agent",
      "--engine=codex",
      `--schema=${JSON.stringify(schema)}`,
      prompt
    ]);

    assert.equal(scripted.code, 0, scripted.stderr);
    assert.equal(direct.code, 0, direct.stderr);
    assert.equal(direct.stdout, scripted.stdout);
    assert.deepEqual(JSON.parse(direct.stdout), workerOutput);
  } finally {
    await fixture.cleanup();
  }
});

test("ensemble agent preserves a schema-valid null exactly like an equivalent script", async () => {
  const fixture = await createProcessFixture("single-agent-null-equivalence", "null");
  const prompt = "Return null because there is no finding.";
  const schema = {
    anyOf: [
      {
        type: "object",
        required: ["finding"],
        additionalProperties: false,
        properties: {
          finding: { type: "string" },
        },
      },
      { type: "null" },
    ],
  };

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "one-call-null-equivalence",
          description: "A schema-valid null is a successful agent result"
        };
        return await agent(${JSON.stringify(prompt)}, {
          engine: "codex",
          maxAttempts: 1,
          schema: ${JSON.stringify(schema)}
        });
      `,
    );

    const scripted = await fixture.run();
    const direct = await fixture.runArgs([
      "agent",
      "--engine=codex",
      `--schema=${JSON.stringify(schema)}`,
      prompt,
    ]);

    assert.equal(scripted.code, 0, scripted.stderr);
    assert.equal(scripted.stdout, "null\n");
    assert.equal(direct.code, 0, direct.stderr);
    assert.equal(direct.stdout, scripted.stdout);
  } finally {
    await fixture.cleanup();
  }
});

test("ensemble agent reports retry exhaustion as a failed partial run through the built process", async () => {
  const fixture = await createProcessFixture("single-agent-exhaustion", "not JSON");
  const schema = {
    anyOf: [
      {
        type: "object",
        required: ["finding"],
        additionalProperties: false,
        properties: {
          finding: { type: "string" },
        },
      },
      { type: "null" },
    ],
  };

  try {
    const direct = await fixture.runArgs([
      "agent",
      "--engine=codex",
      `--schema=${JSON.stringify(schema)}`,
      "Return a finding or null.",
    ]);

    assert.equal(direct.code, 1);
    assert.equal(direct.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.doesNotMatch(direct.stdout, /^null$/m);
    assert.match(direct.stderr, /Agent exhausted its attempts without producing a result/);
    assert.equal(
      (await fixture.messages()).filter((message) => message.method === "turn/start").length,
      3,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("ensemble agent gives a supervisor terminal evidence in foreground and redirected-background runs", async () => {
  const schema = {
    type: "object",
    required: ["finding"],
    additionalProperties: false,
    properties: { finding: { type: "string" } }
  };
  const cases: Array<{
    name: string;
    response: string;
    args: string[];
    exitCode: number;
    stdout: string;
    outcome: "complete" | "failed";
    error?: RegExp;
    agentStatus: "complete" | "failed" | null;
  }> = [
    {
      name: "schema-valid null success",
      response: "null",
      args: ["agent", "--engine=codex", `--schema=${JSON.stringify({ type: "null" })}`, "return no finding"],
      exitCode: 0,
      stdout: "null\n",
      outcome: "complete",
      agentStatus: "complete"
    },
    {
      // This is deliberately a policy-rejected pre-dispatch case, rather
      // than a reproduction of the intermittent incident. Its discriminators
      // are the fail-closed diagnostic and the absent agent record below;
      // exit status and stdout only establish the supervisor-facing terminal
      // surfaces for that known rejection.
      name: "pre-dispatch strip rejection",
      response: "unused",
      args: ["agent", "--engine=opencode", "--strip=skills", "must not dispatch"],
      exitCode: 1,
      stdout: '{"partial":true,"reason":"failed","completed":[]}\n',
      outcome: "failed",
      error: /The worker was not dispatched/,
      agentStatus: null
    },
    {
      name: "worker failure",
      response: "not JSON",
      args: ["agent", "--engine=codex", `--schema=${JSON.stringify(schema)}`, "return a finding"],
      exitCode: 1,
      stdout: '{"partial":true,"reason":"failed","completed":[]}\n',
      outcome: "failed",
      error: /Agent exhausted its attempts without producing a result/,
      agentStatus: "failed"
    }
  ];

  for (const shape of ["foreground", "redirected-background"] as const) {
    for (const terminal of cases) {
      const fixture = await createProcessFixture(
        `single-agent-supervisor-${shape}-${terminal.name.replaceAll(" ", "-")}`,
        terminal.response
      );
      try {
        const result =
          shape === "foreground"
            ? await fixture.runArgsWithEnv(terminal.args, { ENSEMBLE_RUN_RECORD: "1" })
            : await fixture.runRedirectedBackgroundArgs(terminal.args, { ENSEMBLE_RUN_RECORD: "1" });

        assert.equal(result.code, terminal.exitCode, `${shape} ${terminal.name}: ${result.stderr}`);
        assert.equal(result.stdout, terminal.stdout, `${shape} ${terminal.name}: ${result.stderr}`);
        if (terminal.error !== undefined) {
          assert.match(result.stderr, terminal.error, `${shape} ${terminal.name}`);
        }
        const announced = result.stderr.match(/\[sentinel\] will write (\S+) when the run ends/);
        assert.ok(announced, `${shape} ${terminal.name}: sentinel path must be announced\n${result.stderr}`);
        const runDirectory = path.dirname(announced[1]!);
        const sentinel = JSON.parse(await readFile(announced[1]!, "utf8")) as {
          outcome: string;
          exit_code: number;
        };
        assert.equal(sentinel.outcome, terminal.outcome, `${shape} ${terminal.name}`);
        assert.equal(sentinel.exit_code, terminal.exitCode, `${shape} ${terminal.name}`);

        const resultRecord = JSON.parse(await readFile(path.join(runDirectory, "result.json"), "utf8")) as {
          status: string;
          exit_code: number;
          value: unknown;
        };
        assert.equal(resultRecord.status, terminal.outcome, `${shape} ${terminal.name}`);
        assert.equal(resultRecord.exit_code, terminal.exitCode, `${shape} ${terminal.name}`);
        assert.deepEqual(resultRecord.value, JSON.parse(terminal.stdout), `${shape} ${terminal.name}`);

        const agentPaths = (await readdir(runDirectory, { recursive: true })).filter((entry) => path.basename(entry) === "agent.json");
        assert.equal(agentPaths.length, terminal.agentStatus === null ? 0 : 1, `${shape} ${terminal.name}`);
        if (terminal.agentStatus !== null) {
          const agent = JSON.parse(await readFile(path.join(runDirectory, agentPaths[0]!), "utf8")) as { status: string };
          assert.equal(agent.status, terminal.agentStatus, `${shape} ${terminal.name}`);
        }
      } finally {
        await fixture.cleanup();
      }
    }
  }
});

test("built CLI retries a scoped overload and archives the provider diagnostic", async () => {
  const fixture = await createProcessFixture("scoped-overload-retry", "recovered");
  const recordStore = path.join(path.dirname(fixture.script), "records");
  const overload = {
    error: {
      message: "Upstream capacity is temporarily exhausted; invalid_json_schema is not the cause",
      additionalDetails: "gateway detail: server_is_overloaded",
      codexErrorInfo: "serverOverloaded"
    },
    willRetry: false
  };

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "scoped-overload-retry",
          description: "Retry an in-band provider overload"
        };
        return await agent("return recovered", {
          engine: "codex",
          maxAttempts: 2
        });
      `
    );

    const result = await fixture.runWithEnv({
      ENSEMBLE_FAKE_CODEX_ERROR_SEQUENCE: JSON.stringify([overload]),
      ENSEMBLE_RUN_RECORD: "1",
      ENSEMBLE_RUN_RECORD_DIR: recordStore
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"recovered"\n`);
    assert.equal(
      (await fixture.messages()).filter((message) => message.method === "turn/start").length,
      2
    );

    const agent = await loadOnlyAgentRecord(recordStore);
    assert.equal(agent.attempts.length, 2);
    assert.equal(agent.attempts[0]?.failure?.kind, "AppServerOverloadedError");
    assert.match(agent.attempts[0]?.failure?.message ?? "", /serverOverloaded/);
    assert.match(agent.attempts[0]?.failure?.message ?? "", /Upstream capacity is temporarily exhausted/);
    assert.match(agent.attempts[0]?.failure?.message ?? "", /gateway detail: server_is_overloaded/);
    assert.deepEqual(agent.attempts[0]?.app_server_diagnostic, {
      code: "serverOverloaded",
      message: "serverOverloaded: Upstream capacity is temporarily exhausted; invalid_json_schema is not the cause: gateway detail: server_is_overloaded",
      payload: JSON.stringify({ ...overload, threadId: "thread-1", turnId: "turn-1" })
    });
    assert.equal(agent.attempts[1]?.status, "complete");
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI records observed request and notification diagnostics, but not an unobserved timeout cause", async () => {
  const cases = [
    {
      name: "request",
      scriptOptions: "",
      env: {
        ENSEMBLE_FAKE_CODEX_TURN_START_ERROR: JSON.stringify({
          code: -32603,
          message: "upstream refused the turn; invalid_json_schema is not the cause",
          data: { detail: "real request cause" }
        })
      },
      stderr: /-32603.*upstream refused the turn.*real request cause/s,
      diagnostic: {
        code: -32603,
        message: "upstream refused the turn; invalid_json_schema is not the cause",
        payload: '{"detail":"real request cause"}'
      }
    },
    {
      name: "notification",
      scriptOptions: "",
      env: {
        ENSEMBLE_FAKE_CODEX_ERROR_SEQUENCE: JSON.stringify([
          { error: { message: "notification cause", codexErrorInfo: "serverOverloaded" }, willRetry: false }
        ])
      },
      stderr: /notification cause/,
      diagnostic: {
        code: "serverOverloaded",
        message: "serverOverloaded: notification cause",
        payload: /notification cause/
      }
    },
    {
      name: "timeout",
      scriptOptions: ", timeoutMs: 50",
      env: { ENSEMBLE_FAKE_CODEX_STALL_AFTER_TURN_START: "1" },
      stderr: /timed out after 50ms/,
      diagnostic: null
    }
  ] as const;

  for (const entry of cases) {
    const fixture = await createProcessFixture(`diagnostic-${entry.name}`);
    const recordStore = path.join(path.dirname(fixture.script), "records");
    try {
      await writeFile(
        fixture.script,
        `export const meta = { name: "diagnostic-${entry.name}" }; return await agent("fail", { engine: "codex", maxAttempts: 1${entry.scriptOptions} });`
      );
      const result = await fixture.runWithEnv({
        ...entry.env,
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore
      });
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, entry.stderr);

      const diagnostic = (await loadOnlyAgentRecord(recordStore)).attempts[0]?.app_server_diagnostic;
      if (entry.diagnostic === null) {
        assert.equal(diagnostic, null);
      } else {
        assert.ok(diagnostic);
        assert.equal(diagnostic.code, entry.diagnostic.code);
        assert.equal(diagnostic.message, entry.diagnostic.message);
        if (typeof entry.diagnostic.payload === "string") {
          assert.equal(diagnostic.payload, entry.diagnostic.payload);
        } else {
          assert.match(diagnostic.payload, entry.diagnostic.payload);
        }
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test("built CLI interrupts an abandoned turn before replacement without awaiting a response", async () => {
  const overloadSequence = [
    [
      {
        method: "item/agentMessage/delta",
        params: { delta: "partial before overload", itemId: "agent-message-turn-1" }
      },
      {
        method: "error",
        params: {
          error: { message: "capacity exhausted", codexErrorInfo: "serverOverloaded" },
          willRetry: false
        }
      }
    ]
  ];

  for (const interruptResponse of ["accepted", "rejected", "withheld"] as const) {
    const fixture = await createProcessFixture(`interrupt-before-replacement-${interruptResponse}`, "recovered");
    const recordStore = path.join(path.dirname(fixture.script), "records");
    try {
      await writeFile(
        fixture.script,
        `
          export const meta = {
            name: "interrupt-before-replacement",
            description: "Record abandoned-turn wire ordering"
          };
          return await agent("return recovered", {
            engine: "codex",
            maxAttempts: 2
          });
        `
      );

      const startedAt = performance.now();
      const result = await fixture.runWithEnv({
        ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify(overloadSequence),
        ENSEMBLE_FAKE_CODEX_REJECT_INTERRUPT: interruptResponse === "rejected" ? "1" : "0",
        ENSEMBLE_FAKE_CODEX_WITHHOLD_INTERRUPT_RESPONSE: interruptResponse === "withheld" ? "1" : "0",
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore
      });
      const elapsedMs = performance.now() - startedAt;

      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, `"recovered"\n`);
      const overloadPayloadOptOut = (await fixture.validations()).find(
        (validation) => validation.outcome === "allowed-malformed"
      );
      assert.equal(overloadPayloadOptOut, undefined, "the overload payload must validate without its itemId opt-out");
      if (interruptResponse === "withheld") {
        assert.ok(
          elapsedMs < 10_000,
          `replacement took ${elapsedMs.toFixed(0)}ms with the interrupt response withheld; it must not await the 30s request timeout`
        );
      }
      const messages = await fixture.messages();
      assert.deepEqual(
        messages.map((message) => message.method),
        ["initialize", "initialized", "thread/start", "turn/start", "turn/interrupt", "thread/start", "turn/start"]
      );
      const interrupt = messages.find((message) => message.method === "turn/interrupt");
      assert.deepEqual(interrupt?.params, { threadId: "thread-1", turnId: "turn-1" });

      const agent = await loadOnlyAgentRecord(recordStore);
      assert.equal(agent.attempts.length, 2);
      assert.equal(agent.attempts[0]?.raw_output, "partial before overload");
      assert.equal(agent.attempts[1]?.status, "complete");
    } finally {
      await fixture.cleanup();
    }
  }
});

test("built CLI interrupts a turn that times out before any turn notification", { timeout: 45_000 }, async () => {
  const fixture = await createProcessFixture("interrupt-timeout-before-notification");
  const recordStore = path.join(path.dirname(fixture.script), "records");
  const timeoutControl = path.join(path.dirname(fixture.script), "turn-timeout-control");
  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "interrupt-timeout-before-notification",
          description: "Interrupt a started turn when its local deadline expires"
        };
        return await agent("time out before a notification", {
          engine: "codex",
          maxAttempts: 1,
          timeoutMs: 30001
        });
      `
    );

    const result = await fixture.runNodeArgsWithEnv(
      ["--import", turnTimeoutAcceleratorPath, bundledCliPath, fixture.script],
      {
        ENSEMBLE_FAKE_CODEX_STALL_AFTER_TURN_START: "1",
        ENSEMBLE_TURN_TIMEOUT_CONTROL: timeoutControl,
        ENSEMBLE_TURN_TIMEOUT_MS: "30001",
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore
      },
      45_000,
    );

    assert.equal(result.code, 1, `turn timeout did not reject before the test kill switch\n${result.stderr}`);
    assert.match(result.stderr, /TurnTimeoutError/);
    const messages = await fixture.messages();
    assert.deepEqual(
      messages.map((message) => message.method),
      ["initialize", "initialized", "thread/start", "turn/start", "turn/interrupt"]
    );
    assert.deepEqual(messages.at(-1)?.params, { threadId: "thread-1", turnId: "turn-1" });
    assert.equal((await loadOnlyAgentRecord(recordStore)).status, "timed-out");
  } finally {
    await fixture.cleanup();
  }
});

// The 20 s cap is the mutation backstop, not a fit to the ~4.4 s this test
// takes when it passes: under mutation the deadline never fires, and this cap
// is what converts that hang into a failure. Trimming it toward the observed
// runtime removes the only thing that makes the mutation legible, and leaves
// no margin on a loaded machine. The fixture's own timings are scaled with it
// (ratios unchanged, deadline:kill-switch still 1:5).
test("built bundle times out an output-silent worker while its tool remains active", { timeout: 20_000 }, async () => {
  // Manufactured-condition exception: a live engine cannot be made to emit
  // tool progress while withholding all further worker output on cue. The
  // recording app-server fixture supplies exactly that condition. The direct
  // transport leg observes client ingress; the following process leg drives
  // the shipped bundle and proves terminalisation and archival behaviour.
  const fixture = await createProcessFixture("tool-active-output-silent");
  const recordStore = path.join(path.dirname(fixture.script), "records");
  try {
    let timeoutAt: number | null = null;
    let resolveProgressAfterTimeout: (() => void) | undefined;
    const progressAfterTimeout = new Promise<void>((resolve) => {
      resolveProgressAfterTimeout = resolve;
    });
    const transport = await CodexAppServerTransport.start({
      cwd: process.cwd(),
      codexBin: fixture.codexBin,
      workerEnv: {
        ENSEMBLE_CODEX_SCHEMA_CLI: fixture.schemaCli,
        ENSEMBLE_FAKE_CODEX_TOOL_ACTIVE_OUTPUT_SILENT: "1",
        ENSEMBLE_FAKE_CODEX_TOOL_PROGRESS_INTERVAL_MS: "60"
      },
      requestTimeoutMs: 1_000,
      startupHandshakeTimeoutMs: 1_000,
      clientName: "ensemble-process-estate",
      clientVersion: "0.0.0",
      onEvent: (event) => {
        if (event.method === "item/mcpToolCall/progress" && timeoutAt !== null && event.receivedAt > timeoutAt) {
          resolveProgressAfterTimeout?.();
        }
      }
    });
    try {
      const threadId = await transport.openThread({});
      await assert.rejects(
        () => transport.runTurn(threadId, "observe tool traffic after timeout", { timeoutMs: 450 }),
        TurnTimeoutError
      );
      timeoutAt = Date.now();
      await progressAfterTimeout;
    } finally {
      await transport.close();
    }

    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "tool-active-output-silent-deadline",
          description: "Bound an output-silent turn despite app-server tool progress"
        };
        return await agent("wait for a tool that never returns output", {
          engine: "codex",
          maxAttempts: 1,
          timeoutMs: 3_000
        });
      `
    );

    const result = await fixture.runArgsWithEnv(
      [fixture.script],
      {
        ENSEMBLE_FAKE_CODEX_TOOL_ACTIVE_OUTPUT_SILENT: "1",
        ENSEMBLE_FAKE_CODEX_TOOL_PROGRESS_INTERVAL_MS: "60",
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore
      },
      15_000
    );

    assert.equal(result.code, 1, `tool-active run must fail when its deadline fires\n${result.stderr}`);
    assert.match(result.stderr, /TurnTimeoutError/);
    const messages = await fixture.messages();
    assert.deepEqual(messages.at(-1)?.params, { threadId: "thread-1", turnId: "turn-1" });
    assert.equal(messages.at(-1)?.method, "turn/interrupt");
    const agent = await loadOnlyAgentRecord(recordStore);
    assert.equal(agent.status, "timed-out");
    assert.equal(agent.attempts[0]?.raw_output, "partial before ongoing tool activity");
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI keeps a non-overload notification terminal and renders its diagnostic", async () => {
  const fixture = await createProcessFixture("scoped-terminal-error");
  const recordStore = path.join(path.dirname(fixture.script), "records");
  const terminal = {
    error: {
      message: "Provider credentials were rejected",
      additionalDetails: "server_is_overloaded appeared only in unstructured detail",
      codexErrorInfo: "unauthorized"
    },
    willRetry: false
  };

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "scoped-terminal-error",
          description: "Surface a terminal in-band provider error"
        };
        return await agent("must fail immediately", {
          engine: "codex",
          maxAttempts: 3
        });
      `
    );

    const result = await fixture.runWithEnv({
      ENSEMBLE_FAKE_CODEX_ERROR_SEQUENCE: JSON.stringify([terminal]),
      ENSEMBLE_RUN_RECORD: "1",
      ENSEMBLE_RUN_RECORD_DIR: recordStore
    });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(result.stderr, /unauthorized/);
    assert.match(result.stderr, /Provider credentials were rejected/);
    assert.equal(
      (await fixture.messages()).filter((message) => message.method === "turn/start").length,
      1
    );

    const agent = await loadOnlyAgentRecord(recordStore);
    assert.equal(agent.attempts.length, 1);
    assert.equal(agent.attempts[0]?.failure?.kind, "AppServerRequestError");
    assert.match(agent.attempts[0]?.failure?.message ?? "", /unauthorized/);
    assert.match(agent.attempts[0]?.failure?.message ?? "", /Provider credentials were rejected/);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI throws a scoped overload after the bounded attempts", async () => {
  const fixture = await createProcessFixture("scoped-overload-exhaustion");
  const recordStore = path.join(path.dirname(fixture.script), "records");
  const overload = {
    error: {
      message: "Upstream remained overloaded",
      additionalDetails: null,
      codexErrorInfo: "serverOverloaded"
    },
    willRetry: false
  };

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "scoped-overload-exhaustion",
          description: "Bound repeated in-band provider overloads"
        };
        return await agent("must throw after two overloads", {
          engine: "codex",
          maxAttempts: 2,
          schema: {
            type: "object",
            required: ["ok"],
            additionalProperties: false,
            properties: {
              ok: { type: "boolean" }
            }
          }
        });
      `
    );

    const result = await fixture.runWithEnv({
      ENSEMBLE_FAKE_CODEX_ERROR_SEQUENCE: JSON.stringify([overload, overload]),
      ENSEMBLE_RUN_RECORD: "1",
      ENSEMBLE_RUN_RECORD_DIR: recordStore
    });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(result.stderr, /AppServerOverloadedError/);
    assert.match(result.stderr, /serverOverloaded/);
    assert.match(result.stderr, /Upstream remained overloaded/);
    assert.equal(
      (await fixture.messages()).filter((message) => message.method === "turn/start").length,
      2
    );

    const agent = await loadOnlyAgentRecord(recordStore);
    assert.equal(agent.attempts.length, 2);
    for (const attempt of agent.attempts) {
      assert.equal(attempt.failure?.kind, "AppServerOverloadedError");
      assert.match(attempt.failure?.message ?? "", /serverOverloaded/);
      assert.match(attempt.failure?.message ?? "", /Upstream remained overloaded/);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI lets the app-server complete a turn when its notification says it will retry", async () => {
  const fixture = await createProcessFixture("scoped-internal-retry", "internally-recovered");
  const recordStore = path.join(path.dirname(fixture.script), "records");
  const overload = {
    error: {
      message: "The app-server is retrying this turn",
      additionalDetails: null,
      codexErrorInfo: "serverOverloaded"
    },
    willRetry: true
  };
  const internalRetrySequence = [
    { method: "error", params: overload },
    { method: "error", params: overload },
  ];

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "scoped-internal-retry",
          description: "Do not multiply an app-server-owned retry"
        };
        return await agent("let the current turn recover", {
          engine: "codex",
          maxAttempts: 2
        });
      `
    );

    const result = await fixture.runArgsWithEnv(
      [fixture.script],
      {
        ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify([internalRetrySequence]),
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore
      },
      estateProcessHangGuardMs,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"internally-recovered"\n`);
    assert.equal(
      (await fixture.messages()).filter((message) => message.method === "turn/start").length,
      1
    );

    const agent = await loadOnlyAgentRecord(recordStore);
    assert.equal(agent.attempts.length, 1);
    assert.equal(agent.attempts[0]?.status, "complete");
    assert.equal(agent.attempts[0]?.failure, null);
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI rejects a broken app-server retry promise with its last diagnostic", async () => {
  const fixture = await createProcessFixture("broken-internal-retry");
  const recordStore = path.join(path.dirname(fixture.script), "records");
  const brokenPromise = {
    error: {
      message: "BROKEN_PROMISE_DIAGNOSTIC_91",
      additionalDetails: "provider retry stream went quiet",
      codexErrorInfo: "serverOverloaded"
    },
    willRetry: true
  };
  const brokenSequence = Array.from(
    { length: 6 },
    () => ({ method: "error", params: brokenPromise }),
  );

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "broken-internal-retry",
          description: "Bound an app-server retry promise by its notifications"
        };
        return await agent("reject instead of waiting forever", {
          engine: "codex",
          maxAttempts: 2
        });
      `
    );

    const result = await fixture.runArgsWithEnv(
      [fixture.script],
      {
        ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify([
          brokenSequence,
          brokenSequence
        ]),
        ENSEMBLE_FAKE_CODEX_STALL_AFTER_NOTIFICATION_SEQUENCE: "1",
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore
      },
      estateProcessHangGuardMs,
    );

    assert.equal(result.code, 1, `guard did not reject before the test kill switch\n${result.stderr}`);
    assert.match(result.stderr, /AppServerRetryPromiseBrokenError/);
    assert.match(result.stderr, /BROKEN_PROMISE_DIAGNOSTIC_91/);
    assert.equal(
      (await fixture.messages()).filter((message) => message.method === "turn/start").length,
      2
    );

    const agent = await loadOnlyAgentRecord(recordStore);
    assert.equal(agent.attempts.length, 2);
    for (const attempt of agent.attempts) {
      assert.equal(attempt.failure?.kind, "AppServerRetryPromiseBrokenError");
      assert.match(attempt.failure?.message ?? "", /serverOverloaded/);
      assert.match(attempt.failure?.message ?? "", /BROKEN_PROMISE_DIAGNOSTIC_91/);
      assert.match(attempt.failure?.message ?? "", /provider retry stream went quiet/);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI resets the app-server retry-promise count on turn progress", async () => {
  const fixture = await createProcessFixture("internal-retry-progress", "progress-recovered");
  const retrying = {
    error: {
      message: "Retrying after partial progress",
      additionalDetails: null,
      codexErrorInfo: "serverOverloaded"
    },
    willRetry: true
  };
  const progressSequence = Array.from({ length: 6 }, (_, index) => [
    { method: "error", params: retrying },
    {
      method: "item/agentMessage/delta",
      params: {
        delta: `progress-${index}`,
        itemId: "progress-message"
      }
    }
  ]).flat();

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "internal-retry-progress",
          description: "Reset retry promises when the live turn progresses"
        };
        return await agent("survive retries separated by progress", {
          engine: "codex",
          maxAttempts: 1
        });
      `
    );

    const result = await fixture.runArgsWithEnv(
      [fixture.script],
      {
        ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify([progressSequence])
      },
      estateProcessHangGuardMs,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"progress-recovered"\n`);
    assert.equal(
      (await fixture.messages()).filter((message) => message.method === "turn/start").length,
      1
    );
  } finally {
    await fixture.cleanup();
  }
});

test("built CLI rejects a live turn when its thread enters systemError", async () => {
  const fixture = await createProcessFixture("thread-system-error");
  const recordStore = path.join(path.dirname(fixture.script), "records");
  const systemErrorSequence = [
    {
      method: "thread/status/changed",
      params: {
        status: { type: "systemError" }
      }
    }
  ];

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "thread-system-error",
          description: "Reject a live turn when its thread dies"
        };
        return await agent("must not wait on a dead thread", {
          engine: "codex",
          maxAttempts: 2
        });
      `
    );

    const result = await fixture.runArgsWithEnv(
      [fixture.script],
      {
        ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify([systemErrorSequence]),
        ENSEMBLE_FAKE_CODEX_STALL_AFTER_NOTIFICATION_SEQUENCE: "1",
        ENSEMBLE_RUN_RECORD: "1",
        ENSEMBLE_RUN_RECORD_DIR: recordStore
      },
      estateProcessHangGuardMs,
    );

    assert.equal(result.code, 1, `systemError did not reject before the test kill switch\n${result.stderr}`);
    assert.match(result.stderr, /AppServerSystemError/);
    assert.match(result.stderr, /systemError without a diagnostic/);
    const messages = await fixture.messages();
    assert.equal(messages.filter((message) => message.method === "turn/start").length, 1);
    assert.deepEqual(
      messages.find((message) => message.method === "turn/interrupt")?.params,
      { threadId: "thread-1", turnId: "turn-1" }
    );

    const agent = await loadOnlyAgentRecord(recordStore);
    assert.equal(agent.attempts.length, 1);
    for (const attempt of agent.attempts) {
      assert.equal(attempt.failure?.kind, "AppServerSystemError");
      assert.match(attempt.failure?.message ?? "", /systemError without a diagnostic/);
    }
  } finally {
    await fixture.cleanup();
  }
});

interface RecordedMessage {
  method?: string;
  params?: {
    sandbox?: unknown;
    sandboxPolicy?: unknown;
    input?: Array<{ text?: unknown }>;
    threadId?: unknown;
    turnId?: unknown;
  };
}

interface RecordedAgent {
  status: "in-progress" | "complete" | "failed" | "timed-out" | "interrupted" | "abandoned";
  parse_route: "direct" | "object-fallback" | "array-fallback" | null;
  attempts: Array<{
    status: "complete" | "failed";
    failure: { kind: string; message: string } | null;
    app_server_diagnostic: { code: number | string | null; message: string; payload: string } | null;
    raw_output: string | null;
  }>;
}

interface ProcessFixture {
  script: string;
  dataHome: string;
  codexBin: string;
  schemaCli: string;
  run: () => Promise<{ code: number | null; stdout: string; stderr: string }>;
  runArgs: (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  runArgsWithEnv: (
    args: string[],
    overrides: NodeJS.ProcessEnv,
    timeoutMs?: number,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  runRedirectedBackgroundArgs: (
    args: string[],
    overrides: NodeJS.ProcessEnv,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  runNodeArgsWithEnv: (
    args: string[],
    overrides: NodeJS.ProcessEnv,
    timeoutMs?: number,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  runWithEnv: (overrides: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  messages: () => Promise<RecordedMessage[]>;
  validations: () => Promise<ValidationRecord[]>;
  cleanup: () => Promise<void>;
}

interface ValidationRecord {
  outcome: "valid" | "allowed-malformed";
  reason?: string;
  schemaPath: string;
}

async function createProcessFixture(name: string, response = "worker-ok"): Promise<ProcessFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), `ensemble-${name}-estate-`));
  const binDirectory = path.join(directory, "bin");
  const fakeCodex = path.join(binDirectory, "codex");
  const capturePath = path.join(directory, "codex-input.jsonl");
  const validationCapturePath = path.join(directory, "codex-validation.jsonl");
  const script = path.join(directory, "workflow.js");
  await mkdir(binDirectory);
  await writeFile(capturePath, "");
  await writeFile(validationCapturePath, "");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node\nimport ${JSON.stringify(path.resolve("test/fixtures/codex/recording-app-server.mjs"))};\n`
  );
  await chmod(fakeCodex, 0o755);

  const env = isolatedEnvironment(directory);
  env.PATH = `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`;
  env.ENSEMBLE_FAKE_CODEX_CAPTURE = capturePath;
  env.ENSEMBLE_FAKE_CODEX_VALIDATION_CAPTURE = validationCapturePath;
  env.ENSEMBLE_FAKE_CODEX_RESPONSE = response;
  const schemaCli = await executablePath("codex");
  env.ENSEMBLE_CODEX_SCHEMA_CLI = schemaCli;

  return {
    script,
    dataHome: path.join(directory, "data"),
    codexBin: fakeCodex,
    schemaCli,
    run: () => runNode([bundledCliPath, script], env),
    runArgs: (args) => runNode([bundledCliPath, ...args], env),
    runArgsWithEnv: (args, overrides, timeoutMs) =>
      runNode([bundledCliPath, ...args], { ...env, ...overrides }, timeoutMs),
    runRedirectedBackgroundArgs: async (args, overrides) => {
      const stdoutPath = path.join(directory, "redirected-stdout.txt");
      const stderrPath = path.join(directory, "redirected-stderr.txt");
      const result = await runProcess(
        "bash",
        [
          "-c",
          'node_path=$1; cli_path=$2; stdout_path=$3; stderr_path=$4; shift 4; "$node_path" "$cli_path" "$@" >"$stdout_path" 2>"$stderr_path" & child=$!; wait "$child"',
          "ensemble-redirected-background",
          process.execPath,
          bundledCliPath,
          stdoutPath,
          stderrPath,
          ...args
        ],
        { ...env, ...overrides }
      );
      return {
        code: result.code,
        stdout: await readFile(stdoutPath, "utf8"),
        stderr: await readFile(stderrPath, "utf8")
      };
    },
    runNodeArgsWithEnv: (args, overrides, timeoutMs) =>
      runNode(args, { ...env, ...overrides }, timeoutMs),
    runWithEnv: (overrides) => runNode([bundledCliPath, script], { ...env, ...overrides }),
    messages: async () =>
      (await readFile(capturePath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedMessage),
    validations: async () =>
      (await readFile(validationCapturePath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ValidationRecord),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function readArchivedAgentsInSeparateProcess(dataHome: string): Promise<Array<{ label: string | null; status: string; attempts: unknown[] }>> {
  const result = await runNode([path.resolve("test/consumers/read-archived-agents.mjs"), dataHome]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as Array<{ label: string | null; status: string; attempts: unknown[] }>;
}

function isolatedEnvironment(directory: string): NodeJS.ProcessEnv {
  // Declared overrides only — the hermetic base in runProcess supplies the
  // rest of the environment with every ambient ENSEMBLE_ key stripped.
  return {
    ENSEMBLE_RUN_RECORD: "0",
    ENSEMBLE_STATUS: "0",
    XDG_DATA_HOME: path.join(directory, "data"),
    // Isolation here is by data home: the suite runner's own per-run store
    // redirection (a named pass-through in the hermetic base) would
    // silently win over it, so remove it explicitly.
    ENSEMBLE_RUN_RECORD_DIR: undefined
  };
}

async function loadOnlyAgentRecord(recordStore: string): Promise<RecordedAgent> {
  const agentPath = await findOnlyFile(recordStore, "agent.json");
  return JSON.parse(await readFile(agentPath, "utf8")) as RecordedAgent;
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await readFile(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`file never appeared: ${file}`);
}
