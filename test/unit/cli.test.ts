import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runEnsembleCli } from "../../src/cli.js";
import { EngineRegistry } from "../../src/engines.js";
import { EnsembleRuntime } from "../../src/runtime.js";
import { Scheduler } from "../../src/scheduler.js";
import { TokenBudget } from "../../src/budget.js";

import type { EngineAdapter, EngineInvocation } from "../../src/engines.js";
import type { Budget, EngineName, RuntimeOptions, TurnResult } from "../../src/types.js";

class CaptureStream extends Writable {
  chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

test("CLI prints result JSON to stdout and logs to stderr", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli" };
      log("hello stderr");
      return { args };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script, "a", "b"], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.text(), "{\"args\":[\"a\",\"b\"]}\n");
  assert.equal(stderr.text(), "hello stderr\n");
});

test("CLI passes parsed JSON as args when --json-args is set", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-json-args-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-json-args" };
      return { args, isArray: Array.isArray(args) };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([`--json-args={"items":["a","b"],"count":2}`, script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.text(), "{\"args\":{\"items\":[\"a\",\"b\"],\"count\":2},\"isArray\":false}\n");
  assert.equal(stderr.text(), "");
});

test("CLI wires per-engine budget ceilings into the workflow runtime", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-budget-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-budget" };
      const first = await agent("spend-codex", { engine: "codex" });
      let codexBlocked = false;
      try {
        await agent("codex-again", { engine: "codex" });
      } catch (error) {
        codexBlocked = /Token budget exhausted/.test(String(error?.message ?? error));
      }
      const claude = await agent("claude-ok", { engine: "claude" });
      return {
        first,
        codexBlocked,
        claude,
        codexRemaining: budget.remaining("codex"),
        claudeUnbounded: budget.remaining("claude") === Infinity
      };
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const runtimeOptions: RuntimeOptions[] = [];

  const exitCode = await runEnsembleCli([`--budget=codex=5`, script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async (options) => {
      const runtimeOption = options ?? {};
      runtimeOptions.push(runtimeOption);
      return budgetRuntime(runtimeOption);
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(runtimeOptions[0]?.budgetCeilings, { codex: 5 });
  assert.equal(
    stdout.text(),
    "{\"first\":\"codex:spend-codex\",\"codexBlocked\":true,\"claude\":\"claude:claude-ok\",\"codexRemaining\":0,\"claudeUnbounded\":true}\n"
  );
  assert.equal(stderr.text(), "");
});

test("CLI wires per-engine concurrency caps into the runtime scheduler", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-concurrency-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-concurrency" };
      await parallel([
        () => agent("c1", { engine: "codex" }),
        () => agent("c2", { engine: "codex" }),
        () => agent("c3", { engine: "codex" }),
        () => agent("h1", { engine: "claude" }),
        () => agent("h2", { engine: "claude" }),
        () => agent("h3", { engine: "claude" })
      ]);
      return "done";
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const runtimeOptions: RuntimeOptions[] = [];
  const codexEngines: ScheduledTextEngine[] = [];
  const claudeEngines: ScheduledTextEngine[] = [];

  const exitCode = await runEnsembleCli([`--concurrency=codex=1`, `--concurrency=claude=2`, script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async (options) => {
      const runtimeOption = options ?? {};
      runtimeOptions.push(runtimeOption);
      const codex = new ScheduledTextEngine("codex", runtimeOption.concurrencyCaps?.codex ?? 99);
      const claude = new ScheduledTextEngine("claude", runtimeOption.concurrencyCaps?.claude ?? 99);
      codexEngines.push(codex);
      claudeEngines.push(claude);
      return new EnsembleRuntime({
        engines: new EngineRegistry([codex, claude]),
        defaultTurnTimeoutMs: 1_000,
        defaultMaxAttempts: 1
      });
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(runtimeOptions[0]?.concurrencyCaps, { codex: 1, claude: 2 });
  assert.equal(codexEngines[0]?.maxActive, 1);
  assert.equal(claudeEngines[0]?.maxActive, 2);
  assert.equal(stdout.text(), "\"done\"\n");
  assert.equal(stderr.text(), "");
});

test("CLI returns non-zero and writes errors to stderr when the script throws", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-cli-"));
  const script = path.join(directory, "workflow.js");
  await writeFile(
    script,
    `
      export const meta = { name: "cli-error" };
      throw new Error("bad workflow");
    `
  );

  const stdout = new CaptureStream();
  const stderr = new CaptureStream();

  const exitCode = await runEnsembleCli([script], {
    cwd: directory,
    stdout,
    stderr,
    createRuntime: async () => fakeRuntime()
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /Error: bad workflow/);
});

test("CLI entrypoint runs when invoked through a symlinked binary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ensemble-bin-"));
  const binPath = path.join(directory, "ensemble");
  const entrypointPath = fileURLToPath(new URL("../../src/cli/ensemble.js", import.meta.url));
  await symlink(entrypointPath, binPath);

  const result = spawnSync(process.execPath, [binPath], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Usage: ensemble [--json-args '<json>'] [--budget engine=N] [--concurrency engine=N] <script.js> [args...]\n"
  );
});

function fakeRuntime(): EnsembleRuntime {
  const budget: Budget = {
    spent: () => 0,
    remaining: () => Number.POSITIVE_INFINITY
  };

  return {
    budget,
    worktrees: [],
    onEvent: () => () => {},
    agent: async (prompt: string) => prompt,
    close: async () => {}
  } as unknown as EnsembleRuntime;
}

function budgetRuntime(options: RuntimeOptions): EnsembleRuntime {
  const budget = new TokenBudget(options.budgetCeilings);

  return {
    budget,
    worktrees: [],
    onEvent: () => () => {},
    agent: async (prompt: string, agentOptions: { engine?: unknown }) => {
      const engine = agentOptions.engine;
      if (engine !== "codex" && engine !== "claude") {
        throw new Error("test runtime requires an engine");
      }
      budget.assertCanStart(engine);
      if (prompt === "spend-codex") {
        budget.record(engine, tokenUsageEvent(5));
      }
      return `${engine}:${prompt}`;
    },
    close: async () => {}
  } as unknown as EnsembleRuntime;
}

class ScheduledTextEngine implements EngineAdapter {
  readonly concurrency: number;
  readonly scheduler: Scheduler;
  active = 0;
  maxActive = 0;

  constructor(
    readonly name: EngineName,
    concurrency: number
  ) {
    this.concurrency = concurrency;
    this.scheduler = new Scheduler(concurrency);
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule(task);
  }

  createInvocation(prompt: string): EngineInvocation {
    return {
      runAttempt: async () => {
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        this.active -= 1;
        return turn(`${this.name}:${prompt}`);
      }
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

function turn(text: string): TurnResult {
  return {
    text,
    deltaText: text,
    durationMs: 1,
    firstDeltaMs: 1,
    items: {},
    tokenUsageEvents: []
  };
}

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
