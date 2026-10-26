import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executablePath, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/scripts/ensemble.mjs");
const appServerFixturePath = path.resolve("test/fixtures/codex/recording-app-server.mjs");
const archiveConsumerPath = path.resolve("test/consumers/read-incident-sequence-record.mjs");

test("accepted request, partial output, overload, and termination retain one causal attempt across consumers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-incident-sequence-"));
  const binDirectory = path.join(directory, "bin");
  const fakeCodex = path.join(binDirectory, "codex");
  const capturePath = path.join(directory, "codex-input.jsonl");
  const workflowPath = path.join(directory, "workflow.js");
  const dataHome = path.join(directory, "data");
  const identifier = "INCIDENT_SEQUENCE_ACCEPTANCE_71";

  try {
    await mkdir(binDirectory);
    await writeFile(capturePath, "");
    await writeFile(fakeCodex, `#!/usr/bin/env node\nimport ${JSON.stringify(appServerFixturePath)};\n`);
    await chmod(fakeCodex, 0o755);
    await writeFile(
      workflowPath,
      `
        export const meta = { task: { id: ${JSON.stringify(identifier)} } };
        return await agent(${JSON.stringify(`dispatch ${identifier}`)}, { engine: "codex", maxAttempts: 1 });
      `
    );

    const overloadSequence = [[
      {
        method: "item/agentMessage/delta",
        params: { itemId: "incident-partial", delta: `partial ${identifier}` }
      },
      {
        method: "error",
        params: {
          error: {
            message: `overload ${identifier}`,
            additionalDetails: `provider terminal cause ${identifier}`,
            codexErrorInfo: "serverOverloaded"
          },
          willRetry: false
        }
      }
    ]];
    const environment: NodeJS.ProcessEnv = {
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      ENSEMBLE_CODEX_SCHEMA_CLI: await executablePath("codex"),
      ENSEMBLE_FAKE_CODEX_CAPTURE: capturePath,
      ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify(overloadSequence),
      ENSEMBLE_STATUS: "0",
      XDG_DATA_HOME: dataHome,
      // Isolation here is by data home: the suite runner's own store
      // redirection (a named pass-through in the hermetic base) would
      // silently win over it, so remove it explicitly.
      ENSEMBLE_RUN_RECORD_DIR: undefined
    };

    // The fixture supplies only the on-demand overload. The built bundle,
    // caller-visible process result, dispatch protocol, and archive are real.
    const caller = await runNode([bundledCliPath, workflowPath], environment);
    // The terminal overload is the dispatched worker's failure: the script
    // receives null and the run completes; the notice carries the cause.
    assert.equal(caller.code, 0, caller.stderr);
    assert.equal(caller.stdout, "null\n");
    assert.match(caller.stderr, /\[codex\] agent 1 failed after 1 attempt — AppServerOverloadedError/);
    assert.match(caller.stderr, new RegExp(`overload ${identifier}`));
    assert.equal((caller.stderr.match(/AppServerOverloadedError/g) ?? []).length, 1);

    const messages = (await readFile(capturePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: { input?: Array<{ text?: string }> } });
    const turnStarts = messages.filter((message) => message.method === "turn/start");
    assert.equal(turnStarts.length, 1);
    assert.equal(turnStarts[0]?.params?.input?.[0]?.text, `dispatch ${identifier}`);

    // This consumer deliberately has only the resolved data home and
    // identifier: it rebuilds the causal join from the sealed archive in a
    // separate process.
    const consumer = await runNode([archiveConsumerPath, dataHome, identifier]);
    assert.equal(consumer.code, 0, consumer.stderr);
    assert.deepEqual(JSON.parse(consumer.stdout), {
      task: identifier,
      prompt: `dispatch ${identifier}`,
      partial: `partial ${identifier}`,
      failure: `turn notification failed (serverOverloaded): serverOverloaded: overload ${identifier}: provider terminal cause ${identifier}; data: {"error":{"message":"overload ${identifier}","additionalDetails":"provider terminal cause ${identifier}","codexErrorInfo":"serverOverloaded"},"willRetry":false,"threadId":"thread-1","turnId":"turn-1"}`
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
