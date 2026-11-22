import {
  AcpClient,
  acpPermissionChoice,
  acpUpdateText,
  type AcpPermissionPolicy,
  type AcpPromptResult,
  type AcpSession,
  type AcpExit,
  type AcpSessionUpdate,
  type AcpUsage
} from "./acp-client.js";
import { CommandContainment, unestablishedStopDiagnostics, type CommandStop } from "./contained-command.js";
import { defaultAgyConcurrency } from "./concurrency-defaults.js";
import { isCanonicalEffort, type EngineEffortReport, type ServedEffortLevels } from "./effort-resolution.js";
import { launchEnvironment } from "./engine-environment.js";
import {
  AcpExitedError,
  AcpRequestError,
  AgySubstrateRefusedError,
  EngineShutdownError,
  InvalidAgentOptionValueError,
  TurnTimeoutError,
  WhitespaceStreamError,
  attachFailedTurnResult,
  attachPartialWorkerText,
  attachWorkerExitStatus,
  workerExitStatusOf,
  type WorkerExitStatus
} from "./errors.js";
import { Scheduler } from "./scheduler.js";
import { WhitespaceStream } from "./whitespace-stream.js";
import { NoWorkerScopes } from "./worker-scopes.js";
import { inSessionCorrection, laterTurnPrompt, openingPrompt, previousFailureNotice } from "./worker-instructions.js";

import type { LeanStartSupport } from "./lean-start.js";
import type { EngineCapabilityTable } from "./capability-stripping.js";
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
import type { EngineTranscriptArtifact, JsonObject, JsonSchema, RuntimeEvent, TokenUsageBreakdown, TokenUsageEvent } from "./types.js";

/**
 * The Antigravity engine: workers on Google's Antigravity CLI, each one an
 * `agy acp` server process holding one Agent Client Protocol session.
 *
 * - **Model and effort are session settings**, set after `session/new` and
 *   before the first prompt: the model by its base name, the canonical
 *   level as agy's `thought_level`. agy lists a model's levels only once
 *   that model is set, and a model with a single level offers no setting.
 * - **Every tool approval is granted**, once where agy offers that, since a
 *   worker runs with nobody to ask (`AGY_PERMISSION_POLICY`).
 * - **The schema rides the prompt.** agy takes no JSON Schema, so the turn's
 *   contract goes in the message (`worker-instructions.ts`) and the
 *   runtime's own check judges the answer.
 * - **A retry stays in the session that failed** while it is alive: the
 *   session holds the task and the failed reply, so the correction names
 *   only the failure. A worker whose process ended is replaced, and the new
 *   session is told of the failure it never saw.
 * - **The answer is the final message**: the message text that follows the
 *   turn's last tool call. The whole turn's text is kept as `deltaText`.
 */

/** The command an operator knows the server by: it names the worker in errors and teardown reports. */
const AGY_ACP = "agy acp";

/** How long a cancelled turn may take to end before its worker is stopped. */
const CANCEL_GRACE_MS = 10_000;

/** A model id whose last segment names a canonical level: how a model with a single level spells it (`gpt-oss-120b-medium`). */
const SOLE_LEVEL_SUFFIX = /-(none|minimal|low|medium|high|xhigh|max)$/;

/** agy's JSON-RPC code for a request it will not serve without a sign-in. */
const AGY_AUTHENTICATION_REQUIRED = -32000;
/** agy's JSON-RPC code for a setting value it does not offer. */
const AGY_INVALID_PARAMS = -32602;

/** Grants every approval, once where agy offers that. */
export const AGY_PERMISSION_POLICY: AcpPermissionPolicy = (request) => acpPermissionChoice(request, "allow_once", "allow_always");

/** How the adapter starts an `agy acp` server. */
export interface AgyLaunch {
  /** The `agy` binary. Defaults to `agy` on the launch environment's PATH. */
  bin: string;
  env: NodeJS.ProcessEnv;
  commands: CommandContainment;
  clientInfo: { name: string; version: string };
  /** The bound on every request but a prompt. */
  requestTimeoutMs?: number;
  /** Receives the `transport/decodeFailed` event for a frame the client could not use. */
  onEvent?: (event: RuntimeEvent) => void;
}

/** What a worker is opened with: where it runs, and the settings it is given before its first prompt. */
interface AgyWorkerSettings {
  cwd: string;
  model?: string;
  effort?: string;
}

/**
 * One `agy acp` process and its one session. Opening it is the dispatch:
 * every refusal before a prompt is sent surfaces from `open`.
 */
class AgyWorker {
  readonly client: AcpClient;
  readonly session: AcpSession;
  /** The level the model runs at, where it has one to report. */
  readonly effort: string | null;
  #listener: ((update: AcpSessionUpdate) => void) | null = null;
  #stop: Promise<CommandStop> | null = null;

  private constructor(client: AcpClient, session: AcpSession, effort: string | null, route: (worker: AgyWorker) => void) {
    this.client = client;
    this.session = session;
    this.effort = effort;
    route(this);
  }

  /**
   * Start the server, open the session and apply the model and level.
   * Rejects with `AgySubstrateRefusedError` where agy could not start, has
   * no sign-in or opened no session, and with `InvalidAgentOptionValueError`
   * for a model agy does not list or a level the model does not offer;
   * every rejection stops the process first.
   */
  static async open(launch: AgyLaunch, settings: AgyWorkerSettings): Promise<AgyWorker> {
    let client: AcpClient;
    try {
      client = await AcpClient.start({
        name: AGY_ACP,
        file: launch.bin,
        args: ["acp"],
        cwd: settings.cwd,
        env: launch.env,
        commands: launch.commands,
        clientInfo: launch.clientInfo,
        permissionPolicy: AGY_PERMISSION_POLICY,
        onDecodeFailure: (failure) => launch.onEvent?.({
          method: "transport/decodeFailed",
          params: { byteLength: failure.byteLength, linePrefix: failure.linePrefix },
          receivedAt: Date.now()
        }),
        ...(launch.requestTimeoutMs !== undefined ? { requestTimeoutMs: launch.requestTimeoutMs } : {})
      });
    } catch (error) {
      throw refusal(`${AGY_ACP} could not start in ${settings.cwd}`, error);
    }
    let deliver: (update: AcpSessionUpdate) => void = () => undefined;
    try {
      const session = await client.newSession({ cwd: settings.cwd, onUpdate: (update) => deliver(update) });
      const effort = await applySettings(session, settings);
      return new AgyWorker(client, session, effort, (worker) => {
        deliver = (update) => worker.#listener?.(update);
      });
    } catch (error) {
      await client.close();
      if (error instanceof InvalidAgentOptionValueError) throw error;
      if (error instanceof AcpRequestError && error.code === AGY_AUTHENTICATION_REQUIRED) {
        throw refusal("agy is not signed in: run `agy` once and sign in to the account its workers should use", error);
      }
      throw refusal(`${AGY_ACP} opened no session in ${settings.cwd}`, error);
    }
  }

  /** The model the session runs on, as agy names it; null where agy offers no model setting. */
  get model(): string | null {
    return this.session.model?.current ?? null;
  }

  /** Receives this worker's updates; one turn listens at a time. */
  listen(listener: ((update: AcpSessionUpdate) => void) | null): void {
    this.#listener = listener;
  }

  /** Stops the process; every call shares the one stop. */
  close(): Promise<CommandStop> {
    this.#stop ??= this.client.close();
    return this.#stop;
  }

  get closed(): boolean {
    return this.#stop !== null;
  }
}

function refusal(detail: string, cause: unknown): AgySubstrateRefusedError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const refused = new AgySubstrateRefusedError(`${detail}: ${reason}`, cause instanceof Error ? cause : undefined);
  const exit = workerExitStatusOf(cause);
  return exit === null ? refused : attachWorkerExitStatus(refused, exit);
}

/**
 * Sets the dispatch's model and level on a fresh session and returns the
 * level it runs at. The model is checked against the session's own list
 * before it is asked for, so a misspelt name is refused with the names agy
 * offers; a level is checked against the levels agy lists once the model is
 * set. A model with a single level offers no setting: a level asked of it
 * is accepted where it is that model's one level and refused otherwise.
 */
async function applySettings(session: AcpSession, settings: AgyWorkerSettings): Promise<string | null> {
  if (settings.model !== undefined) {
    const offered = session.model?.values ?? [];
    if (!offered.includes(settings.model)) {
      throw new InvalidAgentOptionValueError("model", settings.model,
        `one of ${offered.join(" | ")} (the models agy lists; the effort is set apart from the model, so a name carries no level)`);
    }
    try {
      await session.setModel(settings.model);
    } catch (error) {
      if (error instanceof AcpRequestError && error.code === AGY_INVALID_PARAMS) {
        throw new InvalidAgentOptionValueError("model", settings.model, `a model agy serves (${error.message})`);
      }
      throw error;
    }
  }
  const model = session.model?.current ?? settings.model ?? "the default model";
  const levels = session.thoughtLevel;
  if (levels === null) {
    const sole = soleLevelOf(model);
    if (settings.effort !== undefined && settings.effort !== sole) {
      throw new InvalidAgentOptionValueError("effort", settings.effort,
        sole === null ? `absent — agy offers no thought level for ${model}` : `${sole}, the one level agy offers for ${model}`);
    }
    return sole;
  }
  if (settings.effort === undefined) return levels.current;
  if (!levels.values.includes(settings.effort)) {
    throw new InvalidAgentOptionValueError("effort", settings.effort,
      `one of ${levels.values.join(" | ")} (the thought levels agy offers for ${model})`);
  }
  if (levels.current !== settings.effort) {
    try {
      await session.setThoughtLevel(settings.effort);
    } catch (error) {
      if (error instanceof AcpRequestError && error.code === AGY_INVALID_PARAMS) {
        throw new InvalidAgentOptionValueError("effort", settings.effort, `a thought level agy serves for ${model} (${error.message})`);
      }
      throw error;
    }
  }
  return session.thoughtLevel?.current ?? settings.effort;
}

function soleLevelOf(model: string): string | null {
  return SOLE_LEVEL_SUFFIX.exec(model)?.[1] ?? null;
}

/**
 * The models agy offers and the canonical levels each serves, read once
 * from a session that is never prompted, so effort resolution can clamp a
 * level before a worker is dispatched.
 */
interface AgyModelCatalogue {
  defaultModel: string | null;
  levels: ReadonlyMap<string, ServedEffortLevels | null>;
}

async function readCatalogue(launch: AgyLaunch, cwd: string): Promise<AgyModelCatalogue> {
  const worker = await AgyWorker.open(launch, { cwd });
  try {
    const defaultModel = worker.model;
    const levels = new Map<string, ServedEffortLevels | null>();
    for (const model of worker.session.model?.values ?? []) {
      await worker.session.setModel(model);
      const offered = worker.session.thoughtLevel?.values ?? [];
      const sole = soleLevelOf(model);
      const canonical = worker.session.thoughtLevel === null ? (sole === null ? [] : [sole]) : offered.filter(isCanonicalEffort);
      levels.set(model, canonical.length === 0 ? null : Object.fromEntries(canonical.map((level) => [level, level])));
    }
    return { defaultModel, levels };
  } finally {
    await worker.close();
  }
}

/** How one turn ended, with everything it showed on the way. */
interface AgyTurn {
  ending:
    | { kind: "replied"; reply: AcpPromptResult }
    | { kind: "deadline"; reply: AcpPromptResult | null }
    | { kind: "whitespace"; reply: AcpPromptResult | null }
    | { kind: "rejected"; error: AcpRequestError }
    | { kind: "lost"; error: Error };
  /** The message text after the turn's last tool call. */
  finalText: string;
  /** Every message chunk of the turn, in order. */
  allText: string;
  startedAt: number;
  firstDeltaAt: number | null;
  endedAt: number;
  /** The turn as it was exchanged, one JSON value per line. */
  transcript: string[];
  /** Stops of the turn's worker, for the attempt's account: the caller adds the stop of a worker that is gone or was stopped. */
  stops: CommandStop[];
}

/**
 * Runs one prompt on a worker, bounded by the turn deadline and the
 * whitespace bound: either ends the turn with `session/cancel`, and a turn
 * that does not end within the grace is ended by stopping the worker.
 */
async function runTurn(worker: AgyWorker, message: string, timeoutMs: number | undefined, context: EngineAttemptContext): Promise<AgyTurn> {
  const startedAt = Date.now();
  const turn: AgyTurn = {
    ending: { kind: "lost", error: new Error("unsettled") },
    finalText: "", allText: "", startedAt, firstDeltaAt: null, endedAt: startedAt,
    transcript: [JSON.stringify({ type: "prompt", at: new Date(startedAt).toISOString(), text: message })],
    stops: []
  };
  let stopping: "deadline" | "whitespace" | null = null;
  let grace: NodeJS.Timeout | undefined;
  const stop = (reason: "deadline" | "whitespace"): void => {
    if (stopping !== null) return;
    stopping = reason;
    worker.session.cancel();
    // The stop is the caller's to account: it finds the worker closed.
    grace = setTimeout(() => { void worker.close(); }, CANCEL_GRACE_MS);
  };
  const whitespace = new WhitespaceStream(startedAt, () => stop("whitespace"));
  const deadline = timeoutMs === undefined ? undefined : setTimeout(() => stop("deadline"), timeoutMs);
  let seen = false;
  worker.listen((update) => {
    turn.transcript.push(JSON.stringify({ type: "update", at: new Date(update.receivedAt).toISOString(), update: update.body }));
    if (!seen) {
      seen = true;
      safely(() => context.onLiveEvidence?.());
    }
    const text = update.kind === "agent_message_chunk" ? acpUpdateText(update) : null;
    if (text !== null) {
      turn.firstDeltaAt ??= update.receivedAt;
      turn.allText += text;
      turn.finalText += text;
      whitespace.observeText(text);
    } else if (update.kind === "tool_call" || update.kind === "tool_call_update") {
      turn.finalText = "";
      whitespace.observeActivity();
    } else if (update.kind === "agent_thought_chunk" || update.kind === "plan") {
      whitespace.observeActivity();
    }
    safely(() => context.onOutput?.());
  });
  try {
    const reply = await worker.session.prompt(message);
    turn.transcript.push(JSON.stringify({ type: "reply", at: new Date().toISOString(), reply: reply.reply }));
    turn.ending = stopping === null ? { kind: "replied", reply } : { kind: stopping, reply };
  } catch (error) {
    if (stopping !== null && error instanceof AcpExitedError) {
      turn.ending = { kind: stopping, reply: null };
    } else if (error instanceof AcpRequestError) {
      turn.ending = { kind: "rejected", error };
    } else {
      turn.ending = { kind: "lost", error: error instanceof Error ? error : new Error(String(error)) };
    }
  } finally {
    clearTimeout(deadline);
    clearTimeout(grace);
    whitespace.clear();
    worker.listen(null);
    turn.endedAt = Date.now();
  }
  return turn;
}

function safely(observe: () => void): void {
  try { observe(); } catch { /* Observability cannot fail a turn. */ }
}

/** Turns a reply's counts into the shared breakdown: agy's input excludes the cached share, and its output includes the thought tokens. */
function breakdownOf(usage: AcpUsage): TokenUsageBreakdown {
  const cachedRead = usage.cachedReadTokens ?? 0;
  const cachedWrite = usage.cachedWriteTokens;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const thought = usage.thoughtTokens;
  return {
    inputTokens: input,
    cachedInputTokens: cachedRead + (cachedWrite ?? 0),
    ...(cachedWrite !== null ? { cacheCreationInputTokens: cachedWrite } : {}),
    outputTokens: output,
    ...(thought !== null ? { reasoningOutputTokens: thought } : {}),
    totalTokens: usage.totalTokens ?? input + cachedRead + (cachedWrite ?? 0) + output
  };
}

function addUsage(total: TokenUsageBreakdown | null, last: TokenUsageBreakdown): TokenUsageBreakdown {
  if (total === null) return last;
  const optional = (key: "cacheCreationInputTokens" | "reasoningOutputTokens"): Partial<TokenUsageBreakdown> =>
    total[key] === undefined && last[key] === undefined ? {} : { [key]: (total[key] ?? 0) + (last[key] ?? 0) };
  return {
    inputTokens: total.inputTokens + last.inputTokens,
    cachedInputTokens: total.cachedInputTokens + last.cachedInputTokens,
    outputTokens: total.outputTokens + last.outputTokens,
    totalTokens: total.totalTokens + last.totalTokens,
    ...optional("cacheCreationInputTokens"),
    ...optional("reasoningOutputTokens")
  };
}

/**
 * What one worker's turns are accounted under: its session's usage, summed
 * across turns, and the identity every attempt result carries.
 */
class AgyAccount {
  #total: TokenUsageBreakdown | null = null;
  #turns = 0;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;

  constructor(onEvent: ((event: RuntimeEvent) => void) | undefined) {
    this.#onEvent = onEvent;
  }

  /** Records a reply's usage, reports it, and returns its event; null where the reply carried none. */
  usage(worker: AgyWorker, reply: AcpPromptResult | null, context: EngineAttemptContext): TokenUsageEvent | null {
    if (reply?.usage == null) return null;
    const last = breakdownOf(reply.usage);
    if (last.totalTokens === 0) return null;
    this.#total = addUsage(this.#total, last);
    this.#turns += 1;
    const threadId = worker.session.id;
    const turnId = `${threadId}:agy-${this.#turns}`;
    const raw: JsonObject = {
      threadId, turnId, model: worker.model, tokenUsage: { last: { ...last }, total: { ...this.#total } }, usage: { ...reply.usage }
    };
    const event: TokenUsageEvent = { threadId, turnId, last, total: this.#total, raw };
    safely(() => context.onUsage?.(event));
    safely(() => this.#onEvent?.({ method: "thread/tokenUsage/updated", params: raw, receivedAt: Date.now() }));
    return event;
  }
}

/**
 * What a turn showed, as an attempt result with no failure yet: its text,
 * its usage (accounted and reported here), its transcript and agy's own
 * diagnostics.
 */
function turnEvidence(worker: AgyWorker, turn: AgyTurn, account: AgyAccount, context: EngineAttemptContext): EngineAttemptResult {
  const ending = turn.ending;
  const reply = ending.kind === "replied" || ending.kind === "deadline" || ending.kind === "whitespace" ? ending.reply : null;
  const usageEvent = account.usage(worker, reply, context);
  const transcript: EngineTranscriptArtifact = {
    filename: "transcript.agy.jsonl",
    format: "jsonl",
    source: "agy acp session/update stream",
    content: `${turn.transcript.join("\n")}\n`,
    sessionId: worker.session.id,
    ...(ending.kind === "replied" ? {} : { partial: true })
  };
  const model = worker.model;
  return {
    text: turn.finalText,
    ...(model !== null ? { resolvedModel: model } : {}),
    ...(worker.effort !== null ? { resolvedEffort: worker.effort } : {}),
    deltaText: turn.allText,
    durationMs: turn.endedAt - turn.startedAt,
    firstDeltaMs: turn.firstDeltaAt === null ? null : turn.firstDeltaAt - turn.startedAt,
    items: {},
    tokenUsageEvents: usageEvent === null ? [] : [usageEvent],
    transcripts: [transcript],
    diagnostics: {
      agy: {
        session_id: worker.session.id,
        stop_reason: reply?.stopReason ?? null,
        ...(ending.kind === "rejected" ? { error: { code: ending.error.code ?? null, message: ending.error.message } } : {})
      },
      ...unestablishedStopDiagnostics(turn.stops)
    }
  };
}

/**
 * Settles a turn's evidence as the attempt's outcome: the answer, or a
 * returned failure the runtime's retry rule governs. A deadline and the
 * whitespace bound throw, carrying the evidence, as they do on every engine.
 */
function settleTurn(evidence: EngineAttemptResult, turn: AgyTurn, sessionId: string, timeoutMs: number | undefined): EngineAttemptResult {
  const ending = turn.ending;
  switch (ending.kind) {
    case "replied":
      if (ending.reply.stopReason !== "end_turn") {
        evidence.attemptFailure = { kind: "agy-stop-reason", message: `agy ended the turn with stop reason ${JSON.stringify(ending.reply.stopReason)}` };
      }
      return evidence;
    case "deadline": {
      const error = new TurnTimeoutError(`agy turn timed out after ${timeoutMs}ms`, { kind: "turn", timeoutMs: timeoutMs ?? 0, threadId: sessionId });
      throw attachPartialWorkerText(attachFailedTurnResult(error, evidence), turn.allText);
    }
    case "whitespace":
      throw attachPartialWorkerText(attachFailedTurnResult(new WhitespaceStreamError(), evidence), turn.allText);
    case "rejected":
      evidence.attemptFailure = ending.error.code === AGY_AUTHENTICATION_REQUIRED
        ? { kind: "agy-sign-in-required", message: `agy refused the prompt for want of a sign-in (run \`agy\` and sign in): ${ending.error.message}` }
        : { kind: "agy-prompt-error", message: ending.error.message };
      return evidence;
    case "lost": {
      evidence.attemptFailure = { kind: "agy-worker-lost", message: `the agy worker ended before its turn did: ${ending.error.message}` };
      const exit = workerExitStatusOf(ending.error);
      if (exit !== null) evidence.workerExit = exit;
      return evidence;
    }
  }
}

/** Whether the turn's message reached the session: a reply of any stop reason, or a stop the harness made of it. */
function delivered(turn: AgyTurn): boolean {
  return turn.ending.kind === "replied" || turn.ending.kind === "deadline" || turn.ending.kind === "whitespace";
}

interface AgyInvocationOptions {
  prompt: string;
  options: EngineTurnOptions;
  cwd: string;
  launch: AgyLaunch;
  onClose: (closed: AgyEngineInvocation) => void;
}

/**
 * One one-shot worker. Its first attempt opens a worker; a later attempt
 * corrects in that worker's session while it lives, and opens a new one,
 * told of the failure, once it has gone.
 */
export class AgyEngineInvocation implements EngineInvocation {
  #options: AgyInvocationOptions;
  #worker: AgyWorker | null = null;
  /** Whether the live worker's session holds the task: its opening prompt was delivered. */
  #holdsTask = false;
  #account: AgyAccount;
  #closed = false;
  #settlement: Promise<unknown> | null = null;

  constructor(options: AgyInvocationOptions) {
    this.#options = options;
    this.#account = new AgyAccount(options.launch.onEvent);
  }

  runAttempt(context: EngineAttemptContext): Promise<EngineAttemptResult> {
    const settlement = this.#runAttempt(context);
    this.#settlement = settlement;
    return settlement;
  }

  async #runAttempt(context: EngineAttemptContext): Promise<EngineAttemptResult> {
    if (this.#closed) throw new EngineShutdownError("agy");
    const options = this.#options.options;
    if (this.#worker === null) {
      this.#worker = await AgyWorker.open(this.#options.launch, workerSettings(this.#options.cwd, options));
      this.#holdsTask = false;
    }
    const worker = this.#worker;
    if (this.#closed) throw new EngineShutdownError("agy");
    const message = this.#holdsTask && context.previousFailure !== undefined
      ? inSessionCorrection(context.previousFailure)
      : openingPrompt({
        task: this.#options.prompt,
        ...(options.schema !== undefined ? { schema: options.schema } : {}),
        ...(context.previousFailure !== undefined ? { previousFailure: context.previousFailure } : {})
      });
    safely(() => context.onIdentity?.({ resolvedModel: worker.model, resolvedEffort: worker.effort }));
    const turn = await runTurn(worker, message, options.timeoutMs, context);
    if (delivered(turn)) this.#holdsTask = true;
    if (turn.ending.kind === "lost" || worker.closed) {
      this.#worker = null;
      turn.stops.push(await worker.close());
    }
    if (this.#closed) {
      throw attachPartialWorkerText(new EngineShutdownError("agy"), turn.allText);
    }
    return settleTurn(turnEvidence(worker, turn, this.#account, context), turn, worker.session.id, options.timeoutMs);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#worker?.close();
      await this.#settlement?.catch(() => undefined);
    } finally {
      this.#worker = null;
      this.#options.onClose(this);
    }
  }
}

function workerSettings(cwd: string, options: EngineTurnOptions): AgyWorkerSettings {
  return {
    cwd,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {})
  };
}

interface AgySessionOptions {
  options: EngineTurnOptions;
  cwd: string;
  launch: AgyLaunch;
  observer: EngineSessionObserver | undefined;
  onClose: (closed: AgyWorkerSession) => void;
}

/**
 * One held agy worker: one `agy acp` process and session, opened at the
 * first turn and kept for every later one, so the conversation and its
 * prompt cache build up in agy. A retry corrects in the same session. The
 * worker is lost when its process ends while the session is open; from
 * then on every attempt returns `session-lost`.
 */
class AgyWorkerSession implements EngineWorkerSession {
  #options: AgySessionOptions;
  #worker: AgyWorker | null = null;
  #opening: Promise<AgyWorker> | null = null;
  /** Whether any turn's message has reached the session, so a later turn is not its first. */
  #opened = false;
  #account: AgyAccount;
  #lost: EngineSessionLoss | null = null;
  #lostExit: WorkerExitStatus | null = null;
  #closed = false;

  constructor(options: AgySessionOptions) {
    this.#options = options;
    this.#account = new AgyAccount(options.launch.onEvent);
  }

  beginTurn(prompt: string, turn: EngineSessionTurn): EngineInvocation {
    /** Whether this turn's own message has reached the session. */
    let turnDelivered = false;
    return {
      runAttempt: async (context) => {
        if (this.#lost !== null) return this.#lostResult();
        if (this.#closed) throw new EngineShutdownError("agy");
        const worker = await this.#ensureWorker();
        if (this.#lost !== null) return this.#lostResult();
        if (this.#closed) throw new EngineShutdownError("agy");
        const message = turnDelivered && context.previousFailure !== undefined
          ? inSessionCorrection(context.previousFailure)
          : this.#turnMessage(prompt, turn.schema, context.previousFailure);
        safely(() => context.onIdentity?.({ resolvedModel: worker.model, resolvedEffort: worker.effort }));
        const ran = await runTurn(worker, message, this.#options.options.timeoutMs, context);
        if (delivered(ran)) {
          turnDelivered = true;
          this.#opened = true;
        }
        if (this.#closed) throw attachPartialWorkerText(new EngineShutdownError("agy"), ran.allText);
        const gone = ran.ending.kind === "lost" || worker.closed;
        if (gone) ran.stops.push(await worker.close());
        const evidence = turnEvidence(worker, ran, this.#account, context);
        if (gone) {
          // The worker went with the turn, or would not end it and was
          // stopped: the session is gone, and the turn's evidence rides the loss.
          const exit = await worker.client.exited;
          this.#noteLost(worker, ran.ending.kind === "lost" ? ran.ending.error.message : "it did not end a cancelled turn and was stopped", exit);
          const lost = this.#lostResult();
          return { ...evidence, attemptFailure: lost.attemptFailure!, ...(lost.workerExit !== undefined ? { workerExit: lost.workerExit } : {}) };
        }
        return settleTurn(evidence, ran, worker.session.id, this.#options.options.timeoutMs);
      }
    };
  }

  /**
   * A turn's message: the opening prompt for the session's first, which
   * carries the standing instructions, and the later-turn prompt after.
   * An opening resent after a failure it never saw is told of the failure.
   */
  #turnMessage(prompt: string, schema: JsonSchema | undefined, previousFailure: PreviousAttemptFailure | undefined): string {
    if (this.#opened) {
      const message = laterTurnPrompt({ task: prompt, ...(schema !== undefined ? { schema } : {}) });
      return previousFailure === undefined ? message : `${previousFailureNotice(previousFailure)}\n\n${message}`;
    }
    return openingPrompt({
      task: prompt,
      ...(schema !== undefined ? { schema } : {}),
      ...(previousFailure !== undefined ? { previousFailure } : {})
    });
  }

  /**
   * Single-flight worker open, not failure-memoised: a failed open leaves
   * the session without a worker, so the call's next attempt or next turn
   * may try again.
   */
  #ensureWorker(): Promise<AgyWorker> {
    if (this.#worker !== null) return Promise.resolve(this.#worker);
    this.#opening ??= (async () => {
      try {
        const worker = await AgyWorker.open(this.#options.launch, workerSettings(this.#options.cwd, this.#options.options));
        if (this.#closed) {
          await worker.close();
          throw new EngineShutdownError("agy");
        }
        this.#worker = worker;
        void worker.client.exited.then((exit) => {
          if (!worker.closed) this.#noteLost(worker, describeExit(exit), exit);
        });
        return worker;
      } finally {
        this.#opening = null;
      }
    })();
    return this.#opening;
  }

  #noteLost(worker: AgyWorker, reason: string, exit: AcpExit): void {
    if (this.#closed || this.#lost !== null) return;
    this.#lost = { nativeSession: worker.session.id, reason: `the agy worker is gone: ${reason}`, observedAt: Date.now() };
    this.#lostExit = exit.exitCode !== null || exit.signal !== null ? { exitCode: exit.exitCode, signal: exit.signal } : null;
    safely(() => this.#options.observer?.onLost(this.#lost!));
  }

  #lostResult(): EngineAttemptResult {
    return {
      text: "", deltaText: "", durationMs: null, firstDeltaMs: null, items: {}, tokenUsageEvents: [],
      attemptFailure: { kind: "session-lost", message: this.#lost!.reason },
      ...(this.#lostExit !== null ? { workerExit: this.#lostExit } : {})
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#opening?.catch(() => undefined);
      await this.#worker?.close();
    } finally {
      this.#worker = null;
      this.#options.onClose(this);
    }
  }
}

function describeExit(exit: AcpExit): string {
  const how = exit.signal !== null ? `${AGY_ACP} was ended by ${exit.signal}` : `${AGY_ACP} exited with code ${exit.exitCode}`;
  const stderr = exit.stderrTail.trim();
  return stderr.length > 0 ? `${how}; its last stderr: ${stderr}` : how;
}

export interface AgyEngineAdapterOptions {
  /** Defaults to the fixed per-engine cap (12; see concurrency-defaults). */
  concurrency?: number;
  /** Base working directory workers are dispatched from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The `agy` binary. Defaults to `agy`, found on the launch environment's PATH. */
  bin?: string;
  /** The machine's declared variables for agy's processes. */
  workerEnv?: Record<string, string>;
  /**
   * The run's command containment, which every `agy acp` process starts
   * inside. Omitted, the adapter owns containment of its own and closes it
   * when it closes.
   */
  commands?: CommandContainment;
  clientInfo?: { name: string; version: string };
  requestTimeoutMs?: number;
  /** Routes agy token usage and decode diagnostics into the runtime. */
  onEvent?: (event: RuntimeEvent) => void;
}

export class AgyEngineAdapter implements EngineAdapter {
  readonly name = "agy" as const;
  readonly concurrency: number;
  /** A strip refuses before dispatch: agy's `DisableBuiltInTools` and its skills were never driven. */
  readonly capabilities: EngineCapabilityTable = {
    skills: {
      route: "unsupported",
      detail: "no route that withholds agy's skills from one session has been established"
    },
    agents: {
      route: "unsupported",
      detail: "no route that withholds agy's subagent tools from one session has been established (DisableBuiltInTools on session/new is undriven)"
    }
  };

  readonly leanStart: LeanStartSupport = {
    route: "unsupported",
    detail: "no established route withholds agy's user instructions, skills and MCP servers from one session"
  };

  #cwd: string;
  #launch: AgyLaunch;
  #ownsCommands: boolean;
  #scheduler: Scheduler;
  #invocations = new Set<AgyEngineInvocation>();
  #sessions = new Set<AgyWorkerSession>();
  #catalogue: Promise<AgyModelCatalogue> | null = null;
  #closed = false;

  constructor(options: AgyEngineAdapterOptions = {}) {
    this.concurrency = options.concurrency ?? defaultAgyConcurrency();
    this.#scheduler = new Scheduler(this.concurrency);
    this.#cwd = options.cwd ?? process.cwd();
    this.#ownsCommands = options.commands === undefined;
    this.#launch = {
      bin: options.bin ?? "agy",
      env: launchEnvironment("agy", options.workerEnv),
      commands: options.commands ?? new CommandContainment(new NoWorkerScopes()),
      clientInfo: options.clientInfo ?? { name: "ensemble-workflows", version: "0" },
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {})
    };
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return this.#scheduler.schedule(task);
  }

  /**
   * agy's own account of a model's levels: read once per adapter from a
   * session that is never prompted, and read again after a failed reading.
   * Null where agy cannot be read or does not list the model.
   */
  async effortReport(model: string | undefined): Promise<EngineEffortReport | null> {
    if (this.#closed) return null;
    this.#catalogue ??= readCatalogue(this.#launch, this.#cwd);
    let catalogue: AgyModelCatalogue;
    try {
      catalogue = await this.#catalogue;
    } catch {
      this.#catalogue = null;
      // A reading that failed is not evidence about the worker: its own dispatch refuses as it must.
      return null;
    }
    const identity = model ?? catalogue.defaultModel;
    if (identity === null || !catalogue.levels.has(identity)) return null;
    return { identity, levels: catalogue.levels.get(identity) ?? null };
  }

  createInvocation(prompt: string, options: EngineTurnOptions): EngineInvocation {
    if (this.#closed) throw new EngineShutdownError(this.name);
    const invocation = new AgyEngineInvocation({
      prompt, options, cwd: options.cwd ?? this.#cwd, launch: this.#launch,
      onClose: (closed) => this.#invocations.delete(closed)
    });
    this.#invocations.add(invocation);
    return invocation;
  }

  createSession(options: EngineTurnOptions, observer?: EngineSessionObserver): EngineWorkerSession {
    if (this.#closed) throw new EngineShutdownError(this.name);
    const session = new AgyWorkerSession({
      options, cwd: options.cwd ?? this.#cwd, launch: this.#launch, observer,
      onClose: (closed) => this.#sessions.delete(closed)
    });
    this.#sessions.add(session);
    return session;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#scheduler.close(new EngineShutdownError(this.name));
    await Promise.allSettled([
      ...[...this.#invocations].map((invocation) => invocation.close()),
      ...[...this.#sessions].map((session) => session.close()),
      this.#catalogue?.catch(() => undefined)
    ]);
    if (this.#ownsCommands) await this.#launch.commands.close();
  }
}
