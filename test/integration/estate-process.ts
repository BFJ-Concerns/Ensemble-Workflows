import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  return result.stdout.trim();
}

export function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout?: number
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], timeout });
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
