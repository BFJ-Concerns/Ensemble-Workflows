import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** The bundled launcher a skill install runs, invoked by absolute node path. */
export const bundledCliPath = path.resolve("skills/ensemble-workflow/Base/scripts/ensemble.mjs");

export interface LauncherResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the bundled launcher with `args`, collecting stdout, stderr and the exit code as a caller would. */
export function runLauncher(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<LauncherResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundledCliPath, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

export interface ArchivedAttempt {
  status: string;
  started_at: string | null;
  ended_at: string | null;
  token_usage_events: Array<{ last?: { totalTokens?: number }; total?: { totalTokens?: number } }>;
}

export interface ArchivedAgent {
  label: string | null;
  engine: string;
  status: string;
  resolved_cwd: string;
  parse_route: string | null;
  raw_output: string | null;
  validated_output: unknown;
  session: { id: string; turn: number } | null;
  attempts: ArchivedAttempt[];
  transcripts: Array<{ path: string }>;
  /** The run archive directory this record belongs to. */
  archiveDirectory: string;
}

/** Every agent record a run archived under `recordStore`, read back from disk as a later consumer would. */
export async function archivedAgents(recordStore: string): Promise<ArchivedAgent[]> {
  const agents: ArchivedAgent[] = [];
  for (const entry of await readdir(recordStore, { recursive: true })) {
    if (path.basename(entry) !== "agent.json") {
      continue;
    }
    const agentPath = path.join(recordStore, entry);
    const agent = JSON.parse(await readFile(agentPath, "utf8")) as Omit<ArchivedAgent, "archiveDirectory">;
    agents.push({ ...agent, archiveDirectory: path.resolve(path.dirname(agentPath), "../..") });
  }
  return agents;
}

/** The one archived agent carrying `label`. */
export async function archivedAgent(recordStore: string, label: string): Promise<ArchivedAgent> {
  const matches = (await archivedAgents(recordStore)).filter((agent) => agent.label === label);
  assert.equal(matches.length, 1, `expected one archived agent labelled ${label}, found ${matches.length}`);
  return matches[0] as ArchivedAgent;
}

/**
 * Runs every named check and fails once with all their failures, so a run
 * against a broken product records each product-evidence assertion it
 * breaks rather than only the first.
 */
export function assertEach(checks: Array<[name: string, check: () => void]>): void {
  const failures: string[] = [];
  for (const [name, check] of checks) {
    try {
      check();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message.split("\n").join(" ")}`);
    }
  }
  if (failures.length > 0) {
    assert.fail(
      `${failures.length} of ${checks.length} product-evidence checks failed:\n` +
        failures.map((failure) => `  - ${failure}`).join("\n")
    );
  }
}
