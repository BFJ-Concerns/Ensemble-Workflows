import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { launchEnvironment, writtenEnvironment } from "./engine-environment.js";
import { declaredDirectory, defaultDirectory, fixedDirectory, readSetting } from "./resource-location.js";

import type { LocatedDirectory, SettingReading } from "./resource-location.js";
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
   * `worker` with each value as the operator wrote it (`writtenEnvironment`).
   * A reading quotes its value from here. The two differ only where the
   * launch rewrites a value — a relative Claude `CLAUDE_CONFIG_DIR`, made
   * absolute against the launcher's working directory — and there the
   * directory is still the one `worker` names: pair that path with the
   * reading of the written value, whose base is the directory the launch
   * resolved it against, rather than computing the path a second time.
   */
  written: NodeJS.ProcessEnv;
  /**
   * The launcher's own environment. Paths the adapter creates on the
   * engine's behalf from this process — temporary files under `tmpdir()`,
   * socket directories under `TMUX_TMPDIR` — resolve from this, because
   * the adapter makes them here and not in the engine's process. A
   * relative value here resolves against the launcher's working directory,
   * never `cwd`.
   */
  launcher: NodeJS.ProcessEnv;
  /**
   * The directory the engine's process is launched in, against which a
   * relative value in `worker` resolves: the worker's own placement, or
   * the run's base for an engine whose server the whole run shares.
   */
  cwd: string;
}

export type EngineResourceResolver = (env: EngineResourceEnvironment) => ResourceRequirement[];

/**
 * Codex keeps its whole state under one home: `CODEX_HOME` when the launch
 * environment sets it, else `.codex` under that environment's `HOME`. A
 * Codex caller in a sandbox that leaves that home read-only sees the
 * app-server refuse with `Read-only file system` after the run has begun;
 * this requirement turns that into a refusal before the app-server starts.
 *
 * Each branch builds the directory and its location in one call: the
 * setting in force, read as written against the directory Codex starts in;
 * or the default rule, with the setting that would place the home and the
 * `HOME` the rule starts from.
 */
export function codexResources(env: EngineResourceEnvironment): ResourceRequirement[] {
  const declared = env.written.CODEX_HOME;
  const home = declared
    ? declaredDirectory(readSetting("CODEX_HOME", declared, env.cwd))
    : defaultDirectory({ rule: "$HOME/.codex", movedBy: "CODEX_HOME" }, homeRoot(env.written, env.cwd), ".codex");
  return [{ owner: "codex", role: "Codex home", access: "create-entries", ...home }];
}

/** Claude Code 2.1.321: its daemon sockets are independent of TMPDIR. */
export function claudeResources(env: EngineResourceEnvironment): ResourceRequirement[] {
  const config = claudeConfigDirectory(env.worker, env.cwd);
  const uid = process.getuid?.() ?? 0;
  const daemonRoot = env.worker.TERMUX_VERSION && env.worker.PREFIX ? path.join(env.worker.PREFIX, "tmp") : "/tmp";
  const daemon = path.join(daemonRoot, `cc-daemon-${uid}`, createHash("sha256").update(config).digest("hex").slice(0, 8));
  const homeLocation = env.written.CLAUDE_CONFIG_DIR
    ? declaredDirectory(readSetting("CLAUDE_CONFIG_DIR", env.written.CLAUDE_CONFIG_DIR, process.cwd())).location
    : defaultDirectory({ rule: "$HOME/.claude", movedBy: "CLAUDE_CONFIG_DIR" }, homeRoot(env.written, env.cwd), ".claude").location;
  const home = { path: config, location: homeLocation };
  const global = env.written.CLAUDE_CONFIG_DIR
    ? home
    : defaultDirectory({ rule: "$HOME (.claude.json)", movedBy: "CLAUDE_CONFIG_DIR" }, homeRoot(env.written, env.cwd));
  const scratch = temporaryLocation(env.launcher, process.cwd(), "launcher ");
  const valve = env.launcher.TMUX_TMPDIR
    ? declaredDirectory(readSetting("launcher TMUX_TMPDIR", env.launcher.TMUX_TMPDIR, process.cwd()))
    : defaultDirectory({ rule: "/tmp", movedBy: "launcher TMUX_TMPDIR" }, "/tmp");
  const workerScratch = env.written.CLAUDE_CODE_TMPDIR
    ? declaredDirectory(readSetting("CLAUDE_CODE_TMPDIR", env.written.CLAUDE_CODE_TMPDIR, env.cwd), `claude-${uid}`)
    : temporaryLocation(env.written, env.cwd, "", `claude-${uid}`);
  return [
    { owner: "claude", role: "Claude home", access: "create-entries", ...home },
    { owner: "claude", role: "Claude global configuration", access: "create-entries", ...global },
    { owner: "claude", role: "daemon sockets", access: "bind-socket", ...fixedDirectory(`${daemonRoot}/cc-daemon-<uid>/<config hash>`, daemon) },
    { owner: "claude", role: "dispatch settings scratch files", access: "create-entries", ...scratch },
    { owner: "claude", role: "reply valve sockets", access: "bind-socket", ...valve },
    { owner: "claude", role: "Claude scratch files", access: "create-entries", ...workerScratch }
  ];
}

/** opencode's XDG homes and temporary directory, as reported by `opencode debug paths`. */
export function openCodeResources(env: EngineResourceEnvironment): ResourceRequirement[] {
  const homes = [
    ["XDG_DATA_HOME", ".local/share", "data"],
    ["XDG_CONFIG_HOME", ".config", "configuration"],
    ["XDG_STATE_HOME", ".local/state", "state"],
    ["XDG_CACHE_HOME", ".cache", "cache"]
  ] as const;
  return [
    ...homes.map(([key, fallback, role]): ResourceRequirement => ({
      owner: "opencode", role: `opencode ${role}`, access: "create-entries",
      ...(env.written[key]
        ? declaredDirectory(readSetting(key, env.written[key], env.cwd), "opencode")
        : defaultDirectory({ rule: `$HOME/${fallback}`, movedBy: key }, homeRoot(env.written, env.cwd), fallback, "opencode"))
    })),
    { owner: "opencode", role: "opencode scratch files", access: "create-entries", ...temporaryLocation(env.written, env.cwd, "", "opencode") }
  ];
}

/** Shared with the control plane so transcript reads and preflight use the same home. */
export function claudeConfigDirectory(env: NodeJS.ProcessEnv, cwd: string): string {
  return path.resolve(cwd, (env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), ".claude")).normalize("NFC"));
}

/** The launcher creates the tmux socket here, independently of the worker environment. */
export function claudeValveDirectory(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.TMUX_TMPDIR || "/tmp");
}

/** Node's Unix tmpdir selection; relative declarations resolve where the process starts. */
export function temporaryDirectory(env: NodeJS.ProcessEnv, cwd: string): LocatedDirectory {
  return temporaryLocation(env, cwd);
}

function temporaryLocation(env: NodeJS.ProcessEnv, cwd: string, qualifier = "", ...below: string[]): LocatedDirectory {
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    if (env[key]) return declaredDirectory(readSetting(`${qualifier}${key}`, env[key], cwd), ...below);
  }
  return defaultDirectory({ rule: "/tmp", movedBy: `${qualifier}TMPDIR` }, "/tmp", ...below);
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
  return ENGINE_RESOURCE_RESOLVERS[engine]({
    worker: launchEnvironment(engine, declared, launcher),
    written: writtenEnvironment(engine, declared, launcher),
    launcher,
    cwd
  });
}

/**
 * Where a default under the home directory starts: `HOME` as written,
 * read against `base`, or the account's home directory where the
 * environment sets none.
 */
function homeRoot(env: NodeJS.ProcessEnv, base: string): SettingReading | string {
  return env.HOME ? readSetting("HOME", env.HOME, base) : homedir();
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir();
}
