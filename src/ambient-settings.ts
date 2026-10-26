import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  defaultClaudeConcurrency,
  defaultCodexConcurrency,
  defaultOpenCodeConcurrency
} from "./concurrency-defaults.js";

import { HOLD_SCOPE_ENV } from "./holds.js";
import { CANONICAL_EFFORT_DOMAIN, isCanonicalEffort } from "./effort-resolution.js";
import { createOpenCodeModelRegistry } from "./opencode-model-registry.js";

import type { EffortSettings, EffortTargetSettings, ServedEffortLevels } from "./effort-resolution.js";
import type { OpenCodeModelRegistryEntry } from "./opencode-model-registry.js";
import type { EngineConcurrencyCaps, EngineName, EngineWorkerEnvironment } from "./types.js";

export const CONFIG_SCHEMA_VERSION = 1;
export const AGENT_CEILING_ENV = "ENSEMBLE_AGENT_CEILING";
export const RUN_RECORD_ENV = "ENSEMBLE_RUN_RECORD";
export const RUN_RECORD_DIR_ENV = "ENSEMBLE_RUN_RECORD_DIR";
/**
 * The invoking session's opaque identity. This is deliberately not an ambient
 * setting: it belongs to the run record only, rather than the closed set of
 * runtime settings resolved by `resolveAmbientSettings`.
 */
export const CALLER_IDENTITY_ENV = "ENSEMBLE_CALLER_IDENTITY";

export type SettingLayer = "flag" | "env" | "config-file" | "default";

/**
 * The environment layer's own variable names — the settings a run reads
 * from its environment, each scoped to that run: where its records and
 * status files go, its ceilings, its hold scope, who invoked it. A child
 * process that can outlive the run — Claude Code's per-user daemon, which
 * any `claude` invocation may start — must not inherit them: a daemon
 * homed on one run's relocated store would serve every later session from
 * it. Maintained beside the settings themselves: a new environment-layer
 * setting joins this list in the same change.
 */
const RUN_SCOPED_ENVIRONMENT_VARIABLES: ReadonlySet<string> = new Set([
  AGENT_CEILING_ENV,
  RUN_RECORD_ENV,
  RUN_RECORD_DIR_ENV,
  CALLER_IDENTITY_ENV,
  "ENSEMBLE_STATUS",
  "ENSEMBLE_STATUS_DIR",
  HOLD_SCOPE_ENV
]);

/** Whether a variable is one of the run's own environment-layer settings (the concurrency caps are a per-engine family). */
export function isRunScopedEnvironmentVariable(name: string): boolean {
  return RUN_SCOPED_ENVIRONMENT_VARIABLES.has(name) || name.startsWith("ENSEMBLE_CONCURRENCY_");
}

/** The environment with the run's own settings withheld; everything else inherits unchanged. */
export function withoutRunScopedVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isRunScopedEnvironmentVariable(name)) {
      inherited[name] = value;
    }
  }
  return inherited;
}

export interface Resolved<T> {
  value: T;
  layer: SettingLayer;
}

export interface AmbientSettings {
  configFile: string;
  agentCeiling: Resolved<number | null>;
  concurrencyCaps: Record<EngineName, Resolved<number>>;
  runRecordDir: Resolved<string | null>;
  /**
   * The durable-record store's directory, resolved independently of the
   * record's on/off switch. The completion sentinel lands under the run's
   * directory here even when archiving is disabled: the sentinel is
   * supervision surface, not archive.
   */
  runRecordStoreDir: Resolved<string>;
  statusDir: Resolved<string | null>;
  /**
   * Per-engine environment variables to inject into dispatched workers.
   * Config-file only: the motivating failure is a run whose parent
   * environment cannot be relied on, so an env-var or flag layer would
   * restate the problem the setting exists to solve.
   */
  workerEnvironment: EngineWorkerEnvironment;
  /**
   * The opencode models this machine declares (the config file's
   * `opencode_models` section). This is the whole catalogue: the harness
   * ships no models, so an opencode call can name only what is declared
   * here. Config-file only, like `workerEnvironment`.
   */
  openCodeModels: OpenCodeModelRegistryEntry[];
  /**
   * The machine's effort bounds and per-model served-level maps (the
   * config file's `effort` section), keyed by target. Config-file only,
   * like `workerEnvironment`: a limit a script or variable could lift
   * would protect nothing.
   */
  effort: EffortSettings;
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
  worker_environment?: Partial<Record<EngineName, Record<string, string>>>;
  opencode_models?: Record<string, OpenCodeModelDeclaration>;
  effort?: Record<string, EffortTargetSettings>;
}

const EFFORT_TARGET_KEYS = ["ceiling", "floor", "levels"];

type OpenCodeBillingMode = NonNullable<OpenCodeModelRegistryEntry["billing"]>["mode"];

interface OpenCodeModelDeclaration {
  provider_model: string;
  display_name?: string;
  family?: string;
  vision?: boolean;
  billing?: OpenCodeBillingMode;
  variants?: string[];
}

const OPENCODE_MODEL_DECLARATION_KEYS = ["provider_model", "display_name", "family", "vision", "billing", "variants"];
const OPENCODE_BILLING_MODES: readonly OpenCodeBillingMode[] = ["pay-as-you-go", "self-hosted"];

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
    runRecordStoreDir: resolveRunRecordStoreDir(config, input.env),
    statusDir: resolveStatus(config, input.env, input.cwd),
    workerEnvironment: config?.worker_environment ?? {},
    openCodeModels: openCodeModelEntries(config?.opencode_models),
    effort: config?.effort ?? {}
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

  assertKnownKeys(
    parsed,
    ["schema_version", "agent_ceiling", "concurrency", "run_record", "status", "worker_environment", "opencode_models", "effort"],
    configFile
  );
  if (parsed.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw new AmbientConfigError(
      `Unsupported schema_version ${String(parsed.schema_version)} in ${configFile}; understood versions: ${CONFIG_SCHEMA_VERSION}`
    );
  }
  validateOptionalPositiveInteger(parsed, "agent_ceiling", configFile);
  validateSection(parsed, "concurrency", ENGINES, configFile, validateOptionalPositiveInteger);
  validateSection(parsed, "run_record", ["enabled", "dir"], configFile, validateRunSetting);
  validateSection(parsed, "status", ["enabled", "dir"], configFile, validateRunSetting);
  validateWorkerEnvironment(parsed, configFile);
  validateOpenCodeModels(parsed, configFile);
  validateEffortSection(parsed, configFile);
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

/**
 * `worker_environment` is a map of maps, not a scalar setting, so it takes its
 * own validator rather than riding `validateSection`'s known-key walk: engines
 * are the known keys, and each engine's value is an open set of variable
 * names whose values must all be strings.
 */
function validateWorkerEnvironment(root: Record<string, unknown>, configFile: string): void {
  const section = root.worker_environment;
  if (section === undefined) {
    return;
  }
  if (!isObject(section) || Array.isArray(section)) {
    throw fileValueError(configFile, "worker_environment", "must be a JSON object");
  }
  assertKnownKeys(section, ENGINES, configFile, "worker_environment");
  for (const engine of ENGINES) {
    const variables = section[engine];
    if (variables === undefined) {
      continue;
    }
    const qualified = `worker_environment.${engine}`;
    if (!isObject(variables) || Array.isArray(variables)) {
      throw fileValueError(configFile, qualified, "must be a JSON object of variable names to string values");
    }
    for (const [name, value] of Object.entries(variables)) {
      if (name.trim().length === 0) {
        throw fileValueError(configFile, qualified, "variable names must be non-empty");
      }
      if (typeof value !== "string") {
        throw fileValueError(configFile, `${qualified}.${name}`, "must be a string");
      }
    }
  }
}

/**
 * `opencode_models` maps each model key an author names to its declaration —
 * an open set of keys, like `worker_environment`'s variable names, so it
 * takes its own validator. Name collisions between entries are judged by the
 * registry itself, the one place lookup happens.
 */
function validateOpenCodeModels(root: Record<string, unknown>, configFile: string): void {
  const section = root.opencode_models;
  if (section === undefined) {
    return;
  }
  if (!isObject(section) || Array.isArray(section)) {
    throw fileValueError(configFile, "opencode_models", "must be a JSON object of model keys to declarations");
  }
  for (const [key, declaration] of Object.entries(section)) {
    validateOpenCodeModelDeclaration(key, declaration, configFile);
  }
  try {
    createOpenCodeModelRegistry(openCodeModelEntries(section as Record<string, OpenCodeModelDeclaration>));
  } catch (error) {
    throw fileValueError(configFile, "opencode_models", errorMessage(error));
  }
}

function validateOpenCodeModelDeclaration(key: string, declaration: unknown, configFile: string): void {
  if (key.trim().length === 0) {
    throw fileValueError(configFile, "opencode_models", "model keys must be non-empty");
  }
  const qualified = `opencode_models.${key}`;
  if (!isObject(declaration) || Array.isArray(declaration)) {
    throw fileValueError(configFile, qualified, "must be a JSON object");
  }
  assertKnownKeys(declaration, OPENCODE_MODEL_DECLARATION_KEYS, configFile, qualified);
  const { provider_model: providerModel, display_name: displayName, family, vision, billing, variants } = declaration;
  // `opencode run --model` takes `provider/model`; the provider segment is
  // also the entry's `provider`.
  if (typeof providerModel !== "string" || !/^[^/\s]+\/\S+$/.test(providerModel)) {
    throw fileValueError(configFile, `${qualified}.provider_model`, "must be a provider/model route, such as \"openrouter/vendor/model\"");
  }
  for (const [field, value] of [["display_name", displayName], ["family", family]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
      throw fileValueError(configFile, `${qualified}.${field}`, "must be a non-empty string");
    }
  }
  if (vision !== undefined && typeof vision !== "boolean") {
    throw fileValueError(configFile, `${qualified}.vision`, "must be a boolean");
  }
  if (billing !== undefined && !(OPENCODE_BILLING_MODES as readonly unknown[]).includes(billing)) {
    throw fileValueError(configFile, `${qualified}.billing`, `must be one of ${OPENCODE_BILLING_MODES.join(" | ")}`);
  }
  if (variants !== undefined) {
    if (
      !Array.isArray(variants) ||
      variants.some((variant) => typeof variant !== "string" || variant.trim().length === 0) ||
      new Set(variants).size !== variants.length
    ) {
      throw fileValueError(configFile, `${qualified}.variants`, "must be an array of distinct non-empty strings");
    }
  }
}

/**
 * `effort` maps each target key — `*`, an engine, or `engine:model` — to
 * its bounds and served-level map, an open set of keys like
 * `opencode_models`, so it takes its own validator. Each value is judged as
 * `resolveEffort` will read it: bounds in the canonical vocabulary with the
 * floor no higher than the ceiling, and `levels` a non-empty map from
 * canonical level to the native name the engine is dispatched with, on an
 * engine or model key only — a native name is an engine's, so a `*` map
 * could name nothing that every engine accepts.
 */
function validateEffortSection(root: Record<string, unknown>, configFile: string): void {
  const section = root.effort;
  if (section === undefined) {
    return;
  }
  if (!isObject(section) || Array.isArray(section)) {
    throw fileValueError(configFile, "effort", "must be a JSON object of target keys (\"*\", an engine, or engine:model) to settings");
  }
  for (const [key, settings] of Object.entries(section)) {
    const qualified = `effort.${key}`;
    const engine = key === "*" ? null : key.includes(":") ? key.slice(0, key.indexOf(":")) : key;
    const model = key.includes(":") ? key.slice(key.indexOf(":") + 1) : undefined;
    if (engine !== null && !(ENGINES as readonly string[]).includes(engine)) {
      throw fileValueError(configFile, qualified, `target keys are "*", an engine (${ENGINES.join(" | ")}), or engine:model`);
    }
    if (model !== undefined && model.trim().length === 0) {
      throw fileValueError(configFile, qualified, "an engine:model key must name its model");
    }
    if (!isObject(settings) || Array.isArray(settings)) {
      throw fileValueError(configFile, qualified, "must be a JSON object");
    }
    assertKnownKeys(settings, EFFORT_TARGET_KEYS, configFile, qualified);
    const { ceiling, floor, levels } = settings;
    for (const [field, value] of [["ceiling", ceiling], ["floor", floor]] as const) {
      if (value !== undefined && !isCanonicalEffort(value)) {
        throw fileValueError(configFile, `${qualified}.${field}`, `must be one of ${CANONICAL_EFFORT_DOMAIN.join(" | ")}`);
      }
    }
    if (
      isCanonicalEffort(ceiling) &&
      isCanonicalEffort(floor) &&
      CANONICAL_EFFORT_DOMAIN.indexOf(floor) > CANONICAL_EFFORT_DOMAIN.indexOf(ceiling)
    ) {
      throw fileValueError(configFile, qualified, `floor ${floor} is above ceiling ${ceiling}`);
    }
    if (levels !== undefined) {
      validateServedLevels(levels, engine, `${qualified}.levels`, configFile);
    }
  }
}

function validateServedLevels(levels: unknown, engine: string | null, qualified: string, configFile: string): asserts levels is ServedEffortLevels {
  if (engine === null) {
    throw fileValueError(configFile, qualified, "served levels belong to an engine or engine:model key, not \"*\"");
  }
  if (!isObject(levels) || Array.isArray(levels) || Object.keys(levels).length === 0) {
    throw fileValueError(configFile, qualified, "must be a non-empty JSON object of canonical levels to the engine's native names");
  }
  for (const [level, native] of Object.entries(levels)) {
    if (!isCanonicalEffort(level)) {
      throw fileValueError(configFile, `${qualified}.${level}`, `levels are keyed by canonical level: ${CANONICAL_EFFORT_DOMAIN.join(" | ")}`);
    }
    if (typeof native !== "string" || native.trim().length === 0) {
      throw fileValueError(configFile, `${qualified}.${level}`, "must be the non-empty native name the engine is dispatched with");
    }
  }
}

function openCodeModelEntries(
  section: Record<string, OpenCodeModelDeclaration> | undefined
): OpenCodeModelRegistryEntry[] {
  return Object.entries(section ?? {}).map(([key, declaration]) => ({
    key,
    providerModel: declaration.provider_model,
    displayName: declaration.display_name ?? key,
    provider: declaration.provider_model.slice(0, declaration.provider_model.indexOf("/")),
    ...(declaration.family !== undefined ? { family: declaration.family } : {}),
    capabilities: { vision: declaration.vision ?? false },
    ...(declaration.billing !== undefined ? { billing: { mode: declaration.billing } } : {}),
    variants: declaration.variants ?? []
  }));
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

function resolveRunRecordStoreDir(
  config: MachineConfig | null,
  env: NodeJS.ProcessEnv
): Resolved<string> {
  return resolveDirectory(
    env[RUN_RECORD_DIR_ENV],
    RUN_RECORD_DIR_ENV,
    config?.run_record?.dir,
    path.join(dataHome(env), "ensemble")
  );
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
  if (isDirectory(directory.value)) {
    return directory;
  }
  if (directory.layer !== "default") {
    // An explicitly configured layer fails loud on malformation. A
    // named directory that does not exist would otherwise publish nothing
    // at exit 0 — the operator asked for observability and silently got
    // none. Only the *default* location (`<cwd>/.claude`) opts out by
    // absence: its existence is the publication opt-in.
    throw new AmbientConfigError(
      `Configured status directory does not exist or is not a directory: ${JSON.stringify(directory.value)} ` +
        `(from the ${directory.layer === "env" ? "ENSEMBLE_STATUS_DIR environment variable" : "machine config file"})`
    );
  }
  return { value: null, layer: directory.layer };
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
    throw new AmbientConfigError(
      `Invalid value for ${envKey}: expected on/off, true/false, yes/no, or 1/0; got ${JSON.stringify(envValue)}`
    );
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
      throw new AmbientConfigError(
        `Invalid value for ${envKey}: expected a non-empty directory path; got ${JSON.stringify(envValue)}`
      );
    }
    return { value: envValue, layer: "env" };
  }
  if (fileValue !== undefined) {
    return { value: fileValue, layer: "config-file" };
  }
  return { value: fallback, layer: "default" };
}

function parseEnvironmentInteger(value: string, key: string): number {
  const parsed = Number(value.trim());
  if (!/^[0-9]+$/.test(value.trim()) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AmbientConfigError(`Invalid value for ${key}: expected an integer of at least 1; got ${JSON.stringify(value)}`);
  }
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
