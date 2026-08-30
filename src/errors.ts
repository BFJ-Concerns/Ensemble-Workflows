export class EnsembleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The exempt pre-spawn author-error family. The combinators deliberately
 * collapse runtime worker failures to `null`, but any rejection the runtime
 * raises *before a worker spawns* — from any hook — propagates out of
 * `parallel()`/`pipeline()` and fails the run: a fan-out of
 * identically-invalid calls would otherwise return an array of nulls that
 * `.filter(Boolean)` turns into a silent empty success with no worker ever
 * run. The membership is a criterion — any rejection raised before a worker
 * spawns — not a closed list: a new pre-spawn rejection joins by extending
 * this class, and the combinators and the CLI's clean-line rendering pick it
 * up with no further change.
 */
export class PreSpawnAuthorError extends EnsembleError {}

/** A workflow-authored agent option that the runtime cannot honour. */
export class AgentOptionRejectedError extends PreSpawnAuthorError {}

/**
 * A workflow script path that cannot be read — missing, a directory, or
 * unreadable. Pre-spawn by construction: the script's source is the first
 * thing a run needs, so nothing has been dispatched when the read fails,
 * and the author's fix is the path itself — the message names it and what
 * the filesystem said, never a raw errno stack.
 */
export class WorkflowScriptReadError extends PreSpawnAuthorError {}

/**
 * Terminalisation invariant: whatever ends a turn, the text the worker had
 * produced travels with the failure instead of dying with the turn state.
 * The carrier is a plain property so any error class can carry it without
 * changing its hierarchy; attachment never overwrites an earlier value, so
 * the text closest to the turn wins over a later re-wrap.
 */
interface PartialWorkerTextCarrier {
  partialWorkerText?: string;
}

export function attachPartialWorkerText<T extends Error>(error: T, text: string): T {
  const carrier = error as T & PartialWorkerTextCarrier;
  if (text.length > 0 && carrier.partialWorkerText === undefined) {
    carrier.partialWorkerText = text;
  }
  return error;
}

export function partialWorkerTextOf(error: unknown): string | null {
  if (error instanceof Error) {
    const text = (error as PartialWorkerTextCarrier).partialWorkerText;
    if (typeof text === "string" && text.length > 0) {
      return text;
    }
  }
  return null;
}

/**
 * The app-server's own account of a failed request or notification. This is
 * deliberately a sibling evidence carrier, not an extension of the partial
 * worker-text carrier: engine diagnostics and worker output are different
 * facts with different producers.
 */
export interface AppServerDiagnostic {
  code: number | string | null;
  message: string;
  payload: string;
}

interface AppServerDiagnosticCarrier {
  appServerDiagnostic?: AppServerDiagnostic;
}

export function attachAppServerDiagnostic<T extends Error>(error: T, diagnostic: AppServerDiagnostic): T {
  const carrier = error as T & AppServerDiagnosticCarrier;
  if (carrier.appServerDiagnostic === undefined) {
    carrier.appServerDiagnostic = diagnostic;
  }
  return error;
}

export function appServerDiagnosticOf(error: unknown): AppServerDiagnostic | null {
  if (error instanceof Error) {
    return (error as AppServerDiagnosticCarrier).appServerDiagnostic ?? null;
  }
  return null;
}

/**
 * How a worker process actually died, when the engine observed it. A sibling
 * carrier to the partial-text one above, and deliberately not a generalised
 * metadata channel: it carries exactly the evidence the contract names — the
 * exit status or terminating signal — so a killed leg is distinguishable from
 * one that returned nothing. Attachment never overwrites an earlier value,
 * so the observation closest to the process wins over a later re-wrap.
 */
export interface WorkerExitStatus {
  exitCode: number | null;
  signal: string | null;
}

interface WorkerExitStatusCarrier {
  workerExitStatus?: WorkerExitStatus;
}

export function attachWorkerExitStatus<T extends Error>(error: T, exit: WorkerExitStatus): T {
  const carrier = error as T & WorkerExitStatusCarrier;
  if ((exit.exitCode !== null || exit.signal !== null) && carrier.workerExitStatus === undefined) {
    carrier.workerExitStatus = exit;
  }
  return error;
}

export function workerExitStatusOf(error: unknown): WorkerExitStatus | null {
  if (error instanceof Error) {
    const exit = (error as WorkerExitStatusCarrier).workerExitStatus;
    if (exit !== undefined) {
      return exit;
    }
  }
  return null;
}

/**
 * The identity an `identity: true` call declared, riding an operational
 * failure out of `agent()` so a combinator's collapse can keep it (an
 * identified leg's failure resolves `{ label, phase, output: null }`, never
 * bare `null`). A sibling carrier to the ones above, and deliberately not a
 * general metadata channel: it carries exactly the identity the envelope
 * needs, only on calls that opted in. Attachment never overwrites an earlier
 * value, so the identity closest to the failing call wins over a later
 * re-wrap.
 */
export interface AgentCallIdentity {
  label: string | null;
  phase: string | null;
}

interface AgentIdentityCarrier {
  agentCallIdentity?: AgentCallIdentity;
}

export function attachAgentIdentity<T extends Error>(error: T, identity: AgentCallIdentity): T {
  const carrier = error as T & AgentIdentityCarrier;
  if (carrier.agentCallIdentity === undefined) {
    carrier.agentCallIdentity = identity;
  }
  return error;
}

export function agentIdentityOf(error: unknown): AgentCallIdentity | null {
  if (error instanceof Error) {
    return (error as AgentIdentityCarrier).agentCallIdentity ?? null;
  }
  return null;
}

export class AppServerExitedError extends EnsembleError {}

export class AppServerRequestError extends EnsembleError {
  readonly code: number | string | undefined;
  readonly data?: unknown;

  constructor(method: string, error: { code: number | string | undefined; message: string | undefined; data?: unknown }) {
    const code = error.code === undefined ? "" : ` (${String(error.code)})`;
    const data = error.data === undefined ? "" : `; data: ${renderDiagnostic(error.data)}`;
    super(`${method} failed${code}: ${error.message ?? "unknown app-server error"}${data}`, { cause: error });
    this.code = error.code;
    this.data = error.data;
  }
}

export class AppServerBackpressureError extends AppServerRequestError {}

export class AppServerOverloadedError extends AppServerRequestError {}

export class AppServerRetryPromiseBrokenError extends AppServerRequestError {}

/** A terminal app-server status whose service-window failures are transient. */
export class AppServerSystemError extends AppServerRequestError {}

/** A started turn that produced no output-bearing frame before its transport deadline. */
export class AppServerFirstOutputTimeoutError extends EnsembleError {
  constructor(timeoutMs: number) {
    super(`codex app-server turn did not deliver its first output-bearing frame within ${timeoutMs}ms`);
  }
}

export class AppServerStartupTimeoutError extends EnsembleError {
  constructor(timeoutMs: number) {
    super(`codex app-server initialize handshake timed out after ${timeoutMs}ms`);
  }
}

/**
 * Codex validates `outputSchema` against its own accepted subset before
 * generation. This is not the same failure as an agent returning JSON that does
 * not satisfy the user's schema, so keep it loud and distinguishable.
 */
export class CodexSchemaSubsetUnsupportedError extends EnsembleError {
  readonly code: number | string | undefined;
  readonly data?: unknown;

  constructor(
    error: { code: number | string | undefined; message: string | undefined; data?: unknown },
    diagnostic?: AppServerDiagnostic
  ) {
    const engineDiagnostic =
      diagnostic === undefined
        ? ""
        : ` App-server diagnostic (${String(diagnostic.code)}): ${diagnostic.message}; data: ${diagnostic.payload}`;
    super(
      "Codex rejected outputSchema before generation: the schema is outside Codex's accepted subset or malformed. " +
        "Use a schema supported by Codex outputSchema, or run the workflow on an engine that validates the full JSON Schema client-side." +
        engineDiagnostic,
      { cause: error }
    );
    this.code = error.code;
    this.data = error.data;
  }
}

export class BudgetExceededError extends EnsembleError {
  constructor(engine: string, total: number, spent: number) {
    super(`Token budget exhausted for ${engine}: spent ${spent} of ${total} tokens`);
  }
}

export class MissingEngineError extends AgentOptionRejectedError {
  constructor() {
    super("agent() requires an engine field: use engine: 'codex', engine: 'claude', or engine: 'opencode'");
  }
}

export class UnknownEngineError extends AgentOptionRejectedError {
  constructor(engine: unknown) {
    super(`Unknown agent engine ${JSON.stringify(engine)}; expected 'codex', 'claude', or 'opencode'`);
  }
}

export class EngineNotImplementedError extends EnsembleError {}

/** Rejection for work still queued (never started) when its engine shuts down. */
export class EngineShutdownError extends EnsembleError {
  constructor(engine: string) {
    super(`${engine} engine is shutting down`);
  }
}

export class EmptyAgentOutputError extends EnsembleError {}

/**
 * Base for *operational* failures of a Claude background worker — dispatch
 * died, polling timed out, the worker stalled past the recovery bound, the
 * valve couldn't inject, the transcript couldn't be read. The Claude engine
 * catches these and degrades to a graceful failed turn (the shared loop turns
 * that into `null` for a schema agent, or the empty-output error after the
 * bounded attempts for a text agent). It never lets one hang. A failure that
 * is *not* a `ClaudeWorkerError` is a genuine bug and propagates.
 */
export class ClaudeWorkerError extends EnsembleError {}

export class ClaudeDispatchError extends ClaudeWorkerError {}

export class ClaudePollTimeoutError extends ClaudeWorkerError {}

/** The background session registered but never produced a transcript at all. */
export class ClaudeFirstLifeTimeoutError extends ClaudeWorkerError {}

export class ClaudeBlockedError extends ClaudeWorkerError {}

export class ClaudeValveError extends ClaudeWorkerError {}

export class ClaudeTranscriptError extends ClaudeWorkerError {}

/**
 * The daemon reports the session settled, but its transcript never proved the
 * turn complete and holds no final assistant text to collect. Collection
 * failure must be loud: the alternative is a poll loop spinning silently
 * behind a worker that will never say more.
 */
export class ClaudeCollectionError extends ClaudeWorkerError {}

export class OpenCodeModelRequiredError extends AgentOptionRejectedError {
  constructor(registered: readonly string[]) {
    super(
      `agent({ engine:'opencode' }) requires a model from the curated opencode registry; expected one of ${registered
        .map((name) => JSON.stringify(name))
        .join(", ")}`
    );
  }
}

export class OpenCodeModelNotRegisteredError extends AgentOptionRejectedError {
  constructor(model: string, registered: readonly string[]) {
    super(
      `OpenCode model ${JSON.stringify(model)} is not registered; expected one of ${registered.map((name) => JSON.stringify(name)).join(", ")}`
    );
  }
}

function renderDiagnostic(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch (error) {
    return `[unrenderable diagnostic: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

export class WorktreePlacementRejectedError extends AgentOptionRejectedError {
  constructor(cwd: string, options?: ErrorOptions) {
    super(`isolation:'worktree' requires cwd to be inside a git repository: ${cwd}`, options);
  }
}

export class TurnTimeoutError extends EnsembleError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when a workflow asks a non-Claude engine to honour `fallbackModel`.
 * Only the Claude CLI exposes a fallback-model switch; silently dropping the
 * option would let a script believe its degradation policy was in force.
 */
export class FallbackModelUnsupportedError extends AgentOptionRejectedError {
  constructor(engine: string) {
    super(
      `fallbackModel is not supported on the ${engine} engine in v1: ` +
        "only the Claude engine exposes a fallback-model switch. " +
        "Remove fallbackModel, or use engine:'claude' for declared degradation."
    );
  }
}

/**
 * Thrown before any worker spawns when a requested capability strip cannot
 * be enforced through the target engine's own configuration surface. A
 * restriction the author asked for and did not get is exactly the silent
 * no-op the options invariant exists to prevent — the worker must not
 * dispatch unrestricted.
 */
export class CapabilityStripUnsupportedError extends AgentOptionRejectedError {
  constructor(engine: string, capability: string, detail: string) {
    super(
      `the ${engine} engine cannot strip the ${JSON.stringify(capability)} capability: ${detail}. ` +
        "The worker was not dispatched. Remove the strip request, or use an engine that can enforce it."
    );
  }
}

export class RemovedAgentOptionError extends AgentOptionRejectedError {
  constructor(option: string) {
    super(
      `agent() option ${JSON.stringify(option)} was removed: all workers now run unrestricted with filesystem and network access. ` +
        `Remove ${JSON.stringify(option)} from this call.`
    );
  }
}

export class UnrecognisedAgentOptionError extends AgentOptionRejectedError {
  constructor(option: string, recognised: readonly string[]) {
    super(
      `Unrecognised agent() option ${JSON.stringify(option)}; expected one of ${recognised
        .map((name) => JSON.stringify(name))
        .join(", ")}`
    );
  }
}

export class InvalidAgentOptionValueError extends AgentOptionRejectedError {
  constructor(option: string, value: unknown, expected: string) {
    super(
      `Invalid agent() option ${JSON.stringify(option)} value ${formatAgentOptionValue(value)}; expected ${expected}`
    );
  }
}

/**
 * Thrown by `agent()` before any worker spawns when the requested schema does
 * not compile as JSON Schema. Failing fast here beats paying for a full turn
 * only to discover the schema at validation time.
 */
export class InvalidAgentSchemaError extends AgentOptionRejectedError {
  constructor(message: string, options?: ErrorOptions) {
    super(`agent schema does not compile as JSON Schema: ${message}`, options);
  }
}

function formatAgentOptionValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") {
    return String(value);
  }
  if (typeof value === "bigint") {
    return `${String(value)}n`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
