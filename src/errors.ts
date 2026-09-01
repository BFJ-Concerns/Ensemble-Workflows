import type { EngineAttemptResult } from "./engines.js";

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

/** An agent prompt that cannot be meaningfully sent to a worker. */
export class AgentPromptRejectedError extends PreSpawnAuthorError {}

/**
 * A per-call working directory that cannot be used for worker placement.
 * This is pre-spawn: accepting it would let the engine substitute an
 * unspecified directory while the run record claims the requested one.
 */
export class AgentCwdRejectedError extends PreSpawnAuthorError {}

/**
 * A workflow script path that cannot be read — missing, a directory, or
 * unreadable. Pre-spawn by construction: the script's source is the first
 * thing a run needs, so nothing has been dispatched when the read fails,
 * and the author's fix is the path itself — the message names it and what
 * the filesystem said, never a raw errno stack.
 */
export class WorkflowScriptReadError extends PreSpawnAuthorError {}

/**
 * A hold the runtime cannot raise: malformed options, or a raise after the
 * run began closing. Pre-spawn in the family's sense — nothing was asked of
 * anyone, and the author's fix is the call itself.
 */
export class HoldRejectedError extends PreSpawnAuthorError {}

/**
 * An optional per-hold timeout expired with no accepted answer. An
 * operational bound, not an authoring mistake — deliberately outside the
 * pre-spawn family (like WorkflowTimeoutError), rendered as one clean line;
 * a script that treats expiry as an outcome catches it.
 */
export class HoldTimeoutError extends EnsembleError {
  constructor(holdId: string, timeoutAt: string) {
    super(`hold ${holdId} timed out unanswered${timeoutAt.length > 0 ? ` at ${timeoutAt}` : ""}`);
  }
}

/**
 * A multi-turn worker session requested on an engine that does not hold
 * sessions open across turns. Pre-spawn by the options invariant: an engine
 * held at its one-shot surface (opencode, deliberately) must throw before any
 * worker spawns rather than silently dispatch a fresh session per send.
 */
export class MultiTurnUnsupportedError extends AgentOptionRejectedError {
  constructor(engine: string) {
    super(
      `engine '${engine}' does not support multi-turn worker sessions — ` +
        "create the session on 'claude' or 'codex', or use one-shot agent() calls"
    );
  }
}

/**
 * A send on a worker session that has already been closed (explicitly, or by
 * the run ending). Pre-spawn: nothing was dispatched, and the author's fix
 * is the call ordering.
 */
export class SessionClosedError extends PreSpawnAuthorError {
  constructor() {
    super("this worker session is closed; create a new session to continue");
  }
}

/**
 * A send on a worker session whose previous turn has not settled. A session
 * is one conversation: turns are strictly sequential, and overlapping sends
 * would interleave prompts into one transcript with no defined attribution.
 * Pre-spawn: the second send is rejected before anything is dispatched.
 */
export class SessionBusyError extends PreSpawnAuthorError {
  constructor() {
    super("this worker session is mid-turn; await the previous send() before sending again");
  }
}

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
 * A thrown terminal interruption keeps the turn result the engine had already
 * assembled. The shared retry loop still receives the same rejection; the
 * recorder alone reads these established result fields for its failed attempt.
 */
interface FailedTurnResultCarrier {
  failedTurnResult?: EngineAttemptResult;
}

export function attachFailedTurnResult<T extends Error>(error: T, result: EngineAttemptResult): T {
  const carrier = error as T & FailedTurnResultCarrier;
  if (carrier.failedTurnResult === undefined) {
    carrier.failedTurnResult = result;
  }
  return error;
}

export function failedTurnResultOf(error: unknown): EngineAttemptResult | null {
  if (error instanceof Error) {
    return (error as FailedTurnResultCarrier).failedTurnResult ?? null;
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
 * identified leg's failure resolves `{ label, phase, output: null, failure }`
 * — the failure field the in-script discrimination reads — never bare
 * `null`). A sibling carrier to the ones above, and deliberately not a
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

/** A terminal app-server status with no protocol-level retryability signal. */
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

/**
 * The turn ended with Claude Code's own diagnostic in place of a model
 * reply — the session never reached a model, so the text on the transcript
 * is the client explaining why (an unknown model, a rejected request), not
 * the worker's answer. Its own kind: promoting that text to an answer would
 * archive a success that never happened, and it is neither a dispatch nor a
 * collection failure.
 */
export class ClaudeWorkerDiagnosticError extends ClaudeWorkerError {}

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

/**
 * Which deadline expired, carried as structure beside the message. One class
 * covers two causes with different operator remedies: a `turn` deadline is
 * the one the author set on the `agent()` call, so that call's `timeoutMs`
 * is the lever; a `request` deadline is the transport's own wait for an
 * app-server reply, which no `agent()` option lengthens — telling an
 * operator to raise `timeoutMs` there would send them to the wrong knob.
 * Diagnosis reads these fields rather than re-parsing the message, so the
 * operator-facing line never couples to prose the harness itself wrote.
 */
export type TurnTimeoutDeadline =
  | { readonly kind: "turn"; readonly timeoutMs: number; readonly threadId: string }
  | { readonly kind: "request"; readonly timeoutMs: number; readonly method: string };

export class TurnTimeoutError extends EnsembleError {
  readonly deadline: TurnTimeoutDeadline;

  constructor(message: string, deadline: TurnTimeoutDeadline) {
    super(message);
    this.deadline = deadline;
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
 * Thrown when reading an option's value throws — a getter or a Proxy trap
 * that refuses the read itself, so there is no value to describe. Named as a
 * rejection rather than left to escape: the read happens inside pre-spawn
 * validation, so an unnamed throw surfaces as the value's own error with
 * nothing tying it to the option that carried it, and reaches the operator
 * and the run record as whatever the author's object chose to raise.
 */
export class UnreadableAgentOptionError extends AgentOptionRejectedError {
  constructor(option: string, expected: string, cause: unknown) {
    super(
      `Invalid agent() option ${JSON.stringify(option)}: reading its value threw, so it has no value to judge; expected ${expected}`,
      { cause }
    );
  }
}

/**
 * Thrown by `agent()` before any worker spawns when the requested schema does
 * not compile as JSON Schema. Failing fast here beats paying for a full turn
 * only to discover the schema at validation time.
 */
export class InvalidAgentSchemaError extends AgentOptionRejectedError {
  constructor(message: string, options?: ErrorOptions & { offending?: unknown }) {
    // The offending value beside the validator's reason: an author fixing
    // "must be object" needs to see what was actually passed, bounded so a
    // pathological schema cannot flood the diagnostic.
    super(
      `agent schema does not compile as JSON Schema: ${message}${renderOffendingSchema(options?.offending)}`,
      options
    );
  }
}

function renderOffendingSchema(offending: unknown): string {
  if (offending === undefined) {
    return "";
  }
  let rendered: string;
  try {
    rendered = JSON.stringify(offending) ?? String(offending);
  } catch {
    rendered = String(offending);
  }
  const bounded = rendered.length > 300 ? `${rendered.slice(0, 300)}…` : rendered;
  return ` (offending schema: ${bounded})`;
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
    // Both routes can be refused by the value itself: `JSON.stringify` runs
    // the object's own key enumeration and `toJSON`, and `String` runs its
    // `Symbol.toPrimitive`/`toString`. A value that throws from either would
    // otherwise replace this rejection with its own opaque throw — the
    // rejection message exists to say why the option was refused, so it
    // reports the value as undescribable rather than failing to be written.
    try {
      return String(value);
    } catch {
      return "[a value that cannot be described]";
    }
  }
}

/**
 * An error described for a durable record: the class name as a
 * discriminating kind, plus the message. The kind is what lets a consumer
 * holding only the archive tell a script bug from an unknown-engine typo
 * from a budget refusal, all of which otherwise read as bare `failed`.
 */
export function describeError(error: unknown): { kind: string; message: string } {
  if (error instanceof Error) {
    return { kind: error.name, message: error.message };
  }
  return { kind: "error", message: String(error) };
}
