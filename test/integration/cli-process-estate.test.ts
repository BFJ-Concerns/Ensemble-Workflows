import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

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

    const env: NodeJS.ProcessEnv = { ...process.env, XDG_DATA_HOME: dataHome };
    delete env.ENSEMBLE_RUN_RECORD;
    delete env.ENSEMBLE_RUN_RECORD_DIR;

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
    const result = await runNode([cliPath, script], {
      ...process.env,
      ENSEMBLE_RUN_RECORD: "off"
    });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, `{"partial":true,"reason":"failed","completed":[]}\n`);
    assert.match(result.stderr, /RemovedAgentOptionError: agent\(\) option "sandbox" was removed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("built CLI leaves a missing status namespace absent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-status-estate-"));
  const script = path.join(directory, "workflow.js");
  const statusDir = path.join(directory, "not-opted-in");

  try {
    await writeFile(
      script,
      `
        export const meta = {
          name: "status-publication-opt-in",
          description: "Filesystem proof that disabled publication stays invisible"
        };
        return { completed: true };
      `
    );
    const env = isolatedEnvironment(directory);
    delete env.ENSEMBLE_STATUS;
    env.ENSEMBLE_STATUS_DIR = statusDir;

    const result = await runNode([bundledCliPath, script], env);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `{"completed":true}\n`);
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
    await writeFile(statusTarget, "not a directory\n");
    const env = isolatedEnvironment(directory);
    delete env.ENSEMBLE_STATUS;
    env.ENSEMBLE_STATUS_DIR = statusTarget;
    const preload = path.resolve("test/fixtures/status/throwing-reporter-preload.mjs");
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim();

    const result = await runNode([bundledCliPath, script], env);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `{"completed":true}\n`);
    assert.equal(result.stderr, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
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

test("built CLI recovers nested valid JSON through an unparseable balanced region", async () => {
  const fixture = await createProcessFixture("nested-json", `Findings: { see below ["a","b"] }`);

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

    const result = await fixture.run();

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `["a","b"]\n`);
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
    assert.doesNotMatch(result.stderr, /config/i);
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

interface RecordedMessage {
  method?: string;
  params?: {
    sandbox?: unknown;
    sandboxPolicy?: unknown;
  };
}

interface ProcessFixture {
  script: string;
  run: () => Promise<{ code: number | null; stdout: string; stderr: string }>;
  runArgs: (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  runArgsWithEnv: (
    args: string[],
    overrides: NodeJS.ProcessEnv,
    timeoutMs?: number,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  runWithEnv: (overrides: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  messages: () => Promise<RecordedMessage[]>;
  cleanup: () => Promise<void>;
}

async function createProcessFixture(name: string, response = "worker-ok"): Promise<ProcessFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), `ensemble-${name}-estate-`));
  const binDirectory = path.join(directory, "bin");
  const fakeCodex = path.join(binDirectory, "codex");
  const capturePath = path.join(directory, "codex-input.jsonl");
  const script = path.join(directory, "workflow.js");
  await mkdir(binDirectory);
  await writeFile(capturePath, "");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node\nimport ${JSON.stringify(path.resolve("test/fixtures/codex/recording-app-server.mjs"))};\n`
  );
  await chmod(fakeCodex, 0o755);

  const env = isolatedEnvironment(directory);
  env.PATH = `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`;
  env.ENSEMBLE_FAKE_CODEX_CAPTURE = capturePath;
  env.ENSEMBLE_FAKE_CODEX_RESPONSE = response;

  return {
    script,
    run: () => runNode([bundledCliPath, script], env),
    runArgs: (args) => runNode([bundledCliPath, ...args], env),
    runArgsWithEnv: (args, overrides, timeoutMs) =>
      runNode([bundledCliPath, ...args], { ...env, ...overrides }, timeoutMs),
    runWithEnv: (overrides) => runNode([bundledCliPath, script], { ...env, ...overrides }),
    messages: async () =>
      (await readFile(capturePath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedMessage),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

function isolatedEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ENSEMBLE_RUN_RECORD: "0",
    ENSEMBLE_STATUS: "0",
    XDG_DATA_HOME: path.join(directory, "data")
  };
}

async function findOnlyFile(root: string, basename: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const matches = entries.filter((entry) => path.basename(entry) === basename);
  assert.equal(matches.length, 1, `expected one ${basename}, found ${matches.length}`);
  return path.join(root, matches[0] ?? "");
}

async function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
