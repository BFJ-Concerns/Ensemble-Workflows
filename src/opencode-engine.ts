import { randomUUID } from "node:crypto";

import { CommandContainment, unestablishedStopDiagnostics, type CommandStop, type ContainedCommand } from "./contained-command.js";
import { launchEnvironment } from "./engine-environment.js";
import {
  EngineShutdownError,
  SubstrateRefusedError,
  TurnTimeoutError,
  WhitespaceStreamError,
  attachFailedTurnResult,
  attachPartialWorkerText,
  attachWorkerExitStatus,
  failedTurnResultOf,
  partialWorkerTextOf
} from "./errors.js";
import { OPENCODE_TRANSCRIPT, transcriptContent } from "./live-transcript.js";
import { prepareOpenCodeLaunch, sweepAbandonedOpenCodeProfiles } from "./opencode-launch-config.js";
import { subtractUsage } from "./usage-summary.js";
import { WhitespaceStream } from "./whitespace-stream.js";
import { openingPrompt } from "./worker-instructions.js";
import { createWorkerScopes, DEFAULT_STOP_BOUNDS } from "./worker-scopes.js";

import type { StrippableCapability } from "./capability-stripping.js";
import type {
  EngineAttemptContext,
  PreviousAttemptFailure,
  EngineAttemptResult,
  EngineInvocation,
  EngineTurnOptions
} from "./engines.js";
import type { EngineTranscriptArtifact, RuntimeEvent, TokenUsageBreakdown, TokenUsageEvent } from "./types.js";

export interface OpenCodeRunner {
  run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult>;
  exportSession(sessionId: string, cwd: string, signal?: AbortSignal, onCommandStop?: (stop: CommandStop) => void): Promise<OpenCodeSessionExportResult>;
}

export type OpenCodeSessionExportResult =
  | { status: "ok"; stdout: string }
  | {
      status: "command-failed";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    };

export interface OpenCodeRunOptions {
  prompt: string;
  cwd: string;
  providerModel: string;
  // Omitted → the run subprocess is not killed on a deadline (unbounded).
  timeoutMs?: number;
  variant?: string;
  strip?: readonly StrippableCapability[];
  lean?: boolean;
  /** Aborting stops the command's containment (SIGTERM, escalating to SIGKILL). */
  signal?: AbortSignal;
  /** Called once, on the run's first stdout chunk — the earliest observable sign of worker output. */
  onFirstData?: () => void;
  /** Receives each stdout chunk so live accounting can advance before exit. */
  onData?: (chunk: string) => void;
  /** Every command stop, including one followed by a thrown runner failure. */
  onCommandStop?: (stop: CommandStop) => void;
}

export interface OpenCodeRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The runner's per-turn timer expired while the subprocess was still running. */
  deadlineExpired?: boolean;
  /** The run was stopped after streaming only whitespace past the bound. */
  whitespaceLimitReached?: boolean;
}

export interface OpenCodeEngineInvocationOptions {
  prompt: string;
  cwd: string;
  providerModel: string;
  modelKey: string;
  options: EngineTurnOptions;
  runner?: OpenCodeRunner;
  onEvent?: (event: RuntimeEvent) => void;
  /** Adapter deregistration: called exactly once, when close() completes. */
  onClose?: (invocation: OpenCodeEngineInvocation) => void;
}

interface OpenCodeExport {
  info?: {
    id?: unknown;
    tokens?: unknown;
    cost?: unknown;
    model?: unknown;
  };
  messages?: unknown;
}

interface ParsedRunEvents {
  events: unknown[];
  sessionId: string | null;
}

interface OpenCodeUsage {
  breakdown: TokenUsageBreakdown | null;
  cost: unknown;
}

interface OpenCodeTokenSnapshot {
  cachedInputTokens: number;
  cacheCreationInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  reportedTotal: number | null;
  hasCategorisedTokens: boolean;
}

type OpenCodeExportDiagnostic =
  | { status: "available" }
  | { status: "no-session-id" }
  | { status: "command-failed"; exit_code: number | null; signal: NodeJS.Signals | null; stderr: string }
  | { status: "parse-failed"; error: string }
  | { status: "unusable"; error: string };

type ParsedExport = { ok: true; data: OpenCodeExport } | { ok: false; error: string };

export class OpenCodeCliRunner implements OpenCodeRunner {
  #bin: string;
  #killGraceMs: number;
  #env: NodeJS.ProcessEnv;
  #commands: CommandContainment | undefined;
  #profileSweep: Promise<void> | undefined;

  constructor(bin = "opencode", options: { killGraceMs?: number; workerEnv?: Record<string, string>; commands?: CommandContainment } = {}) {
    this.#bin = bin;
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_STOP_BOUNDS.stopGraceMs;
    this.#env = launchEnvironment("opencode", options.workerEnv);
    this.#commands = options.commands;
  }

  async run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    const args = [
      "run",
      "--auto",
      "--format",
      "json",
      "--model",
      options.providerModel,
      "--dir",
      options.cwd,
      "--title",
      "ensemble-worker"
    ];
    if (options.variant !== undefined) {
      args.push("--variant", options.variant);
    }
    args.push(options.prompt);
    const signal = options.signal;
    if (signal?.aborted) return stoppedBeforeLaunch();
    try {
      this.#profileSweep ??= sweepAbandonedOpenCodeProfiles();
      await this.#profileSweep;
      if (signal?.aborted) return stoppedBeforeLaunch();
      const launch = await prepareOpenCodeLaunch({
        env: this.#env,
        strip: options.strip ?? [],
        lean: options.lean === true,
        providerModel: options.providerModel,
        run: (command, env) => runProcess(
          this.#bin, command, options.cwd, env, this.#commands, 30_000,
          this.#killGraceMs, signal, undefined, undefined, options.onCommandStop
        )
      });
      try {
        return await runProcess(
          this.#bin, args, options.cwd, launch.env, this.#commands,
          options.timeoutMs, this.#killGraceMs, signal, options.onFirstData,
          options.onData, options.onCommandStop
        );
      } finally {
        await launch.close?.();
      }
    } catch (error) {
      if (signal?.aborted) return stoppedBeforeLaunch();
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "EACCES") {
        throw new SubstrateRefusedError(`opencode could not start (${code})`, { cause: error });
      }
      throw error;
    }
  }

  async exportSession(sessionId: string, cwd: string, signal?: AbortSignal, onCommandStop?: (stop: CommandStop) => void): Promise<OpenCodeSessionExportResult> {
    const result = await runProcess(this.#bin, ["export", sessionId], cwd, this.#env, this.#commands, 30_000, this.#killGraceMs, signal, undefined, undefined, onCommandStop);
    if (result.exitCode !== 0) {
      return {
        status: "command-failed",
        exitCode: result.exitCode,
        signal: result.signal,
        stderr: result.stderr
      };
    }
    return { status: "ok", stdout: result.stdout };
  }
}

export class OpenCodeEngineInvocation implements EngineInvocation {
  #prompt: string;
  #cwd: string;
  #providerModel: string;
  #modelKey: string;
  #options: EngineTurnOptions;
  #runner: OpenCodeRunner;
  #onEvent: ((event: RuntimeEvent) => void) | undefined;
  #reportedUsage: TokenUsageBreakdown | null = null;
  #budgetEventCounter = 0;
  #abortController = new AbortController();
  #closePromise: Promise<void> | null = null;
  #settlement: Promise<EngineAttemptResult> | null = null;
  #onClose: ((invocation: OpenCodeEngineInvocation) => void) | undefined;

  constructor(options: OpenCodeEngineInvocationOptions) {
    this.#prompt = options.prompt;
    this.#cwd = options.cwd;
    this.#providerModel = options.providerModel;
    this.#modelKey = options.modelKey;
    this.#options = options.options;
    this.#runner = options.runner ?? new OpenCodeCliRunner();
    this.#onEvent = options.onEvent;
    this.#onClose = options.onClose;
  }

  runAttempt(context: EngineAttemptContext): Promise<EngineAttemptResult> {
    // close() must be able to await a live attempt so cancellation is not
    // "torn down under a caller still running": track the settlement.
    const stops: CommandStop[] = [];
    const startedAt = Date.now();
    const settlement = this.#runAttempt(context, (stop) => stops.push(stop)).then(
      (result) => ({ ...result, diagnostics: { ...result.diagnostics, ...unestablishedStopDiagnostics(stops) } }),
      (error: unknown) => {
        if (error instanceof Error && stops.some((stop) => stop.attemptAccount !== null)) {
          // Preserve a timeout's complete evidence. A runner/export failure
          // without a result still carries the stops observed before it threw.
          const text = partialWorkerTextOf(error) ?? "";
          const result = failedTurnResultOf(error) ?? {
            text, deltaText: text, durationMs: Date.now() - startedAt,
            firstDeltaMs: null, items: {}, tokenUsageEvents: []
          };
          result.diagnostics = { ...result.diagnostics, ...unestablishedStopDiagnostics(stops) };
          attachFailedTurnResult(error, result);
        }
        throw error;
      }
    );
    this.#settlement = settlement;
    return settlement.finally(() => {
      if (this.#settlement === settlement) {
        this.#settlement = null;
      }
    });
  }

  async #runAttempt(context: EngineAttemptContext, onCommandStop: (stop: CommandStop) => void): Promise<EngineAttemptResult> {
    this.#reportedUsage = null;
    let streamBuffer = "";
    const streamEvents: unknown[] = [];
    let streamSessionId: string | null = null;
    const syntheticSessionId = this.#syntheticSessionId();
    let identityPublished = false;
    const publishEvent = (event: unknown): void => {
      if (!identityPublished && sessionIdFromEvent(event) !== null) {
        identityPublished = true;
        context.onIdentity?.({ resolvedModel: this.#providerModel, resolvedEffort: null });
      }
      context.onOutput?.();
      context.onTranscriptEvent?.(event);
    };
    const reportUsage = (sessionId: string, usage: OpenCodeUsage): void => {
      if (usage.breakdown === null) return;
      const event = this.#reportUsage(sessionId, usage.breakdown, usage.cost);
      if (event !== null) context.onUsage?.(event);
    };
    const onData = (chunk: string): void => {
      streamBuffer += chunk;
      const lines = streamBuffer.split(/\r?\n/);
      streamBuffer = lines.pop() ?? "";
      const previousCount = streamEvents.length;
      for (const line of lines) {
        const event = parseRunEvent(line);
        if (event === undefined) continue;
        streamEvents.push(event);
        streamSessionId = sessionIdFromEvent(event) ?? streamSessionId;
        publishEvent(event);
      }
      if (streamEvents.length > previousCount) {
        reportUsage(streamSessionId ?? syntheticSessionId, usageFromStream(streamEvents));
      }
    };
    const run = await this.#runner.run({
      prompt: this.#buildPrompt(context.previousFailure),
      cwd: this.#cwd,
      providerModel: this.#providerModel,
      ...(this.#options.strip === undefined ? {} : { strip: this.#options.strip }),
      ...(this.#options.lean === true ? { lean: true } : {}),
      ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}),
      ...(this.#options.effort !== undefined ? { variant: this.#options.effort } : {}),
      ...(context.onLiveEvidence !== undefined ? { onFirstData: context.onLiveEvidence } : {}),
      onData,
      onCommandStop,
      signal: this.#abortController.signal
    });
    const parsedRun = parseRunEvents(run.stdout);
    const sessionId = parsedRun.sessionId ?? syntheticSessionId;
    // A runner can return the last line without a newline, or provide only
    // its completed stdout. Publish any events not delivered in its chunks.
    for (const event of parsedRun.events.slice(streamEvents.length)) publishEvent(event);
    const streamUsage = usageFromStream(parsedRun.events);
    reportUsage(sessionId, streamUsage);
    const fallback = run.whitespaceLimitReached
      ? parsedRun.events.map(runTextPart).join("")
      : fallbackText(parsedRun.events);
    if (this.#abortController.signal.aborted) {
      // A cancelled worker is a shutdown, not an opencode failure — and a
      // cancelled invocation must not fork a fresh export subprocess just
      // to learn what its killed run had said.
      throw attachWorkerExitStatus(
        attachPartialWorkerText(new EngineShutdownError("opencode"), fallback),
        { exitCode: run.exitCode, signal: run.signal }
      );
    }
    const timeoutMs = run.deadlineExpired ? this.#options.timeoutMs : undefined;
    if (run.whitespaceLimitReached || timeoutMs !== undefined) {
      // A stopped run has no export. Keep the spend and transcript already
      // observed in the stream on the attempt's failure.
      const workerExit = { exitCode: run.exitCode, signal: run.signal };
      const error = timeoutMs === undefined ? new WhitespaceStreamError() : new TurnTimeoutError(
        `opencode turn timed out after ${timeoutMs}ms: ${openCodeFailureMessage(run, parsedRun.events)}`, {
          kind: "turn",
          timeoutMs,
          threadId: sessionId
        });
      const evidence = this.#attemptEvidence(parsedRun, null, sessionId, streamUsage);
      attachFailedTurnResult(error, {
        text: fallback,
        resolvedModel: this.#providerModel,
        workerExit,
        deltaText: fallback,
        durationMs: run.durationMs,
        firstDeltaMs: null,
        items: {},
        ...evidence
      });
      throw attachWorkerExitStatus(attachPartialWorkerText(error, fallback), workerExit);
    }
    let exportData: OpenCodeExport | null = null;
    let exportDiagnostic: OpenCodeExportDiagnostic;
    if (parsedRun.sessionId === null) {
      exportDiagnostic = { status: "no-session-id" };
    } else {
      let exportResult: OpenCodeSessionExportResult;
      try {
        exportResult = await this.#runner.exportSession(parsedRun.sessionId, this.#cwd, this.#abortController.signal, onCommandStop);
      } catch (error) {
        if (error instanceof Error) {
          attachPartialWorkerText(error, fallback);
        }
        throw error;
      }
      if (exportResult.status === "command-failed") {
        exportDiagnostic = {
          status: "command-failed",
          exit_code: exportResult.exitCode,
          signal: exportResult.signal,
          stderr: exportResult.stderr
        };
      } else {
        const parsedExport = parseExport(exportResult.stdout);
        if (parsedExport.ok) {
          exportData = parsedExport.data;
          exportDiagnostic = { status: "available" };
        } else {
          exportDiagnostic = { status: "parse-failed", error: parsedExport.error };
        }
      }
    }
    if (this.#abortController.signal.aborted) {
      // Cancellation can also land while the export subprocess runs; a
      // cancelled attempt must terminalise as a shutdown here too, never be
      // classified as a run failure the loop would redispatch or dressed up
      // as a success from fallback text.
      throw attachWorkerExitStatus(
        attachPartialWorkerText(new EngineShutdownError("opencode"), fallback),
        { exitCode: run.exitCode, signal: run.signal }
      );
    }
    let text = fallback;
    if (exportData !== null) {
      const exportedText = finalAssistantText(exportData);
      if (exportedText.trim().length > 0) {
        text = exportedText;
      } else {
        exportDiagnostic = { status: "unusable", error: "export did not contain assistant text" };
      }
    }
    const exportEvent = exportData === null ? null : { type: "session/export", data: exportData };
    if (exportEvent !== null) context.onTranscriptEvent?.(exportEvent);
    const usage = exportData === null
      ? streamUsage
      : { breakdown: usageFromExport(exportData), cost: exportData.info?.cost ?? null };
    reportUsage(sessionId, usage);
    const { tokenUsageEvents, transcripts } = this.#attemptEvidence(parsedRun, exportEvent, sessionId, usage);

    const reportedFailure = reportedRunFailure(parsedRun.events, exportData, text);
    const lostBeforeAnswer = run.signal !== null && reportedFailure === null && text.trim().length === 0;
    if (run.exitCode !== 0 || reportedFailure !== null) {
      // An operational failure consumes a bounded retry attempt, the
      // contract the usage brief documents for every engine — so it returns
      // as a failed result the shared loop governs (imitating the Claude
      // engine's failedTurnResult), not a thrown error that would propagate
      // on the attempt it occurs. For a subprocess engine a retry means a
      // fresh dispatch with the failure folded into the next prompt.
      // Evidence rides the result: the worker's partial text, its usage and
      // transcript, and *how* the process died — exit status or terminating
      // signal — so a killed leg is distinguishable from one that returned
      // nothing.
      return {
        text,
        resolvedModel: this.#providerModel,
        attemptFailure: {
          kind: lostBeforeAnswer ? "opencode-worker-lost" : "opencode-run-error",
          message: reportedFailure === null
            ? openCodeFailureMessage(run, parsedRun.events)
            : `opencode run failed: ${reportedFailure.message}`
        },
        workerExit: { exitCode: run.exitCode, signal: run.signal },
        deltaText: text,
        durationMs: run.durationMs,
        firstDeltaMs: null,
        items: {},
        tokenUsageEvents,
        transcripts,
        diagnostics: {
          opencode: {
            session_export: exportDiagnostic,
            ...(reportedFailure?.status === undefined ? {} : { http_status: reportedFailure.status })
          }
        }
      };
    }

    return {
      text,
      resolvedModel: this.#providerModel,
      deltaText: text,
      durationMs: run.durationMs,
      firstDeltaMs: null,
      items: {},
      tokenUsageEvents,
      transcripts,
      diagnostics: {
        opencode: {
          session_export: exportDiagnostic
        }
      }
    };
  }

  #attemptEvidence(
    parsedRun: ParsedRunEvents,
    exportEvent: { type: string; data: OpenCodeExport } | null,
    sessionId: string,
    usage: OpenCodeUsage
  ): { tokenUsageEvents: TokenUsageEvent[]; transcripts: EngineTranscriptArtifact[] } {
    const usageEvent = usage.breakdown === null
      ? null
      : this.#usageEvent(sessionId, usage.breakdown, usage.breakdown, usage.cost);
    const events = exportEvent === null ? parsedRun.events : [...parsedRun.events, exportEvent];
    return {
      tokenUsageEvents: usageEvent === null ? [] : [usageEvent],
      transcripts: events.length === 0 ? [] : [{
        filename: OPENCODE_TRANSCRIPT.filename,
        format: "jsonl",
        source: OPENCODE_TRANSCRIPT.source,
        content: transcriptContent(events),
        ...(parsedRun.sessionId !== null ? { sessionId: parsedRun.sessionId } : {})
      }]
    };
  }

  async close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#abortController.abort();
      try {
        await this.#settlement?.catch(() => undefined);
      } finally {
        this.#onClose?.(this);
      }
    })();
    await this.#closePromise;
  }

  /**
   * Attribution identity for a token-bearing stream that named no session:
   * unique per invocation, and visibly synthetic so a consumer never
   * mistakes it for a real opencode session id.
   */
  #syntheticSessionId(): string {
    return `opencode-no-session-${randomUUID()}`;
  }

  #reportUsage(sessionId: string, total: TokenUsageBreakdown, cost: unknown): TokenUsageEvent | null {
    const last = subtractUsage(total, this.#reportedUsage);
    if (last.totalTokens === 0) {
      return null;
    }
    this.#reportedUsage = total;
    const event = this.#usageEvent(sessionId, last, total, cost);
    if (event === null) {
      return null;
    }
    this.#onEvent?.({
      method: "thread/tokenUsage/updated",
      params: event.raw,
      receivedAt: Date.now()
    });
    return event;
  }

  #usageEvent(
    sessionId: string,
    last: TokenUsageBreakdown,
    total: TokenUsageBreakdown,
    cost: unknown
  ): TokenUsageEvent | null {
    if (total.totalTokens === 0) {
      return null;
    }
    this.#budgetEventCounter += 1;
    const turnId = `${sessionId}:opencode-${this.#budgetEventCounter}`;
    const event = {
      threadId: sessionId,
      turnId,
      last,
      total,
      raw: {
        threadId: sessionId,
        turnId,
        model: this.#modelKey,
        providerModel: this.#providerModel,
        tokenUsage: { last, total },
        cost
      }
    };
    return event;
  }

  #buildPrompt(previousFailure: PreviousAttemptFailure | undefined): string {
    return openingPrompt({
      task: this.#prompt,
      ...(this.#options.schema !== undefined ? { schema: this.#options.schema } : {}),
      ...(previousFailure !== undefined ? { previousFailure } : {})
    });
  }
}

function stoppedBeforeLaunch(): OpenCodeRunResult {
  return { exitCode: null, signal: "SIGTERM", stdout: "", stderr: "", durationMs: 0 };
}

async function runProcess(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  commands: CommandContainment | undefined,
  timeoutMs: number | undefined,
  killGraceMs: number,
  abortSignal?: AbortSignal,
  onFirstData?: () => void,
  onData?: (chunk: string) => void,
  onCommandStop?: (stop: CommandStop) => void
): Promise<OpenCodeRunResult> {
  const startedAt = Date.now();
  if (abortSignal?.aborted) {
    return stoppedBeforeLaunch();
  }
  // The default registry supplies run-owned containment. A standalone runner
  // owns the same machinery for this command and closes it before returning.
  const scopes = commands === undefined ? await createWorkerScopes() : undefined;
  const containment = commands ?? new CommandContainment(scopes!);
  try {
    const command = await containment.contain(`opencode ${args[0]}`, file, args, {
      cwd, env, stdio: ["ignore", "pipe", "pipe"]
    });
    return await collectProcess(command, startedAt, timeoutMs, killGraceMs, args[0] === "run", abortSignal, onFirstData, onData, onCommandStop);
  } finally {
    if (scopes !== undefined) {
      try {
        await containment.close();
      } finally {
        await scopes.close();
      }
    }
  }
}

/** Stop ownership before waiting for pipes: a descendant may hold them open. */
function collectProcess(
  command: ContainedCommand,
  startedAt: number,
  timeoutMs: number | undefined,
  killGraceMs: number,
  watchWhitespace: boolean,
  abortSignal?: AbortSignal,
  onFirstData?: () => void,
  onData?: (chunk: string) => void,
  onCommandStop?: (stop: CommandStop) => void
): Promise<OpenCodeRunResult> {
  return new Promise((resolve, reject) => {
    const child = command.child;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    // Placement is asynchronous. The command may have exited and its pipes
    // closed before containment handed it back, so events alone are not a
    // complete lifecycle account.
    let exited = child.exitCode !== null || child.signalCode !== null;
    let closed = exited && (child.stdout?.closed ?? true) && (child.stderr?.closed ?? true);
    let stopped = false;
    let deadlineExpired = false;
    let whitespaceLimitReached = false;
    let stopping: Promise<void> | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let processError: Error | undefined;
    let exitCode: number | null = child.exitCode;
    let exitSignal: NodeJS.Signals | null = child.signalCode;

    let streamBuffer = "";
    const whitespace = watchWhitespace ? new WhitespaceStream(startedAt, () => {
      whitespaceLimitReached = true;
      stop();
    }) : null;

    const settle = (): void => {
      if (settled || !stopped || !closed) return;
      settled = true;
      clearTimeout(drainTimer);
      abortSignal?.removeEventListener("abort", terminate);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // An unconfirmed stop must not leave the child's handle holding up the
      // run's diagnostic. The attempt or run accounts for the stop.
      child.unref();
      if (processError !== undefined) {
        reject(processError);
      } else {
        resolve({ exitCode, signal: exitSignal, stdout: stdout.join(""), stderr: stderr.join(""),
          durationMs: Date.now() - startedAt, deadlineExpired, whitespaceLimitReached });
      }
    };
    const stop = (): void => {
      whitespace?.clear();
      clearTimeout(timeout);
      stopping ??= command.stop({ stopGraceMs: killGraceMs, confirmMs: DEFAULT_STOP_BOUNDS.confirmMs }).then((observation) => {
        // Delivery precedes settlement, so errors and ordinary results alike
        // retain the account. The engine passes an attempt-local collector.
        onCommandStop?.(observation);
        stopped = true;
        // Even an unavailable/refused scope or an unconfirmed stop cannot
        // let an escaped pipe holder block the run's teardown report.
        if (!closed) {
          drainTimer = setTimeout(() => { closed = true; settle(); }, 1_000);
        }
        settle();
      });
    };
    const terminate = (): void => {
      if (!settled) stop();
    };
    // Exit ends execution time; draining a completed process is not a timeout.
    const timeout = timeoutMs === undefined || exited ? undefined : setTimeout(() => {
      if (!settled && !exited) {
        deadlineExpired = true;
        stop();
      }
    }, timeoutMs);

    let firstDataSeen = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (!firstDataSeen) {
        firstDataSeen = true;
        try { onFirstData?.(); } catch { /* Observability cannot fail a worker. */ }
      }
      try { onData?.(chunk); } catch { /* Live accounting cannot fail a worker. */ }
      stdout.push(chunk);
      if (whitespace !== null && stopping === undefined) {
        streamBuffer += chunk;
        const lines = streamBuffer.split(/\r?\n/);
        streamBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseRunEvent(line);
          const text = runTextPart(event);
          if (text !== null) {
            whitespace.observeText(text);
          } else if (isRecord(event) && (event.type === "tool_use" || event.type === "reasoning")) {
            whitespace.observeActivity();
          }
        }
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", (error) => {
      processError = error;
      stop();
    });
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      // A normally exited engine can leave live shell commands behind too.
      stop();
    });
    child.on("close", (code, signal) => {
      closed = true;
      exitCode = code;
      exitSignal = signal;
      stop();
      settle();
    });
    abortSignal?.addEventListener("abort", terminate, { once: true });
    if (exited) stop();
    // Containment setup is asynchronous; cancellation can race the hand-off.
    if (abortSignal?.aborted) terminate();
  });
}

function parseRunEvents(stdout: string): ParsedRunEvents {
  const events: unknown[] = [];
  let sessionId: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseRunEvent(line);
    if (event === undefined) continue;
    events.push(event);
    const candidate = sessionIdFromEvent(event);
    if (candidate !== null) sessionId = candidate;
  }
  return { events, sessionId };
}

function parseRunEvent(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { type: "raw", text: line };
  }
}

function sessionIdFromEvent(event: unknown): string | null {
  if (!isRecord(event)) {
    return null;
  }
  const direct = event.sessionID ?? event.sessionId;
  if (typeof direct === "string") {
    return direct;
  }
  const nested = event.session;
  if (isRecord(nested) && typeof nested.id === "string") {
    return nested.id;
  }
  return null;
}

function parseExport(output: string): ParsedExport {
  const start = output.indexOf("{");
  if (start < 0) {
    return { ok: false, error: "export output did not contain a JSON object" };
  }
  try {
    const value = JSON.parse(output.slice(start)) as unknown;
    return isRecord(value)
      ? { ok: true, data: value as OpenCodeExport }
      : { ok: false, error: "export JSON root was not an object" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function finalAssistantText(exportData: OpenCodeExport): string {
  if (!Array.isArray(exportData.messages)) {
    return "";
  }
  for (let index = exportData.messages.length - 1; index >= 0; index -= 1) {
    const message = exportData.messages[index];
    if (!isRecord(message) || !isRecord(message.info) || message.info.role !== "assistant") {
      continue;
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const text = parts
      .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join("");
    if (text.trim().length > 0) {
      return text;
    }
  }
  return "";
}

function runTextPart(event: unknown): string | null {
  if (!isRecord(event) || event.type !== "text" || !isRecord(event.part)) return null;
  return event.part.type === "text" && typeof event.part.text === "string" ? event.part.text : null;
}

function fallbackText(events: unknown[]): string {
  let currentStepText: string[] | null = null;
  let finalStoppedStepText = "";
  for (const event of events) {
    if (!isRecord(event) || !isRecord(event.part)) {
      continue;
    }
    if (event.type === "step_start" && event.part.type === "step-start") {
      currentStepText = [];
      continue;
    }
    const text = runTextPart(event);
    if (text !== null) {
      // A message may stream in several text parts; retaining the step boundary
      // prevents earlier tool-progress narration from becoming the answer.
      if (currentStepText === null && finalStoppedStepText.length > 0) {
        continue;
      }
      currentStepText ??= [];
      currentStepText.push(text);
      continue;
    }
    if (event.type === "step_finish" && event.part.type === "step-finish") {
      if (event.part.reason === "stop" && currentStepText !== null) {
        const stoppedStepText = currentStepText.join("");
        // A later housekeeping step may stop without emitting an answer. It
        // must not erase the last completed text-bearing assistant step.
        if (stoppedStepText.trim().length > 0) {
          finalStoppedStepText = stoppedStepText;
        }
      }
      currentStepText = null;
    }
  }
  if (finalStoppedStepText.length > 0) {
    return finalStoppedStepText;
  }
  const inProgressText = currentStepText?.join("") ?? "";
  if (inProgressText.length > 0) {
    return inProgressText;
  }

  // Retain compatibility with older event shapes after trying the current
  // opencode JSON stream contract above.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event)) {
      continue;
    }
    if (typeof event.text === "string") {
      return event.text;
    }
    if (typeof event.message === "string") {
      return event.message;
    }
  }
  return "";
}

function usageFromExport(exportData: OpenCodeExport): TokenUsageBreakdown | null {
  const messageTokens: unknown[] = [];
  if (Array.isArray(exportData.messages)) {
    for (const message of exportData.messages) {
      if (isRecord(message) && isRecord(message.info) && message.info.role === "assistant") {
        messageTokens.push(message.info.tokens);
      }
    }
  }
  return aggregateOpenCodeUsage(messageTokens) ?? aggregateOpenCodeUsage([exportData.info?.tokens]);
}

function usageFromStream(events: unknown[]): OpenCodeUsage {
  const stepTokens: unknown[] = [];
  let cost: number | null = null;
  for (const event of events) {
    if (
      !isRecord(event) ||
      event.type !== "step_finish" ||
      !isRecord(event.part) ||
      event.part.type !== "step-finish"
    ) {
      continue;
    }
    stepTokens.push(event.part.tokens);
    const stepCost = numberValue(event.part.cost);
    if (stepCost !== null) {
      cost = (cost ?? 0) + stepCost;
    }
  }
  return { breakdown: aggregateOpenCodeUsage(stepTokens), cost };
}

function openCodeTokenSnapshot(tokens: unknown): OpenCodeTokenSnapshot | null {
  if (!isRecord(tokens)) {
    return null;
  }
  const inputTokens = numberField(tokens, "input");
  const outputTokens = numberField(tokens, "output");
  const reasoningOutputTokens = numberField(tokens, "reasoning");
  const cache = tokens.cache;
  const cacheReadTokens = isRecord(cache) ? numberField(cache, "read") : null;
  const cacheCreationInputTokens = isRecord(cache) ? numberField(cache, "write") : null;
  const cachedInputTokens =
    cacheReadTokens === null && cacheCreationInputTokens === null
      ? null
      : (cacheReadTokens ?? 0) + (cacheCreationInputTokens ?? 0);
  const reportedTotal = numberField(tokens, "total");
  if (
    inputTokens === null &&
    outputTokens === null &&
    reasoningOutputTokens === null &&
    cachedInputTokens === null &&
    reportedTotal === null
  ) {
    return null;
  }
  return {
    cachedInputTokens: cachedInputTokens ?? 0,
    ...(cacheCreationInputTokens === null ? {} : { cacheCreationInputTokens }),
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    reasoningOutputTokens: reasoningOutputTokens ?? 0,
    reportedTotal,
    hasCategorisedTokens:
      cachedInputTokens !== null ||
      inputTokens !== null ||
      outputTokens !== null ||
      reasoningOutputTokens !== null
  };
}

function aggregateOpenCodeUsage(tokenSnapshots: unknown[]): TokenUsageBreakdown | null {
  let sawUsage = false;
  let cachedInputTokens = 0;
  let cacheCreationInputTokens: number | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let uncategorisedTokens = 0;
  for (const tokens of tokenSnapshots) {
    const snapshot = openCodeTokenSnapshot(tokens);
    if (snapshot === null) {
      continue;
    }
    sawUsage = true;
    // opencode 1.18.5's captured multi-step stream restates input/cache for
    // each model step while output/reasoning are new deltas. Charge the final
    // input/cache snapshot once and every generated delta, matching Claude's
    // convention. See test/fixtures/opencode/multi-step-tool-calls.jsonl.
    cachedInputTokens = snapshot.cachedInputTokens;
    cacheCreationInputTokens = snapshot.cacheCreationInputTokens;
    inputTokens = snapshot.inputTokens;
    outputTokens += snapshot.outputTokens;
    reasoningOutputTokens += snapshot.reasoningOutputTokens;
    if (!snapshot.hasCategorisedTokens && snapshot.reportedTotal !== null) {
      uncategorisedTokens += snapshot.reportedTotal;
    }
  }
  if (!sawUsage) {
    return null;
  }
  const totalTokens =
    cachedInputTokens + inputTokens + outputTokens + reasoningOutputTokens + uncategorisedTokens;
  return {
    cachedInputTokens,
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function openCodeFailureMessage(run: OpenCodeRunResult, events: unknown[]): string {
  const eventError = events.map(errorFromEvent).find((message) => message !== null);
  if (eventError !== undefined && eventError !== null) {
    return `opencode run failed: ${eventError.message}`;
  }
  const stderr = run.stderr.trim();
  if (stderr.length > 0) {
    return `opencode run failed: ${stderr}`;
  }
  return `opencode run failed with exit code ${run.exitCode ?? `signal ${run.signal ?? "unknown"}`}`;
}

interface OpenCodeReportedFailure {
  message: string;
  status?: number;
}

function reportedRunFailure(events: unknown[], exportData: OpenCodeExport | null, text: string): OpenCodeReportedFailure | null {
  const eventError = events.map(errorFromEvent).find((message) => message !== null);
  if (eventError !== undefined) {
    return eventError;
  }
  const messages = Array.isArray(exportData?.messages) ? exportData.messages.filter(isRecord) : [];
  const assistantMessages = messages.filter((message) => isRecord(message.info) && message.info.role === "assistant");
  const lastAssistant = assistantMessages.at(-1);
  const assistantError = isRecord(lastAssistant?.info) ? errorFromEvent(lastAssistant.info) : null;
  if (assistantError !== null) {
    return assistantError;
  }
  // Tool errors can be recovered within a turn. Only attribute an empty
  // answer to a failed tool when it is the last tool the worker reported.
  if (text.trim().length > 0) {
    return null;
  }
  const exportedTools = assistantMessages
    .flatMap((message) => Array.isArray(message.parts) ? message.parts : [])
    .filter((part) => isRecord(part) && part.type === "tool");
  const streamedTools = events
    .flatMap((event) => isRecord(event) && isRecord(event.part) && event.part.type === "tool" ? [event.part] : []);
  const lastTool: unknown = exportedTools.at(-1) ?? streamedTools.at(-1);
  if (!isRecord(lastTool) || !isRecord(lastTool.state) || lastTool.state.status !== "error") {
    return null;
  }
  const tool = typeof lastTool.tool === "string" ? lastTool.tool : "unknown";
  const error = typeof lastTool.state.error === "string" ? lastTool.state.error : "no diagnostic reported";
  return { message: `tool ${tool} failed: ${error}` };
}

function errorFromEvent(event: unknown): OpenCodeReportedFailure | null {
  if (!isRecord(event)) {
    return null;
  }
  const error = event.error;
  if (typeof error === "string") {
    return { message: error };
  }
  if (isRecord(error)) {
    const data = error.data;
    if (isRecord(data) && typeof data.message === "string") {
      return {
        message: data.message,
        ...(error.name === "APIError" && typeof data.statusCode === "number" ? { status: data.statusCode } : {})
      };
    }
    if (typeof error.message === "string") {
      return { message: error.message };
    }
    if (typeof error.name === "string") {
      return { message: error.name };
    }
  }
  return null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  return numberValue(record[key]);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
