import { ZCODE_TRANSCRIPT, transcriptContent } from "./live-transcript.js";
import { randomUUID } from "node:crypto";

import { unestablishedStopDiagnostics, type CommandContainment, type CommandStop } from "./contained-command.js";
import { CANONICAL_EFFORT_DOMAIN, isCanonicalEffort } from "./effort-resolution.js";
import { launchEnvironment } from "./engine-environment.js";
import {
  AgentPromptRejectedError,
  EngineShutdownError,
  TurnTimeoutError,
  WhitespaceStreamError,
  ZCodeSubstrateRefusedError,
  attachFailedTurnResult,
  attachPartialWorkerText,
  attachWorkerExitStatus,
  failedTurnResultOf,
  partialWorkerTextOf
} from "./errors.js";
import { Scheduler } from "./scheduler.js";
import { fitsOneArgument, MAX_ARGUMENT_BYTES, runStreamedCommand, type StreamedCommandResult } from "./streamed-command.js";
import { subtractUsage } from "./usage-summary.js";
import { DEFAULT_STOP_BOUNDS } from "./worker-scopes.js";
import { parseZCodeModel, type ZCodeModelSelection } from "./zcode-model.js";
import { defaultZCodeConcurrency } from "./concurrency-defaults.js";

import type { EngineCapabilityTable, StrippableCapability } from "./capability-stripping.js";
import type { EngineEffortReport } from "./effort-resolution.js";
import type {
  EngineAdapter,
  EngineAttemptContext,
  EngineAttemptResult,
  EngineInvocation,
  EngineSessionLoss,
  EngineSessionObserver,
  EngineSessionTurn,
  EngineTurnOptions,
  EngineWorkerSession,
  PreviousAttemptFailure
} from "./engines.js";
import type { LeanStartSupport } from "./lean-start.js";
import type { WhitespaceStream } from "./whitespace-stream.js";
import type { EngineName, JsonObject, JsonSchema, RuntimeEvent, TokenUsageBreakdown, TokenUsageEvent } from "./types.js";

/**
 * The `zcode` engine drives the owner's fork of ZCode one headless run per
 * turn: `zcode --prompt=<text> --output-format stream-json` with the run's
 * provider, model and reasoning level named by `--provider`, `--model` and
 * `--reasoning-level`. The run streams each session event as a JSON line
 * and closes with a `result` line saying whether it finished, failed or
 * was cancelled. A held worker's later turns resume the same persisted
 * ZCode session (`--resume <sessionId>`), so its context and prompt cache
 * carry across turns. Read from zcode 0.17.1 on 2026-11-22.
 */

/** One run of zcode as the adapter asks for it. */
export interface ZCodeRunOptions {
  prompt: string;
  cwd: string;
  provider: string;
  model: string;
  reasoningLevel: string;
  /** The persisted session a held worker's later turn continues. */
  resume?: string;
  /** Whole tools withheld from the model for this run (`--disallowed-tools`). */
  disallowedTools?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  onFirstData?: () => void;
  onData?: (chunk: string) => void;
  onCommandStop?: (stop: CommandStop) => void;
}

export interface ZCodeRunner {
  run(options: ZCodeRunOptions): Promise<StreamedCommandResult>;
  /** One short command (`--help`, `models`) the adapter reads the installed zcode's abilities from. */
  inspect(args: readonly string[]): Promise<StreamedCommandResult>;
  /** How a refusal names the installed zcode. */
  readonly bin: string;
}

export class ZCodeCliRunner implements ZCodeRunner {
  readonly bin: string;
  #killGraceMs: number;
  #env: NodeJS.ProcessEnv;
  #commands: CommandContainment | undefined;

  constructor(bin = "zcode", options: { killGraceMs?: number; workerEnv?: Record<string, string>; commands?: CommandContainment } = {}) {
    this.bin = bin;
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_STOP_BOUNDS.stopGraceMs;
    this.#env = launchEnvironment("zcode", options.workerEnv);
    this.#commands = options.commands;
  }

  async run(options: ZCodeRunOptions): Promise<StreamedCommandResult> {
    return runStreamedCommand({
      label: "zcode run",
      file: this.bin,
      args: zcodeRunArguments(options),
      cwd: options.cwd,
      env: this.#env,
      commands: this.#commands,
      timeoutMs: options.timeoutMs,
      killGraceMs: this.#killGraceMs,
      signal: options.signal,
      onFirstData: options.onFirstData,
      onData: options.onData,
      onCommandStop: options.onCommandStop,
      watchLine: watchZCodeLine
    });
  }

  async inspect(args: readonly string[]): Promise<StreamedCommandResult> {
    return runStreamedCommand({
      label: `zcode ${args[0] ?? ""}`.trim(),
      file: this.bin,
      args: [...args],
      cwd: process.cwd(),
      env: this.#env,
      commands: this.#commands,
      timeoutMs: 60_000,
      killGraceMs: this.#killGraceMs,
      signal: undefined
    });
  }
}

/**
 * The command line of one run. The prompt rides `--prompt=` so a prompt
 * that opens with `-` is never read as a flag.
 */
export function zcodeRunArguments(options: ZCodeRunOptions): string[] {
  return [
    `--prompt=${options.prompt}`,
    "--output-format", "stream-json",
    "--provider", options.provider,
    "--model", options.model,
    "--reasoning-level", options.reasoningLevel,
    "--cwd", options.cwd,
    ...(options.resume !== undefined ? ["--resume", options.resume] : []),
    ...(options.disallowedTools !== undefined && options.disallowedTools.length > 0
      ? ["--disallowed-tools", ...options.disallowedTools]
      : [])
  ];
}

/** The model listing `zcode models` prints: each model's reasoning levels, in the order zcode lists them. */
export class ZCodeListing {
  #levels = new Map<string, readonly string[]>();
  /**
   * Whether zcode read every provider's listing. A provider whose listing
   * failed (zcode reports `"status": "failed"`, as a NanoGPT listing that
   * timed out does, and exits 1) has no models here.
   */
  readonly complete: boolean;

  constructor(models: readonly { provider: string; model: string; reasoningLevels: readonly string[] }[], complete = true) {
    for (const entry of models) {
      this.#levels.set(`${entry.provider}/${entry.model}`, entry.reasoningLevels);
    }
    this.complete = complete;
  }

  /** The reasoning levels zcode lists for the model, or undefined where it lists no such model. */
  levels(selection: ZCodeModelSelection): readonly string[] | undefined {
    return this.#levels.get(`${selection.provider}/${selection.model}`);
  }

  /**
   * Records levels zcode named for a model the listing lacked, as its
   * refusal of an unsupported level does (`Supported levels: …`), so the
   * rest of the run knows them without asking again.
   */
  learn(selection: ZCodeModelSelection, levels: readonly string[]): void {
    const key = `${selection.provider}/${selection.model}`;
    if (!this.#levels.has(key)) this.#levels.set(key, levels);
  }
}

/**
 * Parses `zcode models` output: `{ models: [{ provider, model,
 * reasoningLevels, ... }], listings: [{ provider, status, ... }] }`. Null
 * where the output is not that shape. zcode prints it whether or not each
 * provider's listing was read, so a parsed listing is the ability whatever
 * the command's exit status.
 */
export function parseZCodeListing(stdout: string): ZCodeListing | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return null;
  const models = parsed.models.flatMap((entry) =>
    isRecord(entry) && typeof entry.provider === "string" && typeof entry.model === "string"
      ? [{
          provider: entry.provider,
          model: entry.model,
          reasoningLevels: Array.isArray(entry.reasoningLevels)
            ? entry.reasoningLevels.filter((level): level is string => typeof level === "string")
            : []
        }]
      : []
  );
  const complete = !Array.isArray(parsed.listings) ||
    parsed.listings.every((listing) => !isRecord(listing) || listing.status === undefined || listing.status === "read");
  return new ZCodeListing(models, complete);
}

/**
 * The level a dispatch with no requested effort runs at: zcode's own
 * choice for a model picked without a level, its highest listed level,
 * kept within the canonical vocabulary (a gateway's `ultra` is not a
 * reasoning level Ensemble names). A model whose levels are all outside
 * the vocabulary (`disabled`, `enabled`) takes zcode's own highest.
 */
export function defaultZCodeReasoningLevel(levels: readonly string[] | undefined): string | undefined {
  if (levels === undefined || levels.length === 0) return undefined;
  const canonical = CANONICAL_EFFORT_DOMAIN.filter((level) => levels.includes(level));
  return canonical.at(-1) ?? levels.at(-1);
}

/**
 * The tools a strip withholds, by zcode's own tool names. Skill
 * invocation is the `Skill` tool; agent spawning is the `Agent` tool and
 * the dynamic-workflow tool that starts agent runs (`CreateWorkflow`).
 * Withheld tools are not offered to the model for the run; measured
 * 2026-11-22 on zcode 0.17.1, a run's offered tool count fell from 47 to
 * 45 with `Skill` and `Agent` withheld.
 */
const STRIPPED_TOOLS: Readonly<Record<StrippableCapability, readonly string[]>> = {
  skills: ["Skill"],
  agents: ["Agent", "CreateWorkflow"]
};

export function disallowedToolsFor(strip: readonly StrippableCapability[] | undefined): string[] {
  return [...new Set((strip ?? []).flatMap((capability) => STRIPPED_TOOLS[capability]))];
}

export interface ZCodeEngineAdapterOptions {
  /** Defaults to 12. */
  concurrency?: number;
  /** Base working directory workers are dispatched from. Defaults to `process.cwd()`. */
  cwd?: string;
  runner?: ZCodeRunner;
  /** Routes zcode token usage into the runtime budget recorder. */
  onEvent?: (event: RuntimeEvent) => void;
}

/** What the installed zcode can do, read once per run from its help and listing. */
type ZCodeAbilities = { listing: ZCodeListing };

export class ZCodeEngineAdapter implements EngineAdapter {
  readonly name = "zcode" satisfies EngineName;
  readonly concurrency: number;
  readonly capabilities: EngineCapabilityTable = {
    skills: { route: "config", detail: "zcode --disallowed-tools Skill withholds the skill tool from the model for the run" },
    agents: {
      route: "config",
      detail: "zcode --disallowed-tools Agent CreateWorkflow withholds the subagent and dynamic-workflow tools from the model for the run"
    }
  };

  readonly leanStart: LeanStartSupport = {
    route: "unsupported",
    detail: "zcode has no per-run switch that withholds the operator's instructions, skill listing and MCP servers"
  };

  #scheduler: Scheduler;
  #cwd: string;
  #runner: ZCodeRunner;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #abilities: Promise<ZCodeAbilities> | null = null;
  #active = new Set<{ close(): Promise<void> }>();
  #closed = false;

  constructor(options: ZCodeEngineAdapterOptions = {}) {
    this.concurrency = options.concurrency ?? defaultZCodeConcurrency();
    this.#scheduler = new Scheduler(this.concurrency);
    this.#cwd = options.cwd ?? process.cwd();
    this.#runner = options.runner ?? new ZCodeCliRunner();
    this.#onEvent = options.onEvent;
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(task);
  }

  // No `modelIdentity`, and a report naming no identity: a zcode model's
  // served levels are the ones zcode lists for it on that provider, so the
  // built-in table, whose rows describe the levels other routes serve (the
  // Codex route's `none` on gpt-6-luna, which the gateway refuses through
  // zcode), never stands in for the listing. The machine's own `levels`
  // map for a `zcode:provider/model` key still outranks it.

  async effortReport(model: string | undefined): Promise<EngineEffortReport | null> {
    if (model === undefined) return null;
    let selection: ZCodeModelSelection;
    let abilities: ZCodeAbilities;
    try {
      selection = parseZCodeModel(model);
      abilities = await this.#readAbilities();
    } catch {
      // The dispatch itself refuses a bad spelling or an unusable zcode,
      // naming why; a missing report only leaves the level to pass through.
      return null;
    }
    const listed = abilities.listing.levels(selection);
    if (listed === undefined) return null;
    const levels = Object.fromEntries(listed.filter(isCanonicalEffort).map((level) => [level, level]));
    return { identity: null, levels: Object.keys(levels).length === 0 ? null : levels };
  }

  createInvocation(prompt: string, options: EngineTurnOptions): EngineInvocation {
    if (this.#closed) throw new EngineShutdownError(this.name);
    const turn = this.#turnSettings(options);
    const invocation = new ZCodeEngineInvocation(prompt, turn, (closed) => this.#active.delete(closed));
    this.#active.add(invocation);
    return invocation;
  }

  createSession(options: EngineTurnOptions, observer: EngineSessionObserver): EngineWorkerSession {
    if (this.#closed) throw new EngineShutdownError(this.name);
    const session = new ZCodeWorkerSession(this.#turnSettings(options), observer, (closed) => this.#active.delete(closed));
    this.#active.add(session);
    return session;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#scheduler.close(new EngineShutdownError(this.name));
    await Promise.allSettled([...this.#active].map(async (worker) => worker.close()));
  }

  #turnSettings(options: EngineTurnOptions): ZCodeTurnSettings {
    const selection = parseZCodeModel(options.model);
    return {
      selection,
      options,
      cwd: options.cwd ?? this.#cwd,
      runner: this.#runner,
      abilities: () => this.#readAbilities(),
      onEvent: this.#onEvent
    };
  }

  /**
   * Reads, once per run, whether the installed zcode can be told a run's
   * provider, model and reasoning level and can print its model listing,
   * and keeps the listing for the run, a listing that lacked a provider
   * included: reading it again would wait on that provider again, for
   * every dispatch and every retry. Single-flight and not failure-memoised:
   * a zcode that could not be read is asked again by the next dispatch.
   */
  #readAbilities(): Promise<ZCodeAbilities> {
    const reading = this.#abilities ??= readZCodeAbilities(this.#runner).catch((error: unknown) => {
      if (this.#abilities === reading) this.#abilities = null;
      throw error;
    });
    return reading;
  }
}

async function readZCodeAbilities(runner: ZCodeRunner): Promise<ZCodeAbilities> {
  const refuse = (detail: string): never => {
    throw new ZCodeSubstrateRefusedError(`zcode at ${runner.bin} cannot serve the zcode engine: ${detail}`);
  };
  let help: StreamedCommandResult;
  try {
    help = await runner.inspect(["--help"]);
  } catch (error) {
    return refuse(`it could not be run (${error instanceof Error ? error.message : String(error)})`);
  }
  const usage = `${help.stdout}\n${help.stderr}`;
  const lacks = [
    ...(/--reasoning-level\b/.test(usage) && /--provider\b/.test(usage) && /--model\b/.test(usage)
      ? []
      : ["per-run model selection (--provider, --model and --reasoning-level)"]),
    ...(/^\s+models\s/m.test(usage) ? [] : ["a model listing (zcode models)"])
  ];
  if (lacks.length > 0) {
    return refuse(`it lacks ${lacks.join(" and ")}; the engine needs a ZCode that has both`);
  }
  let listed: StreamedCommandResult;
  try {
    listed = await runner.inspect(["models"]);
  } catch (error) {
    return refuse(`its model listing could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
  const listing = parseZCodeListing(listed.stdout);
  if (listing === null) {
    const stderr = listed.stderr.trim();
    return refuse(`its model listing (zcode models) did not print the expected JSON${stderr.length > 0 ? `: ${stderr}` : ""}`);
  }
  return { listing };
}

/** What every turn of one dispatch shares. */
interface ZCodeTurnSettings {
  selection: ZCodeModelSelection;
  options: EngineTurnOptions;
  cwd: string;
  runner: ZCodeRunner;
  abilities: () => Promise<ZCodeAbilities>;
  onEvent: ((event: RuntimeEvent) => void) | undefined;
}

/** A one-shot zcode worker: each attempt is a fresh run, its correction riding the prompt. */
class ZCodeEngineInvocation implements EngineInvocation {
  #prompt: string;
  #settings: ZCodeTurnSettings;
  #abort = new AbortController();
  #settlement: Promise<unknown> | null = null;
  #closing: Promise<void> | null = null;
  #onClose: (invocation: ZCodeEngineInvocation) => void;

  constructor(prompt: string, settings: ZCodeTurnSettings, onClose: (invocation: ZCodeEngineInvocation) => void) {
    this.#prompt = prompt;
    this.#settings = settings;
    this.#onClose = onClose;
  }

  async runAttempt(context: EngineAttemptContext): Promise<EngineAttemptResult> {
    const settlement = runZCodeAttempt(this.#settings, {
      prompt: workerPrompt(this.#prompt, this.#settings.options.schema, context.previousFailure),
      resume: undefined,
      signal: this.#abort.signal,
      context
    });
    this.#settlement = settlement;
    try {
      return (await settlement).result;
    } finally {
      if (this.#settlement === settlement) this.#settlement = null;
    }
  }

  async close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#abort.abort();
      try {
        await this.#settlement?.catch(() => undefined);
      } finally {
        this.#onClose(this);
      }
    })();
    await this.#closing;
  }
}

/**
 * One held zcode worker: a persisted ZCode session, created by its first
 * run and resumed by every later one, so the session's context and prompt
 * cache accumulate. A retry stays in the session where one exists: the
 * session already holds the turn's prompt, so the correction names only
 * the failure. The session is lost when zcode no longer finds it.
 */
class ZCodeWorkerSession implements EngineWorkerSession {
  #settings: ZCodeTurnSettings;
  #observer: EngineSessionObserver;
  #onClose: (session: ZCodeWorkerSession) => void;
  #sessionId: string | null = null;
  #lost: EngineSessionLoss | null = null;
  #abort = new AbortController();
  #settlement: Promise<unknown> | null = null;
  #closed = false;

  constructor(settings: ZCodeTurnSettings, observer: EngineSessionObserver, onClose: (session: ZCodeWorkerSession) => void) {
    this.#settings = settings;
    this.#observer = observer;
    this.#onClose = onClose;
  }

  beginTurn(prompt: string, turn: EngineSessionTurn): EngineInvocation {
    return { runAttempt: (context) => this.#runTurnAttempt(prompt, turn.schema, context) };
  }

  async #runTurnAttempt(prompt: string, schema: JsonSchema | undefined, context: EngineAttemptContext): Promise<EngineAttemptResult> {
    if (this.#lost !== null) return this.#lostResult();
    if (this.#closed) throw new EngineShutdownError("zcode");
    const resume = this.#sessionId ?? undefined;
    const message = resume !== undefined && context.previousFailure !== undefined
      ? correctionLine(context.previousFailure)
      : workerPrompt(prompt, schema, resume === undefined ? context.previousFailure : undefined);
    const settlement = runZCodeAttempt(this.#settings, {
      prompt: message,
      resume,
      signal: this.#abort.signal,
      context
    });
    this.#settlement = settlement;
    try {
      const { result, sessionId, sessionMissing } = await settlement;
      if (sessionMissing && resume !== undefined) {
        this.#noteLost(resume, result.attemptFailure?.message ?? `zcode no longer finds session ${resume}`);
        return { ...result, attemptFailure: { kind: "session-lost", message: this.#lost!.reason } };
      }
      this.#sessionId ??= sessionId;
      return result;
    } catch (error) {
      // A run stopped mid-turn still created its session: keep it for the retry.
      this.#sessionId ??= sessionIdOfFailure(error);
      throw error;
    } finally {
      if (this.#settlement === settlement) this.#settlement = null;
    }
  }

  #noteLost(sessionId: string, reason: string): void {
    if (this.#closed || this.#lost !== null) return;
    this.#lost = { nativeSession: sessionId, reason, observedAt: Date.now() };
    try { this.#observer.onLost(this.#lost); }
    catch { /* Observability cannot fail a turn. */ }
  }

  #lostResult(): EngineAttemptResult {
    return {
      text: "", deltaText: "", durationMs: null, firstDeltaMs: null, items: {}, tokenUsageEvents: [],
      attemptFailure: { kind: "session-lost", message: this.#lost!.reason }
    };
  }

  async close(): Promise<void> {
    // The session persists in zcode's own store between runs; nothing
    // runs between turns, so closing stops any turn still in flight.
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    try {
      await this.#settlement?.catch(() => undefined);
    } finally {
      this.#onClose(this);
    }
  }
}

const sessionIdsOfFailures = new WeakMap<Error, string>();

function sessionIdOfFailure(error: unknown): string | null {
  return error instanceof Error ? sessionIdsOfFailures.get(error) ?? null : null;
}

/** The text a run is sent: the harness's worker preamble, the schema it must answer in, any correction, then the task. */
function workerPrompt(prompt: string, schema: JsonSchema | undefined, previousFailure: PreviousAttemptFailure | undefined): string {
  const lines: string[] = [
    "You are an automated worker dispatched by the Ensemble orchestration harness.",
    "Work fully autonomously: never ask for confirmation or permission, and do not pause to ask questions - make a reasonable decision and finish the task."
  ];
  if (schema !== undefined) {
    lines.push(
      "When finished, include in your FINAL message a JSON value that conforms to this JSON Schema. You may surround the value with prose, explanation, or markdown code fences:",
      JSON.stringify(schema)
    );
  }
  if (previousFailure !== undefined) {
    lines.push(correctionLine(previousFailure));
  }
  lines.push("", "Task:", prompt);
  return lines.join("\n");
}

/**
 * The most characters of a failure's message a correction repeats. A
 * correction rides the same command-line argument as the prompt, so its
 * length is bounded for the prompt's own bound to hold on every attempt.
 */
const CORRECTION_MESSAGE_CHARACTERS = 2_000;

function correctionLine(failure: PreviousAttemptFailure): string {
  const message = failure.message.length > CORRECTION_MESSAGE_CHARACTERS
    ? `${failure.message.slice(0, CORRECTION_MESSAGE_CHARACTERS)}…`
    : failure.message;
  return `A previous attempt failed (${failure.kind}): ${message}. Correct it this time.`;
}

/**
 * Refuses, before any worker spawns, a prompt zcode cannot be given. A run
 * takes its prompt only as one command-line argument (`--prompt=`), which
 * Linux bounds at 128 KiB; the bound is judged on the text a run is sent,
 * with room for the longest correction a retry adds.
 */
export function assertZCodePromptFits(prompt: string, schema: JsonSchema | undefined): void {
  const longest = workerPrompt(prompt, schema, {
    kind: "x".repeat(64),
    message: "\u{10FFFF}".repeat(CORRECTION_MESSAGE_CHARACTERS)
  });
  if (fitsOneArgument(`--prompt=${longest}`)) return;
  throw new AgentPromptRejectedError(
    `the zcode engine cannot be given this prompt: zcode takes a prompt only as one command-line argument, ` +
    `which Linux bounds at ${MAX_ARGUMENT_BYTES} bytes (128 KiB), and this prompt is ${Buffer.byteLength(prompt, "utf8")} bytes` +
    `${schema !== undefined ? " before its schema" : ""}; shorten it, or dispatch it on an engine that takes longer prompts`
  );
}

interface ZCodeAttemptRequest {
  prompt: string;
  resume: string | undefined;
  signal: AbortSignal;
  context: EngineAttemptContext;
}

interface ZCodeAttemptOutcome {
  result: EngineAttemptResult;
  sessionId: string | null;
  /** zcode reported the resumed session missing (`Session not found`). */
  sessionMissing: boolean;
}

/** The level a dispatch asked for: the resolved effort's native name, else the requested effort; undefined where it asked for none. */
function requestedReasoningLevel(options: EngineTurnOptions): string | undefined {
  return options.effortResolution?.dispatched ?? options.effort;
}

/**
 * The level sent when a dispatch asked for none and the listing does not
 * have the model, as when the model's provider did not answer the listing.
 * zcode names no model without a level, so one is sent; a model that does
 * not serve it is refused before any request, naming the levels it does,
 * and the run is made again at zcode's own choice among those.
 */
const UNLISTED_MODEL_LEVEL = "medium";

/** The levels zcode's refusal of an unsupported level names (`… Supported levels: low, high.`), or null. */
export function supportedLevelsOfRefusal(message: string): string[] | null {
  const match = /\bUnsupported reasoning level "[^"]*".*\bSupported levels: ([^\n]*?)\.?\s*$/m.exec(message);
  if (match === null) return null;
  const levels = match[1]!.split(",").map((level) => level.trim()).filter((level) => level.length > 0);
  return levels.length === 0 ? null : levels;
}

async function runZCodeAttempt(settings: ZCodeTurnSettings, request: ZCodeAttemptRequest): Promise<ZCodeAttemptOutcome> {
  const stops: CommandStop[] = [];
  const startedAt = Date.now();
  try {
    const outcome = await runZCodeTurn(settings, request, (stop) => stops.push(stop));
    outcome.result.diagnostics = { ...outcome.result.diagnostics, ...unestablishedStopDiagnostics(stops) };
    return outcome;
  } catch (error) {
    if (error instanceof Error && stops.some((stop) => stop.attemptAccount !== null)) {
      const text = partialWorkerTextOf(error) ?? "";
      const result = failedTurnResultOf(error) ?? {
        text, deltaText: text, durationMs: Date.now() - startedAt, firstDeltaMs: null, items: {}, tokenUsageEvents: []
      };
      result.diagnostics = { ...result.diagnostics, ...unestablishedStopDiagnostics(stops) };
      attachFailedTurnResult(error, result);
    }
    throw error;
  }
}

async function runZCodeTurn(
  settings: ZCodeTurnSettings,
  request: ZCodeAttemptRequest,
  onCommandStop: (stop: CommandStop) => void
): Promise<ZCodeAttemptOutcome> {
  const { selection, options } = settings;
  const { context } = request;
  // Refused before any worker exists: a zcode that cannot be driven.
  const { listing } = await settings.abilities();
  if (request.signal.aborted) throw new EngineShutdownError("zcode");
  const requested = requestedReasoningLevel(options);
  const launch = async (reasoningLevel: string) => {
    const stream = new ZCodeStream(settings, context);
    const run = await settings.runner.run({
      prompt: request.prompt,
      cwd: settings.cwd,
      provider: selection.provider,
      model: selection.model,
      reasoningLevel,
      ...(request.resume !== undefined ? { resume: request.resume } : {}),
      disallowedTools: disallowedToolsFor(options.strip),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      signal: request.signal,
      ...(context.onLiveEvidence !== undefined ? { onFirstData: context.onLiveEvidence } : {}),
      onData: (chunk) => stream.push(chunk),
      onCommandStop
    });
    stream.end(run.stdout);
    return { stream, run };
  };
  let { stream, run } = await launch(requested ?? defaultZCodeReasoningLevel(listing.levels(selection)) ?? UNLISTED_MODEL_LEVEL);
  if (requested === undefined && listing.levels(selection) === undefined && !request.signal.aborted) {
    // The level was a guess for a model the listing lacked: zcode's refusal
    // names the model's levels, and the run is made again at its own choice.
    const refusal = stream.evidence().failure(run);
    const levels = refusal === null ? null : supportedLevelsOfRefusal(refusal.message);
    const level = defaultZCodeReasoningLevel(levels ?? undefined);
    if (levels !== null && level !== undefined) {
      listing.learn(selection, levels);
      ({ stream, run } = await launch(level));
    }
  }
  const evidence = stream.evidence();
  const workerExit = { exitCode: run.exitCode, signal: run.signal };
  const text = evidence.response ?? evidence.streamedText;
  const base = {
    text,
    deltaText: evidence.streamedText,
    durationMs: run.durationMs,
    firstDeltaMs: evidence.firstTextAt === null ? null : evidence.firstTextAt - stream.startedAt,
    items: {},
    tokenUsageEvents: evidence.usageEvents,
    transcripts: evidence.transcripts,
    ...(evidence.resolvedModel !== null ? { resolvedModel: evidence.resolvedModel } : {}),
    ...(evidence.resolvedEffort !== null ? { resolvedEffort: evidence.resolvedEffort } : {}),
    diagnostics: { zcode: evidence.diagnostics(run) } as JsonObject
  } satisfies EngineAttemptResult;

  if (request.signal.aborted) {
    // A cancelled worker is the run's teardown, not a zcode failure.
    throw attachWorkerExitStatus(attachPartialWorkerText(new EngineShutdownError("zcode"), text), workerExit);
  }
  if (run.whitespaceLimitReached === true || run.deadlineExpired === true) {
    const error = run.whitespaceLimitReached === true
      ? new WhitespaceStreamError()
      : new TurnTimeoutError(`zcode turn timed out after ${options.timeoutMs}ms`, {
          kind: "turn",
          timeoutMs: options.timeoutMs ?? 0,
          threadId: evidence.sessionId ?? `zcode-no-session-${randomUUID()}`
        });
    attachFailedTurnResult(error, { ...base, workerExit });
    if (evidence.sessionId !== null) sessionIdsOfFailures.set(error, evidence.sessionId);
    throw attachWorkerExitStatus(attachPartialWorkerText(error, text), workerExit);
  }
  const failure = evidence.failure(run);
  return {
    result: failure === null ? base : { ...base, attemptFailure: failure, workerExit },
    sessionId: evidence.sessionId,
    sessionMissing: failure?.kind === "zcode-run-error" && /^zcode run failed: Session not found\b/.test(failure.message)
  };
}

/** The whitespace-stream bound on zcode's event stream: streamed text, and tool or reasoning activity. */
export function watchZCodeLine(line: string, whitespace: WhitespaceStream): void {
  const event = parseLine(line);
  if (!isRecord(event)) return;
  const payload = isRecord(event.payload) ? event.payload : {};
  if (event.type === "model.streaming") {
    if (payload.kind === "text_delta" && typeof payload.delta === "string") {
      whitespace.observeText(payload.delta);
    } else if (typeof payload.kind === "string" && /^(?:reasoning|tool)_/.test(payload.kind)) {
      whitespace.observeActivity();
    }
  } else if (event.type === "tool.updated") {
    whitespace.observeActivity();
  }
}

/**
 * One run's event stream, read as it arrives: each JSON line reaches the
 * live transcript and the live status, each completed model request's
 * usage reaches the budget, and the closing `result` line says how the
 * run ended.
 */
class ZCodeStream {
  readonly startedAt = Date.now();
  #settings: ZCodeTurnSettings;
  #context: EngineAttemptContext;
  #buffer = "";
  #events: unknown[] = [];
  #result: Record<string, unknown> | null = null;
  #sessionId: string | null = null;
  #messageText = new Map<string, string>();
  #lastTextMessage: string | null = null;
  #firstTextAt: number | null = null;
  #requests = new Set<string>();
  #requestTotal: TokenUsageBreakdown | null = null;
  #reported: TokenUsageBreakdown | null = null;
  #liveUsage: TokenUsageEvent[] = [];
  #resolvedModel: string | null = null;
  #resolvedEffort: string | null = null;
  #turnError: Record<string, unknown> | null = null;

  constructor(settings: ZCodeTurnSettings, context: EngineAttemptContext) {
    this.#settings = settings;
    this.#context = context;
  }

  push(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) this.#line(line);
  }

  /** Reads whatever the chunks did not deliver: a final unterminated line. */
  end(stdout: string): void {
    if (this.#events.length === 0 && this.#buffer.length === 0 && stdout.length > 0) {
      // A runner that delivered no chunks (a test double) hands over the whole output here.
      this.push(stdout);
    }
    if (this.#buffer.trim().length > 0) this.#line(this.#buffer);
    this.#buffer = "";
  }

  #line(line: string): void {
    const event = parseLine(line);
    if (event === undefined) return;
    this.#events.push(event);
    observe(() => this.#context.onTranscriptEvent?.(event));
    observe(() => this.#context.onOutput?.());
    if (!isRecord(event)) return;
    if (typeof event.sessionId === "string") this.#sessionId = event.sessionId;
    if (event.type === "result") {
      this.#result = event;
      const usage = isRecord(event.usage) ? usageBreakdown(event.usage) : null;
      if (usage !== null) this.#report(usage);
      return;
    }
    const payload = isRecord(event.payload) ? event.payload : null;
    if (payload === null) return;
    if (event.type === "model.streaming" && payload.kind === "text_delta" && typeof payload.delta === "string") {
      const message = typeof payload.assistantMessageId === "string" ? payload.assistantMessageId : "";
      this.#messageText.set(message, (this.#messageText.get(message) ?? "") + payload.delta);
      this.#lastTextMessage = message;
      this.#firstTextAt ??= Date.now();
    } else if (event.type === "turn.failed" && isRecord(payload.error)) {
      this.#turnError = payload.error;
    } else if (event.type === "session.updated" && typeof payload.requestId === "string" && typeof payload.providerId === "string") {
      this.#request(payload);
    }
  }

  /** A model request's start names the served model; its completion carries its usage. */
  #request(payload: Record<string, unknown>): void {
    const model = typeof payload.modelId === "string" ? `${payload.providerId as string}/${payload.modelId}` : null;
    const reasoning = isRecord(payload.modelCall) && isRecord(payload.modelCall.reasoning) ? payload.modelCall.reasoning : null;
    const reported = typeof reasoning?.effectiveLevel === "string" && reasoning.effectiveLevel !== "unknown"
      ? reasoning.effectiveLevel : null;
    // A request's completion carries usage and no reasoning, and a later
    // request may report its level as unknown: the level a request of the
    // same model reported stands until one reports another.
    const effective = reported ?? (model === this.#resolvedModel ? this.#resolvedEffort : null);
    if (model !== null && (model !== this.#resolvedModel || effective !== this.#resolvedEffort)) {
      this.#resolvedModel = model;
      this.#resolvedEffort = effective;
      observe(() => this.#context.onIdentity?.({ resolvedModel: model, resolvedEffort: effective }));
    }
    const usage = isRecord(payload.usage) && payload.durationMs !== undefined ? usageBreakdown(payload.usage) : null;
    if (usage === null || this.#requests.has(payload.requestId as string)) return;
    this.#requests.add(payload.requestId as string);
    this.#requestTotal = this.#requestTotal === null ? usage : addUsage(this.#requestTotal, usage);
    this.#report(this.#requestTotal);
  }

  /** Reports the run's spend so far, as the delta from what was reported before. */
  #report(total: TokenUsageBreakdown): void {
    const last = subtractUsage(total, this.#reported);
    if (last.totalTokens <= 0) return;
    this.#reported = total;
    const event = this.#usageEvent(last, total);
    this.#liveUsage.push(event);
    observe(() => this.#context.onUsage?.(event));
    this.#settings.onEvent?.({ method: "thread/tokenUsage/updated", params: event.raw, receivedAt: Date.now() });
  }

  #usageEvent(last: TokenUsageBreakdown, total: TokenUsageBreakdown): TokenUsageEvent {
    const threadId = this.#sessionId ?? "zcode-no-session";
    const turnId = `${threadId}:zcode-${this.#context.attempt}-${this.#liveUsage.length + 1}`;
    return {
      threadId, turnId, last, total,
      raw: { threadId, turnId, model: `${this.#settings.selection.provider}/${this.#settings.selection.model}`, tokenUsage: { last, total } } as unknown as JsonObject
    };
  }

  evidence() {
    const result = this.#result;
    const response = typeof result?.response === "string" ? result.response : null;
    const streamedText = this.#lastTextMessage === null ? "" : this.#messageText.get(this.#lastTextMessage) ?? "";
    const turnError = this.#turnError;
    const content = transcriptContent(this.#events);
    return {
      response,
      streamedText,
      firstTextAt: this.#firstTextAt,
      sessionId: this.#sessionId,
      resolvedModel: this.#resolvedModel,
      resolvedEffort: this.#resolvedEffort,
      usageEvents: this.#reported === null ? [] : [this.#usageEvent(this.#reported, this.#reported)],
      transcripts: content.length === 0 ? [] : [{
        filename: ZCODE_TRANSCRIPT.filename,
        format: "jsonl" as const,
        source: ZCODE_TRANSCRIPT.source,
        content,
        ...(this.#sessionId !== null ? { sessionId: this.#sessionId } : {})
      }],
      diagnostics: (run: StreamedCommandResult): JsonObject => ({
        outcome: typeof result?.outcome === "string" ? result.outcome : null,
        ...(typeof result?.error === "string" ? { error: result.error } : {}),
        turn_error: turnError === null ? null : {
          code: stringOrNull(turnError.code),
          type: stringOrNull(turnError.type),
          message: stringOrNull(turnError.message),
          reason: isRecord(turnError.attribution) ? stringOrNull(turnError.attribution.reason) : null,
          source: isRecord(turnError.attribution) ? stringOrNull(turnError.attribution.source) : null
        },
        session_id: this.#sessionId,
        exit_code: run.exitCode,
        signal: run.signal,
        ...(run.stderr.trim().length > 0 ? { stderr: run.stderr.trim().slice(-4_000) } : {})
      }),
      /**
       * Why the run failed; null for a run that finished. zcode closes every
       * run it handles, a refused or failed one included, with its `result`
       * line, so a process that ended without one died under the worker:
       * killed, or crashed past zcode's own handling.
       */
      failure: (run: StreamedCommandResult): { kind: "zcode-run-error" | "zcode-worker-lost"; message: string } | null => {
        const stderr = run.stderr.trim().replace(/^Error: /, "").split("\n")[0] ?? "";
        if (result === null) {
          const ending = run.signal !== null ? `was killed by ${run.signal}` : `exited with code ${run.exitCode ?? "unknown"}`;
          return {
            kind: "zcode-worker-lost",
            message: `zcode ${ending} before its closing result${stderr.length > 0 ? `: ${stderr}` : ""}`
          };
        }
        const outcome = result.outcome;
        if (outcome === "finished" && run.exitCode === 0) return null;
        const runError = (message: string) => ({ kind: "zcode-run-error" as const, message: `zcode run failed: ${message}` });
        if (outcome === "cancelled") return runError("the run was cancelled");
        if (typeof result.error === "string") return runError(result.error);
        if (stderr.length > 0) return runError(stderr);
        return runError(`exit code ${run.exitCode ?? "unknown"}${run.signal !== null ? `, signal ${run.signal}` : ""}`);
      }
    };
  }
}

/** zcode's usage fields as a breakdown: input includes its cached share, output its reasoning. */
function usageBreakdown(usage: Record<string, unknown>): TokenUsageBreakdown | null {
  const input = numberOr0(usage.inputTokens);
  const output = numberOr0(usage.outputTokens);
  const cacheRead = numberOr0(usage.cacheReadTokens);
  const cacheWrite = typeof usage.cacheWriteTokens === "number" ? usage.cacheWriteTokens : undefined;
  const total = typeof usage.totalTokens === "number" ? usage.totalTokens : input + output;
  if (total === 0 && input === 0 && output === 0) return null;
  return {
    cachedInputTokens: cacheRead + (cacheWrite ?? 0),
    ...(cacheWrite !== undefined ? { cacheCreationInputTokens: cacheWrite } : {}),
    inputTokens: input,
    outputTokens: output,
    ...(typeof usage.reasoningTokens === "number" ? { reasoningOutputTokens: usage.reasoningTokens } : {}),
    totalTokens: total
  };
}

function addUsage(left: TokenUsageBreakdown, right: TokenUsageBreakdown): TokenUsageBreakdown {
  const creation = left.cacheCreationInputTokens === undefined || right.cacheCreationInputTokens === undefined
    ? undefined : left.cacheCreationInputTokens + right.cacheCreationInputTokens;
  const reasoning = left.reasoningOutputTokens === undefined || right.reasoningOutputTokens === undefined
    ? undefined : left.reasoningOutputTokens + right.reasoningOutputTokens;
  return {
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    ...(creation !== undefined ? { cacheCreationInputTokens: creation } : {}),
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
    totalTokens: left.totalTokens + right.totalTokens
  };
}

function observe(callback: () => void): void {
  try { callback(); } catch { /* Observability cannot fail a worker. */ }
}

function parseLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { type: "raw", text: line };
  }
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
