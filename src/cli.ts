import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { createRuntime } from "./index.js";
import { runWorkflowScript, WorkflowTimeoutError } from "./script-runner.js";
import { StatusFileWriter } from "./status-file.js";
import { readStatusLine } from "./status-line.js";

import type { RunProgress } from "./progress.js";
import type { CompletedAgentOutput, EnsembleRuntime } from "./runtime.js";
import type { EngineBudgetCeilings, EngineConcurrencyCaps, EngineName } from "./types.js";
import type { Writable } from "node:stream";

type InterruptSignal = "SIGINT" | "SIGTERM";

export interface EnsembleCliOptions {
  cwd?: string;
  stdout?: Writable;
  stderr?: Writable;
  createRuntime?: typeof createRuntime;
  timeoutMs?: number;
  /**
   * Directory for the live status side-channel. A non-empty string enables
   * writing the run's snapshot (and is the directory `--statusline` reads).
   * `null`/`undefined` disables it. Resolved from the environment at the bin.
   */
  statusDir?: string | null;
  /** Injectable clock for the `--statusline` reader; defaults to `Date.now`. */
  now?: () => number;
}

export async function runEnsembleCli(argv: string[], options: EnsembleCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();

  // Statusline mode: render the latest run's snapshot as one line and exit.
  // This is what a Claude Code statusLine command invokes; it never starts a run.
  if (argv.includes("--statusline")) {
    const line = await readStatusLine(options.statusDir ?? null, options.now ?? (() => Date.now()));
    if (line !== null) {
      stdout.write(`${line}\n`);
    }
    return 0;
  }

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
  let progress: RunProgress | undefined;
  let statusWriter: StatusFileWriter | null = null;

  try {
    const scriptPath = path.resolve(cwd, invocation.scriptArg);
    const source = await readFile(scriptPath, "utf8");
    runtime = await (options.createRuntime ?? createRuntime)({
      cwd,
      ...(invocation.budgetCeilings !== undefined ? { budgetCeilings: invocation.budgetCeilings } : {}),
      ...(invocation.concurrencyCaps !== undefined ? { concurrencyCaps: invocation.concurrencyCaps } : {})
    });
    // The CLI `--timeout` flag wins over a programmatically injected one; both
    // feed the same whole-workflow ceiling in `runWorkflowScript`.
    const timeoutMs = invocation.timeoutMs ?? options.timeoutMs;
    // Injected test runtimes may not carry a progress model; read it defensively.
    progress = (runtime as { progress?: RunProgress }).progress;

    const statusDir = options.statusDir ?? null;
    if (progress !== undefined && statusDir !== null && statusDir.length > 0) {
      statusWriter = new StatusFileWriter({
        progress,
        dir: statusDir,
        onError: (error) => {
          stderr.write(`[status] failed to write progress snapshot: ${formatError(error)}\n`);
        }
      });
    }

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
      },
      ...(progress !== undefined
        ? { onMeta: (meta: unknown) => progress?.setWorkflow(workflowName(meta)) }
        : {})
    };
    const interrupt = watchWorkflowInterrupts();
    try {
      const { result } = await Promise.race([
        runWorkflowScript(timeoutMs === undefined ? runnerOptions : { ...runnerOptions, timeoutMs }),
        interrupt.promise
      ]);

      stdout.write(`${serialiseResult(result)}\n`);
      return 0;
    } finally {
      interrupt.dispose();
    }
  } catch (error) {
    // A stopped workflow would otherwise discard every completed worker's
    // output. Emit a best-effort partial envelope to stdout so the driver can
    // recover the finished work; the error still goes to stderr and the exit
    // code stays non-zero, so callers that gate on it are unaffected.
    if (error instanceof WorkflowTimeoutError || error instanceof WorkflowInterruptedError) {
      stdout.write(`${serialiseResult(partialResult(runtime))}\n`);
    }
    stderr.write(`${formatError(error)}\n`);
    return 1;
  } finally {
    // Mark the run done and flush the final snapshot before tearing down.
    progress?.finish();
    if (statusWriter !== null) {
      await statusWriter.close();
    }
    if (runtime !== null) {
      await runtime.close();
    }
  }
}

/**
 * A stopped run's recovered work, marked so a driver can tell it apart from a clean
 * return. The `partial: true` flag plus the non-zero exit code distinguish it
 * from a normal result (which is the script's raw return value).
 */
interface PartialResult {
  partial: true;
  reason: "interrupted";
  completed: readonly CompletedAgentOutput[];
}

function partialResult(runtime: EnsembleRuntime | null): PartialResult {
  // Injected test runtimes may not carry the collector; read it defensively,
  // mirroring how `progress` is read above.
  const completed =
    (runtime as { completedOutputs?: () => readonly CompletedAgentOutput[] } | null)?.completedOutputs?.() ?? [];
  return { partial: true, reason: "interrupted", completed };
}

function workflowName(meta: unknown): string | null {
  if (typeof meta === "object" && meta !== null && "name" in meta) {
    const name = (meta as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

interface ParsedInvocation {
  scriptArg: string | undefined;
  args: unknown;
  budgetCeilings?: EngineBudgetCeilings;
  concurrencyCaps?: EngineConcurrencyCaps;
  timeoutMs?: number;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

class WorkflowInterruptedError extends Error {
  constructor(readonly signal: InterruptSignal) {
    super(`Workflow interrupted by ${signal}`);
    this.name = new.target.name;
  }
}

function watchWorkflowInterrupts(): { promise: Promise<never>; dispose: () => void } {
  const signals: readonly InterruptSignal[] = ["SIGINT", "SIGTERM"];
  const handlers = new Map<InterruptSignal, () => void>();

  const promise = new Promise<never>((_resolve, reject) => {
    for (const signal of signals) {
      const handler = () => {
        for (const [registeredSignal, registeredHandler] of handlers) {
          process.off(registeredSignal, registeredHandler);
        }
        handlers.clear();
        reject(new WorkflowInterruptedError(signal));
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });

  return {
    promise,
    dispose: () => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
      handlers.clear();
    }
  };
}

function parseInvocation(argv: string[]): ParsedInvocation {
  const split = splitTuningFlags(argv);
  const parsed = parseArgs({
    args: split.tuningArgs,
    options: {
      "json-args": { type: "string" },
      budget: { type: "string", multiple: true },
      concurrency: { type: "string", multiple: true },
      timeout: { type: "string" }
    },
    strict: true,
    allowPositionals: false
  });

  const jsonArgs = parsed.values["json-args"];
  const positionalArgs = split.scriptArg === undefined ? [] : split.scriptArgs;
  const args = jsonArgs === undefined ? positionalArgs : parseJsonArgs(jsonArgs);
  const budgetCeilings = parseEngineMap(parsed.values.budget, parseBudgetCeiling, "--budget");
  const concurrencyCaps = parseEngineMap(parsed.values.concurrency, parseConcurrencyCap, "--concurrency");
  const timeoutMs = parseTimeoutMs(parsed.values.timeout);

  return {
    scriptArg: split.scriptArg,
    args,
    ...(budgetCeilings !== undefined ? { budgetCeilings } : {}),
    ...(concurrencyCaps !== undefined ? { concurrencyCaps } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
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
  return value === "--json-args" || value === "--budget" || value === "--concurrency" || value === "--timeout";
}

function isKnownInlineOption(value: string): boolean {
  return (
    value.startsWith("--json-args=") ||
    value.startsWith("--budget=") ||
    value.startsWith("--concurrency=") ||
    value.startsWith("--timeout=")
  );
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

// Whole-workflow timeout in milliseconds (the `runWorkflowScript` ceiling),
// distinct from the per-turn `agent()` timeoutMs set inside a script.
function parseTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new CliUsageError(`--timeout value must be a positive integer of milliseconds, got ${value}`);
  }
  return timeoutMs;
}

function usage(): string {
  return "Usage: ensemble [--json-args '<json>'] [--budget engine=N] [--concurrency engine=N] [--timeout ms] <script.js> [args...]\n";
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
