#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { programNameFor, runEnsembleCli } from "../cli.js";
import { nodeVersionError } from "../node-version.js";

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);

/**
 * Resolves once everything written to the stream so far has reached its
 * descriptor. A zero-length write's callback fires in order behind the
 * queued chunks, so the result or envelope on stdout and the diagnostics on
 * stderr are on the wire before the process ends — whatever the stream's
 * target (a pipe on Linux writes synchronously; a file or a TTY elsewhere
 * may not).
 */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

if (isMain) {
  const versionError = nodeVersionError();
  if (versionError !== null) {
    process.stderr.write(`${versionError}\n`);
    process.exitCode = 1;
  } else {
    const cwd = process.cwd();
    const exitCode = await runEnsembleCli(process.argv.slice(2), {
      cwd,
      programName: programNameFor(process.argv[1])
    });
    // The launcher's terminal work is done: the result or envelope is
    // printed, the record sealed, the sentinel written, the workers torn
    // down. Nothing the script body left pending — a timer it
    // forgot, a handle it never closed — may hold the orchestrator's shell
    // for the remainder of that timer, or let the opt-in `--timeout`
    // announce a deadline it then fails to enforce: the body is ordinary
    // Node, so the launcher ends the process itself with the code it
    // recorded, once its own output has reached the descriptors.
    process.exitCode = exitCode;
    await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
    process.exit(exitCode);
  }
}
