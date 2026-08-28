import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The suite runner's own isolation redirections (scripts/run-test-suite.mjs
 * exports them around every suite): the one enumerated exception to the
 * ambient strip below, because stripping them would send estate children's
 * archives and schema caches to the machine's real store — the exact
 * pollution the runner's per-run temp store exists to prevent. A test that
 * needs to escape them overrides explicitly (undefined removes the key).
 */
const SUITE_ISOLATION_KEYS = ["ENSEMBLE_RUN_RECORD_DIR", "ENSEMBLE_CODEX_SCHEMA_CACHE_DIRECTORY"];

/**
 * The child environment every estate spawn runs under: the inherited
 * environment with every harness-owned ambient key stripped — the whole
 * `ENSEMBLE_` prefix (bar the suite-isolation keys above), plus the colour
 * variables that break exact-stream assertions — and the caller's declared
 * overrides spread on top, so declared wins and everything undeclared
 * still inherits. An override explicitly set to `undefined` removes the
 * key from the child entirely. This closes the ambient-environment class
 * by construction: a machine exporting `ENSEMBLE_*` or `FORCE_COLOR`
 * cannot steer a spawned CLI or consumer, and a test that needs a harness
 * setting declares it. The hostile-ambient journey in
 * cli-process-estate.test.ts is the guard that arms this strip; it lives
 * in a different file on purpose, so the pair cannot be deleted together
 * without reddening.
 */
export function hermeticEstateEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const ambient =
      (key.startsWith("ENSEMBLE_") && !SUITE_ISOLATION_KEYS.includes(key)) ||
      key === "FORCE_COLOR" ||
      key === "NO_COLOR";
    if (!ambient) {
      env[key] = value;
    }
  }
  const composed: NodeJS.ProcessEnv = { ...env, ...overrides };
  for (const key of Object.keys(composed)) {
    if (composed[key] === undefined) {
      delete composed[key];
    }
  }
  return composed;
}

export function runNode(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
  timeout?: number
): Promise<ProcessResult> {
  return runProcess(process.execPath, args, envOverrides, timeout);
}

export async function executablePath(name: string): Promise<string> {
  const result = await runProcess("which", [name]);
  assert.equal(result.code, 0, `required executable ${name} is unavailable: ${result.stderr}`);
  const executable = result.stdout.trim();
  assert.ok(executable.length > 0, `required executable ${name} resolved to an empty path`);
  return executable;
}

export async function findOnlyFile(root: string, basename: string): Promise<string> {
  const entries = await readdir(root, { recursive: true });
  const matches = entries.filter((entry) => path.basename(entry) === basename);
  assert.equal(matches.length, 1, `expected one ${basename}, found ${matches.length}`);
  return path.join(root, matches[0] ?? "");
}

/**
 * Every estate child spawns through here (or composes its environment with
 * `hermeticEstateEnvironment` where it needs its own spawn mechanics), so
 * `envOverrides` is declared variables only — never a full environment:
 * spreading `process.env` into it would reintroduce the ambient keys the
 * base just stripped.
 */
export function runProcess(
  command: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
  timeout?: number
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: hermeticEstateEnvironment(envOverrides),
      stdio: ["ignore", "pipe", "pipe"],
      timeout
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
