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
        return await agent("return worker-ok", {
          engine: "codex",
          maxAttempts: 1
        });
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `"worker-ok"\n`);
    const messages = await fixture.messages();
    const turnStarts = messages.filter((message) => message.method === "turn/start");
    assert.equal(turnStarts.length, 1);
    assert.deepEqual(turnStarts[0]?.params?.sandboxPolicy, { type: "dangerFullAccess" });
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

test("built CLI propagates removed options from parallel before that worker spawns", async () => {
  const fixture = await createProcessFixture("parallel-option-rejection");

  try {
    await writeFile(
      fixture.script,
      `
        export const meta = {
          name: "parallel-option-rejection",
          description: "Rejected options escape fan-out without preventing valid siblings"
        };
        return await parallel([
          () => agent("valid sibling", { engine: "codex", maxAttempts: 1 }),
          () => agent("removed option", {
            engine: "codex",
            sandbox: "read-only",
            maxAttempts: 1
          })
        ]);
      `
    );

    const result = await fixture.run();

    assert.equal(result.code, 1);
    const envelope = JSON.parse(result.stdout) as {
      partial: boolean;
      reason: string;
      completed: unknown[];
    };
    assert.equal(envelope.partial, true);
    assert.equal(envelope.reason, "failed");
    assert.ok(Array.isArray(envelope.completed));
    assert.match(result.stderr, /sandbox[\s\S]*removed/i);
    const messages = await fixture.messages();
    assert.equal(messages.filter((message) => message.method === "turn/start").length, 1);
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

interface RecordedMessage {
  method?: string;
  params?: {
    sandboxPolicy?: unknown;
  };
}

interface ProcessFixture {
  script: string;
  run: () => Promise<{ code: number | null; stdout: string; stderr: string }>;
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
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env
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
