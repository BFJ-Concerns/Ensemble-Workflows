import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import { settingToChange } from "./resource-location.js";
import type { ResourceLocation, SettingReading } from "./resource-location.js";

import { SubstrateRefusedError } from "./errors.js";

import type { LocatedDirectory } from "./resource-location.js";
import type { EngineName } from "./types.js";

/**
 * The resource-access preflight: before the launcher accepts a run, and
 * before each engine's substrate first starts, judge whether the launching
 * process can actually use the filesystem resources that work will need —
 * create entries in a home, bind a Unix socket under a directory — and
 * refuse up front, naming the resource and, where evidence names one, the
 * caller's sandbox and the mode that lifts it. Without it, a dispatching
 * session inside a sandbox learns the cause only from an engine's own error
 * after the run has begun (`Read-only file system` from the Codex
 * app-server, `EPERM` listening under `/tmp/cc-daemon-…` from Claude).
 *
 * Who declares what:
 *
 * - The launcher's own resources are declared and judged by the CLI at its
 *   acceptance boundary, so a refusal there is a rejected invocation — one
 *   line, exit 2, no sentinel, no archive (`judgeResources`).
 * - Each engine's resources are declared by that engine's resolver in
 *   `engine-resources.ts`, resolved from the environment the engine is
 *   launched with (`launchEnvironment`), and judged by `EngineResourceGate`
 *   immediately before that engine's first attempt — never at launch,
 *   because a run needs only the engines its script names. A refusal there
 *   is a substrate refusal: pre-spawn, availability-classed, advancing the
 *   call's fallback chain where an entry remains and otherwise failing the
 *   run.
 *
 * A probe creates its evidence under a name of its own — a private
 * directory, or a socket — and removes it before it returns, so a
 * preflight leaves nothing behind whether it passes or refuses. A requirement whose directory does
 * not exist yet is judged at its nearest existing ancestor, since creating
 * the missing levels is the first write its owner will make.
 */

/**
 * What the owner does under the requirement's directory:
 *
 * - `create-entries` — creates files and directories in it.
 * - `bind-socket` — listens on a Unix socket in it. Judged separately from
 *   `create-entries` because a sandbox can allow file writes under a path
 *   and still deny the socket (Claude's daemon socket is the observed case).
 */
export type ResourceAccess = "create-entries" | "bind-socket";

/** Whose resource it is: the launcher's own, or one engine's. */
export type ResourceOwner = "launcher" | EngineName;

/**
 * A directory the owner uses, the access it needs there, and — as
 * `location` — how the directory was chosen, from which a refusal names
 * the setting to change, shows a relative value against the directory it
 * was resolved against, and offers no setting where none moves it.
 * Producers build `path` and `location` together with the constructors in
 * `resource-location.ts`.
 */
export interface ResourceRequirement extends LocatedDirectory {
  owner: ResourceOwner;
  /** What the resource is for, as the refusal names it ("Codex home", "durable run record store"). */
  role: string;
  access: ResourceAccess;
}

/** One requirement the launching process failed: the error the probe met, where it met it. */
export interface ResourceDenial {
  requirement: ResourceRequirement;
  /** The directory the probe acted in: the requirement's own, or its nearest existing ancestor. */
  probedPath: string;
  /** The system error code (`EROFS`, `EACCES`, `EPERM`, `ENOTDIR`), or `unknown`. */
  code: string;
  message: string;
}

/** A sandbox around the launching process, as evidence identifies it. */
export interface CallerSandbox {
  /** The sandbox's name as its operator knows it ("Codex workspace-write"). */
  name: string;
  /** What identified it — an environment variable and its value, say — so the diagnosis is checkable. */
  evidence: string;
  /** The mode or setting that lifts it, as the operator would type or choose it. */
  lift: string;
}

/**
 * One way of recognising a sandbox around the launching process. `detect`
 * returns the evidence it matched, or null; it must match on evidence the
 * sandbox itself leaves — an environment variable it sets, a marker it
 * mounts — and never on the denial alone, since a read-only home or a full
 * disk produces the same errno without any sandbox.
 */
export interface CallerSandboxRule {
  name: string;
  lift: string;
  detect(env: NodeJS.ProcessEnv, denials: readonly ResourceDenial[]): string | null;
}

/**
 * The sandboxes the preflight can name, first match winning. Each rule
 * rests on measured evidence of what that sandbox leaves in its children's
 * environment. Where no rule matches, the refusal names the denied
 * resources without mentioning a sandbox.
 */
export const CALLER_SANDBOX_RULES: readonly CallerSandboxRule[] = [
  {
    // Codex workspace-write marks disabled networking or an active network
    // proxy. Either identifies Codex, not its filesystem policy, so a
    // filesystem or socket denial is also required.
    name: "Codex",
    lift: 'launch Ensemble with sandbox_mode="danger-full-access", or a permission profile granting these paths and Unix socket access',
    detect: (env, denials) => {
      const marker = ["CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_NETWORK_PROXY_ACTIVE"].find((key) => env[key] === "1");
      return marker !== undefined && denials.some((denial) => ["EROFS", "EACCES", "EPERM"].includes(denial.code))
        ? `${marker}=1; filesystem or socket access denied`
        : null;
    }
  }
];

export function diagnoseCallerSandbox(
  env: NodeJS.ProcessEnv,
  denials: readonly ResourceDenial[],
  rules: readonly CallerSandboxRule[] = CALLER_SANDBOX_RULES
): CallerSandbox | null {
  for (const rule of rules) {
    const evidence = rule.detect(env, denials);
    if (evidence !== null) {
      return { name: rule.name, evidence, lift: rule.lift };
    }
  }
  return null;
}

/**
 * The launch environment denied a resource the run or an engine needs.
 * A substrate refusal: raised before any worker exists, its remedy the
 * launch environment's rather than the script's.
 */
export class ResourcePreflightRefusedError extends SubstrateRefusedError {
  constructor(
    readonly denials: readonly ResourceDenial[],
    readonly sandbox: CallerSandbox | null
  ) {
    super(refusalMessage(denials, sandbox));
  }
}

function refusalMessage(denials: readonly ResourceDenial[], sandbox: CallerSandbox | null): string {
  const denied = denials.map((denial) => {
    const { requirement } = denial;
    const verb = requirement.access === "bind-socket" ? "bind a socket under" : "create entries in";
    const where = denial.probedPath === requirement.path ? "" : ` (probed at ${denial.probedPath})`;
    const who = requirement.owner === "launcher" ? "the launcher" : `the ${requirement.owner} engine`;
    const setting = settingToChange(requirement.location);
    const access = requirement.access === "bind-socket" ? "a directory where Unix socket binding is permitted" : "a writable directory";
    const remedy = setting === null
      ? `grant the launching process access to ${verb} this directory; no setting moves it`
      : `set ${setting} to ${access}, or grant the launching process access to ${verb} this directory`;
    return `cannot ${verb} ${requirement.path}${where}, ${who}'s ${requirement.role} (${describeLocation(requirement.location)}): ${denial.code}; ${remedy}`;
  });
  const cause = sandbox === null
    ? ""
    : ` — the launching process runs inside the ${sandbox.name} sandbox (${sandbox.evidence}), and access was denied; ${sandbox.lift}`;
  return `${denied.join("; ")}${cause}`;
}

function describeLocation(location: ResourceLocation): string {
  switch (location.kind) {
    case "declared": return `from ${describeReading(location.reading)}`;
    case "default": return `default: ${location.rule}${location.from === null ? "" : `; from ${describeReading(location.from)}`}`;
    case "fixed": return `fixed: ${location.rule}`;
  }
}

function describeReading(reading: SettingReading): string {
  return `${reading.setting}=${JSON.stringify(reading.value)}${reading.resolvedAgainst === null ? "" : `; relative to ${reading.resolvedAgainst}`}`;
}

/** Probe every requirement concurrently; the denials, in requirement order. */
export async function probeResources(requirements: readonly ResourceRequirement[]): Promise<ResourceDenial[]> {
  const outcomes = await Promise.all(requirements.map((requirement) => probeResource(requirement)));
  return outcomes.filter((denial): denial is ResourceDenial => denial !== null);
}

/** Probe and refuse: throws `ResourcePreflightRefusedError` when any requirement is denied. */
export async function judgeResources(
  requirements: readonly ResourceRequirement[],
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const denials = await probeResources(requirements);
  if (denials.length > 0) {
    throw new ResourcePreflightRefusedError(denials, diagnoseCallerSandbox(env, denials));
  }
}

/**
 * Exercise one requirement's access for real, and clean up after it. Null
 * when the access works; the denial otherwise. An error raised while
 * removing what the probe itself created propagates: that was this
 * process's to remove, and failing to is not a verdict on the requirement.
 */
export async function probeResource(requirement: ResourceRequirement): Promise<ResourceDenial | null> {
  const located = await nearestExistingDirectory(requirement.path);
  if ("code" in located) {
    return { requirement, probedPath: located.path, code: located.code, message: located.message };
  }
  return requirement.access === "bind-socket"
    ? probeSocketBinding(requirement, located.path)
    : probeEntryCreation(requirement, located.path);
}

async function probeEntryCreation(requirement: ResourceRequirement, dir: string): Promise<ResourceDenial | null> {
  let scratch: string;
  try {
    scratch = await mkdtemp(path.join(dir, ".ensemble-probe-"));
  } catch (error) {
    return denialOf(requirement, dir, error);
  }
  await rm(scratch, { recursive: true, force: true });
  return null;
}

/**
 * A Unix socket path is bounded (107 bytes on Linux), so the probe binds
 * directly in the directory under a 12-byte name: a directory too long for
 * that is too long for any socket its owner would bind there, and is
 * denied as such rather than reported as a sandbox's refusal.
 */
async function probeSocketBinding(requirement: ResourceRequirement, dir: string): Promise<ResourceDenial | null> {
  const socketPath = path.join(dir, `.ep-${randomBytes(4).toString("hex")}`);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    return {
      requirement,
      probedPath: dir,
      code: "ENAMETOOLONG",
      message: `a socket path under ${dir} exceeds the ${MAX_SOCKET_PATH_BYTES}-byte limit for a Unix socket`
    };
  }
  try {
    await listenOnce(socketPath);
  } catch (error) {
    return denialOf(requirement, dir, error);
  }
  // A failed bind created no socket. Probing its path again can itself
  // be denied and must not replace the access verdict.
  await rm(socketPath, { force: true });
  return null;
}

const MAX_SOCKET_PATH_BYTES = 107;

async function nearestExistingDirectory(
  target: string
): Promise<{ path: string } | { path: string; code: string; message: string }> {
  let current = path.resolve(target);
  for (;;) {
    try {
      const entry = await stat(current);
      if (entry.isDirectory()) {
        return { path: current };
      }
      return { path: current, code: "ENOTDIR", message: `${current} exists and is not a directory` };
    } catch (error) {
      const code = errnoOf(error);
      const parent = path.dirname(current);
      if (code !== "ENOENT" || parent === current) {
        return { path: current, code, message: messageOf(error) };
      }
      current = parent;
    }
  }
}

function listenOnce(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });
}

function denialOf(requirement: ResourceRequirement, probedPath: string, error: unknown): ResourceDenial {
  return { requirement, probedPath, code: errnoOf(error), message: messageOf(error) };
}

function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "unknown";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves resources against each attempt's placement and judges each
 * distinct resource set once per run. A relative worker home can name a
 * different path at each placement, so only identical requirements share a
 * judgement. Each refusal is a fresh error because the runtime attaches
 * per-attempt evidence to the error it records.
 */
export class EngineResourceGate {
  #requirementsOf: (engine: EngineName, cwd: string) => readonly ResourceRequirement[];
  #env: NodeJS.ProcessEnv;
  #judged = new Map<string, Promise<ResourceDenial[]>>();

  constructor(requirementsOf: (engine: EngineName, cwd: string) => readonly ResourceRequirement[], env: NodeJS.ProcessEnv = process.env) {
    this.#requirementsOf = requirementsOf;
    this.#env = env;
  }

  async require(engine: EngineName, cwd: string = process.cwd()): Promise<void> {
    const requirements = this.#requirementsOf(engine, cwd);
    const key = JSON.stringify([engine, requirements]);
    let judged = this.#judged.get(key);
    if (judged === undefined) {
      judged = probeResources(requirements).catch((error: unknown) => {
        // Cleanup failure is not an access verdict and no worker ran.
        // Let a later call probe afresh rather than caching this rejected
        // operation. Each waiter wraps the cause separately below.
        this.#judged.delete(key);
        throw error;
      });
      this.#judged.set(key, judged);
    }
    let denials: ResourceDenial[];
    try {
      denials = await judged;
    } catch (error) {
      throw new SubstrateRefusedError(`resource preflight for ${engine} could not finish: ${messageOf(error)}`, { cause: error });
    }
    if (denials.length > 0) {
      throw new ResourcePreflightRefusedError(denials, diagnoseCallerSandbox(this.#env, denials));
    }
  }
}
