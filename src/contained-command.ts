import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";

import { EnsembleError, StopUnconfirmedError } from "./errors.js";
import {
  DEFAULT_STOP_BOUNDS,
  waitUntil,
  type ScopePlacement,
  type StopBounds,
  type StopOutcome,
  type WorkerScopes
} from "./worker-scopes.js";

/**
 * A worker's own command — a process the launcher spawns for one attempt,
 * such as an `opencode run` — started inside ownership the run holds from
 * before the command's first instruction, so that ending the command ends
 * everything it ever started.
 *
 * This is the counterpart of `runOwnedCommand` (owned-command.ts), whose
 * ownership is deliberately one pid because a `claude` command can start the
 * supervisor every Claude session on the machine shares. A contained command
 * is the opposite case: nothing it starts is anyone else's, and all of it
 * ends with the attempt or, at the latest, with the run.
 *
 * The division of work, on every engine that contains a command:
 *
 * - The engine stops. Whoever contained a command calls `stop()` once it no
 *   longer needs it — on cancellation, on a deadline, and after the command's
 *   own ordinary exit, since an exited command can leave descendants running.
 *   That stop is also what releases the engine's own wait: a descendant
 *   holding the command's output pipes ends with it, so an engine never
 *   waits for the run's close to end a command for it.
 * - The run confirms. `CommandContainment.close()` runs after every engine
 *   has closed, stops whatever was left unstopped, and rejects with
 *   `StopUnconfirmedError` naming each command whose end the run could not
 *   establish. An engine therefore plumbs no stop result anywhere: a stop
 *   it made and could not confirm is reported by the run's close.
 */
export interface ContainedCommand {
  /**
   * The command's own process: the start gate execs it in place, so the pid,
   * the streams and the exit are the command's. It leads a session of its
   * own, so a terminal's interrupt reaches it only through the run.
   */
  readonly child: ChildProcess;
  readonly reach: ContainmentReach;
  /**
   * End the command and everything within its reach, and confirm the end.
   * Every call shares the first call's stop and its bounds. Never rejects.
   */
  stop(bounds?: StopBounds): Promise<StopOutcome>;
}

/**
 * How far a contained command's ownership reaches, fixed when `contain()`
 * resolves.
 *
 * - `scope`: the command runs in a scope of its own, created around it
 *   before its first instruction, so every process it ever starts is born
 *   there and stays there — reparented, in a new session or a new process
 *   group alike — and a confirmed stop means none of them is left.
 * - `process-group`: no scope could be had, and `reason` says why (no user
 *   manager answers, or the manager refused or did not confirm the scope).
 *   The command leads a process group of its own and a stop ends that
 *   group. A descendant that starts a session or group of its own leaves the
 *   run's reach, and nothing here can see it go.
 *
 * Each command takes a scope of its own under either worker scope grouping,
 * because a deadline or a cancellation stops one attempt's command without
 * touching another worker's processes.
 */
export type ContainmentReach = { kind: "scope"; unit: string } | { kind: "process-group"; reason: string };

/** Where one standard stream of a contained command goes. */
export type ContainedStream = "ignore" | "pipe" | "inherit";

/** What a contained command carries through: its environment, working directory and three standard streams. */
export interface ContainOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio: readonly [ContainedStream, ContainedStream, ContainedStream];
}

export interface CommandContainmentOptions {
  /** The bounds `close()` stops each remaining command within. */
  stopBounds?: StopBounds;
}

/**
 * One run's contained commands. It is the run's, not the scope manager's: a
 * manager the caller supplied may outlive the run or serve another, and this
 * closes with the run either way, ending the commands the run started and
 * nothing else the manager holds.
 */
export class CommandContainment {
  #scopes: WorkerScopes;
  #stopBounds: StopBounds;
  /** Distinguishes this run's command groups on a manager another run may share. */
  #label = randomUUID().slice(0, 8);
  #count = 0;
  /** Commands whose end the run has not established: not yet stopped, or stopped without confirmation. */
  #owned = new Set<Contained>();
  /** Containments under way, so `close()` stops a command whose start it raced. */
  #containing = new Set<Promise<unknown>>();
  #closing: Promise<void> | null = null;

  constructor(scopes: WorkerScopes, options: CommandContainmentOptions = {}) {
    this.#scopes = scopes;
    this.#stopBounds = options.stopBounds ?? DEFAULT_STOP_BOUNDS;
  }

  /**
   * Start a command inside run-owned containment. `name` says what the
   * command is to an operator reading a teardown report (`opencode run`).
   * Resolves once the command is running inside its reach. Rejects only when
   * the command cannot start — its executable does not resolve (an error
   * shaped like Node's own spawn failure, `code` ENOENT or EACCES), or the
   * containment is closed — and then nothing ran. A manager that cannot
   * give the command a scope still starts it, at `process-group` reach.
   */
  async contain(name: string, file: string, args: readonly string[], options: ContainOptions): Promise<ContainedCommand> {
    if (this.#closing !== null) {
      throw new EnsembleError(`the run's command containment is closed; ${name} was not started`);
    }
    const containing = this.#containBehindGate(name, file, args, options);
    const tracked = containing.catch(() => undefined);
    this.#containing.add(tracked);
    try {
      return await containing;
    } finally {
      this.#containing.delete(tracked);
    }
  }

  async #containBehindGate(name: string, file: string, args: readonly string[], options: ContainOptions): Promise<ContainedCommand> {
    const gated = await spawnGated(file, args, options);
    const pid = gated.child.pid!;
    this.#count += 1;
    const group = `command-${this.#label}-${this.#count}`;
    // The command is blocked at its gate and cannot have started anything,
    // so the scope is created around it alone, and the placement confirms
    // the move from the process's own cgroup line before the gate opens.
    let placement: ScopePlacement;
    try {
      placement = await this.#scopes.place(group, [pid]);
    } catch (error) {
      // Placement never rejects by contract. A manager that breaks it must
      // not leave a shell waiting at a gate nobody will open.
      gated.child.kill("SIGKILL");
      throw error;
    }
    let reach: ContainmentReach;
    let stopper: (bounds: StopBounds) => Promise<StopOutcome>;
    if (placement.kind === "placed") {
      reach = { kind: "scope", unit: placement.unit };
      stopper = (bounds) => this.#scopes.stop(group, bounds);
    } else {
      reach = {
        kind: "process-group",
        reason: placement.kind === "unavailable" ? "no systemd user manager is reachable" : `the manager gave the command no scope: ${placement.reason}`
      };
      // A refusal can follow a scope the manager accepted and had not yet
      // filled, so the stop covers the group's scope as well as the process
      // group; a group the manager holds no scope for costs it nothing.
      stopper = async (bounds) => worstOf(await Promise.all([stopProcessGroup(pid, bounds), this.#scopes.stop(group, bounds)]));
    }
    const command = new Contained(name, gated.child, reach, stopper, (stopped, outcome) => {
      if (unestablished(stopped, outcome) === null) {
        this.#owned.delete(stopped);
      }
    });
    this.#owned.add(command);
    gated.open();
    return command;
  }

  /**
   * End the run's remaining commands and confirm every command the run
   * started has ended: the run's statement that its workers' commands have
   * stopped. Containment is refused once close has begun; one already under
   * way finishes first and is stopped with the rest. Rejects with
   * `StopUnconfirmedError` naming each command whose end could not be
   * established — processes within its reach outlived the stop, or it was
   * cut short at `process-group` reach, where a process that left the group
   * was never visible. Later calls share the first call's outcome.
   */
  close(): Promise<void> {
    this.#closing ??= this.#closeOnce();
    return this.#closing;
  }

  async #closeOnce(): Promise<void> {
    await Promise.all([...this.#containing]);
    const accounts = await Promise.all(
      [...this.#owned].map(async (command) => ({ command, outcome: await command.stop(this.#stopBounds) }))
    );
    const unconfirmed = accounts.flatMap(({ command, outcome }) => {
      const reason = unestablished(command, outcome);
      return reason === null ? [] : [{ owner: command.owner, reason }];
    });
    if (unconfirmed.length > 0) {
      throw new StopUnconfirmedError(unconfirmed);
    }
  }
}

/**
 * The one judgement of whether a stopped command's end is established; null
 * when it is. An unconfirmed stop never is. A confirmed stop is, except for
 * a command cut short — still running when it was stopped — at
 * `process-group` reach: its group is observed empty, but what it had
 * started outside the group is exactly what the run cannot see, and the
 * run says so rather than report the work stopped. A command that ended by
 * itself at that reach is taken at its exit, as every worker's is on a
 * machine without a scope manager.
 */
function unestablished(command: Contained, outcome: StopOutcome): string | null {
  if (outcome.kind === "unconfirmed") {
    return outcome.reason;
  }
  if (command.reach.kind === "process-group" && command.cutShort) {
    return `cut short without a scope (${command.reach.reason}): its process group ended, and a process it started outside that group was never visible to the run`;
  }
  return null;
}

/** A contained command whose stop is one shared, never-rejecting promise. */
class Contained implements ContainedCommand {
  readonly child: ChildProcess;
  readonly reach: ContainmentReach;
  /** Whether the first stop found the command still running. */
  cutShort = false;
  #name: string;
  #stopper: (bounds: StopBounds) => Promise<StopOutcome>;
  #onStopped: (command: Contained, outcome: StopOutcome) => void;
  #stopping: Promise<StopOutcome> | null = null;

  constructor(
    name: string,
    child: ChildProcess,
    reach: ContainmentReach,
    stopper: (bounds: StopBounds) => Promise<StopOutcome>,
    onStopped: (command: Contained, outcome: StopOutcome) => void
  ) {
    this.#name = name;
    this.child = child;
    this.reach = reach;
    this.#stopper = stopper;
    this.#onStopped = onStopped;
  }

  /** How the operator finds the command's processes: its scope, or its process group. */
  get owner(): string {
    return `${this.#name} in ${this.reach.kind === "scope" ? this.reach.unit : `process group ${this.child.pid ?? "unknown"}`}`;
  }

  stop(bounds: StopBounds = DEFAULT_STOP_BOUNDS): Promise<StopOutcome> {
    if (this.#stopping === null) {
      this.cutShort = this.child.exitCode === null && this.child.signalCode === null;
      this.#stopping = this.#stopper(bounds)
        .catch((error: unknown): StopOutcome => ({ kind: "unconfirmed", reason: error instanceof Error ? error.message : String(error) }))
        .then((outcome) => {
          this.#onStopped(this, outcome);
          return outcome;
        });
    }
    return this.#stopping;
  }
}

/**
 * The start gate a contained command passes through: a shell that waits on
 * descriptor 3 for one line, closes it, and execs the command in place, so
 * the command keeps the shell's pid and nothing of the gate survives into
 * it. A gate that closes without that line ends the shell (status 125)
 * before the command ever runs.
 */
const START_GATE = 'IFS= read -r go <&3 || exit 125; exec 3<&-; exec "$@"';

/** A command spawned and waiting at its gate; `open()` lets it run. */
interface GatedSpawn {
  child: ChildProcess;
  open(): void;
}

/**
 * Spawn a command behind the start gate, leading a session and process group
 * of its own. The executable is resolved first, against the command's own
 * `PATH` and working directory, so a missing or non-executable command
 * rejects here with the error a bare spawn would raise, rather than
 * surfacing as the gate shell's exit status.
 */
async function spawnGated(file: string, args: readonly string[], options: ContainOptions): Promise<GatedSpawn> {
  const executable = await resolveExecutable(file, args, options);
  const child = spawn("/bin/sh", ["-c", START_GATE, "ensemble-contained", executable, ...args], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdio: [...options.stdio, "pipe"],
    detached: true
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const gate = child.stdio[3] as Writable;
  // The gate's far end closes when the command execs, or when the shell
  // dies at the gate; either way a write error here has nothing to tell.
  gate.on("error", () => undefined);
  return {
    child,
    open: () => {
      gate.end("go\n");
    }
  };
}

/** The executable a command name resolves to, searched as `execvp` would; rejects shaped like Node's own spawn failure. */
async function resolveExecutable(file: string, args: readonly string[], options: ContainOptions): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const searchPath = (options.env ?? process.env).PATH ?? "";
  const candidates = file.includes("/")
    ? [path.resolve(cwd, file)]
    : searchPath.split(":").map((directory) => path.resolve(cwd, directory.length > 0 ? directory : ".", file));
  let code: "ENOENT" | "EACCES" = "ENOENT";
  for (const candidate of candidates) {
    const isFile = await stat(candidate).then(
      (found) => found.isFile(),
      () => false
    );
    if (!isFile) continue;
    const executable = await access(candidate, constants.X_OK).then(
      () => true,
      () => false
    );
    if (executable) {
      return candidate;
    }
    code = "EACCES";
  }
  throw Object.assign(new Error(`spawn ${file} ${code}`), {
    code,
    errno: -osConstants.errno[code],
    syscall: `spawn ${file}`,
    path: file,
    spawnargs: [...args]
  });
}

/**
 * End a process group and confirm it emptied: SIGTERM, the grace, SIGKILL,
 * the confirmation window. The group's id stays allocated while any member
 * lives, so a signal sent while the group is observed live cannot reach an
 * unrelated group that recycled the id.
 */
async function stopProcessGroup(pgid: number, bounds: StopBounds): Promise<StopOutcome> {
  if (!groupLive(pgid)) {
    return { kind: "stopped" };
  }
  signalGroup(pgid, "SIGTERM");
  if (await waitUntil(() => !groupLive(pgid), bounds.stopGraceMs)) {
    return { kind: "stopped" };
  }
  signalGroup(pgid, "SIGKILL");
  if (await waitUntil(() => !groupLive(pgid), bounds.confirmMs)) {
    return { kind: "stopped" };
  }
  return {
    kind: "unconfirmed",
    reason: `process group ${pgid} outlived SIGTERM by ${bounds.stopGraceMs}ms and SIGKILL by ${bounds.confirmMs}ms`
  };
}

/** Whether any process remains in the group; one the user may not signal still counts. */
function groupLive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group emptied between the check and the signal: the state wanted.
  }
}

/** The weaker of several stops over one command: unconfirmed if any part was. */
function worstOf(outcomes: readonly StopOutcome[]): StopOutcome {
  const reasons = outcomes.flatMap((outcome) => (outcome.kind === "unconfirmed" ? [outcome.reason] : []));
  return reasons.length === 0 ? { kind: "stopped" } : { kind: "unconfirmed", reason: reasons.join("; ") };
}
