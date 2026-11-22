import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import type { StrippableCapability } from "./capability-stripping.js";
import { CapabilityStripUnsupportedError, LeanStartUnsupportedError } from "./errors.js";
import { captureProcessOwner, judgeOwnerGone } from "./process-owner-evidence.js";
import type { JsonObject } from "./types.js";

const LEAN_DIRECTORY_PREFIX = "ensemble-opencode-lean-";
const OWNER_FILENAME = "owner.json";
const OPENCODE_STRIP_TOOLS = { skills: "skill", agents: "task" } as const;

interface OpenCodeLaunchConfig {
  env: NodeJS.ProcessEnv;
  close?: () => Promise<void>;
}

interface ConfigCommandResult {
  exitCode: number | null;
  stdout: string;
}

/** Reclaim private profiles whose launcher is provably gone. */
export async function sweepAbandonedOpenCodeProfiles(): Promise<void> {
  const root = tmpdir();
  const host = hostname();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(LEAN_DIRECTORY_PREFIX)) continue;
    const directory = path.join(root, entry.name);
    try {
      const owner: unknown = JSON.parse(await readFile(path.join(directory, OWNER_FILENAME), "utf8"));
      if (await judgeOwnerGone(owner, "/proc", host) === "owner-process-gone") {
        await rm(directory, { recursive: true, force: true });
      }
    } catch {
      // An unreadable owner may belong to a launcher still writing its record.
    }
  }
}

/** Prepare an opt-in worker before sending the prompt. Config discovery can
 * return credentials and instructions, so its output stays inside the adapter. */
export async function prepareOpenCodeLaunch(options: {
  env: NodeJS.ProcessEnv;
  strip: readonly StrippableCapability[];
  lean: boolean;
  providerModel: string;
  run: (args: string[], env: NodeJS.ProcessEnv) => Promise<ConfigCommandResult>;
}): Promise<OpenCodeLaunchConfig> {
  const { env, strip, lean, providerModel, run } = options;
  if (!lean && strip.length === 0) return { env };
  const refuse = (detail: string): never => {
    if (lean) throw new LeanStartUnsupportedError("opencode", detail);
    throw new CapabilityStripUnsupportedError("opencode", strip[0]!, detail);
  };
  const readConfig = async (environment: NodeJS.ProcessEnv): Promise<JsonObject> => {
    const result = await run(["debug", "config"], environment);
    const config = result.exitCode === 0 ? parseObject(result.stdout) : null;
    return config ?? refuse("opencode debug config did not return readable configuration");
  };
  const original = await readConfig(env);
  if (!lean) {
    // External plugins can change the loaded agent configuration at startup.
    if (list(original.plugin).length > 0 && !/^(1|true)$/i.test(env.OPENCODE_PURE ?? "")) {
      refuse("active external plugins can change agent permissions after configuration is loaded");
    }
    const injected = parseConfigContent(env.OPENCODE_CONFIG_CONTENT || "{}");
    if (injected === null) return refuse("OPENCODE_CONFIG_CONTENT must be a JSONC object for a stripped worker");
    const denied = withStrippedPermissions(original, strip);
    const stripped = {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...injected,
        ...denied,
        agent: overlayAgentPermissions(denied.agent, injected.agent),
        ...(denied.mode === undefined ? {} : { mode: overlayAgentPermissions(denied.mode, injected.mode) })
      }),
      OPENCODE_PERMISSION: JSON.stringify(denied.permission)
    };
    verifyStrips(await readConfig(stripped), strip);
    return { env: stripped };
  }

  // Keep provider routes, credentials in the original data home, and
  // permission restrictions. Load the profile from private config paths so
  // opencode's usual discovery cannot add interactive context to it.
  const owner = await captureProcessOwner("/proc", hostname());
  const directory = await mkdtemp(path.join(tmpdir(), LEAN_DIRECTORY_PREFIX));
  const close = () => rm(directory, { recursive: true, force: true });
  try {
    // Record ownership before any file that can contain credentials.
    await writeFile(path.join(directory, OWNER_FILENAME), JSON.stringify(owner), { mode: 0o600 });
    const configFile = path.join(directory, "opencode.json");
    const profile = {
      $schema: "https://opencode.ai/config.json",
      provider: original.provider,
      enabled_providers: original.enabled_providers,
      disabled_providers: original.disabled_providers,
      default_agent: original.default_agent,
      ...withStrippedPermissions(original, strip, true)
    };
    // The config is already resolved, including any variable references in
    // provider options. JSON escapes keep opencode from expanding them again.
    const content = JSON.stringify(profile).replace(/\{(?=(?:env|file):)/g, "\\u007b");
    await writeFile(configFile, content, { mode: 0o600 });
    const isolated = {
      ...env,
      XDG_CONFIG_HOME: directory,
      OPENCODE_CONFIG_DIR: directory,
      OPENCODE_CONFIG: configFile,
      OPENCODE_CONFIG_CONTENT: undefined,
      OPENCODE_PERMISSION: undefined,
      OPENCODE_TEST_HOME: directory,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_PURE: "1"
    };
    const resolved = await readConfig(isolated);
    // Organisation or managed settings can still arrive after the profile.
    if (list(resolved.instructions).length > 0 ||
        Object.values(object(resolved.mcp)).some((value) => object(value).enabled !== false) ||
        Object.values(object(resolved.skills)).some((values) => list(values).length > 0) ||
        Object.values(object(resolved.agent)).some((agent) => typeof object(agent).prompt === "string")) {
      refuse("opencode still loads instructions, skills or MCP servers in the isolated configuration");
    }
    verifyStrips(resolved, strip);
    const provider = providerModel.slice(0, providerModel.indexOf("/"));
    const models = await run(["models", provider], isolated);
    if (models.exitCode !== 0 || !models.stdout.split(/\r?\n/).some((line) => line.trim() === providerModel)) {
      refuse(`the isolated configuration cannot reach the registered model ${JSON.stringify(providerModel)}`);
    }
    return { env: isolated, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function withStrippedPermissions(config: JsonObject, strip: readonly StrippableCapability[], lean = false): {
  permission: JsonObject;
  agent: JsonObject;
  mode?: JsonObject;
} {
  const permission = (value: unknown): JsonObject => {
    const rules: JsonObject = typeof value === "string" ? { "*": value } : { ...object(value) };
    for (const capability of strip) {
      const tool = OPENCODE_STRIP_TOOLS[capability];
      delete rules[tool];
      rules[tool] = "deny";
    }
    return rules;
  };
  return {
    permission: permission(config.permission),
    agent: Object.fromEntries(Object.entries(object(config.agent)).map(([name, value]) => {
      const agent = object(value);
      return [name, lean
        ? { mode: agent.mode, disable: agent.disable, hidden: agent.hidden, permission: permission(agent.permission) }
        : { permission: permission(agent.permission) }];
    })),
    ...(!lean && Object.hasOwn(config, "mode") ? {
      mode: Object.fromEntries(Object.entries(object(config.mode)).map(([name, value]) => {
        const mode = object(value);
        return [name, { permission: permission(mode.permission) }];
      }))
    } : {})
  };
}

function overlayAgentPermissions(denies: JsonObject, injected: unknown): JsonObject {
  const base = object(injected);
  return {
    ...base,
    ...Object.fromEntries(Object.entries(denies).map(([name, value]) => [
      name, { ...object(base[name]), ...object(value) }
    ]))
  };
}

/** opencode evaluates the last matching permission rule, including an
 * agent-specific wildcard. A blanket deny removes the tool from the worker. */
function verifyStrips(config: JsonObject, strip: readonly StrippableCapability[]): void {
  const globalRules = Object.entries(object(config.permission));
  for (const capability of strip) {
    const tool = OPENCODE_STRIP_TOOLS[capability];
    const agentRules = Object.values(object(config.agent)).map((agent) => Object.entries(object(object(agent).permission)));
    for (const rules of [globalRules, ...agentRules.map((rules) => [...globalRules, ...rules])]) {
      const last = rules.findLast(([pattern]) => {
        const wildcard = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
        return new RegExp(`^${wildcard}$`, process.platform === "win32" ? "i" : "").test(tool);
      });
      const action = last?.[1];
      if (action === "deny") continue;
      const patterns = Object.entries(object(action));
      if (patterns.length === 1 && patterns[0]?.[0] === "*" && patterns[0]?.[1] === "deny") continue;
      throw new CapabilityStripUnsupportedError("opencode", capability,
        `opencode's resolved configuration does not grant a blanket deny of ${tool}`);
    }
  }
}

/** Preserve JSONC strings while removing comments and trailing commas. */
function parseConfigContent(text: string): JsonObject | null {
  const string = /"(?:[^"\\]|\\.)*"/g.source;
  const comments = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g.source;
  const uncommented = text.replace(new RegExp(`(${string})|${comments}`, "g"), (_match, quoted?: string) => quoted ?? "");
  return parseObject(uncommented.replace(new RegExp(`(${string})|,(?=\\s*[}\\]])`, "g"), (_match, quoted?: string) => quoted ?? ""));
}

function parseObject(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
