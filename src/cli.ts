import { readFile } from "node:fs/promises";
import path from "node:path";

import { createRuntime } from "./index.js";
import { runWorkflowScript } from "./script-runner.js";

import type { EnsembleRuntime } from "./runtime.js";
import type { Writable } from "node:stream";

export interface EnsembleCliOptions {
  cwd?: string;
  stdout?: Writable;
  stderr?: Writable;
  createRuntime?: typeof createRuntime;
  timeoutMs?: number;
}

export async function runEnsembleCli(argv: string[], options: EnsembleCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  const [scriptArg, ...scriptArgs] = argv;

  if (scriptArg === undefined) {
    stderr.write("Usage: ensemble <script.js> [args...]\n");
    return 2;
  }

  let runtime: EnsembleRuntime | null = null;

  try {
    const scriptPath = path.resolve(cwd, scriptArg);
    const source = await readFile(scriptPath, "utf8");
    runtime = await (options.createRuntime ?? createRuntime)({ cwd });
    runtime.onEvent((event) => {
      if (event.method !== "worktree/finished" || event.params.changed !== true) {
        return;
      }
      const worktreePath = typeof event.params.path === "string" ? event.params.path : "<unknown>";
      const branch = typeof event.params.branch === "string" ? event.params.branch : "<unknown>";
      stderr.write(`[worktree] changed ${worktreePath} (${branch})\n`);
    });
    const runnerOptions = {
      source,
      filename: scriptPath,
      runtime,
      args: scriptArgs,
      log: (message: string) => {
        stderr.write(`${message}\n`);
      }
    };
    const { result } = await runWorkflowScript(
      options.timeoutMs === undefined ? runnerOptions : { ...runnerOptions, timeoutMs: options.timeoutMs }
    );

    stdout.write(`${serialiseResult(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    return 1;
  } finally {
    if (runtime !== null) {
      await runtime.close();
    }
  }
}

function serialiseResult(result: unknown): string {
  const json = JSON.stringify(result);
  return json === undefined ? "null" : json;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}
