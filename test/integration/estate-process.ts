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

export function runNode(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeout?: number
): Promise<ProcessResult> {
  return runProcess(process.execPath, args, env, timeout);
}

export async function executablePath(name: string): Promise<string> {
  const result = await runProcess("which", [name], process.env);
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

export function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout?: number
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: exactStreamEnvironment(env),
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

function exactStreamEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  delete childEnv.FORCE_COLOR;
  delete childEnv.NO_COLOR;
  return childEnv;
}
