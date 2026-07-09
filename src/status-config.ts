import { statSync } from "node:fs";
import path from "node:path";

// Values of ENSEMBLE_STATUS that switch the side-channel off. Anything else
// (including unset) leaves it on.
const DISABLED_VALUES = new Set(["0", "off", "false", "no"]);

/**
 * Resolves where the live status snapshot is written and read.
 *
 * The status side-channel is an ambient observability concern — the user's
 * environment, not the workflow author's per-run choice — so it is configured
 * by environment variable rather than a CLI tuning flag:
 *
 * - `ENSEMBLE_STATUS=off` (or `0`/`false`/`no`) disables it entirely.
 * - `ENSEMBLE_STATUS_DIR` overrides the directory.
 * - Otherwise it uses the run cwd's `.claude` directory, if already present.
 *
 * Returns the directory, or `null` when disabled. Resolving at the process edge
 * (the bin) gives direct file consumers one stable cwd-local location.
 */
export function resolveStatusDir(env: NodeJS.ProcessEnv, cwd: string): string | null {
  const toggle = (env.ENSEMBLE_STATUS ?? "").trim().toLowerCase();
  if (DISABLED_VALUES.has(toggle)) {
    return null;
  }

  const explicit = env.ENSEMBLE_STATUS_DIR?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const localClaudeDir = path.join(cwd, ".claude");
  try {
    return statSync(localClaudeDir).isDirectory() ? localClaudeDir : null;
  } catch {
    return null;
  }
}
