import { HoldTimeoutError, PreSpawnAuthorError, appServerDiagnosticOf, workerExitStatusOf } from "./errors.js";
import { WorkflowTimeoutError } from "./script-runner.js";

import type { RuntimeAgentRecord } from "./run-record.js";

/**
 * The translation layer from "an exception reached the top" to "what went
 * wrong and what to do": post-spawn operational failures present a concise
 * operator diagnosis — cause first, internals available beneath, never a
 * stack into the signal handler as the default surface. Author errors keep
 * their own clean-line family; a genuinely unknown error falls through to
 * the caller's stack rendering, because hiding an undiagnosed failure's
 * internals would trade evidence for tidiness.
 */

export interface TerminalPresentationContext {
  /** The run's archive directory when recording was on; names where internals live. */
  archiveDir: string | null;
  /** The last settled agent record — the per-attempt evidence an exhausted direct agent leaves. */
  lastAgentRecord: RuntimeAgentRecord | null;
}

/** One operator-facing diagnosis: a cause-first line, then indented detail lines. */
export function presentTerminalError(error: unknown, context: TerminalPresentationContext): string | null {
  const lines = diagnose(error, context);
  if (lines === null) {
    return null;
  }
  const [first, ...detail] = lines;
  return [first, ...detail.map((line) => `  ${line}`)].join("\n");
}

function diagnose(error: unknown, context: TerminalPresentationContext): string[] | null {
  if (isInterrupt(error)) {
    return [
      `Interrupted (${error.signal}) — partial result on stdout${recordSuffix(context)}`
    ];
  }
  if (error instanceof WorkflowTimeoutError) {
    return [`${error.message} — partial result on stdout${recordSuffix(context)}`];
  }
  if (error instanceof Error && error.name === "SingleAgentFailedError") {
    // The archive holds precise per-attempt failures and the worker's own
    // diagnosis; withholding them behind a bare class name made the
    // operator open the archive to learn what stderr already knew.
    const lines = [error.message];
    for (const attempt of context.lastAgentRecord?.attempts ?? []) {
      if (attempt.failure !== null) {
        const diagnosis = attempt.rawOutput === null ? "" : bounded(attempt.rawOutput);
        const workerDiagnosis = diagnosis === "" ? "" : `; worker diagnosis: ${diagnosis}`;
        lines.push(
          `attempt ${attempt.attempt} (${attempt.failure.kind}): ${bounded(attempt.failure.message)}${workerDiagnosis}`
        );
      }
    }
    const record = context.lastAgentRecord;
    if (context.archiveDir !== null && record !== null) {
      lines.push(`full attempt evidence: ${context.archiveDir}/agents/${String(record.id).padStart(6, "0")}/agent.json`);
    }
    return lines;
  }
  const argListLimit = findErrorCode(error, "E2BIG");
  if (argListLimit) {
    // The only universally honest remedy is a shorter prompt: which
    // engines take the prompt through argv (and so hit this limit) is
    // dispatch machinery the operator cannot re-route per call.
    return [
      "Prompt exceeds the platform's argument-size limit (E2BIG) — shorten the prompt (this engine passes it as a process argument)"
    ];
  }
  if (error instanceof Error && error.name === "AppServerExitedError") {
    // Discriminate how the server died from the evidence the error already
    // carries, rather than presenting one generic class for interrupt,
    // termination, and crash alike. The message itself is kept whole in
    // the detail lines: the server's own last words routinely carry the
    // actionable cause (a fixture's validation failure, a stderr tail),
    // and truncating them would trade evidence for tidiness.
    const exit = workerExitStatusOf(error);
    const how =
      exit?.signal !== null && exit?.signal !== undefined
        ? `terminated by ${exit.signal}`
        : exit?.exitCode !== null && exit?.exitCode !== undefined
          ? `exited with code ${exit.exitCode}`
          : "exited unexpectedly";
    const lines = [`Codex app-server ${how}`, ...error.message.split("\n")];
    const diagnostic = appServerDiagnosticOf(error);
    if (diagnostic !== null) {
      lines.push(`server diagnostic: ${diagnostic.message}`);
    }
    return lines;
  }
  if (error instanceof HoldTimeoutError || error instanceof PreSpawnAuthorError) {
    // Already clean-line families; the caller's formatError owns them.
    return null;
  }
  return null;
}

function recordSuffix(context: TerminalPresentationContext): string {
  return context.archiveDir !== null ? `; record: ${context.archiveDir}` : "";
}

function bounded(text: string, limit = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function isInterrupt(error: unknown): error is Error & { signal: string } {
  // WorkflowInterruptedError lives with the CLI's interrupt watcher;
  // matching it structurally here avoids a module cycle without weakening
  // the check below name + evidence.
  return (
    error instanceof Error &&
    error.name === "WorkflowInterruptedError" &&
    typeof (error as { signal?: unknown }).signal === "string"
  );
}

function findErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if ((current as NodeJS.ErrnoException).code === code || current.message.includes(code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
