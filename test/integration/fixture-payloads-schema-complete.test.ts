import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const recordingFixturePath = path.resolve("test/fixtures/codex/recording-app-server.mjs");

test("built CLI accepts all repaired recording-fixture payloads without opt-outs", async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run({
      ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify([[
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
      ]])
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '"worker-ok"\n');
    const validations = await fixture.validations();
    const validatedSchemas = new Set(validations.filter((entry) => entry.outcome === "valid").map((entry) => entry.schemaPath));
    for (const schemaPath of [
      "v1/InitializeResponse.json",
      "v2/ThreadStartResponse.json",
      "v2/TurnStartResponse.json",
      "ServerNotification.json"
    ]) {
      assert.ok(validatedSchemas.has(schemaPath), `missing successful validation for ${schemaPath}`);
    }
    assert.ok(
      validations.every((entry) => entry.outcome === "valid"),
      `repaired payloads must not need opt-outs: ${JSON.stringify(validations)}`
    );
  });
});

test("recorded thread/start frame also satisfies a closed installed-CLI schema shape", async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run({}, { closeThreadStartSchema: true });

    assert.equal(result.code, 0, result.stderr);
    const validations = await fixture.validations();
    assert.ok(
      validations.some((entry) => entry.outcome === "valid" && entry.schemaPath === "v2/ThreadStartResponse.json"),
      `thread/start frame was not accepted by the closed schema: ${JSON.stringify(validations)}`
    );
  });
});

test("built CLI rejects a completed recording-fixture payload missing a required field", async () => {
  await withFixture(async (fixture) => {
    const result = await fixture.run({ ENSEMBLE_FAKE_CODEX_SCHEMA_DRIFT: "missing-initialize-user-agent" });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /InitializeResponse\.json validation/);
    assert.match(result.stderr, /must have required property 'userAgent'/);
  });
});

interface ValidationRecord {
  schemaPath: string;
  outcome: "valid" | "allowed-malformed";
}

interface Fixture {
  run: (
    overrides?: NodeJS.ProcessEnv,
    options?: { closeThreadStartSchema?: boolean }
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  validations: () => Promise<ValidationRecord[]>;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-fixture-payloads-schema-complete-"));
  const binDirectory = path.join(directory, "bin");
  const fakeCodex = path.join(binDirectory, "codex");
  const validationCapture = path.join(directory, "validation.jsonl");
  const workflow = path.join(directory, "workflow.js");
  await mkdir(binDirectory);
  await writeFile(validationCapture, "");
  await writeFile(
    workflow,
    `export const meta = { name: "fixture-payloads-schema-complete" };\nreturn await agent("return worker-ok", { engine: "codex", maxAttempts: 2 });\n`
  );
  await writeFile(fakeCodex, `#!/usr/bin/env node\nimport ${JSON.stringify(recordingFixturePath)};\n`);
  await chmod(fakeCodex, 0o755);

  try {
    const codexCli = await executablePath("codex");
    await run({
    run: async (overrides = {}, options = {}) => {
      const schemaCli = options.closeThreadStartSchema
        ? await closedThreadStartSchemaCli(directory, codexCli)
        : codexCli;
      return runProcess(process.execPath, [bundledCliPath, workflow], {
          ...process.env,
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          ENSEMBLE_CODEX_SCHEMA_CLI: schemaCli,
          ENSEMBLE_FAKE_CODEX_VALIDATION_CAPTURE: validationCapture,
          ENSEMBLE_RUN_RECORD: "0",
          ENSEMBLE_STATUS: "0",
          XDG_DATA_HOME: path.join(directory, "data"),
          ...overrides
        });
    },
      validations: async () => (await readFile(validationCapture, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ValidationRecord)
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function closedThreadStartSchemaCli(directory: string, codexCli: string): Promise<string> {
  const wrapper = path.join(directory, "closed-thread-start-schema-codex.mjs");
  await writeFile(
    wrapper,
    `#!/usr/bin/env node\n` +
      `import { readFile, writeFile } from "node:fs/promises";\n` +
      `import path from "node:path";\n` +
      `import { spawn } from "node:child_process";\n` +
      `const child = spawn(${JSON.stringify(codexCli)}, process.argv.slice(2), { stdio: "inherit" });\n` +
      `child.once("exit", async (code) => {\n` +
      `  if (code !== 0) process.exit(code ?? 1);\n` +
      `  const out = process.argv.at(-1);\n` +
      `  if (process.argv.includes("generate-json-schema") && out !== undefined) {\n` +
      `    const file = path.join(out, "v2", "ThreadStartResponse.json");\n` +
      `    const schema = JSON.parse(await readFile(file, "utf8"));\n` +
      `    delete schema.properties.approvalsReviewer;\n` +
      `    schema.required = schema.required.filter((field) => field !== "approvalsReviewer");\n` +
      `    schema.additionalProperties = false;\n` +
      `    await writeFile(file, JSON.stringify(schema));\n` +
      `  }\n` +
      `  process.exit(0);\n` +
      `});\n`
  );
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function executablePath(name: string): Promise<string> {
  const result = await runProcess("which", [name], process.env);
  assert.equal(result.code, 0, `required executable ${name} is unavailable: ${result.stderr}`);
  return result.stdout.trim();
}

function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
