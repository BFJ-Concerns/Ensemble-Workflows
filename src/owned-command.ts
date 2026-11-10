import type { ChildProcess } from "node:child_process";

import type { LaunchOptions, WorkerScopes } from "./worker-scopes.js";

/**
 * A short-lived command the launcher starts and owns — a `claude --bg`
 * launch, a roster query, a `tmux` step — run to its own end or cancelled
 * within a stated bound.
 *
 * Ownership is the command's own process and nothing else. Cancelling
 * signals that one pid, never its process group, its descendants or the
 * scope it runs in: any `claude` command can start the per-user supervisor,
 * which then serves every Claude session on the machine, and ending the
 * command's tree or scope would end the supervisor and every sibling worker
 * with it. Both launch routes hand back the command's own pid — a direct
 * launch spawns it, and `systemd-run --scope` execs it in place (measured on
 * systemd 262; `worker-scopes.test.ts` holds the check) — so cancellation has
 * one observable contract on either route.
 *
 * What a cancelled command already set in motion elsewhere — a request the
 * supervisor accepted before the command died — is not the command's and is
 * not undone here. The caller that started the command owns that residue
 * and must account for it (the Claude control plane's unclaimed launches).
 */
export interface CommandResult {
  /** True only for a command that ran to its own end and exited 0. */
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  /**
   * How the command ended.
   *
   * - `completed` — it exited by itself, or never started (a spawn error,
   *   reported in `stderr`).
   * - `cancelled` — the caller's signal ended it and its exit was observed:
   *   nothing the command itself was is left running. Also the ending of a
   *   command whose signal had aborted before it was launched.
   * - `unconfirmed` — the caller's signal ended the wait, the command was
   *   sent SIGKILL, and its exit was still not observed within the bound.
   *   It may yet be running; the caller must treat whatever it could still
   *   do as possible.
   */
  ending: "completed" | "cancelled" | "unconfirmed";
}

/**
 * The time a cancellation may take. After the caller's signal aborts, the
 * command gets SIGTERM and `stopGraceMs` to exit, then SIGKILL; after its
 * exit (or after the SIGKILL, if no exit comes) the streams get `drainMs` to
 * close. A cancelled command therefore settles within
 * `stopGraceMs + drainMs` of the abort, plus scheduling latency, whatever
 * the command does.
 *
 * `drainMs` also bounds an uncancelled command: once it has exited, a
 * descendant still holding its stdout or stderr (a supervisor it started
 * with inherited streams) cannot hold the result back longer than that.
 */
export interface CommandBounds {
  stopGraceMs: number;
  drainMs: number;
}

export const DEFAULT_COMMAND_BOUNDS: CommandBounds = { stopGraceMs: 2_000, drainMs: 1_000 };

export interface OwnedCommandOptions extends Omit<LaunchOptions, "stdio"> {
  /** Written to stdin, which is then closed; null closes it at once. */
  input: string | null;
  /** Aborting cancels the command (see `CommandBounds`). */
  signal?: AbortSignal;
  bounds?: CommandBounds;
}

/**
 * Launch a command through the scope manager and resolve with its result.
 * Never rejects: a command that cannot start resolves `completed` with
 * `ok: false` and the reason in `stderr`, so callers read one verdict shape.
 */
export async function runOwnedCommand(
  scopes: WorkerScopes,
  file: string,
  args: readonly string[],
  options: OwnedCommandOptions
): Promise<CommandResult> {
  const { input, signal, bounds = DEFAULT_COMMAND_BOUNDS, ...launch } = options;
  if (signal?.aborted) {
    return { ok: false, stdout: "", stderr: abortAccount(signal), exitCode: null, signal: null, ending: "cancelled" };
  }
  let child: ChildProcess;
  try {
    child = await scopes.launch(file, args, { ...launch, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: null, signal: null, ending: "completed" };
  }
  return new Promise<CommandResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let cancelled = false;
    let exited: { code: number | null; signal: string | null } | null = null;
    let spawnError: Error | null = null;
    let settled = false;
    const timers = new Set<NodeJS.Timeout>();
    const after = (ms: number, run: () => void): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timers.add(timer);
    };

    const settle = (ending: CommandResult["ending"]): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Our ends of the pipes only: a descendant holding the other ends
      // keeps its copies, and nothing here waits on them any longer.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      const said = spawnError?.message ?? Buffer.concat(stderr).toString();
      resolve({
        ok: ending === "completed" && spawnError === null && exited?.code === 0,
        stdout: Buffer.concat(stdout).toString(),
        // A cancelled command's own stderr is kept, with the cancellation's
        // reason after it, so an account names both.
        stderr: ending === "completed" || signal === undefined ? said : [said, abortAccount(signal)].filter((part) => part.length > 0).join("\n"),
        exitCode: exited?.code ?? null,
        signal: exited?.signal ?? null,
        ending
      });
    };
    const endingNow = (): CommandResult["ending"] => (cancelled ? "cancelled" : "completed");

    const onAbort = (): void => {
      if (exited !== null || settled) return;
      cancelled = true;
      // `child.kill` signals the pid libuv still holds for this child, and
      // only while it has not been reaped, so a recycled pid is never hit.
      child.kill("SIGTERM");
      after(bounds.stopGraceMs, () => {
        if (exited !== null) return;
        child.kill("SIGKILL");
        after(bounds.drainMs, () => settle("unconfirmed"));
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      // A spawn failure emits no exit; the command never ran.
      if (child.pid === undefined) {
        spawnError = error;
        settle(endingNow());
      }
    });
    child.on("exit", (code, exitSignal) => {
      exited = { code, signal: exitSignal };
      after(bounds.drainMs, () => settle(endingNow()));
    });
    child.on("close", () => settle(endingNow()));

    signal?.addEventListener("abort", onAbort, { once: true });
    // Launch is asynchronous: an abort during that hand-off precedes the
    // listener, so re-read the signal once the child is owned.
    if (signal?.aborted) onAbort();
    // A child that rejects input may close stdin before this write
    // completes; its exit status and stderr are the useful account, so the
    // stream's secondary EPIPE is suppressed.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? undefined);
  });
}

function abortAccount(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return `cancelled: ${reason instanceof Error ? reason.message : String(reason)}`;
}
