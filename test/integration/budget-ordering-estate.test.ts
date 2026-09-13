import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executablePath, runNode } from "./estate-process.js";

const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");
const recordingAppServerPath = path.resolve("test/fixtures/codex/recording-app-server.mjs");

test("built consumer preserves a dispatched worker's transport failure after sibling usage exhausts the budget", async () => {
  await withEstate(async (estate) => {
    await writeFile(
      estate.workflow,
      `
        export const meta = { name: "budget-retry-sibling-ordering" };
        const outcomes = await Promise.allSettled([
          agent("retrying transport worker", { engine: "codex", label: "retrying", maxAttempts: 2 }),
          agent("usage-exhausting sibling", { engine: "codex", label: "sibling", maxAttempts: 1 })
        ]);
        return outcomes.map((outcome) => outcome.status === "fulfilled"
          ? { status: outcome.status, value: outcome.value }
          : {
              status: outcome.status,
              name: outcome.reason?.name ?? null,
              message: String(outcome.reason?.message ?? outcome.reason)
            });
      `
    );

    const overload = overloadNotification("recording fixture overload");
    const result = await estate.run(
      [
        [usageNotification(9), overload],
        [usageNotification(11)],
        [usageNotification(7), overload]
      ],
      ["--budget=codex=5"]
    );

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    // The retrying worker's exhausted overload is its own failure, resolved
    // as the call's null — not a budget rejection, which would have
    // thrown pre-dispatch — and the notice on stderr names the transport's
    // account, with the archive below holding both attempts.
    assert.deepEqual(output[0], { status: "fulfilled", value: null });
    assert.match(result.stderr, /\[codex\] agent 1 \(retrying\) failed after 2 attempts — AppServerOverloadedError/);
    assert.match(result.stderr, /recording fixture overload/);
    assert.deepEqual(output[1], { status: "fulfilled", value: "worker-ok" });

    const requests = await estate.requests();
    assert.equal(requests.filter((request) => request.method === "thread/start").length, 3);
    assert.equal(requests.filter((request) => request.method === "turn/start").length, 3);

    const agents = await estate.agents();
    assert.equal(agents.length, 2);
    const retrying = agents.find((agent) => agent.label === "retrying");
    assert.equal(retrying?.status, "failed");
    assert.equal(retrying?.attempts.length, 2);
    assert.deepEqual(retrying?.attempts.map((attempt) => attempt.failure?.kind), [
      "AppServerOverloadedError",
      "AppServerOverloadedError"
    ]);
    assert.equal(agents.find((agent) => agent.label === "sibling")?.status, "complete");
  });
});

test("built consumer completes every admitted queued call after overshoot and rejects only the next dispatch", async () => {
  await withEstate(async (estate) => {
    await writeFile(
      estate.workflow,
      `
        export const meta = { name: "budget-admitted-backlog" };
        const admitted = await parallel([
          () => agent("queued worker one", { engine: "codex", label: "queued-1", maxAttempts: 1 }),
          () => agent("queued worker two", { engine: "codex", label: "queued-2", maxAttempts: 1 }),
          () => agent("queued worker three", { engine: "codex", label: "queued-3", maxAttempts: 1 })
        ]);
        let blocked;
        try {
          await agent("must be blocked", { engine: "codex", label: "blocked", maxAttempts: 1 });
          blocked = null;
        } catch (error) {
          blocked = { name: error?.name ?? null, message: String(error?.message ?? error) };
        }
        return { admitted, spent: budget.spent("codex"), blocked };
      `
    );

    const result = await estate.run(
      [[usageNotification(10)], [usageNotification(10)], [usageNotification(10)]],
      ["--budget=codex=5", "--concurrency=codex=1"]
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      admitted: ["worker-ok", "worker-ok", "worker-ok"],
      spent: 30,
      blocked: {
        name: "BudgetExceededError",
        message: "Token budget exhausted for codex: spent 30 of 5 tokens"
      }
    });
    const requests = await estate.requests();
    assert.equal(requests.filter((request) => request.method === "thread/start").length, 3);
    assert.equal(requests.filter((request) => request.method === "turn/start").length, 3);
    const agents = await estate.agents();
    assert.deepEqual(agents.map((agent) => agent.label).sort(), ["queued-1", "queued-2", "queued-3"]);
    assert.ok(agents.every((agent) => agent.status === "complete" && agent.attempts.length === 1));
  });
});

interface RequestMessage { method?: string }
interface AgentRecord {
  label: string | null;
  status: string;
  attempts: Array<{ failure: { kind: string } | null }>;
}

function usageNotification(totalTokens: number) {
  const breakdown = {
    cachedInputTokens: 0,
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens
  };
  return {
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { last: breakdown, total: breakdown } },
    allowMalformed: "the generated Codex notification schema omits the runtime's established token-usage event"
  };
}

function overloadNotification(message: string) {
  return {
    method: "error",
    params: {
      error: { message, codexErrorInfo: "serverOverloaded" },
      willRetry: false
    },
    allowMalformed: "the fixture overload carries classifier fields outside the locally closed schema"
  };
}

async function withEstate(run: (estate: Awaited<ReturnType<typeof createEstate>>) => Promise<void>) {
  const estate = await createEstate();
  try {
    await run(estate);
  } finally {
    await estate.cleanup();
  }
}

async function createEstate() {
  const realCodex = await executablePath("codex");
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-budget-ordering-estate-"));
  const binDirectory = path.join(directory, "bin");
  const fakeCodex = path.join(binDirectory, "codex");
  const capturePath = path.join(directory, "codex-input.jsonl");
  const recordStore = path.join(directory, "records");
  const workflow = path.join(directory, "workflow.js");
  await mkdir(binDirectory);
  await writeFile(capturePath, "");
  await writeFile(fakeCodex, `#!/usr/bin/env node\nimport ${JSON.stringify(recordingAppServerPath)};\n`);
  await chmod(fakeCodex, 0o755);

  return {
    workflow,
    run: (sequences: unknown[][], cliArgs: string[]) =>
      runNode(
        [bundledCliPath, ...cliArgs, workflow],
        {
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
          // Always the resolved real codex, never an inherited value: an
          // inherited pointer is how this test came to run its own fake as its
          // schema CLI and fork until the machine died (2026-08-03). The sibling
          // estates resolve it unconditionally too.
          ENSEMBLE_CODEX_SCHEMA_CLI: realCodex,
          ENSEMBLE_FAKE_CODEX_CAPTURE: capturePath,
          ENSEMBLE_FAKE_CODEX_NOTIFICATION_SEQUENCES: JSON.stringify(sequences),
          ENSEMBLE_RUN_RECORD: "1",
          ENSEMBLE_RUN_RECORD_DIR: recordStore,
          ENSEMBLE_STATUS: "0",
          XDG_DATA_HOME: path.join(directory, "data")
        },
        15_000
      ),
    requests: async (): Promise<RequestMessage[]> =>
      (await readFile(capturePath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    agents: async (): Promise<AgentRecord[]> => {
      const entries = await readdir(recordStore, { recursive: true });
      return Promise.all(
        entries
          .filter((entry) => path.basename(entry) === "agent.json")
          .map(async (entry) => JSON.parse(await readFile(path.join(recordStore, entry), "utf8")))
      );
    },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}


