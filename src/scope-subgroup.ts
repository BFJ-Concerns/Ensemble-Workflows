import { mkdir, readFile, readdir, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { cgroupEmpty, waitUntil, type StopBounds, type StopOutcome } from "./worker-scopes.js";

/**
 * A subgroup of a worker scope: a cgroup of its own, directly below the
 * scope's, that holds one process and everything it goes on to start.
 *
 * It exists for a scope several workers share (`run` grouping). The scope
 * is the run's one box — a memory reading or an out-of-memory kill there
 * covers every worker — so a command that belongs to the run has to sit
 * inside it; and one attempt's command still has to be stoppable without
 * touching the workers beside it, which a signal to the scope cannot do.
 * A subgroup gives both: its processes are the scope's, charged to it and
 * ended with it, and they are also a set of their own that can be listed,
 * signalled and confirmed gone.
 *
 * What makes that sound:
 *
 * - The scope manager creates every scope delegated (`Delegate=yes`), which
 *   hands the cgroup tree below the scope to the launcher. A subgroup is
 *   therefore made and removed here, through the cgroup filesystem, and the
 *   manager is never asked about it.
 * - No controller is enabled below the scope, so a subgroup accounts for
 *   nothing by itself: the charge stays with the scope, and processes may
 *   sit in the scope's own cgroup beside its subgroups.
 * - A cgroup's membership is inherited at fork and survives a new session,
 *   a new process group and reparenting, so entering the subgroup before a
 *   process has started anything puts everything it ever starts there.
 * - The manager's stop of the scope reaches its subgroups — it signals and
 *   observes the scope's whole tree — so a subgroup nobody stopped ends
 *   with the scope and needs no bookkeeping of its own.
 */
export interface ScopeSubgroup {
  /** The last segment of the subgroup's cgroup path, below the scope's. */
  readonly name: string;
  /**
   * End every process in the subgroup and confirm it empty, within
   * `bounds`: SIGTERM to each member, the grace, then a kill of the whole
   * subgroup and the confirmation window. Emptiness is read from the
   * subgroup's own cgroup, as a scope's is, and a subgroup confirmed empty
   * is removed. One whose scope has already ended holds nothing. Safe to
   * call again, after any outcome: it signals only what is in the subgroup
   * at that moment. Never rejects.
   */
  stop(bounds: StopBounds): Promise<StopOutcome>;
}

/** The verdict on entering a subgroup. `refused` leaves the process where it was, in the scope's own cgroup. */
export type ScopeSubgroupEntry = { kind: "entered"; subgroup: ScopeSubgroup } | { kind: "refused"; reason: string };

export interface ScopeSubgroupOptions {
  /** The proc filesystem the process's cgroup is read from. Defaults to `/proc`. */
  procDir?: string;
  /** The cgroup v2 mount the subgroup is made under. Defaults to `/sys/fs/cgroup`. */
  cgroupRoot?: string;
}

/**
 * Move a process the scope manager has placed in `unit` into a new subgroup
 * of that scope. The caller holds the process still while this runs — a
 * contained command waits at its start gate — because only a process that
 * has started nothing takes its whole future tree with it. `name` is one
 * path segment, unique within the scope for the scope's life. The move is
 * confirmed from the process's own cgroup line before it is reported. Never
 * rejects.
 */
export async function enterScopeSubgroup(unit: string, name: string, pid: number, options: ScopeSubgroupOptions = {}): Promise<ScopeSubgroupEntry> {
  const procDir = options.procDir ?? "/proc";
  const cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
  const scope = await cgroupOf(pid, procDir);
  if (scope === null || !scope.endsWith(`/${unit}`)) {
    return { kind: "refused", reason: `process ${pid} is not in ${unit}${scope === null ? "" : `: it is in ${scope}`}` };
  }
  const directory = path.join(cgroupRoot, scope, name);
  try {
    await mkdir(directory);
  } catch (error) {
    return { kind: "refused", reason: `${unit} could not be divided: ${messageOf(error)}` };
  }
  try {
    await writeFile(path.join(directory, "cgroup.procs"), String(pid));
  } catch (error) {
    await rmdir(directory).catch(() => undefined);
    return { kind: "refused", reason: `process ${pid} could not be moved into ${name} of ${unit}: ${messageOf(error)}` };
  }
  if ((await cgroupOf(pid, procDir)) !== `${scope}/${name}`) {
    // The process exited, or something else moved it: there is nothing here to stop.
    await rmdir(directory).catch(() => undefined);
    return { kind: "refused", reason: `process ${pid} did not stay in ${name} of ${unit}` };
  }
  return { kind: "entered", subgroup: new CgroupSubgroup(name, directory) };
}

class CgroupSubgroup implements ScopeSubgroup {
  readonly name: string;
  #directory: string;

  constructor(name: string, directory: string) {
    this.name = name;
    this.#directory = directory;
  }

  async stop(bounds: StopBounds): Promise<StopOutcome> {
    try {
      const empty = (): Promise<boolean> => cgroupEmpty(this.#directory);
      if (!(await empty())) {
        await signalMembers(this.#directory, "SIGTERM");
        if (!(await waitUntil(empty, bounds.stopGraceMs))) {
          await killMembers(this.#directory);
          if (!(await waitUntil(empty, bounds.confirmMs))) {
            const left = await members(this.#directory).catch(() => []);
            return {
              kind: "unconfirmed",
              reason: `${left.length > 0 ? `pids ${left.join(", ")}` : "processes"} in ${this.name} outlived SIGTERM by ${bounds.stopGraceMs}ms and SIGKILL by ${bounds.confirmMs}ms`
            };
          }
        }
      }
      // Gone already where the scope ended first; kept where the command
      // made cgroups of its own below it, which end with the scope.
      await rmdir(this.#directory).catch(() => undefined);
      return { kind: "stopped" };
    } catch (error) {
      return { kind: "unconfirmed", reason: `could not stop ${this.name}: ${messageOf(error)}` };
    }
  }
}

/** The cgroup v2 path a process sits in, from its own `/proc/<pid>/cgroup` line; null where it cannot be read. */
async function cgroupOf(pid: number, procDir: string): Promise<string | null> {
  const file = await readFile(path.join(procDir, String(pid), "cgroup"), "utf8").catch(() => "");
  const line = file.split("\n").find((entry) => entry.startsWith("0::"));
  return line === undefined ? null : line.slice("0::".length);
}

/** Every process in a cgroup and in the cgroups below it. A cgroup that is gone holds none. */
async function members(directory: string): Promise<number[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entries === null) return [];
  const own = (await readFile(path.join(directory, "cgroup.procs"), "utf8").catch(() => ""))
    .split(/\s+/)
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number);
  const below = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => members(path.join(directory, entry.name))));
  return [...own, ...below.flat()];
}

async function signalMembers(directory: string, signal: NodeJS.Signals): Promise<void> {
  for (const pid of await members(directory)) {
    try {
      process.kill(pid, signal);
    } catch {
      // It exited between the listing and the signal: the state wanted.
    }
  }
}

/**
 * SIGKILL to the whole subgroup. The kernel's own `cgroup.kill` (Linux
 * 5.14) reaches every member at once, a process forking as it is listed
 * included; a kernel without it gets the signal member by member.
 */
async function killMembers(directory: string): Promise<void> {
  try {
    await writeFile(path.join(directory, "cgroup.kill"), "1");
  } catch {
    await signalMembers(directory, "SIGKILL");
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
