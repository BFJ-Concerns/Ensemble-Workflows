import { access, mkdtemp, realpath, rm, symlink, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** Resolve once; the caller owns the private directory until the proof finishes. */
export async function selectClaudeExecutable(executable: string, temporaryRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<{
  executable: string;
  env: NodeJS.ProcessEnv;
  dispose: () => Promise<void>;
}> {
  const selected = await realpath(executable);
  await access(selected, constants.X_OK);
  const directory = await mkdtemp(path.join(temporaryRoot, "claude-proof-"));
  try {
    await symlink(selected, path.join(directory, "claude"));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    executable: selected,
    env: { ...env, PATH: [directory, env.PATH].filter(Boolean).join(path.delimiter) },
    dispose: () => rm(directory, { recursive: true, force: true })
  };
}

/** Only lifecycle fields, never raw daemon messages that might contain private data. */
export async function supervisorLifecycle(config: string): Promise<Record<string, string>[]> {
  let text: string;
  try {
    text = await readFile(path.join(config, "daemon.log"), "utf8");
  } catch (error) {
    return [{ event: "log-unavailable", code: (error as NodeJS.ErrnoException).code ?? "unknown" }];
  }
  return text.split("\n").flatMap<Record<string, string>>((line) => {
    const at = /^\[([^\]]+)\]/.exec(line)?.[1] ?? "unknown";
    const start = /daemon start .*version=([\w.-]+) pid=(\d+)/.exec(line);
    if (start) return [{ at, event: "start", version: start[1]!, pid: start[2]! }];
    const competing = /another daemon is already running \(pid=(\d+), version=([\w.-]+)/.exec(line);
    if (competing) return [{ at, event: "competing-start", pid: competing[1]!, version: competing[2]! }];
    const end = /shutting down \(cause=([\w_-]+), uptime=(\d+)s, leases=(\d+), live_workers=(\d+)/.exec(line);
    if (end) return [{ at, event: "shutdown", cause: end[1]!, uptime: end[2]!, leases: end[3]!, liveWorkers: end[4]! }];
    const settled = /bg settled ([\w-]+) \(([\w-]+)\)/.exec(line);
    if (settled) return [{ at, event: "settled", worker: settled[1]!, outcome: settled[2]! }];
    return [];
  });
}

export interface SupervisorIdentity {
  pid: number | null;
  startTicks: string | null;
  cgroup: string | null;
  version: string;
}

export type SupervisorTransition = "unchanged" | "upgrade" | "unexplained";

/** Snapshots must bracket the observations and retain the same ordered log prefix. */
export function classifySupervisorTransition(
  before: SupervisorIdentity,
  after: SupervisorIdentity,
  baseline: readonly Record<string, string>[],
  evidence: readonly Record<string, string>[]
): SupervisorTransition {
  if (before.pid === null || after.pid === null || before.startTicks === null || after.startTicks === null ||
      before.cgroup === null || after.cgroup === null) return "unexplained";
  if (before.pid === after.pid && before.startTicks === after.startTicks) {
    return before.cgroup === after.cgroup && before.version === after.version ? "unchanged" : "unexplained";
  }
  if (baseline.length === 0 || evidence.some((row) => row.event === "log-unavailable") ||
      baseline.some((row, index) => JSON.stringify(row) !== JSON.stringify(evidence[index]))) return "unexplained";
  const original = baseline.findLast((row) => row.event === "start" || row.event === "shutdown");
  if (original?.event !== "start" || original.pid !== String(before.pid) || original.version !== before.version) return "unexplained";
  const transitions = evidence.slice(baseline.length).filter((row) => row.event === "start" || row.event === "shutdown");
  return transitions.length === 2 && transitions[0]!.event === "shutdown" && transitions[0]!.cause === "upgrade" &&
    transitions[1]!.event === "start" && transitions[1]!.pid === String(after.pid) && transitions[1]!.version === after.version
    ? "upgrade" : "unexplained";
}
