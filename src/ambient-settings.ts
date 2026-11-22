import { assertEffortSection } from "./effort-resolution.js";
import type { EffortPolicy, EffortSection } from "./effort-resolution.js";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  defaultClaudeConcurrency,
  defaultCodexConcurrency,
  defaultOpenCodeConcurrency
} from "./concurrency-defaults.js";

import { assertValidFallbackChain, assertValidFallbackEffort } from "./engine-option-validation.js";
import { AgentOptionRejectedError } from "./errors.js";
import { HOLD_SCOPE_ENV } from "./holds.js";
import { createOpenCodeModelRegistry } from "./opencode-model-registry.js";

import type { FallbackMap, MachineFallback } from "./fallback-source.js";
import type { ModelFamilyAssignments } from "./model-family.js";
import type { NamedTargetBinding, NamedTargets } from "./named-targets.js";
import type { OpenCodeModelRegistryEntry } from "./opencode-model-registry.js";
import type { EngineConcurrencyCaps, EngineName, EngineWorkerEnvironment } from "./types.js";

import type { WorkerScopeGrouping } from "./worker-scopes.js";

export const WORKER_SCOPE_ENV = "ENSEMBLE_WORKER_SCOPE";
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
  WORKER_SCOPE_ENV,
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
  workerScope: Resolved<WorkerScopeGrouping>;
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
   * The names this machine binds to an engine, with or without a model and
   * optionally a fallback chain (the config file's `targets` section), and
   * the file they were read from. Config-file only, like
   * `workerEnvironment`; with no section, no name is bound.
   */
  namedTargets: NamedTargets;
  machineFallback: MachineFallback;
  effortPolicy: EffortPolicy;
  /**
   * The families this machine assigns to models by name (the config file's
   * `model_families` section), outranking the harness's own grouping.
   * Config-file only, like `workerEnvironment`; with no section, the
   * grouping alone decides.
   */
  modelFamilies: ModelFamilyAssignments;
  /**
   * Whether a run whose workers all resolved onto one model family says so
   * at its end (the config file's `single_family_notice`). On unless the
   * file turns it off.
   */
  singleFamilyNotice: boolean;
}

export interface AmbientSettingFlags {
  workerScope?: WorkerScopeGrouping;
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
  worker_scope?: WorkerScopeGrouping;
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
  targets?: Record<string, NamedTargetBinding>;
  fallback?: FallbackMap;
  effort?: EffortSection;
  model_families?: Record<string, string>;
  single_family_notice?: boolean;
}

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
    workerScope: input.flags?.workerScope !== undefined
      ? { value: parseWorkerScopeGrouping(input.flags.workerScope, "--worker-scope"), layer: "flag" }
      : input.env[WORKER_SCOPE_ENV] !== undefined
        ? { value: parseWorkerScopeGrouping(input.env[WORKER_SCOPE_ENV], WORKER_SCOPE_ENV), layer: "env" }
        : config?.worker_scope !== undefined
          ? { value: config.worker_scope, layer: "config-file" }
          : { value: "worker", layer: "default" },
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
    statusDir: resolveStatus(config, input.env, input.cwd, configFile),
    workerEnvironment: config?.worker_environment ?? {},
    openCodeModels: openCodeModelEntries(config?.opencode_models),
    namedTargets: { bindings: config?.targets ?? {}, source: configFile },
    machineFallback: { chains: config?.fallback ?? {}, source: configFile },
    effortPolicy: { section: config?.effort ?? {}, source: configFile },
    modelFamilies: config?.model_families ?? {},
    singleFamilyNotice: config?.single_family_notice ?? true
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

  const newer = typeof parsed.schema_version === "number" && parsed.schema_version > CONFIG_SCHEMA_VERSION;
  if (!newer) {
    assertKnownKeys(
      parsed,
      ["schema_version", "worker_scope", "agent_ceiling", "concurrency", "run_record", "status", "worker_environment", "opencode_models", "targets", "fallback", "effort", "model_families", "single_family_notice"],
      configFile
    );
  }
  if (parsed.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw new AmbientConfigError(
      `Unsupported schema_version ${JSON.stringify(parsed.schema_version)} in ${configFile}; understood versions: ${CONFIG_SCHEMA_VERSION}` +
      (newer ? "; this file was written for a newer Ensemble. Upgrade Ensemble to read it." : "")
    );
  }
  if (parsed.worker_scope !== undefined) {
    parseWorkerScopeGrouping(parsed.worker_scope, `worker_scope in ${configFile}`);
  }
  validateOptionalPositiveInteger(parsed, "agent_ceiling", configFile);
  validateSection(parsed, "concurrency", ENGINES, configFile, validateOptionalPositiveInteger);
  validateSection(parsed, "run_record", ["enabled", "dir"], configFile, validateRunSetting);
  validateSection(parsed, "status", ["enabled", "dir"], configFile, validateRunSetting);
  validateWorkerEnvironment(parsed, configFile);
  validateOpenCodeModels(parsed, configFile);
  validateModelFamilies(parsed, configFile);
  if (parsed.single_family_notice !== undefined && typeof parsed.single_family_notice !== "boolean") {
    throw fileValueError(configFile, "single_family_notice", "must be a boolean");
  }
  validateNamedTargetBindings(parsed.targets, configFile);
  validateMachineFallback(parsed.fallback, parsed.targets, configFile);
  if (parsed.effort !== undefined) {
    assertEffortSection(parsed.effort, (key, detail) => {
      throw fileValueError(configFile, `effort${key ? `.${key}` : ""}`, detail);
    });
  }
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
 * `model_families` maps model names, an open set like `worker_environment`'s
 * variable names, to the family each belongs to.
 */
function validateModelFamilies(root: Record<string, unknown>, configFile: string): void {
  const section = root.model_families;
  if (section === undefined) {
    return;
  }
  if (!isObject(section) || Array.isArray(section)) {
    throw fileValueError(configFile, "model_families", "must be a JSON object of model names to family names");
  }
  for (const [model, family] of Object.entries(section)) {
    if (model.trim().length === 0) {
      throw fileValueError(configFile, "model_families", "model names must be non-empty");
    }
    if (typeof family !== "string" || family.trim().length === 0) {
      throw fileValueError(configFile, `model_families.${model}`, "must be a non-empty string");
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
 * `targets` maps the operator's own names to a binding: an engine, and
 * optionally a model and a fallback chain. Names are an open set, like
 * `opencode_models`' keys, and their own namespace: a call reaches one
 * through `target`, never `engine`, so a name may spell an engine's. An
 * opencode binding's model is judged against the registry at dispatch, as
 * for a call naming opencode literally; the chain is judged here by the
 * rule every chain meets.
 */
export function validateNamedTargetBindings(section: unknown, configFile: string): void {
  if (section === undefined) {
    return;
  }
  if (!isObject(section) || Array.isArray(section)) {
    throw fileValueError(configFile, "targets", "must be a JSON object of target names to { engine, model?, fallback? } bindings");
  }
  for (const [name, binding] of Object.entries(section)) {
    if (name.trim().length === 0) {
      throw fileValueError(configFile, "targets", "target names must be non-empty");
    }
    const qualified = `targets.${name}`;
    if (!isObject(binding) || Array.isArray(binding)) {
      throw fileValueError(configFile, qualified, "must be a JSON object naming engine, and optionally model and fallback");
    }
    assertKnownKeys(binding, ["engine", "model", "fallback"], configFile, qualified);
    if (!(ENGINES as readonly unknown[]).includes(binding.engine)) {
      throw fileValueError(
        configFile,
        `${qualified}.engine`,
        `target ${JSON.stringify(name)} is bound to unknown engine ${JSON.stringify(binding.engine)}; expected one of ${ENGINES.join(" | ")}`
      );
    }
    if (binding.model !== undefined && (typeof binding.model !== "string" || binding.model.trim().length === 0)) {
      throw fileValueError(configFile, `${qualified}.model`, "must be a non-empty string");
    }
    validateConfiguredChain(binding.fallback, section, configFile, `${qualified}.fallback`);
  }
}

export function validateMachineFallback(section: unknown, targets: unknown, configFile: string): void {
  if (section === undefined) return;
  if (!isObject(section) || Array.isArray(section)) {
    throw fileValueError(configFile, "fallback", "must be a JSON object keyed by engine or engine:model");
  }
  for (const [key, chain] of Object.entries(section)) {
    const separator = key.indexOf(":");
    const engine = separator === -1 ? key : key.slice(0, separator);
    const qualified = `fallback.${key}`;
    if (!(ENGINES as readonly string[]).includes(engine) ||
        (separator !== -1 && key.slice(separator + 1).trim().length === 0)) {
      throw fileValueError(configFile, qualified, `key must name an engine or engine:model for one of ${ENGINES.join(" | ")}`);
    }
    if (chain === undefined) {
      throw fileValueError(configFile, qualified, "must declare a fallback chain");
    }
    validateConfiguredChain(chain, targets, configFile, qualified);
  }
}

function validateConfiguredChain(chain: unknown, targets: unknown, configFile: string, key: string): void {
  try {
    assertValidFallbackChain(chain);
  } catch (error) {
    if (error instanceof AgentOptionRejectedError) {
      throw fileValueError(configFile, key, error.message);
    }
    throw error;
  }
  for (const [index, entry] of (chain ?? []).entries()) {
    if (entry.target === undefined) continue;
    const written = entry as { target: string; engine?: unknown; model?: unknown };
    if (written.engine !== undefined || written.model !== undefined) {
      throw fileValueError(configFile, key,
        `entry ${index} names target ${JSON.stringify(entry.target)} beside a literal engine or model; an entry names one or the other`);
    }
    const named = isObject(targets) && Object.hasOwn(targets, entry.target) ? targets[entry.target] : undefined;
    if (named === undefined) {
      throw fileValueError(configFile, key, `entry ${index} names target ${JSON.stringify(entry.target)}, which this file does not bind`);
    }
    try {
      if (isObject(named)) assertValidFallbackEffort(entry.effort, named.engine, index);
    } catch (error) {
      if (error instanceof AgentOptionRejectedError) throw fileValueError(configFile, key, error.message);
      throw error;
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
  cwd: string,
  configFile: string
): Resolved<string | null> {
  const enabled = resolveEnabled(env.ENSEMBLE_STATUS, "ENSEMBLE_STATUS", config?.status?.enabled);
  if (!enabled.value) {
    return { value: null, layer: enabled.layer };
  }
  const directory = resolveDirectory(
    env.ENSEMBLE_STATUS_DIR,
    "ENSEMBLE_STATUS_DIR",
    config?.status?.dir,
    path.join(dataHome(env), "ensemble", "status")
  );
  if (directory.layer !== "default") {
    const resolved = path.resolve(cwd, directory.value);
    let problem: string | null = null;
    if (!isDirectory(resolved)) {
      problem = "does not exist or is not a directory";
    } else {
      try {
        accessSync(resolved, constants.W_OK | constants.X_OK);
      } catch {
        problem = "is not writable and searchable";
      }
    }
    if (problem !== null) {
      const setting = directory.layer === "env" ? "ENSEMBLE_STATUS_DIR" : `status.dir in ${JSON.stringify(configFile)}`;
      throw new AmbientConfigError(
        `Configured status directory ${problem}: ${setting}, path ${JSON.stringify(directory.value)}, resolved ${JSON.stringify(resolved)}; ` +
        "create the directory and grant write and search permission, choose another path, or disable status with ENSEMBLE_STATUS=off"
      );
    }
  }
  return directory;
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

/** The closed grouping vocabulary shared by configuration, CLI and library options. */
export function parseWorkerScopeGrouping(value: unknown, source: string): WorkerScopeGrouping {
  if (value !== "worker" && value !== "run") {
    throw new AmbientConfigError(`Invalid value for ${source}: expected worker or run; got ${JSON.stringify(value)}`);
  }
  return value;
}
