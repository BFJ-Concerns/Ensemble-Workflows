import type { EngineAttemptResult } from "./engines.js";
import type { EngineTranscriptArtifact } from "./types.js";

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
 * A tally the runtime cannot record: a blank name or a value that is
 * not a finite number. Pre-spawn in the family's sense — the author's own
 * call is what is wrong, and a fan-out that recorded an unusable tally
 * must fail rather than archive a count that means nothing.
 */
export class TallyRejectedError extends PreSpawnAuthorError {}

/**
 * An engine's substrate refused the dispatch before any worker existed —
 * Claude Code declining to start a background session, a daemon that will
 * not come up. Pre-spawn by the family's criterion — a substrate that exits
 * or refuses before the worker exists is a rejection raised before a worker
 * spawns — though the remedy is the launch environment's rather than the
 * script's. The runtime records the refused dispatch with its availability
 * class, spends no attempt on it, advances the call's fallback chain where
 * an entry remains, and otherwise lets it propagate — through the
 * combinators, out of the run — so a run can never lose a whole engine
 * family to identical refusals and still end `complete`. Members name the
 * substrate that refused.
 */
export class SubstrateRefusedError extends PreSpawnAuthorError {}

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

/** The transcript observed by a turn that ended before completion. */
interface PartialTranscriptCarrier {
  partialTranscript?: EngineTranscriptArtifact;
}

export function attachPartialTranscript<T extends Error>(error: T, transcript: EngineTranscriptArtifact): T {
  const carrier = error as T & PartialTranscriptCarrier;
  if (carrier.partialTranscript === undefined) {
    carrier.partialTranscript = transcript;
  }
  return error;
}

export function partialTranscriptOf(error: unknown): EngineTranscriptArtifact | null {
  return error instanceof Error ? (error as PartialTranscriptCarrier).partialTranscript ?? null : null;
}

/** First answer delta timing observed before a failed turn was discarded. */
interface FirstDeltaMsCarrier {
  firstDeltaMs?: number;
}

export function attachFirstDeltaMs<T extends Error>(error: T, firstDeltaMs: number): T {
  const carrier = error as T & FirstDeltaMsCarrier;
  if (carrier.firstDeltaMs === undefined) {
    carrier.firstDeltaMs = firstDeltaMs;
  }
  return error;
}

export function firstDeltaMsOf(error: unknown): number | null {
  return error instanceof Error ? (error as FirstDeltaMsCarrier).firstDeltaMs ?? null : null;
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
 * The remedy for a Codex pre-generation schema rejection. The alternative
 * names the engines an author can move the call to — Codex is the one that
 * refused.
 */
export const CODEX_SCHEMA_REJECTION_REMEDY =
  "Use a schema within Codex's outputSchema subset, or run this agent on engine 'claude' or 'opencode', which validate the full JSON Schema client-side.";

/**
 * The diagnostic's payload with every string that restates the diagnostic's
 * message replaced by a pointer back to it. The app-server routinely echoes
 * its message inside `data`, and rendering both puts the same diagnostic in
 * front of the reader twice — once readable, once as an escaped JSON string.
 * The payload's other fields stay; a payload that only restated the message
 * renders as "". An unparseable payload is returned unchanged.
 */
export function payloadBesideMessage(diagnostic: AppServerDiagnostic): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(diagnostic.payload);
  } catch {
    return diagnostic.payload;
  }
  const message = diagnostic.message.trim();
  const restates = (value: string) => {
    const trimmed = value.trim();
    return trimmed.length > 0 && (trimmed === message || (trimmed.length >= 32 && message.endsWith(trimmed)));
  };
  let replaced = false;
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string" && restates(value)) {
      replaced = true;
      return "(the diagnostic above)";
    }
    if (depth > 16 || value === null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1));
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, depth + 1)]));
  };
  const rendered = walk(parsed, 0);
  if (!replaced) {
    return diagnostic.payload;
  }
  return rendered === "(the diagnostic above)" ? "" : JSON.stringify(rendered);
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
      diagnostic === undefined ? "" : ` App-server diagnostic (${String(diagnostic.code)}): ${diagnostic.message}`;
    const payload = diagnostic === undefined ? "" : payloadBesideMessage(diagnostic);
    super(
      "Codex rejected outputSchema before generation: the schema is outside Codex's accepted subset or malformed. " +
        CODEX_SCHEMA_REJECTION_REMEDY +
        engineDiagnostic +
        (payload === "" ? "" : `; data: ${payload}`),
      { cause: error }
    );
    this.code = error.code;
    this.data = error.data;
  }
}

/**
 * A token budget refused to start an agent. A ceiling of 0 never ran out —
 * it admitted nothing from the start — so it says that rather than
 * describing a spend that never happened.
 */
export class BudgetExceededError extends EnsembleError {
  readonly engine: string;
  readonly total: number;
  readonly spent: number;

  constructor(engine: string, total: number, spent: number) {
    super(
      total === 0
        ? `Token budget for ${engine} is 0, which admits no agent: this agent was not started`
        : `Token budget exhausted for ${engine}: spent ${spent} of ${total} tokens`
    );
    this.engine = engine;
    this.total = total;
    this.spent = spent;
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

/**
 * Base for *operational* failures of a Claude background worker that
 * existed — polling timed out, the worker stalled past the recovery bound,
 * the valve couldn't inject, the transcript couldn't be read. The Claude
 * engine catches these and degrades to a graceful failed turn, which the
 * shared loop spends an attempt on and retries within the bound, resolving
 * `null` at exhaustion on either call shape. It never lets one hang. A
 * dispatch Claude Code refused is not a member: no worker existed, so it is
 * a `ClaudeDispatchError` on the pre-spawn side. Any other failure that is
 * *not* a `ClaudeWorkerError` is not degraded by the engine: it propagates to
 * the runtime as the attempt's thrown failure — spent, retried within the
 * bound, and resolved `null` at exhaustion — so a genuine bug is legible on
 * the record and the failure notice rather than swallowed.
 */
export class ClaudeWorkerError extends EnsembleError {}

/**
 * `claude --bg` exited non-zero and no session was registered under the
 * dispatch's name: Claude Code declined before a session existed. The
 * message names the placed directory and the declaration, and carries Claude
 * Code's own text bounded to one line, because the remedy lives in the
 * launch environment — the operator reads it off the run's failure, never
 * off a `null`. A dispatch the daemon accepted but never registered is not
 * a refusal: see `ClaudeRegistrationTimeoutError`.
 */
export class ClaudeDispatchError extends SubstrateRefusedError {}

/**
 * The Codex app-server could not serve a thread for this attempt because
 * the substrate itself never started or is already gone — the handshake
 * timed out, the process exited or failed to spawn — so no worker existed
 * — a substrate that exits or refuses before the worker exists is pre-spawn.
 * A `thread/start` the running server *rejected* is the server answering and
 * is not a member: that stays the attempt's own failure. The cause is kept
 * whole, and the app-server's exit evidence rides the carrier as it rode the
 * cause.
 */
export class CodexSubstrateRefusedError extends SubstrateRefusedError {
  /**
   * `detail` is the cause as the raising site presents it — the diagnosis
   * seam's rendering where one exists (how the server died, its last stderr
   * kept whole and control-stripped), the cause's message otherwise — so the
   * refusal line the run fails on carries the same evidence the failure
   * notice would have.
   */
  constructor(cwd: string | undefined, cause: Error, detail: string = cause.message) {
    super(`Codex app-server could not serve a thread${cwd === undefined ? "" : ` in ${cwd}`}: ${detail}`, { cause });
  }
}

export class ClaudePollTimeoutError extends ClaudeWorkerError {}

/** The background session registered but never produced a transcript at all. */
export class ClaudeFirstLifeTimeoutError extends ClaudeWorkerError {}

/**
 * The daemon accepted the dispatch (`claude --bg` returned) but no session
 * appeared in the roster within the dispatch bound. Not a refusal: Claude
 * Code did not decline, and a session the roster has not yet surfaced may
 * exist — so this is an operational failure, spent and retried within the
 * attempt bound like a poll deadline, and the dispatch bound is the lever.
 */
export class ClaudeRegistrationTimeoutError extends ClaudeWorkerError {}

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
    super(`agent({ engine:'opencode' }) requires a model from the opencode registry; ${registeredOpenCodeModels(registered)}`);
  }
}

export class OpenCodeModelNotRegisteredError extends AgentOptionRejectedError {
  constructor(model: string, registered: readonly string[]) {
    super(`OpenCode model ${JSON.stringify(model)} is not registered; ${registeredOpenCodeModels(registered)}`);
  }
}

/** The registry's names, or — when it has none — where the operator declares them. */
function registeredOpenCodeModels(registered: readonly string[]): string {
  return registered.length > 0
    ? `expected one of ${registered.map((name) => JSON.stringify(name)).join(", ")}`
    : "no opencode models are declared; declare them under opencode_models in the machine configuration ($XDG_CONFIG_HOME/ensemble/config.json)";
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
 * Thrown before any worker spawns when a fallback chain is malformed
 * or names a target the harness will not dispatch to. A chain that cannot
 * be honoured must fail at declaration, not on the day it first advances:
 * a fallback nobody exercises is exactly the silent no-op the options
 * invariant forbids.
 */
export class FallbackTargetRejectedError extends AgentOptionRejectedError {
  constructor(detail: string) {
    super(`Invalid fallback chain: ${detail}`);
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
      option === "fallbackModel"
        ? 'agent() option "fallbackModel" was removed: the Claude-only engine-side model swap is retired. ' +
            "Declare an ordered fallback chain instead — `fallback: [{ engine, model, effort? }, …]` — " +
            "which the harness advances on every engine and records in the run record."
        : `agent() option ${JSON.stringify(option)} was removed: all workers now run unrestricted with filesystem and network access. ` +
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

/** One pre-spawn rejection for all option faults found on a single agent() call. */
export class InvalidAgentOptionsError extends AgentOptionRejectedError {
  constructor(errors: readonly AgentOptionRejectedError[]) {
    super(`Invalid agent() options: ${errors.map((error) => error.message).join("; ")}`);
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

/** A schema cycle the selected local path cannot compile is rejected before a worker spawns. */
export class CyclicAgentSchemaError extends InvalidAgentSchemaError {
  constructor(location: string, firstSeenAt: string, kind: "object" | "reference" = "object") {
    super(kind === "object"
      ? `object-reference cycle at ${location} (back to ${firstSeenAt}); replace the object link with a JSON Schema $ref`
      : `JSON Schema $ref cycle at ${location} (back to ${firstSeenAt}); make a reference lead through a concrete schema constraint`);
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
 * The durable run record could not start: its directory could not be
 * created or its opening artefacts could not be written. An operational
 * failure of the run (recording was enabled, so the run has no archive),
 * rendered cause-first in one line; the filesystem error rides `cause`.
 */
export class RunRecordStartError extends EnsembleError {
  constructor(readonly storeDir: string, cause: unknown) {
    super(
      `the durable run record could not start under ${storeDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }

  /** The path the store was creating or writing when it failed, as the filesystem error names it. */
  get blockedPath(): string {
    const named = (this.cause as { path?: unknown } | undefined)?.path;
    return typeof named === "string" ? named : this.storeDir;
  }

  /** The failing filesystem call (`mkdir`, `open`, …) and its error code, where the cause carries them. */
  get filesystemFailure(): { syscall: string | null; code: string | null } {
    const cause = this.cause as { syscall?: unknown; code?: unknown } | undefined;
    return {
      syscall: typeof cause?.syscall === "string" ? cause.syscall : null,
      code: typeof cause?.code === "string" ? cause.code : null
    };
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
