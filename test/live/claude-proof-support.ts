import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { readProcessStartTicks } from "../../src/process-owner-evidence.js";
import { access, mkdtemp, realpath, rm, symlink, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const exec = promisify(execFile);

/** Resolve once; the caller owns the private directory until the proof finishes. */
export async function selectClaudeExecutable(executable: string, temporaryRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<{
  executable: string;
  version: string | null;
  env: NodeJS.ProcessEnv;
  dispose: () => Promise<void>;
}> {
  let resolved = executable;
  if (!executable.includes(path.sep)) {
    resolved = "";
    for (const directory of (env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
      const candidate = path.resolve(directory, executable);
      try {
        await access(candidate, constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
        resolved = candidate;
        break;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    if (!resolved) throw new Error(`Executable ${executable} not found on PATH`);
  }
  const selected = await realpath(resolved);
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
    version: await claudeVersion(selected, env),
    env: { ...env, PATH: [directory, env.PATH].filter(Boolean).join(path.delimiter) },
    dispose: () => rm(directory, { recursive: true, force: true })
  };
}

/** A failed or unrecognised version response is unavailable evidence. */
async function claudeVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await exec(executable, ["--version"], { env });
    return /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?: \(Claude Code\))?\s*$/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

export type ClaudeVersionEvidence = "matching" | "mismatched" | "unavailable";

export function classifyClaudeVersion(selected: string | null, observed: string | null): ClaudeVersionEvidence {
  if (!selected || !observed) return "unavailable";
  return selected === observed ? "matching" : "mismatched";
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
  // Startup attempts log before acquiring the daemon lock. The observed
  // process, rather than the last attempt, identifies the serving supervisor.
  const original = baseline.findLastIndex(row => row.event === "start" && row.pid === String(before.pid) && row.version === before.version);
  if (original < 0 || baseline.slice(original + 1).some(row => row.event === "shutdown")) return "unexplained";
  const transitions = evidence.slice(baseline.length).filter((row) => row.event === "start" || row.event === "shutdown");
  return transitions.length === 2 && transitions[0]!.event === "shutdown" && transitions[0]!.cause === "upgrade" &&
    transitions[1]!.event === "start" && transitions[1]!.pid === String(after.pid) && transitions[1]!.version === after.version
    ? "upgrade" : "unexplained";
}

/** Read-only status, with the command's evidence retained even when it fails. */
export async function daemonStatus(executable: string, env: NodeJS.ProcessEnv): Promise<{ pid: number | null; code: number | string; stdout: string; stderr: string }> {
  let result: { code: number | string; stdout: string; stderr: string };
  try {
    const { stdout, stderr } = await exec(executable, ["daemon", "status"], { env });
    result = { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    result = { code: failed.code ?? "unknown", stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message };
  }
  const match = /^pid:\s+(\d+)/m.exec(result.stdout);
  return { ...result, pid: match === null ? null : Number(match[1]) };
}

/** Read-only PID lookup; a failed status command does not establish a live daemon. */
export async function daemonPid(executable: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  const status = await daemonStatus(executable, env);
  return status.code === 0 ? status.pid : null;
}

export async function supervisorSnapshot(executable: string, env: NodeJS.ProcessEnv, startAt: number | "current" = 0): Promise<{ selectedVersion: string | null; versionEvidence: ClaudeVersionEvidence; identity: SupervisorIdentity; lifecycle: Record<string, string>[]; offset: number }> {
  const pid = await daemonPid(executable, env);
  const all = await supervisorLifecycle(env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"));
  // The operator's log spans unrelated sessions. Retain the serving daemon's
  // start and subsequent lifecycle, using the same offset after the journey.
  const offset = startAt === "current" ? Math.max(0, all.findLastIndex(row => row.event === "start" && row.pid === String(pid))) : startAt;
  const lifecycle = all.slice(offset).filter(row => row.event !== "settled");
  const identity: SupervisorIdentity = {
    pid,
    startTicks: pid === null ? null : await readProcessStartTicks("/proc", pid),
    cgroup: pid === null ? null : await readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => null),
    version: lifecycle.findLast(row => row.event === "start" && row.pid === String(pid))?.version ?? ""
  };
  const selectedVersion = await claudeVersion(executable, env);
  return { selectedVersion, versionEvidence: classifyClaudeVersion(selectedVersion, identity.version), identity, lifecycle, offset };
}

export function assertSupervisorTransition(
  before: Awaited<ReturnType<typeof supervisorSnapshot>>,
  after: Awaited<ReturnType<typeof supervisorSnapshot>>,
  context: string
): string {
  const transition = classifySupervisorTransition(before.identity, after.identity, before.lifecycle, after.lifecycle);
  assert.notEqual(transition, "unexplained", `${context}: supervisor stopped, moved or changed without a recorded upgrade: ${JSON.stringify({ before, after })}`);
  return transition;
}


/** Fixed-version proof requires matching versions as well as valid lifecycle evidence. */
export function assertFixedClaudeVersion(
  before: Awaited<ReturnType<typeof supervisorSnapshot>>,
  after: Awaited<ReturnType<typeof supervisorSnapshot>>,
  context: string
): string {
  const transition = assertSupervisorTransition(before, after, context);
  assert.ok(before.selectedVersion && before.selectedVersion === after.selectedVersion &&
    classifyClaudeVersion(before.selectedVersion, before.identity.version) === "matching" &&
    classifyClaudeVersion(after.selectedVersion, after.identity.version) === "matching",
  `${context}: fixed-version proof lacks matching selected CLI and native supervisor versions: ${JSON.stringify({ before, after })}`);
  return transition;
}
