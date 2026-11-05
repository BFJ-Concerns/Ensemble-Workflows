import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { boundedEvidence } from "./operator-diagnosis.js";

/**
 * How a run groups its workers into systemd scopes: one scope per worker, or
 * one scope shared by every worker of the run. Codex workers are threads of
 * one app-server process, so in `worker` mode they share that process's
 * scope.
 */
export type WorkerScopeGrouping = "worker" | "run";

/** The group name every worker of a run shares under `run` grouping. */
export const RUN_SCOPE_GROUP = "run";

/**
 * The verdict on one placement. `placed` names the scope the processes now
 * sit in. `unavailable` is the fallback: no systemd user manager is
 * reachable, so the workers run where they were started — exactly as a
 * machine without systemd runs them. `refused` is a manager that answered
 * and would not place: the processes exited first, the unit could not be
 * created, the manager is closed. Placement never throws: a worker whose
 * scope could not be arranged is still a worker, and the caller records the
 * refusal rather than failing the dispatch.
 */
export type ScopePlacement =
  | { kind: "placed"; unit: string; pids: readonly number[] }
  | { kind: "unavailable" }
  | { kind: "refused"; reason: string };

/** The spawn options a launched command carries through unchanged: its streams, environment and working directory. */
export type LaunchOptions = Pick<SpawnOptions, "cwd" | "env" | "stdio">;

/**
 * Places worker processes into systemd user scopes inside the slice that
 * holds the launcher's own cgroup, so that whatever box the launcher runs
 * in — a terminal pane's scope, a run slice an admission tool made — also
 * contains its workers, and an out-of-memory kill or a memory reading there
 * covers the run or the worker rather than an unrelated pane.
 *
 * Two routes, for the two ways a worker process comes to exist:
 *
 * - `place()` adopts processes that already run — a Claude session the
 *   per-user supervisor forked, named by the roster's `pid`; a Codex
 *   app-server this process spawned — into the named group's scope,
 *   creating the scope on the group's first placement and attaching to it
 *   after. Linux never moves memory already charged when a process changes
 *   cgroup, so a caller places as soon as it knows the pid.
 * - `launch()` starts a command that may itself start a long-lived process
 *   nobody here owns — any `claude` invocation can start the per-user
 *   supervisor — in a transient scope of its own, under the user manager's
 *   default slice and outside the launcher's box. A supervisor started
 *   inside the box would die with it, taking every Claude session on the
 *   machine; one started here outlives the command in a scope of its own.
 *   The command's streams, environment, working directory and exit status
 *   pass through unchanged.
 *
 * The manager owns every scope it created and nothing else: `close()` stops
 * those scopes, and a scope `launch()` ran a command in is never one of
 * them, so teardown cannot reach the supervisor.
 */
export interface WorkerScopes {
  /** The slice that holds the launcher's cgroup, as discovered; null where none was found (the manager's default applies). */
  readonly slice: string | null;
  place(group: string, pids: readonly number[]): Promise<ScopePlacement>;
  launch(file: string, args: readonly string[], options: LaunchOptions): Promise<ChildProcess>;
  /** Stop every scope this manager created. Best-effort; never throws. */
  close(): Promise<void>;
}

export interface SystemdWorkerScopesOptions {
  /** The slice new worker scopes are created in. Omitted, the user manager's default slice. */
  slice?: string | null;
  /**
   * Distinguishes this launcher's units from another's on the same manager.
   * Defaults to this process's pid: a scope outlives its launcher only while
   * its processes do, so a recycled pid meeting a leftover scope joins it.
   */
  label?: string;
  busctlBin?: string;
  systemdRunBin?: string;
  systemctlBin?: string;
  /** The environment the systemd clients run under — it must carry the bus address or runtime directory. Defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /** The proc filesystem a placed process's cgroup is confirmed from. Defaults to `/proc`. */
  procDir?: string;
  /** How long a scope creation may take to move its processes before the placement is reported refused. */
  moveTimeoutMs?: number;
}

/** The scope manager over a reachable systemd user manager, driven through its D-Bus API by `busctl` and by `systemd-run`. */
export class SystemdWorkerScopes implements WorkerScopes {
  readonly slice: string | null;

  #label: string;
  #busctlBin: string;
  #systemdRunBin: string;
  #systemctlBin: string;
  #env: NodeJS.ProcessEnv;
  #procDir: string;
  #moveTimeoutMs: number;
  /** Units this manager created, by group: the set `close()` stops. */
  #units = new Map<string, string>();
  /** One placement at a time per group, so concurrent first placements create one scope rather than race for the name. */
  #groupTurns = new Map<string, Promise<unknown>>();
  #closed = false;

  constructor(options: SystemdWorkerScopesOptions = {}) {
    this.slice = options.slice ?? null;
    this.#label = options.label ?? String(process.pid);
    this.#busctlBin = options.busctlBin ?? "busctl";
    this.#systemdRunBin = options.systemdRunBin ?? "systemd-run";
    this.#systemctlBin = options.systemctlBin ?? "systemctl";
    this.#env = options.env ?? process.env;
    this.#procDir = options.procDir ?? "/proc";
    this.#moveTimeoutMs = options.moveTimeoutMs ?? 5_000;
  }

  /** The unit a group's processes are placed in: `ensemble-<label>-<group>.scope`, the group made unit-name safe. */
  unitFor(group: string): string {
    return `ensemble-${unitSafe(this.#label)}-${unitSafe(group)}.scope`;
  }

  async place(group: string, pids: readonly number[]): Promise<ScopePlacement> {
    if (this.#closed) {
      return { kind: "refused", reason: "the scope manager is closed" };
    }
    const turn = (this.#groupTurns.get(group) ?? Promise.resolve()).then(() => this.#placeInTurn(group, pids));
    this.#groupTurns.set(group, turn.catch(() => undefined));
    return turn;
  }

  async #placeInTurn(group: string, requested: readonly number[]): Promise<ScopePlacement> {
    if (this.#closed) {
      return { kind: "refused", reason: "the scope manager is closed" };
    }
    // A pid that exited between the caller's reading and this call makes
    // the manager refuse the whole list ("No such process"), so only live
    // processes are offered; one that exits after the check is retried
    // without, once.
    const unit = this.unitFor(group);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pids = requested.filter(isLive);
      if (pids.length === 0) {
        return { kind: "refused", reason: "every process to place had already exited" };
      }
      const outcome = this.#units.has(group) ? await this.#attach(unit, pids, true) : await this.#start(unit, pids, true);
      if (outcome === null) {
        this.#units.set(group, unit);
        // Creating a scope is a job the manager runs after answering, so
        // the move is confirmed from the processes' own cgroup lines before
        // it is reported: a caller reading memory for the scope straight
        // after must find the processes already charged to it.
        if (!(await this.#moved(unit, pids))) {
          return { kind: "refused", reason: `the manager accepted ${unit} but its processes had not moved within ${this.#moveTimeoutMs}ms` };
        }
        return { kind: "placed", unit, pids };
      }
      if (/No such process/.test(outcome)) {
        continue;
      }
      return { kind: "refused", reason: outcome };
    }
    return { kind: "refused", reason: "the processes to place exited while being placed" };
  }

  /**
   * Create the group's scope around these processes. A unit of that name
   * already loaded — a leftover of an earlier launcher with this label, or
   * a concurrent creation — is joined instead. Null on success; otherwise
   * the manager's refusal. Each route falls back to the other once: the
   * unit's state can change between the two calls, and a second flip is
   * reported rather than chased.
   */
  async #start(unit: string, pids: readonly number[], joinExisting: boolean): Promise<string | null> {
    // Delegate=yes is what lets later processes join: the manager refuses
    // to migrate processes into a non-delegated unit, and a group gains
    // members after its first — a run's later workers, a Codex app-server
    // joining a run scope, a replacement session the supervisor restarted.
    const properties = [
      ["PIDs", "au", String(pids.length), ...pids.map(String)],
      ["Delegate", "b", "true"],
      ...(this.slice !== null ? [["Slice", "s", this.slice]] : [])
    ];
    const started = await this.#manager("StartTransientUnit", "ssa(sv)a(sa(sv))", [
      unit,
      "fail",
      String(properties.length),
      ...properties.flat(),
      "0"
    ]);
    if (started === null || !joinExisting || !/already loaded/.test(started)) {
      return started;
    }
    return this.#attach(unit, pids, false);
  }

  /** Add processes to the group's existing scope; a scope that ended with its last process is created again. */
  async #attach(unit: string, pids: readonly number[], recreateGone: boolean): Promise<string | null> {
    const attached = await this.#manager("AttachProcessesToUnit", "ssau", [unit, "/", String(pids.length), ...pids.map(String)]);
    if (attached === null || !recreateGone || !/not loaded/.test(attached)) {
      return attached;
    }
    return this.#start(unit, pids, false);
  }

  /** Whether every listed process that is still alive sits in the unit, waited for up to the move timeout. */
  async #moved(unit: string, pids: readonly number[]): Promise<boolean> {
    const deadline = Date.now() + this.#moveTimeoutMs;
    for (;;) {
      const lines = await Promise.all(
        pids.map((pid) => readFile(path.join(this.#procDir, String(pid), "cgroup"), "utf8").catch(() => null))
      );
      if (lines.every((line) => line === null || line.trimEnd().endsWith(`/${unit}`))) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /**
   * The slice a launched command's scope goes in: the parent of the
   * launcher's own slice, so the command — and a supervisor it starts —
   * sits outside the box the launcher's slice draws, whether that box is
   * the slice itself or a scope inside it. A launcher in `agents-run1.slice`
   * launches into `agents.slice`; one in `agents.slice` or `app.slice`
   * launches into the user manager's root slice. Null where the launcher's
   * slice is unknown: the manager's default then applies.
   */
  get launchSlice(): string | null {
    return this.slice === null ? null : parentSlice(this.slice);
  }

  async launch(file: string, args: readonly string[], options: LaunchOptions): Promise<ChildProcess> {
    // `--scope` runs the command as systemd-run's own child with the
    // caller's streams, environment and working directory, and exits with
    // the command's status; the command and everything it starts sit in a
    // fresh scope in `launchSlice`, outside the launcher's own slice.
    // `--collect` lets a scope that failed be garbage collected like one
    // that ended cleanly. The caller's options go through untouched —
    // systemd-run finds the bus from the same environment the command
    // runs under, and an environment the caller narrowed (a run's own
    // settings withheld from a child that can start the supervisor) must
    // stay narrowed.
    const slice = this.launchSlice;
    return spawn(
      this.#systemdRunBin,
      [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        ...(slice !== null ? [`--slice=${slice}`] : []),
        `--description=ensemble: ${file} ${args[0] ?? ""}`.trimEnd(),
        "--",
        file,
        ...args
      ],
      options
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    // A placement already queued runs to its end before the units are
    // read: one accepted after the snapshot would otherwise leave a scope
    // nobody stops. Placements queued from here on are refused above.
    await Promise.all([...this.#groupTurns.values()]);
    this.#groupTurns.clear();
    const units = [...this.#units.values()];
    this.#units.clear();
    // Stopping a scope ends every process still in it — a worker's escaped
    // descendant included — which is what owning the scope means. A scope
    // whose processes already left is gone from the manager and the stop
    // reports it not loaded; that is the state wanted, not a failure.
    await Promise.all(
      units.map(
        (unit) =>
          new Promise<void>((resolve) => {
            execFile(this.#systemctlBin, ["--user", "stop", "--no-block", unit], { env: this.#env }, () => resolve());
          })
      )
    );
  }

  /** One call on the manager object. Null when it succeeded; otherwise the bounded text of its refusal. */
  #manager(method: string, signature: string, args: readonly string[]): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        this.#busctlBin,
        [
          "--user",
          "call",
          "org.freedesktop.systemd1",
          "/org/freedesktop/systemd1",
          "org.freedesktop.systemd1.Manager",
          method,
          signature,
          ...args
        ],
        { env: this.#env },
        (error, _stdout, stderr) => {
          resolve(error === null ? null : boundedEvidence(stderr.trim() || error.message));
        }
      );
    });
  }
}

/** The manager for a machine without a reachable systemd user manager: workers dispatch as they always have. */
export class NoWorkerScopes implements WorkerScopes {
  readonly slice = null;

  async place(): Promise<ScopePlacement> {
    return { kind: "unavailable" };
  }

  async launch(file: string, args: readonly string[], options: LaunchOptions): Promise<ChildProcess> {
    return spawn(file, [...args], options);
  }

  async close(): Promise<void> {}
}

export interface CreateWorkerScopesOptions extends Omit<SystemdWorkerScopesOptions, "slice"> {
  /** The proc filesystem the launcher's own cgroup is read from. Defaults to `/proc`. */
  procDir?: string;
}

/**
 * The manager for this machine: the systemd one where the user manager
 * answers on the bus, in the slice that holds this process's cgroup; the
 * no-op one otherwise. Probing is one bus round trip and one file read, done
 * once here so every later placement is a plain call.
 */
export async function createWorkerScopes(options: CreateWorkerScopesOptions = {}): Promise<WorkerScopes> {
  const { procDir = "/proc", ...systemd } = options;
  const env = systemd.env ?? process.env;
  if (!(await userManagerAnswers(systemd.busctlBin ?? "busctl", env))) {
    return new NoWorkerScopes();
  }
  const cgroup = await readFile(path.join(procDir, "self", "cgroup"), "utf8").catch(() => "");
  return new SystemdWorkerScopes({ ...systemd, slice: containingSlice(cgroup) });
}

/**
 * The slice unit that holds a process, read from its `/proc/<pid>/cgroup`
 * line (cgroup v2: `0::/user.slice/user-1000.slice/user@1000.service/agents.slice/pane.scope`).
 * Only the part below the user manager's own service counts — the slices
 * above it belong to the system manager — and a process sitting directly
 * in the user manager, or outside any user manager, has no containing
 * slice. A slice directory's name is its unit name (nesting is encoded in
 * the name itself: `agents-run1.slice` lives under `agents.slice`), so the
 * nearest `.slice` segment is the answer.
 */
export function containingSlice(cgroupFile: string): string | null {
  const line = cgroupFile.split("\n").find((entry) => entry.startsWith("0::"));
  if (line === undefined) {
    return null;
  }
  const segments = line.slice("0::".length).split("/").filter((segment) => segment.length > 0);
  const userManager = segments.findIndex((segment) => /^user@\d+\.service$/.test(segment));
  if (userManager === -1) {
    return null;
  }
  for (let index = segments.length - 1; index > userManager; index -= 1) {
    const segment = segments[index]!;
    if (segment.endsWith(".slice")) {
      return segment;
    }
  }
  return null;
}

/**
 * The slice a slice lives in, from systemd's naming: `agents-run1.slice`
 * lives in `agents.slice`, and a name with no dash lives in the root
 * slice, `-.slice`.
 */
export function parentSlice(slice: string): string {
  const name = slice.slice(0, -".slice".length);
  const dash = name.lastIndexOf("-");
  return dash === -1 ? "-.slice" : `${name.slice(0, dash)}.slice`;
}

/**
 * A process and every live descendant, read from the children lists the
 * proc filesystem keeps per thread — never from command lines. A caller
 * adopting a process the supervisor forked places the tree: helpers it
 * started before the placement (MCP servers, shells) are otherwise left in
 * the old cgroup, since a cgroup move takes one process at a time.
 */
export async function processTree(pid: number, procDir = "/proc"): Promise<number[]> {
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const taskDir = path.join(procDir, String(parent), "task");
    const tasks = await readdir(taskDir).catch(() => []);
    for (const task of tasks) {
      const children = await readFile(path.join(taskDir, task, "children"), "utf8").catch(() => "");
      for (const child of children.split(/\s+/).filter((entry) => /^\d+$/.test(entry)).map(Number)) {
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
  }
  return [...seen];
}

/** Whether the user manager answers on the bus: the one probe that decides between the systemd manager and the fallback. */
function userManagerAnswers(busctlBin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      busctlBin,
      ["--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.DBus.Peer", "Ping"],
      { env, timeout: 5_000 },
      (error) => resolve(error === null)
    );
  });
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A unit-name-safe rendering of a label: systemd allows letters, digits and `:-_.\`; everything else becomes `_`, and the length is bounded. */
function unitSafe(text: string): string {
  return text.replace(/[^A-Za-z0-9:_.-]/g, "_").slice(0, 64);
}
