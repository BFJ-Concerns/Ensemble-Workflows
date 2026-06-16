import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { createRuntime } from "./index.js";
import { runWorkflowScript } from "./script-runner.js";

import type { EnsembleRuntime } from "./runtime.js";
import type { EngineBudgetCeilings, EngineConcurrencyCaps, EngineName } from "./types.js";
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

  let invocation: ParsedInvocation;
  try {
    invocation = parseInvocation(argv);
  } catch (error) {
    stderr.write(`${formatError(error)}\n`);
    stderr.write(usage());
    return 2;
  }

  if (invocation.scriptArg === undefined) {
    stderr.write(usage());
    return 2;
  }

  let runtime: EnsembleRuntime | null = null;

  try {
    const scriptPath = path.resolve(cwd, invocation.scriptArg);
    const source = await readFile(scriptPath, "utf8");
    runtime = await (options.createRuntime ?? createRuntime)({
      cwd,
      ...(invocation.budgetCeilings !== undefined ? { budgetCeilings: invocation.budgetCeilings } : {}),
      ...(invocation.concurrencyCaps !== undefined ? { concurrencyCaps: invocation.concurrencyCaps } : {})
    });
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
      args: invocation.args,
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

interface ParsedInvocation {
  scriptArg: string | undefined;
  args: unknown;
  budgetCeilings?: EngineBudgetCeilings;
  concurrencyCaps?: EngineConcurrencyCaps;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

function parseInvocation(argv: string[]): ParsedInvocation {
  const split = splitTuningFlags(argv);
  const parsed = parseArgs({
    args: split.tuningArgs,
    options: {
      "json-args": { type: "string" },
      budget: { type: "string", multiple: true },
      concurrency: { type: "string", multiple: true }
    },
    strict: true,
    allowPositionals: false
  });

  const jsonArgs = parsed.values["json-args"];
  const positionalArgs = split.scriptArg === undefined ? [] : split.scriptArgs;
  const args = jsonArgs === undefined ? positionalArgs : parseJsonArgs(jsonArgs);
  const budgetCeilings = parseEngineMap(parsed.values.budget, parseBudgetCeiling, "--budget");
  const concurrencyCaps = parseEngineMap(parsed.values.concurrency, parseConcurrencyCap, "--concurrency");

  return {
    scriptArg: split.scriptArg,
    args,
    ...(budgetCeilings !== undefined ? { budgetCeilings } : {}),
    ...(concurrencyCaps !== undefined ? { concurrencyCaps } : {})
  };
}

function splitTuningFlags(argv: string[]): { tuningArgs: string[]; scriptArg: string | undefined; scriptArgs: string[] } {
  const tuningArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) {
      continue;
    }

    if (value === "--") {
      return {
        tuningArgs,
        scriptArg: argv[index + 1],
        scriptArgs: argv.slice(index + 2)
      };
    }

    if (isKnownInlineOption(value)) {
      tuningArgs.push(value);
      continue;
    }

    if (isKnownOption(value)) {
      const optionValue = argv[index + 1];
      if (optionValue === undefined) {
        throw new CliUsageError(`Option ${value} expects a value`);
      }
      tuningArgs.push(value, optionValue);
      index += 1;
      continue;
    }

    if (value.startsWith("-")) {
      throw new CliUsageError(`Unknown option before script path: ${value}`);
    }

    return {
      tuningArgs,
      scriptArg: value,
      scriptArgs: argv.slice(index + 1)
    };
  }

  return { tuningArgs, scriptArg: undefined, scriptArgs: [] };
}

function isKnownOption(value: string): boolean {
  return value === "--json-args" || value === "--budget" || value === "--concurrency";
}

function isKnownInlineOption(value: string): boolean {
  return value.startsWith("--json-args=") || value.startsWith("--budget=") || value.startsWith("--concurrency=");
}

function parseJsonArgs(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(`--json-args must be valid JSON: ${message}`);
  }
}

function parseEngineMap<T>(
  values: string[] | undefined,
  parseValue: (raw: string) => T,
  flagName: "--budget" | "--concurrency"
): Partial<Record<EngineName, T>> | undefined {
  if (values === undefined || values.length === 0) {
    return undefined;
  }

  const result: Partial<Record<EngineName, T>> = {};
  for (const entry of values) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new CliUsageError(`${flagName} expects engine=value`);
    }
    const engine = parseEngineName(entry.slice(0, separatorIndex), flagName);
    if (result[engine] !== undefined) {
      throw new CliUsageError(`${flagName} repeats ${engine}`);
    }
    result[engine] = parseValue(entry.slice(separatorIndex + 1));
  }

  return result;
}

function parseEngineName(value: string, flagName: string): EngineName {
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new CliUsageError(`${flagName} engine must be codex or claude, got ${value}`);
}

function parseBudgetCeiling(value: string): number {
  const ceiling = Number(value);
  if (!Number.isInteger(ceiling) || ceiling < 0) {
    throw new CliUsageError(`--budget value must be a non-negative integer, got ${value}`);
  }
  return ceiling;
}

function parseConcurrencyCap(value: string): number {
  const cap = Number(value);
  if (!Number.isInteger(cap) || cap < 1) {
    throw new CliUsageError(`--concurrency value must be a positive integer, got ${value}`);
  }
  return cap;
}

function usage(): string {
  return "Usage: ensemble [--json-args '<json>'] [--budget engine=N] [--concurrency engine=N] <script.js> [args...]\n";
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
