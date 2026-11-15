import { spawn } from "node:child_process";

import { workflowScriptReadError } from "./script-runner.js";

// A blocked filesystem open cannot be cancelled in Node's thread pool, and
// even process.exit waits for that pool. Keep the read in a process whose
// termination does not depend on the filesystem returning.
const readerSource = String.raw`
  const { lstatSync, readlinkSync, readFileSync, realpathSync } = require("node:fs");
  const { dirname, isAbsolute, join, resolve } = require("node:path");

  // Resolve process-relative symlinks against the launcher. Stop at an fd
  // magic link: its target may be an unnamed pipe or an unlinked file.
  function launcherPath(source) {
    if (process.platform !== "linux") return source;
    let pending = resolve(source).split("/");
    let directory = "/";
    let links = 0;
    while (pending.length > 0) {
      const part = pending.shift();
      if (!part || part === ".") continue;
      if (part === "..") { directory = dirname(directory); continue; }
      const candidate = join(directory, part);
      if (candidate === "/proc/self" || candidate === "/proc/thread-self") {
        directory = "/proc/" + process.argv[2];
      } else if (/^\/proc\/\d+\/(?:task\/\d+\/)?fd\/\d+$/.test(candidate)) {
        if (pending.some(Boolean)) {
          directory = realpathSync(candidate);
        } else {
          return candidate;
        }
      } else if (lstatSync(candidate).isSymbolicLink()) {
        if (++links > 40) throw Object.assign(new Error("too many symbolic links"), { code: "ELOOP" });
        const target = readlinkSync(candidate);
        if (isAbsolute(target)) directory = "/";
        pending = target.split("/").concat(pending);
      } else {
        directory = candidate;
      }
    }
    return directory;
  }

  try {
    process.stdout.write(readFileSync(launcherPath(process.argv[1])));
  } catch (error) {
    process.stderr.write(JSON.stringify({ message: error.message, code: error.code }));
    process.exitCode = 1;
  }
`;

/** Load source without leaving an uninterruptible filesystem request in the launcher. */
export async function readWorkflowSource(scriptPath: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e", readerSource, scriptPath, String(process.pid)], {
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
