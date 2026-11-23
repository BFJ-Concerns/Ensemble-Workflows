import { CommandContainment, type CommandStop, type ContainedCommand } from "./contained-command.js";
import { AgentPromptRejectedError, SubstrateRefusedError } from "./errors.js";
import { WhitespaceStream } from "./whitespace-stream.js";
import { createWorkerScopes, DEFAULT_STOP_BOUNDS } from "./worker-scopes.js";

/**
 * One command an engine runs per turn and reads as a stream of lines on its
 * stdout (`opencode run --format json`, `zcode -p --output-format
 * stream-json`), placed in the run's containment and collected whole.
 */
export interface StreamedCommandOptions {
  /** How the containment names the command (`opencode run`). */
  label: string;
  file: string;
  args: string[];
  /** Written to the command's stdin, which is then closed; omitted, stdin is empty. */
  stdin?: string | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The run's containment; omitted, the command gets machinery of its own, closed before returning. */
  commands: CommandContainment | undefined;
  /** Omitted, the command is not stopped on a deadline. */
  timeoutMs: number | undefined;
  killGraceMs: number;
  /** Aborting stops the command's containment (SIGTERM, escalating to SIGKILL). */
  signal: AbortSignal | undefined;
  /** Called once, on the first stdout chunk: the earliest observable sign of worker output. */
  onFirstData?: (() => void) | undefined;
  /** Receives each stdout chunk so live accounting can advance before exit. */
  onData?: ((chunk: string) => void) | undefined;
  /** Every command stop, including one followed by a thrown failure. */
  onCommandStop?: ((stop: CommandStop) => void) | undefined;
  /**
   * Judges each complete stdout line against the whitespace-stream bound:
   * the watch reports a line's streamed text (`observeText`) or its
   * tool or reasoning activity (`observeActivity`). Present, the bound is
   * enforced and a command that streams only whitespace past it is
   * stopped; absent, no bound applies.
   */
  watchLine?: ((line: string, whitespace: WhitespaceStream) => void) | undefined;
}

export interface StreamedCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The per-turn timer expired while the command was still running. */
  deadlineExpired?: boolean;
  /** The command was stopped after streaming only whitespace past the bound. */
  whitespaceLimitReached?: boolean;
}

/**
 * The most bytes Linux passes in one command-line argument
 * (`MAX_ARG_STRLEN`, 32 pages), its terminating NUL included. A longer
 * argument fails the spawn with E2BIG.
 */
export const MAX_ARGUMENT_BYTES = 128 * 1024;

/** Whether `argument` fits in one command-line argument. */
export function fitsOneArgument(argument: string): boolean {
  return Buffer.byteLength(argument, "utf8") + 1 <= MAX_ARGUMENT_BYTES;
}

/**
 * Runs the command, contained, and collects it whole. A command that
 * cannot be started (its executable missing or not executable, or the
 * system refusing the spawn) is a `SubstrateRefusedError`: nothing ran,
 * and the engine behind it is unavailable rather than the turn wrong. An
 * argument too long for the system is refused before anything spawns,
 * naming the limit.
 */
export async function runStreamedCommand(options: StreamedCommandOptions): Promise<StreamedCommandResult> {
  const startedAt = Date.now();
  if (options.signal?.aborted) {
    return { exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", durationMs: 0 };
  }
  const oversized = options.args.find((argument) => !fitsOneArgument(argument));
  if (oversized !== undefined) {
    throw new AgentPromptRejectedError(
      `${options.label} cannot be given an argument of ${Buffer.byteLength(oversized, "utf8")} bytes: ` +
      `Linux passes at most ${MAX_ARGUMENT_BYTES} bytes (128 KiB) in one command-line argument`
    );
  }
  // The default registry supplies run-owned containment. A standalone runner
  // owns the same machinery for this command and closes it before returning.
  const scopes = options.commands === undefined ? await createWorkerScopes() : undefined;
  const containment = options.commands ?? new CommandContainment(scopes!);
  try {
    let command: ContainedCommand;
    try {
      command = await containment.contain(options.label, options.file, options.args, {
        cwd: options.cwd, env: options.env, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      });
    } catch (error) {
      throw unstartable(options.label, error);
    }
    if (options.stdin !== undefined) {
      // A command that exits without reading its input closes the pipe;
      // its exit, not the write, is the outcome.
      command.child.stdin?.on("error", () => undefined);
      command.child.stdin?.end(options.stdin);
    }
    return await collectProcess(command, startedAt, { ...options, abortSignal: options.signal });
  } finally {
    if (scopes !== undefined) {
      try {
        await containment.close();
      } finally {
        await scopes.close();
      }
    }
  }
}

/** Only an operating-system spawn error means the executable could not start. */
function unstartable(label: string, error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const { code, errno, syscall } = error as NodeJS.ErrnoException;
  if (typeof code !== "string" || typeof errno !== "number" || !/^spawn(?: |$)/.test(syscall ?? "")) return error;
  return new SubstrateRefusedError(`${label} could not be started (${code}): ${error.message}`, { cause: error });
}

/** Stop ownership before waiting for pipes: a descendant may hold them open. */
function collectProcess(
  command: ContainedCommand,
  startedAt: number,
  options: Pick<StreamedCommandOptions, "timeoutMs" | "killGraceMs" | "watchLine" | "onFirstData" | "onData" | "onCommandStop"> & {
    abortSignal: AbortSignal | undefined;
  }
): Promise<StreamedCommandResult> {
  const { timeoutMs, killGraceMs, watchLine, abortSignal, onFirstData, onData, onCommandStop } = options;
  return new Promise((resolve, reject) => {
    const child = command.child;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    // Placement is asynchronous. The command may have exited and its pipes
    // closed before containment handed it back, so events alone are not a
    // complete lifecycle account.
    let exited = child.exitCode !== null || child.signalCode !== null;
    let closed = exited && (child.stdout?.closed ?? true) && (child.stderr?.closed ?? true);
    let stopped = false;
    let deadlineExpired = false;
    let whitespaceLimitReached = false;
    let stopping: Promise<void> | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let processError: Error | undefined;
    let exitCode: number | null = child.exitCode;
    let exitSignal: NodeJS.Signals | null = child.signalCode;

    let streamBuffer = "";
    const whitespace = watchLine !== undefined ? new WhitespaceStream(startedAt, () => {
      whitespaceLimitReached = true;
      stop();
    }) : null;

    const settle = (): void => {
      if (settled || !stopped || !closed) return;
      settled = true;
      clearTimeout(drainTimer);
      abortSignal?.removeEventListener("abort", terminate);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // An unconfirmed stop must not leave the child's handle holding up the
      // run's diagnostic. The attempt or run accounts for the stop.
      child.unref();
      if (processError !== undefined) {
        reject(processError);
      } else {
        resolve({ exitCode, signal: exitSignal, stdout: stdout.join(""), stderr: stderr.join(""),
          durationMs: Date.now() - startedAt, deadlineExpired, whitespaceLimitReached });
      }
    };
    const stop = (): void => {
      whitespace?.clear();
      clearTimeout(timeout);
      stopping ??= command.stop({ stopGraceMs: killGraceMs, confirmMs: DEFAULT_STOP_BOUNDS.confirmMs }).then((observation) => {
        // Delivery precedes settlement, so errors and ordinary results alike
        // retain the account. The engine passes an attempt-local collector.
        onCommandStop?.(observation);
        stopped = true;
        // Even an unavailable/refused scope or an unconfirmed stop cannot
        // let an escaped pipe holder block the run's teardown report.
        if (!closed) {
          drainTimer = setTimeout(() => { closed = true; settle(); }, 1_000);
        }
        settle();
      });
    };
    const terminate = (): void => {
      if (!settled) stop();
    };
    // Exit ends execution time; draining a completed process is not a timeout.
    const timeout = timeoutMs === undefined || exited ? undefined : setTimeout(() => {
      if (!settled && !exited) {
        deadlineExpired = true;
        stop();
      }
    }, timeoutMs);

    let firstDataSeen = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (!firstDataSeen) {
        firstDataSeen = true;
        try { onFirstData?.(); } catch { /* Observability cannot fail a worker. */ }
      }
      try { onData?.(chunk); } catch { /* Live accounting cannot fail a worker. */ }
      stdout.push(chunk);
      if (whitespace !== null && stopping === undefined) {
        streamBuffer += chunk;
        const lines = streamBuffer.split(/\r?\n/);
        streamBuffer = lines.pop() ?? "";
        for (const line of lines) {
          watchLine?.(line, whitespace);
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", (error) => {
      processError = error;
      stop();
    });
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      // A normally exited engine can leave live shell commands behind too.
      stop();
    });
    child.on("close", (code, signal) => {
      closed = true;
      exitCode = code;
      exitSignal = signal;
      stop();
      settle();
    });
    abortSignal?.addEventListener("abort", terminate, { once: true });
    if (exited) stop();
    // Containment setup is asynchronous; cancellation can race the hand-off.
    if (abortSignal?.aborted) terminate();
  });
}
