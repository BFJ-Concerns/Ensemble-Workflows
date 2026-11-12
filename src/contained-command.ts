import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";

import { EnsembleError, StopUnconfirmedError, type UnestablishedStop } from "./errors.js";
import type { JsonObject } from "./types.js";
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
 * - The run says when it is ending. `CommandContainment.runEnding()` divides
 *   every stop by its occasion (`StopOccasion`): one that begins before it
 *   is an attempt's, one that begins after it is the run's teardown. The
 *   engine never says which, and never reads an abort's reason to find out.
 * - The attempt discloses its own. A worker stopped while the script runs —
 *   by its turn deadline, say — is a failure the script receives as a value,
 *   and what that stop could not establish is part of the same account: the
 *   engine puts `CommandStop.attemptAccount` on the attempt's result
 *   (`unestablishedStopDiagnostics`), and the run still ends as the script
 *   left it.
 * - The run confirms. `CommandContainment.close()` runs after every engine
 *   has closed, stops whatever was left unstopped, and rejects with
 *   `StopUnconfirmedError` naming each command whose end the run could not
 *   establish: one its own teardown cut short, or one an attempt left
 *   running within reach that is running still. An engine therefore plumbs
 *   nothing for a stop the run's ending caused.
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
   * Every call shares the first call's stop, its bounds and its occasion.
   * Never rejects.
   */
  stop(bounds?: StopBounds): Promise<CommandStop>;
}

/**
 * On whose account a stop is made, fixed when the stop begins.
 *
 * - `attempt`: the script is still running. The stop belongs to one
 *   attempt — its deadline expired, its call was cancelled, its command
 *   exited — and the worker's failure, where this is one, reaches the script
 *   as a value. Whatever the stop could not establish is that attempt's to
 *   disclose and never, by itself, fails the run.
 * - `run-ending`: the run has said it is ending (`runEnding()`), so the stop
 *   is its teardown cutting work short, and the run's close answers for it.
 */
export type StopOccasion = "attempt" | "run-ending";

/** What one stop of a contained command observed, and what the attempt that ran the command owes its account. */
export interface CommandStop {
  /** What was observed within the command's reach. */
  readonly outcome: StopOutcome;
  /**
   * The entry the attempt's account carries for this stop, or null where the
   * attempt has nothing to say: the command's end is established, or the
   * stop was the run's teardown and the run's close reports it. Non-null
   * only on the `attempt` occasion, for a command cut short where the run
   * could see no further than its process group, or one whose processes
   * within reach outlived the stop.
   */
  readonly attemptAccount: UnestablishedStop | null;
}

/** The key an attempt's `diagnostics` carries its unestablished stops under, on every engine. */
export const UNESTABLISHED_STOPS_DIAGNOSTIC = "unestablishedStops";

/**
 * The attempt-record form of the stops an attempt made: spread into the
 * attempt result's `diagnostics`, alike on a result that completed, one
 * that failed, and one a thrown failure carries (`attachFailedTurnResult`).
 * Empty where no stop left the attempt anything to disclose. The runtime
 * takes it from there — the attempt record keeps it and the run's event
 * stream announces it — so an engine reports a stop nowhere else.
 */
export function unestablishedStopDiagnostics(stops: readonly CommandStop[]): JsonObject {
  const accounts = stops.flatMap((stop) => (stop.attemptAccount === null ? [] : [{ ...stop.attemptAccount }]));
  return accounts.length === 0 ? {} : { [UNESTABLISHED_STOPS_DIAGNOSTIC]: accounts };
}

/** The unestablished stops an attempt's `diagnostics` carry; none where it carries none. */
export function unestablishedStopsOf(diagnostics: JsonObject | undefined): UnestablishedStop[] {
  const carried = diagnostics?.[UNESTABLISHED_STOPS_DIAGNOSTIC];
  if (!Array.isArray(carried)) {
    return [];
  }
  return carried.flatMap((entry: unknown) => {
    const { owner, reason } = (entry ?? {}) as { owner?: unknown; reason?: unknown };
    return typeof owner === "string" && typeof reason === "string" ? [{ owner, reason }] : [];
  });
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
  /** Commands the run's close still answers for: not yet stopped, or stopped with their end unestablished on the run's account. */
  #owned = new Set<Contained>();
  /** Containments under way, so `close()` stops a command whose start it raced. */
  #containing = new Set<Promise<unknown>>();
  #runEnding = false;
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
    let stopper: Stopper;
    // The manager keeps a scope it could not confirm empty and stops it
    // afresh when asked again, so one call serves both passes.
    const stopScope = (bounds: StopBounds): Promise<StopOutcome> => this.#scopes.stop(group, bounds);
    if (placement.kind === "placed") {
      reach = { kind: "scope", unit: placement.unit };
      stopper = { stop: stopScope, stopAgain: stopScope };
    } else {
      reach = {
        kind: "process-group",
        reason: placement.kind === "unavailable" ? "no systemd user manager is reachable" : `the manager gave the command no scope: ${placement.reason}`
      };
      // A refusal can follow a scope the manager accepted and had not yet
      // filled, so the stop covers the group's scope as well as the process
      // group; a group the manager holds no scope for costs it nothing.
      stopper = {
        stop: async (bounds) => worstOf(await Promise.all([stopProcessGroup(pid, bounds), stopScope(bounds)])),
        stopAgain: async (bounds) => worstOf(await Promise.all([processGroupEnded(pid, bounds), stopScope(bounds)]))
      };
    }
    const command = new Contained(
      name,
      gated.child,
      reach,
      stopper,
      () => (this.#runEnding ? "run-ending" : "attempt"),
      (stopped) => this.#owned.delete(stopped)
    );
    this.#owned.add(command);
    gated.open();
    return command;
  }

  /**
   * The run has begun to end: every stop that begins from here on is the
   * run's teardown (`StopOccasion`). Whoever ends the run calls this before
   * it cancels anything — synchronously, ahead of the first worker it tears
   * down — so no teardown stop is taken for an attempt's. `close()` implies
   * it. Calling it again changes nothing.
   */
  runEnding(): void {
    this.#runEnding = true;
  }

  /**
   * End the run's remaining commands and confirm every command the run
   * started has ended: the run's statement that its workers' commands have
   * stopped. Containment is refused once close has begun; one already under
   * way finishes first and is stopped with the rest. Rejects with
   * `StopUnconfirmedError` naming each command whose end the run could not
   * establish:
   *
   * - one the run's own teardown stopped, where processes within its reach
   *   outlived the stop, or where it was cut short at `process-group` reach
   *   and a process that left the group was never visible;
   * - one an attempt stopped and left running within its reach, which this
   *   close stops again and still cannot confirm.
   *
   * A command an attempt cut short at `process-group` reach is not named:
   * its group ended, the attempt's account already says what could not be
   * seen, and nothing here could learn more. Later calls share the first
   * call's outcome.
   */
  close(): Promise<void> {
    this.#closing ??= this.#closeOnce();
    return this.#closing;
  }

  async #closeOnce(): Promise<void> {
    this.runEnding();
    await Promise.all([...this.#containing]);
    const accounts = await Promise.all([...this.#owned].map((command) => command.stopForRun(this.#stopBounds)));
    const unconfirmed = accounts.flatMap((account) => (account === null ? [] : [account]));
    if (unconfirmed.length > 0) {
      throw new StopUnconfirmedError(unconfirmed);
    }
  }
}

/**
 * How a command's reach is stopped. `stop` ends everything within reach and
 * confirms the end. `stopAgain` is the run's close returning to a command
 * whose `stop`, made for an attempt, left processes running: it may be long
 * after, so it signals only what is still known to be the command's own.
 */
interface Stopper {
  stop(bounds: StopBounds): Promise<StopOutcome>;
  stopAgain(bounds: StopBounds): Promise<StopOutcome>;
}

/** A contained command whose stop is one shared, never-rejecting promise. */
class Contained implements ContainedCommand {
  readonly child: ChildProcess;
  readonly reach: ContainmentReach;
  #name: string;
  #stopper: Stopper;
  #occasionNow: () => StopOccasion;
  #release: (command: Contained) => void;
  /** The first stop: its occasion, whether it found the command still running, and what it observed. */
  #first: { occasion: StopOccasion; cutShort: boolean; observing: Promise<StopOutcome> } | null = null;
  #stop: Promise<CommandStop> | null = null;

  /**
   * `occasionNow` reads the run's state as a stop begins. `release` tells
   * the run its close no longer answers for the command.
   */
  constructor(
    name: string,
    child: ChildProcess,
    reach: ContainmentReach,
    stopper: Stopper,
    occasionNow: () => StopOccasion,
    release: (command: Contained) => void
  ) {
    this.#name = name;
    this.child = child;
    this.reach = reach;
    this.#stopper = stopper;
    this.#occasionNow = occasionNow;
    this.#release = release;
  }

  /** How the operator finds the command's processes: its scope, or its process group. */
  get owner(): string {
    return `${this.#name} in ${this.reach.kind === "scope" ? this.reach.unit : `process group ${this.child.pid ?? "unknown"}`}`;
  }

  stop(bounds: StopBounds = DEFAULT_STOP_BOUNDS): Promise<CommandStop> {
    this.#stop ??= this.#stopFirst(bounds);
    return this.#stop;
  }

  async #stopFirst(bounds: StopBounds): Promise<CommandStop> {
    const first = {
      occasion: this.#occasionNow(),
      cutShort: this.child.exitCode === null && this.child.signalCode === null,
      observing: observed(() => this.#stopper.stop(bounds))
    };
    this.#first = first;
    const outcome = await first.observing;
    const reason = this.#unestablished(outcome, first.cutShort);
    // The run's close answers for a stop its own ending made, and for
    // processes an attempt's stop left running within reach. An attempt's
    // stop that emptied everything it could reach leaves the close nothing
    // to do and nothing to learn, whatever the attempt has to disclose.
    if (reason === null || (first.occasion === "attempt" && outcome.kind === "stopped")) {
      this.#release(this);
    }
    return {
      outcome,
      attemptAccount: reason !== null && first.occasion === "attempt" ? { owner: this.owner, reason } : null
    };
  }

  /**
   * The run's close answering for this command: what it could not
   * establish, or null. A stop the run's ending made is final. One an
   * attempt made that left processes within reach is made again here — the
   * script may have run on long after it — and judged on what this pass
   * observes; what the attempt already disclosed about a process group's
   * limit is not said twice.
   */
  async stopForRun(bounds: StopBounds): Promise<UnestablishedStop | null> {
    await this.stop(bounds);
    const first = this.#first!;
    const outcome = await first.observing;
    if (first.occasion === "run-ending") {
      const reason = this.#unestablished(outcome, first.cutShort);
      return reason === null ? null : { owner: this.owner, reason };
    }
    if (outcome.kind === "stopped") {
      return null;
    }
    const again = await observed(() => this.#stopper.stopAgain(bounds));
    return again.kind === "stopped" ? null : { owner: this.owner, reason: again.reason };
  }

  /**
   * The one judgement of whether a stop established the command's end; null
   * when it did. An unconfirmed stop never does. A confirmed stop does,
   * except for a command cut short — still running when it was stopped — at
   * `process-group` reach: its group is observed empty, but what it had
   * started outside the group is exactly what the run cannot see, and
   * whoever answers for the stop says so rather than report the work
   * stopped. A command that ended by itself at that reach is taken at its
   * exit, as every worker's is on a machine without a scope manager.
   */
  #unestablished(outcome: StopOutcome, cutShort: boolean): string | null {
    if (outcome.kind === "unconfirmed") {
      return outcome.reason;
    }
    if (this.reach.kind === "process-group" && cutShort) {
      return `cut short without a scope (${this.reach.reason}): its process group ended, and a process it started outside that group was never visible to the run`;
    }
    return null;
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
 * End a process group and confirm no executing member remains: SIGTERM, the grace, SIGKILL,
 * the confirmation window. The group's id stays allocated while any member
 * lives, so a signal sent while the group is observed live cannot reach an
 * unrelated group that recycled the id.
 */
async function stopProcessGroup(pgid: number, bounds: StopBounds): Promise<StopOutcome> {
  if (!groupExists(pgid)) {
    return { kind: "stopped" };
  }
  signalGroup(pgid, "SIGTERM");
  if ((await observeGroupEnd(pgid, bounds.stopGraceMs, `process group ${pgid} outlived SIGTERM`)).kind === "stopped") {
    return { kind: "stopped" };
  }
  signalGroup(pgid, "SIGKILL");
  return observeGroupEnd(
    pgid,
    bounds.confirmMs,
    `process group ${pgid} outlived SIGTERM by ${bounds.stopGraceMs}ms and SIGKILL by ${bounds.confirmMs}ms`
  );
}

/**
 * Whether a process group an earlier stop sent SIGKILL has since emptied,
 * waited for within the confirmation window. Nothing is signalled: once the
 * group's members may all have gone its id can belong to an unrelated
 * group, and a kill already pending on a survivor needs no second one.
 */
async function processGroupEnded(pgid: number, bounds: StopBounds): Promise<StopOutcome> {
  return observeGroupEnd(
    pgid,
    bounds.confirmMs,
    `process group ${pgid} still held processes at the run's close, after the SIGKILL its attempt's stop sent`
  );
}

/** Observation failures leave the end unconfirmed, but never interrupt the stop's escalation. */
async function observeGroupEnd(pgid: number, boundMs: number, stillRunning: string): Promise<StopOutcome> {
  let observationError: string | null = null;
  const ended = await waitUntil(async () => {
    try {
      return !(await groupLive(pgid));
    } catch (error) {
      observationError = `could not observe process group ${pgid}: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }, boundMs);
  return ended ? { kind: "stopped" } : { kind: "unconfirmed", reason: observationError ?? stillRunning };
}

/** Make a stop so that it never rejects: an error raised in making it is an observation that could not be made. */
async function observed(stop: () => Promise<StopOutcome>): Promise<StopOutcome> {
  try {
    return await stop();
  } catch (error) {
    return { kind: "unconfirmed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether the group still exists, including unreaped zombie metadata. */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a group still has an executing process. A zombie answers a signal
 * check until its parent reaps it, but has stopped executing and closed its
 * files. Read membership and state together so zombie-only groups do not
 * turn a handled attempt failure into an unconfirmed teardown.
 */
async function groupLive(pgid: number): Promise<boolean> {
  if (!groupExists(pgid)) return false;
  let sawMember = false;
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const info = await readFile(`/proc/${name}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ESRCH") return null;
      throw error;
    });
    if (info === null) continue;
    // After the parenthesised command: state, ppid, process group.
    const fields = info.slice(info.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) !== pgid) continue;
    sawMember = true;
    // An exited thread-group leader can still have live worker threads.
    // num_threads is field 20, index 17 after the command name.
    if ((fields[0] !== "Z" && fields[0] !== "X") || Number(fields[17]) > 1) return true;
  }
  if (!sawMember && groupExists(pgid)) {
    // A group that exists but whose membership is not visible cannot be
    // declared stopped. observed() retains this as an unconfirmed account.
    throw new Error(`could not observe members of process group ${pgid} in /proc`);
  }
  return false;
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
