import path from "node:path";

import { withoutRunScopedVariables } from "./ambient-settings.js";

import type { EngineName } from "./types.js";

/**
 * Declares the workspace sandboxed to every `claude` process the Claude
 * control plane launches. Claude Code (2.1.281 and later) gates background
 * dispatch on the directory's trust — accepted once, interactively, per
 * project directory, inherited by children but never by siblings — so a
 * scratch directory, a sibling checkout, or a generated worktree starts
 * untrusted.
 * With this variable set on the dispatching process the trust check answers
 * *sandboxed* for any resolvable directory and no dialog is owed; its only
 * other effect in the binary — project-declared permission rules no longer
 * gated on a person being present — is moot under the permission bypass
 * every worker already runs with. It is harness bookkeeping, not
 * configuration: it lands after the machine-declared worker environment,
 * like the ownership tag, and is never written to the operator's own Claude
 * configuration. A refusal that survives it is a substrate refusal
 * (`ClaudeDispatchError`), which the runtime treats as pre-spawn.
 */
export const SANDBOXED_WORKSPACE_VARIABLE = "CLAUDE_CODE_SANDBOXED";

/**
 * The environment of the process an engine adapter launches — the Codex
 * app-server, the `claude` control-plane commands, `opencode run` — built
 * from the launcher's own environment and the machine's declared variables
 * for that engine.
 *
 * This is the one definition: each adapter spawns with it, and the resource
 * preflight resolves the engine's homes from it (`engine-resources.ts`), so
 * a home the preflight judges is the home the engine will write. Resolving a
 * home from `process.env` directly would judge the wrong directory whenever
 * the machine configuration declares `CODEX_HOME`, `HOME` or the like for
 * that engine.
 *
 * Declared variables sit above inherited ones and everything undeclared
 * still inherits, so a configured parent keeps working unchanged. Claude's
 * processes additionally lose the run's own settings — a `claude` child can
 * start the per-user daemon, which must not be homed on this run's record or
 * status directories — and carry `SANDBOXED_WORKSPACE_VARIABLE` last, above
 * any declaration of the same name, because every `claude` launched must see
 * it or dispatch fails on trust.
 */
export function launchEnvironment(
  engine: EngineName,
  declared: Readonly<Record<string, string>> | undefined,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (engine === "claude") {
    const env: NodeJS.ProcessEnv = { ...withoutRunScopedVariables(inherited), ...declared, [SANDBOXED_WORKSPACE_VARIABLE]: "1" };
    // Dispatch runs in the worker's cwd; roster and stop commands run in
    // the launcher's. Keep a relative config directory on the same daemon
    // and transcript store across all those commands.
    if (env.CLAUDE_CONFIG_DIR) {
      env.CLAUDE_CONFIG_DIR = path.resolve(env.CLAUDE_CONFIG_DIR.normalize("NFC"));
    }
    return env;
  }
  return { ...inherited, ...declared };
}
