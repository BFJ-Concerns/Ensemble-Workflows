import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  defaultClaudeConcurrency,
  defaultCodexConcurrency,
  defaultOpenCodeConcurrency
} from "./concurrency-defaults.js";

import type { EngineConcurrencyCaps, EngineName } from "./types.js";

export const CONFIG_SCHEMA_VERSION = 1;
export const AGENT_CEILING_ENV = "ENSEMBLE_AGENT_CEILING";
export const RUN_RECORD_ENV = "ENSEMBLE_RUN_RECORD";
export const RUN_RECORD_DIR_ENV = "ENSEMBLE_RUN_RECORD_DIR";

export type SettingLayer = "flag" | "env" | "config-file" | "default";

export interface Resolved<T> {
  value: T;
  layer: SettingLayer;
}

export interface AmbientSettings {
  configFile: string;
  agentCeiling: Resolved<number | null>;
  concurrencyCaps: Record<EngineName, Resolved<number>>;
  runRecordDir: Resolved<string | null>;
  statusDir: Resolved<string | null>;
}

export interface AmbientSettingFlags {
  agentCeiling?: number | null;
  concurrencyCaps?: EngineConcurrencyCaps;
}

export class AmbientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

interface MachineConfig {
  schema_version: 1;
  agent_ceiling?: number;
  concurrency?: Partial<Record<EngineName, number>>;
  run_record?: {
    enabled?: boolean;
    dir?: string;
  };
  status?: {
    enabled?: boolean;
    dir?: string;
  };
}

const ENGINES = ["codex", "claude", "opencode"] as const satisfies readonly EngineName[];
const DISABLED_VALUES = new Set(["0", "off", "false", "no"]);
const ENABLED_VALUES = new Set(["1", "on", "true", "yes"]);

export function resolveAmbientSettings(input: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  flags?: AmbientSettingFlags;
}): AmbientSettings {
  const configFile = machineConfigPath(input.env);
  const config = readMachineConfig(configFile);
  const defaults: Record<EngineName, number> = {
    codex: defaultCodexConcurrency(),
    claude: defaultClaudeConcurrency(),
    opencode: defaultOpenCodeConcurrency()
  };

  return {
    configFile,
    agentCeiling: resolveAgentCeiling({
      flag: input.flags?.agentCeiling,
      env: input.env[AGENT_CEILING_ENV],
      file: config?.agent_ceiling,
      configFile
    }),
    concurrencyCaps: Object.fromEntries(
      ENGINES.map((engine) => [
        engine,
        resolveNumber({
          flag: input.flags?.concurrencyCaps?.[engine],
          env: input.env[`ENSEMBLE_CONCURRENCY_${engine.toUpperCase()}`],
          envKey: `ENSEMBLE_CONCURRENCY_${engine.toUpperCase()}`,
          file: config?.concurrency?.[engine],
          fileKey: `concurrency.${engine}`,
          configFile,
          fallback: defaults[engine]
        })
      ])
    ) as Record<EngineName, Resolved<number>>,
    runRecordDir: resolveRunRecord(config, input.env),
    statusDir: resolveStatus(config, input.env, input.cwd)
  };
}

/** Compatibility wrapper for library callers that only need the archive path. */
export function resolveRunRecordDir(env: NodeJS.ProcessEnv): string | null {
  return resolveAmbientSettings({ env, cwd: process.cwd() }).runRecordDir.value;
}

/** Compatibility wrapper for library callers that only need the status path. */
export function resolveStatusDir(env: NodeJS.ProcessEnv, cwd: string): string | null {
  return resolveAmbientSettings({ env, cwd }).statusDir.value;
}

function machineConfigPath(env: NodeJS.ProcessEnv): string {
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : path.join(homedir(), ".config");
  return path.join(configHome, "ensemble", "config.json");
}

function readMachineConfig(configFile: string): MachineConfig | null {
  let source: string;
  try {
    source = readFileSync(configFile, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw new AmbientConfigError(`Cannot read machine configuration ${configFile}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new AmbientConfigError(`Cannot parse JSON machine configuration ${configFile}: ${errorMessage(error)}`);
  }
  if (!isObject(parsed) || Array.isArray(parsed)) {
    throw fileValueError(configFile, "<root>", "must be a JSON object");
  }

  assertKnownKeys(parsed, ["schema_version", "agent_ceiling", "concurrency", "run_record", "status"], configFile);
  if (parsed.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw new AmbientConfigError(
      `Unsupported schema_version ${String(parsed.schema_version)} in ${configFile}; understood versions: ${CONFIG_SCHEMA_VERSION}`
    );
  }
  validateOptionalPositiveInteger(parsed, "agent_ceiling", configFile);
  validateSection(parsed, "concurrency", ENGINES, configFile, validateOptionalPositiveInteger);
  validateSection(parsed, "run_record", ["enabled", "dir"], configFile, validateRunSetting);
  validateSection(parsed, "status", ["enabled", "dir"], configFile, validateRunSetting);
  return parsed as unknown as MachineConfig;
}

function validateSection(
  root: Record<string, unknown>,
  key: string,
  knownKeys: readonly string[],
  configFile: string,
  validate: (section: Record<string, unknown>, key: string, configFile: string, prefix?: string) => void
): void {
  const value = root[key];
  if (value === undefined) {
    return;
  }
  if (!isObject(value) || Array.isArray(value)) {
    throw fileValueError(configFile, key, "must be a JSON object");
  }
  assertKnownKeys(value, knownKeys, configFile, key);
  for (const nestedKey of knownKeys) {
    validate(value, nestedKey, configFile, key);
  }
}

function validateRunSetting(
  section: Record<string, unknown>,
  key: string,
  configFile: string,
  prefix = ""
): void {
  const value = section[key];
  if (value === undefined) {
    return;
  }
  const qualified = `${prefix}.${key}`;
  if (key === "enabled" && typeof value !== "boolean") {
    throw fileValueError(configFile, qualified, "must be a boolean");
  }
  if (key === "dir" && (typeof value !== "string" || value.trim().length === 0)) {
    throw fileValueError(configFile, qualified, "must be a non-empty string");
  }
}

function validateOptionalPositiveInteger(
  section: Record<string, unknown>,
  key: string,
  configFile: string,
  prefix = ""
): void {
  const value = section[key];
  if (value === undefined) {
    return;
  }
  const qualified = prefix.length > 0 ? `${prefix}.${key}` : key;
  assertPositiveInteger(value, qualified, configFile);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  knownKeys: readonly string[],
  configFile: string,
  prefix?: string
): void {
  const allowed = new Set(knownKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const qualified = prefix === undefined ? key : `${prefix}.${key}`;
      throw new AmbientConfigError(`Unknown machine configuration key ${qualified} in ${configFile}`);
    }
  }
}

function resolveNumber<T extends number | null>(input: {
  flag: number | undefined;
  env: string | undefined;
  envKey: string;
  file: number | undefined;
  fileKey: string;
  configFile: string;
  fallback: T;
}): Resolved<number | T> {
  if (input.flag !== undefined) {
    assertPositiveInteger(input.flag, input.fileKey, "CLI flags");
    return { value: input.flag, layer: "flag" };
  }
  if (input.env !== undefined) {
    const parsed = parseEnvironmentInteger(input.env, input.envKey);
    return { value: parsed, layer: "env" };
  }
  if (input.file !== undefined) {
    return { value: input.file, layer: "config-file" };
  }
  return { value: input.fallback, layer: "default" };
}

function resolveAgentCeiling(input: {
  flag: number | null | undefined;
  env: string | undefined;
  file: number | undefined;
  configFile: string;
}): Resolved<number | null> {
  if (input.flag !== undefined) {
    if (input.flag !== null) {
      assertPositiveInteger(input.flag, "agent_ceiling", "CLI flags");
    }
    return { value: input.flag, layer: "flag" };
  }
  if (input.env !== undefined) {
    if (input.env.trim() === "null") {
      return { value: null, layer: "env" };
    }
    return {
      value: parseEnvironmentInteger(input.env, AGENT_CEILING_ENV),
      layer: "env"
    };
  }
  if (input.file !== undefined) {
    return { value: input.file, layer: "config-file" };
  }
  return { value: null, layer: "default" };
}

function resolveRunRecord(
  config: MachineConfig | null,
  env: NodeJS.ProcessEnv
): Resolved<string | null> {
  const enabled = resolveEnabled(env[RUN_RECORD_ENV], RUN_RECORD_ENV, config?.run_record?.enabled);
  if (!enabled.value) {
    return { value: null, layer: enabled.layer };
  }
  const directory = resolveDirectory(
    env[RUN_RECORD_DIR_ENV],
    RUN_RECORD_DIR_ENV,
    config?.run_record?.dir,
    path.join(dataHome(env), "ensemble")
  );
  return directory;
}

function resolveStatus(
  config: MachineConfig | null,
  env: NodeJS.ProcessEnv,
  cwd: string
): Resolved<string | null> {
  const enabled = resolveEnabled(env.ENSEMBLE_STATUS, "ENSEMBLE_STATUS", config?.status?.enabled);
  if (!enabled.value) {
    return { value: null, layer: enabled.layer };
  }
  const directory = resolveDirectory(
    env.ENSEMBLE_STATUS_DIR,
    "ENSEMBLE_STATUS_DIR",
    config?.status?.dir,
    path.join(cwd, ".claude")
  );
  return { value: isDirectory(directory.value) ? directory.value : null, layer: directory.layer };
}

function resolveEnabled(
  envValue: string | undefined,
  envKey: string,
  fileValue: boolean | undefined
): Resolved<boolean> {
  if (envValue !== undefined) {
    const normalised = envValue.trim().toLowerCase();
    if (DISABLED_VALUES.has(normalised)) {
      return { value: false, layer: "env" };
    }
    if (ENABLED_VALUES.has(normalised)) {
      return { value: true, layer: "env" };
    }
    throw new AmbientConfigError(`Invalid value for ${envKey}: expected on/off, true/false, yes/no, or 1/0`);
  }
  if (fileValue !== undefined) {
    return { value: fileValue, layer: "config-file" };
  }
  return { value: true, layer: "default" };
}

function resolveDirectory(
  envValue: string | undefined,
  envKey: string,
  fileValue: string | undefined,
  fallback: string
): Resolved<string> {
  if (envValue !== undefined) {
    if (envValue.trim().length === 0) {
      throw new AmbientConfigError(`Invalid value for ${envKey}: expected a non-empty directory path`);
    }
    return { value: envValue, layer: "env" };
  }
  if (fileValue !== undefined) {
    return { value: fileValue, layer: "config-file" };
  }
  return { value: fallback, layer: "default" };
}

function parseEnvironmentInteger(value: string, key: string): number {
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new AmbientConfigError(`Invalid value for ${key}: expected an integer of at least 1`);
  }
  const parsed = Number(value.trim());
  assertPositiveInteger(parsed, key, "environment");
  return parsed;
}

function assertPositiveInteger(value: unknown, key: string, source: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    if (source.endsWith(".json")) {
      throw fileValueError(source, key, "must be an integer of at least 1");
    }
    throw new AmbientConfigError(`Invalid value for ${key} from ${source}: expected an integer of at least 1`);
  }
}

function fileValueError(configFile: string, key: string, detail: string): AmbientConfigError {
  return new AmbientConfigError(`Invalid machine configuration key ${key} in ${configFile}: ${detail}`);
}

function dataHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
    ? env.XDG_DATA_HOME
    : path.join(homedir(), ".local", "share");
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
