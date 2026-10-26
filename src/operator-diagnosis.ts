import {
  BudgetExceededError,
  CODEX_SCHEMA_REJECTION_REMEDY,
  CodexSchemaSubsetUnsupportedError,
  EngineShutdownError,
  HoldTimeoutError,
  PreSpawnAuthorError,
  RunRecordStartError,
  TurnTimeoutError,
  agentIdentityOf,
  appServerDiagnosticOf,
  payloadBesideMessage,
  workerExitStatusOf
} from "./errors.js";
import { AmbientConfigError } from "./ambient-settings.js";

import type { RuntimeAgentRecord } from "./run-record.js";

/**
 * The translation layer from "an exception reached the top" to "what went
 * wrong and what to do": post-spawn operational failures present a concise
 * operator diagnosis — cause first, internals available beneath, never a
 * stack into the signal handler as the default surface. Author errors keep
 * their own clean-line family; a genuinely unknown error falls through to
 * the caller's stack rendering, because hiding an undiagnosed failure's
 * internals would trade evidence for tidiness.
 *
 * This module is the one seam every operator-facing failure surface calls —
 * the CLI's terminal catch, its early configuration catch, the teardown
 * lines, and the combinators' per-leg failure logs — so a failure class
 * gains its rendering here once, not per surface.
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

/**
 * The context-free rendering for surfaces that have no archive pointer or
 * last-record accessor to offer — the combinators' per-leg logs, the
 * teardown lines, the pre-run configuration catch. Same seam, same lines,
 * minus the salvage pointers only the terminal catch can name.
 */
export function presentOperationalError(error: unknown): string | null {
  return presentTerminalError(error, { archiveDir: null, lastAgentRecord: null });
}

function diagnose(error: unknown, context: TerminalPresentationContext): string[] | null {
  if (isInterrupt(error)) {
    return [
      `Interrupted (${error.signal}) — partial result on stdout${recordSuffix(context)}`
    ];
  }
  if (isWorkflowTimeout(error)) {
    return [`${error.message} — partial result on stdout${recordSuffix(context)}`];
  }
  if (isScriptProcessEnding(error)) {
    // The run's own process was ended from inside the run window — a
    // `process.exit` from the body, or an exception nothing caught (the
    // script's, or the launcher's own) — and the run is settled as a
    // failure with the ordinary envelope, record, and sentinel. The message
    // already names which; the stack behind it points into the launcher.
    return [`${error.message} — partial result on stdout${recordSuffix(context)}`];
  }
  if (error instanceof RunRecordStartError) {
    return [error.message];
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
        // A failure kind from the attempt vocabulary (`empty-output`) tells
        // the operator what went wrong; one that is an internal error class
        // name tells them nothing the message does not, so it stays in the
        // archive.
        const kind = INTERNAL_CLASS_NAME.test(attempt.failure.kind) ? "" : ` (${attempt.failure.kind})`;
        lines.push(`attempt ${attempt.attempt}${kind}: ${bounded(attempt.failure.message)}${workerDiagnosis}`);
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
  if (error instanceof AmbientConfigError) {
    // The message already names the layer and the remedy; the stack behind
    // it is harness interior, useful to nobody fixing a config value.
    return [`Configuration error: ${error.message}`];
  }
  if (error instanceof CodexSchemaSubsetUnsupportedError) {
    // Cause and remedy first; the app-server's diagnostic once, bounded —
    // the server echoes its message inside the data field, and the echo is
    // dropped so the diagnostic reaches the reader once.
    const lines = [
      "Codex rejected outputSchema before generation: the schema is outside Codex's accepted subset or malformed.",
      CODEX_SCHEMA_REJECTION_REMEDY
    ];
    const diagnostic = appServerDiagnosticOf(error);
    if (diagnostic !== null) {
      const rest = payloadBesideMessage(diagnostic);
      const payload = rest.trim().length === 0 ? "" : `; data: ${bounded(rest)}`;
      lines.push(`server diagnostic (${String(diagnostic.code)}): ${bounded(diagnostic.message)}${payload}`);
    }
    return lines;
  }
  if (error instanceof BudgetExceededError) {
    // A budget refusal is the operator's own threshold doing its job: the
    // remedy is the threshold, and the stack behind it is harness interior.
    return [
      error.message,
      `Raise the ${error.engine} threshold (--budget ${error.engine}=<tokens>, or budgetCeilings.${error.engine} in library use), or remove it to run without one.`
    ];
  }
  if (error instanceof EngineShutdownError) {
    // Reached the operator only because the run was already ending: the
    // leg was interrupted by teardown, not failed by its own work — a
    // stack here points into the author's parallel() call and lies.
    return [`${error.message} — this worker was interrupted by the run ending, not by its own failure`];
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
        ? `was killed by ${exit.signal}`
        : exit?.exitCode !== null && exit?.exitCode !== undefined
          ? `exited with code ${exit.exitCode}`
          : "stopped unexpectedly";
    // The server's message is kept whole but stripped of terminal
    // control: its stderr tail is engine-controlled bytes, and evidence
    // preservation never licenses control injection. A one-line message
    // rides the cause line in brackets so the death is stated once; a
    // longer one (a stderr tail) follows as detail.
    const message = stripControl(error.message).trim();
    const [firstLine, ...rest] = message.split("\n");
    const lines = [
      `the Codex engine process ${how}${firstLine === undefined || firstLine === "" ? "" : ` (${firstLine})`}, so the worker had no engine to run on`,
      ...rest,
      "Nothing in the workflow caused this: re-run it; if it recurs, check that `codex app-server` starts on this machine and that memory is not exhausted (an out-of-memory kill arrives as SIGKILL)."
    ];
    const diagnostic = appServerDiagnosticOf(error);
    if (diagnostic !== null) {
      lines.push(`server diagnostic: ${stripControl(diagnostic.message)}`);
    }
    return lines;
  }
  if (error instanceof TurnTimeoutError) {
    // One class, two deadlines with different levers, discriminated from the
    // evidence the error carries rather than one line that fits only half of
    // it: the turn deadline is the author's own `timeoutMs` on this call, so
    // naming it is actionable; the request deadline is the transport's wait
    // for an app-server reply, which no `agent()` option lengthens, so the
    // same advice there would send the operator to a knob that cannot move.
    // (The handshake's request timeout never arrives here — the transport
    // rethrows that one as AppServerStartupTimeoutError, whose own remedy is
    // starting the server, not waiting longer.)
    const deadline = error.deadline;
    const lines =
      deadline.kind === "turn"
        ? [
            `Worker exceeded its per-agent turn deadline of ${deadline.timeoutMs}ms — the worker was stopped, not the run: raise or remove timeoutMs on this agent() call, or narrow the work it asks for`
          ]
        : [
            `Codex app-server did not answer ${bounded(deadline.method)} within the transport's ${deadline.timeoutMs}ms request deadline — the server stopped responding; this is not the agent's timeoutMs and raising it will not help`,
            "Check that the codex binary is healthy and the machine is not saturated, then re-run."
          ];
    // The identity an `identity: true` call declared is the only handle that
    // points back at the author's own call site. Where none was declared,
    // the harness knows no label, and the line says less rather than
    // inventing one.
    const identity = agentIdentityOf(error);
    const label = identity?.label;
    if (label !== null && label !== undefined) {
      const phase = identity?.phase;
      const phaseSuffix = phase === null || phase === undefined ? "" : ` (phase ${bounded(phase)})`;
      lines.push(`call: ${bounded(label)}${phaseSuffix}`);
    } else if (deadline.kind === "turn") {
      lines.push(`thread: ${bounded(deadline.threadId)}`);
    }
    return lines;
  }
  if (error instanceof HoldTimeoutError || error instanceof PreSpawnAuthorError) {
    // Already clean-line families; the caller's formatError owns them.
    return null;
  }
  return null;
}

/** An error class name (`CodexSchemaSubsetUnsupportedError`), as opposed to an attempt-vocabulary kind. */
const INTERNAL_CLASS_NAME = /^[A-Z][A-Za-z0-9]*Error$/;

function recordSuffix(context: TerminalPresentationContext): string {
  return context.archiveDir !== null ? `; record: ${context.archiveDir}` : "";
}

/**
 * Terminal-control sequences a worker's output could smuggle onto the
 * operator's stderr: OSC (title/clipboard/hyperlink writes, BEL- or
 * ST-terminated), CSI (cursor and erase control), the remaining
 * single-character ESC dispatches, and stray BEL. Worker output is data,
 * never terminal input, so these are stripped before any bounded excerpt
 * is rendered.
 */
const TERMINAL_CONTROL_SEQUENCES =
  // eslint-disable-next-line no-control-regex -- the control characters are the subject of the strip
  /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B\[[0-?]*[ -/]*[@-~]?|\u001B[@-_]?|\u0007/g;

/** Strip only — for evidence kept whole that must still never carry terminal control. */
function stripControl(text: string): string {
  return text.replace(TERMINAL_CONTROL_SEQUENCES, "");
}

function bounded(text: string, limit = 400): string {
  const flat = stripControl(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * The one-line excerpt discipline for worker- or engine-controlled text on
 * an operator surface: terminal control stripped, whitespace flattened,
 * bounded — for a notice line whose full evidence lives in the archive.
 */
export function boundedEvidence(text: string, limit = 400): string {
  return bounded(text, limit);
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

function isScriptProcessEnding(error: unknown): error is Error {
  // Both classes live with the CLI's run-ending watch; structural for the
  // same cycle-avoidance reason as the interrupt match.
  return (
    error instanceof Error &&
    (error.name === "WorkflowProcessExitError" || error.name === "WorkflowUncaughtExceptionError")
  );
}

function isWorkflowTimeout(error: unknown): error is Error {
  // Structural for the same cycle-avoidance reason as the interrupt match:
  // this module is imported by the combinators, which the script runner
  // (WorkflowTimeoutError's home) itself imports.
  return error instanceof Error && error.name === "WorkflowTimeoutError";
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
