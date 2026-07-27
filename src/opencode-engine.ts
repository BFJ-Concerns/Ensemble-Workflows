import { spawn } from "node:child_process";

import { assertFallbackModelSupported } from "./engine-option-validation.js";
import {
  OpenCodeRunError,
  OpenCodeWorktreeIsolationUnsupportedError
} from "./errors.js";

import type { EngineAttemptContext, EngineAttemptFailure, EngineInvocation, EngineTurnOptions } from "./engines.js";
import type { RuntimeEvent, TokenUsageBreakdown, TokenUsageEvent, TurnResult } from "./types.js";

export interface OpenCodeRunner {
  run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult>;
  exportSession(sessionId: string, cwd: string): Promise<OpenCodeSessionExportResult>;
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
}

export interface OpenCodeRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface OpenCodeEngineInvocationOptions {
  prompt: string;
  cwd: string;
  providerModel: string;
  modelKey: string;
  options: EngineTurnOptions;
  runner?: OpenCodeRunner;
  onEvent?: (event: RuntimeEvent) => void;
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

  constructor(bin = "opencode", options: { killGraceMs?: number } = {}) {
    this.#bin = bin;
    this.#killGraceMs = options.killGraceMs ?? 5_000;
  }

  async run(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
    const args = [
      "run",
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
    return runProcess(this.#bin, args, options.cwd, options.timeoutMs, this.#killGraceMs);
  }

  async exportSession(sessionId: string, cwd: string): Promise<OpenCodeSessionExportResult> {
    const result = await runProcess(this.#bin, ["export", sessionId], cwd, 30_000, this.#killGraceMs);
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
  #budgetEventCounter = 0;

  constructor(options: OpenCodeEngineInvocationOptions) {
    this.#prompt = options.prompt;
    this.#cwd = options.cwd;
    this.#providerModel = options.providerModel;
    this.#modelKey = options.modelKey;
    this.#options = options.options;
    this.#runner = options.runner ?? new OpenCodeCliRunner();
    this.#onEvent = options.onEvent;
  }

  async runAttempt(context: EngineAttemptContext): Promise<TurnResult> {
    const run = await this.#runner.run({
      prompt: this.#buildPrompt(context.previousFailure),
      cwd: this.#cwd,
      providerModel: this.#providerModel,
      ...(this.#options.timeoutMs !== undefined ? { timeoutMs: this.#options.timeoutMs } : {}),
      ...(this.#options.effort !== undefined ? { variant: this.#options.effort } : {})
    });
    const parsedRun = parseRunEvents(run.stdout);
    let exportData: OpenCodeExport | null = null;
    let exportDiagnostic: OpenCodeExportDiagnostic;
    if (parsedRun.sessionId === null) {
      exportDiagnostic = { status: "no-session-id" };
    } else {
      const exportResult = await this.#runner.exportSession(parsedRun.sessionId, this.#cwd);
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
    const fallback = fallbackText(parsedRun.events);
    let text = fallback;
    if (exportData !== null) {
      const exportedText = finalAssistantText(exportData);
      if (exportedText.trim().length > 0) {
        text = exportedText;
      } else {
        exportDiagnostic = { status: "unusable", error: "export did not contain assistant text" };
      }
    }
    const usage =
      exportData === null
        ? usageFromStream(parsedRun.events)
        : {
            breakdown: usageFromExport(exportData),
            cost: exportData.info?.cost ?? null
          };
    const usageEvent =
      parsedRun.sessionId === null || usage.breakdown === null
        ? null
        : this.#usageEvent(parsedRun.sessionId, usage.breakdown, usage.cost);
    const transcripts = [
      {
        filename: "transcript.opencode.jsonl",
        format: "jsonl" as const,
        source: "opencode run --format json",
        content: transcriptContent(run.stdout, exportData),
        ...(parsedRun.sessionId !== null ? { sessionId: parsedRun.sessionId } : {})
      }
    ];

    if (run.exitCode !== 0) {
      throw new OpenCodeRunError(openCodeFailureMessage(run, parsedRun.events));
    }

    return {
      text,
      resolvedModel: this.#providerModel,
      deltaText: text,
      durationMs: run.durationMs,
      firstDeltaMs: null,
      items: {},
      tokenUsageEvents: usageEvent === null ? [] : [usageEvent],
      transcripts,
      diagnostics: {
        opencode: {
          session_export: exportDiagnostic
        }
      }
    };
  }

  #usageEvent(sessionId: string, breakdown: TokenUsageBreakdown, cost: unknown): TokenUsageEvent | null {
    if (breakdown.totalTokens === 0) {
      return null;
    }
    this.#budgetEventCounter += 1;
    const turnId = `${sessionId}:opencode-${this.#budgetEventCounter}`;
    const event = {
      threadId: sessionId,
      turnId,
      last: breakdown,
      total: breakdown,
      raw: {
        threadId: sessionId,
        turnId,
        model: this.#modelKey,
        providerModel: this.#providerModel,
        tokenUsage: { last: breakdown, total: breakdown },
        cost
      }
    };
    this.#onEvent?.({
      method: "thread/tokenUsage/updated",
      params: event.raw,
      receivedAt: Date.now()
    });
    return event;
  }

  #buildPrompt(previousFailure: EngineAttemptFailure | undefined): string {
    const lines: string[] = [
      "You are an automated worker dispatched by the Ensemble orchestration harness.",
      "Work fully autonomously: never ask for confirmation or permission, and do not pause to ask questions - make a reasonable decision and finish the task."
    ];
    if (this.#options.schema !== undefined) {
      lines.push(
        "When finished, include in your FINAL message a JSON value that conforms to this JSON Schema. You may surround the value with prose, explanation, or markdown code fences:",
        JSON.stringify(this.#options.schema)
      );
    }
    if (previousFailure !== undefined) {
      lines.push(`A previous attempt failed (${previousFailure.kind}): ${previousFailure.message}. Correct it this time.`);
    }
    lines.push("", "Task:", this.#prompt);
    return lines.join("\n");
  }
}

export function rejectUnsupportedOpenCodeOptions(options: EngineTurnOptions): void {
  if (options.isolation === "worktree") {
    throw new OpenCodeWorktreeIsolationUnsupportedError();
  }
  assertFallbackModelSupported("opencode", options.fallbackModel);
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number | undefined,
  killGraceMs = 5_000
): Promise<OpenCodeRunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    let killEscalation: NodeJS.Timeout | undefined;
    // No timeoutMs → the subprocess is not killed on a deadline; it runs to completion.
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGTERM");
            // A worker that ignores SIGTERM would hang the turn despite the
            // deadline; escalate after a grace period.
            killEscalation = setTimeout(() => {
              child.kill("SIGKILL");
            }, killGraceMs);
            killEscalation.unref();
          }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killEscalation);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killEscalation);
      resolve({
        exitCode,
        signal,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        durationMs: Date.now() - startedAt
      });
    });
  });
}

function parseRunEvents(stdout: string): ParsedRunEvents {
  const events: unknown[] = [];
  let sessionId: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as unknown;
      events.push(event);
      const candidate = sessionIdFromEvent(event);
      if (candidate !== null) {
        sessionId = candidate;
      }
    } catch {
      events.push({ type: "raw", text: line });
    }
  }
  return { events, sessionId };
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
    if (event.type === "text" && event.part.type === "text" && typeof event.part.text === "string") {
      // A message may stream in several text parts; retaining the step boundary
      // prevents earlier tool-progress narration from becoming the answer.
      if (currentStepText === null && finalStoppedStepText.length > 0) {
        continue;
      }
      currentStepText ??= [];
      currentStepText.push(event.part.text);
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
  const cachedInputTokens = isRecord(cache) ? numberField(cache, "read") : null;
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
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function transcriptContent(stdout: string, exportData: OpenCodeExport | null): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (exportData !== null) {
    lines.push(JSON.stringify({ type: "session/export", data: exportData }));
  }
  return `${lines.join("\n")}\n`;
}

function openCodeFailureMessage(run: OpenCodeRunResult, events: unknown[]): string {
  const eventError = events.map(errorFromEvent).find((message) => message !== null);
  if (eventError !== undefined && eventError !== null) {
    return `opencode run failed: ${eventError}`;
  }
  const stderr = run.stderr.trim();
  if (stderr.length > 0) {
    return `opencode run failed: ${stderr}`;
  }
  return `opencode run failed with exit code ${run.exitCode ?? `signal ${run.signal ?? "unknown"}`}`;
}

function errorFromEvent(event: unknown): string | null {
  if (!isRecord(event)) {
    return null;
  }
  const error = event.error;
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error)) {
    const data = error.data;
    if (isRecord(data) && typeof data.message === "string") {
      return data.message;
    }
    if (typeof error.message === "string") {
      return error.message;
    }
    if (typeof error.name === "string") {
      return error.name;
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
