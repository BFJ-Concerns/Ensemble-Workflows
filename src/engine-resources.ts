import { homedir } from "node:os";
import path from "node:path";

import { launchEnvironment } from "./engine-environment.js";

import type { ResourceRequirement } from "./resource-preflight.js";
import type { EngineName } from "./types.js";

/**
 * What each engine needs from the filesystem, declared as resource
 * requirements the preflight probes before the engine's first attempt
 * (`EngineResourceGate`). A resolver is pure path arithmetic over the
 * environments below — no I/O; the gate does the probing — and is asked
 * only when its engine is first used, so a run needs only the resolvers
 * of the engines its script names.
 */
export interface EngineResourceEnvironment {
  /**
   * The environment the engine's process is launched with
   * (`launchEnvironment`). Every path the engine itself chooses — its home,
   * its config directory, its own sockets — resolves from this, never from
   * the launcher's `process.env`, which a machine declaration can override.
   */
  worker: NodeJS.ProcessEnv;
  /**
   * The launcher's own environment. Paths the adapter creates on the
   * engine's behalf from this process — temporary files under `tmpdir()`,
   * socket directories under `TMUX_TMPDIR` — resolve from this, because
   * the adapter makes them here and not in the engine's process.
   */
  launcher: NodeJS.ProcessEnv;
  /** The directory the engine's process is launched in, against which a relative path resolves. */
  cwd: string;
}

export type EngineResourceResolver = (env: EngineResourceEnvironment) => ResourceRequirement[];

/**
 * Codex keeps its whole state under one home: `CODEX_HOME` when the launch
 * environment sets it, else `.codex` under that environment's `HOME`. A
 * Codex caller in a sandbox that leaves that home read-only sees the
 * app-server refuse with `Read-only file system` after the run has begun;
 * this requirement turns that into a refusal before the app-server starts.
 */
export function codexResources(env: EngineResourceEnvironment): ResourceRequirement[] {
  const declared = env.worker.CODEX_HOME;
  const home =
    declared !== undefined && declared.length > 0
      ? { path: path.resolve(env.cwd, declared), from: "CODEX_HOME" }
      : { path: path.join(homeOf(env.worker), ".codex"), from: "default: $HOME/.codex" };
  return [{ owner: "codex", role: "Codex home", path: home.path, access: "create-entries", resolvedFrom: home.from }];
}

/**
 * Claude's requirements are not yet resolved. What they cover: the config
 * directory (`CLAUDE_CONFIG_DIR`, else `.claude` under the home — resolved
 * the way the control plane resolves its projects directory, so the two
 * never disagree); the directory the Claude daemon binds its sockets under
 * (`bind-socket`; observed as `/tmp/cc-daemon-<uid>`, where a sandboxed
 * caller met `EPERM` listening — how Claude Code chooses it is unmeasured);
 * and, from the launcher environment, the per-dispatch settings directories
 * under `tmpdir()` and the valve socket directories under `TMUX_TMPDIR`
 * (else `/tmp`), each read from the same expression the control plane
 * creates them with.
 */
export function claudeResources(): ResourceRequirement[] {
  throw new Error("the claude engine's resource requirements are not yet resolved (src/engine-resources.ts)");
}

/**
 * opencode's requirements are not yet resolved. What they cover: the
 * directories `opencode run` writes its data, state and configuration
 * under, resolved from the launch environment's XDG variables as opencode
 * resolves them (unmeasured).
 */
export function openCodeResources(): ResourceRequirement[] {
  throw new Error("the opencode engine's resource requirements are not yet resolved (src/engine-resources.ts)");
}

/** One resolver per engine: a new engine cannot be added without declaring what it needs. */
export const ENGINE_RESOURCE_RESOLVERS: Readonly<Record<EngineName, EngineResourceResolver>> = {
  codex: codexResources,
  claude: claudeResources,
  opencode: openCodeResources
};

/** An engine's requirements under the environment its adapter launches it with. */
export function engineResourceRequirements(
  engine: EngineName,
  declared: Readonly<Record<string, string>> | undefined,
  cwd: string,
  launcher: NodeJS.ProcessEnv = process.env
): ResourceRequirement[] {
  return ENGINE_RESOURCE_RESOLVERS[engine]({ worker: launchEnvironment(engine, declared, launcher), launcher, cwd });
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir();
}
