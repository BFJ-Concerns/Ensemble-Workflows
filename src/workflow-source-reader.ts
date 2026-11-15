import { spawn } from "node:child_process";

import { workflowScriptReadError } from "./script-runner.js";

// A blocked filesystem open cannot be cancelled in Node's thread pool, and
// even process.exit waits for that pool. Keep the read in a process whose
// termination does not depend on the filesystem returning.
const readerSource = `
  const { readFileSync } = require("node:fs");
  try {
    process.stdout.write(readFileSync(process.argv[1]));
  } catch (error) {
    process.stderr.write(JSON.stringify({ message: error.message, code: error.code }));
    process.exitCode = 1;
  }
`;

/** Load source without leaving an uninterruptible filesystem request in the launcher. */
export async function readWorkflowSource(scriptPath: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e", readerSource, scriptPath], {
      // Paths such as /dev/stdin must refer to the launcher's input.
      stdio: ["inherit", "pipe", "pipe"]
    });
    let source = "";
    let diagnostic = "";
    let processError: Error | null = null;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { source += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { diagnostic += chunk; });
    child.on("error", (error) => { processError = error; });
    const abort = (): void => { child.kill("SIGKILL"); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("close", (code, terminatingSignal) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        reject(signal.reason);
      } else if (code === 0) {
        resolve(source);
      } else {
        let cause: unknown = processError ?? new Error(diagnostic || `Source reader ended with ${terminatingSignal ?? code}`);
        if (diagnostic.length > 0) {
          try {
            const details = JSON.parse(diagnostic) as { message: string; code?: string };
            cause = Object.assign(new Error(details.message), { code: details.code });
          } catch {
            // Non-JSON startup diagnostics remain the complete error message.
          }
        }
        reject(workflowScriptReadError(scriptPath, cause));
      }
    });
  });
}
