import type { StrippableCapability } from "./capability-stripping.js";
import type { OpenCodeModelRegistryEntry } from "./opencode-model-registry.js";

export type JsonObject = Record<string, unknown>;
export type JsonSchema = JsonObject;

export type EngineName = "codex" | "claude" | "opencode";
export type IsolationMode = "worktree";
export type TokenAccountingMode = "last-delta" | "total-cumulative";
export type EngineBudgetCeilings = Partial<Record<EngineName, number | null>>;
export type EngineConcurrencyCaps = Partial<Record<EngineName, number>>;
/**
 * Machine-declared environment variables injected into dispatched workers,
 * scoped per engine. Injected values override inherited ones for that
 * engine's workers; everything undeclared still inherits from the launching
 * process.
 */
export type EngineWorkerEnvironment = Partial<Record<EngineName, Record<string, string>>>;

/**
 * One entry of a fallback chain: a full target — engine and model
 * both named, because a fallback that inherits an ambient default is a
 * substitution nobody chose — with an optional effort that otherwise takes
 * the call's own canonical level, clamped to this engine as any dispatch is.
 */
export interface FallbackTarget {
  engine: EngineName;
  model: string;
  effort?: string;
}

export interface AgentOptions {
  engine: EngineName;
  schema?: JsonSchema;
  model?: string;
  /**
   * Canonical effort level — `minimal | low | medium | high | xhigh` —
   * validated pre-spawn as a harness-owned domain and converted to the
   * engine's native form, clamping to the nearest level the engine
   * offers; the resolved native value lands in the run record. opencode
   * is exempt: its effort names the registry entry's served variants.
   */
  effort?: string;
  /**
   * The ordered fallback chain: full targets the harness re-dispatches
   * this call on, in order, when the current target fails for
   * availability — allowance exhausted, provider overload past its
   * own retry, a substrate that is dead or cannot start. Output failures
   * never advance it. Each entry names its engine and model; an omitted
   * effort takes the call's own. Codex or Claude in any position; an
   * opencode entry is rejected pre-spawn.
   */
  fallback?: FallbackTarget[];
  cwd?: string;
  isolation?: IsolationMode;
  timeoutMs?: number;
  maxAttempts?: number;
  label?: string;
  phase?: string;
  /**
   * Opt-in identified resolution: the call resolves `{ label, phase,
   * output }` instead of the bare output — the same identity the salvage
   * envelope attaches — so a fan-in can filter failures out without losing
   * which worker produced each survivor. Default resolution unchanged.
   */
  identity?: boolean;
  /**
   * Named tool-surface capabilities to strip from this worker, enforced
   * through the engine's own configuration surface. United with the
   * run-wide strip list; an engine that cannot enforce a requested strip
   * fails loud before the worker spawns. Opt-in: an unstripped worker
   * keeps its engine's default tool surface.
   */
  strip?: StrippableCapability[];
  /**
   * Opt-in lean start: the worker begins without the operator's
   * interactive context — user-level rules and instructions, the skill
   * listing, the MCP tool set an interactive session would load — keeping
   * its reach and its engine's built-in tool surface. Combined with the
   * run-wide `lean`; an engine that cannot arrange it fails loud before the
   * worker spawns. A worker nobody asked to be lean is unchanged.
   */
  lean?: boolean;
}

/**
 * Options fixed for a multi-turn worker session's whole life. Engine,
 * model, and effort never vary per turn — changing them would invalidate the
 * session's prompt cache, the asset the capability exists to exploit — and
 * escalation is a fresh dispatch. Everything here is resolved once, at
 * creation; the only per-turn variation is `schema` on `send()`.
 */
export interface WorkerSessionOptions {
  /** `claude` or `codex`; an engine held at its one-shot surface throws before spawn. */
  engine: EngineName;
  model?: string;
  /** Canonical effort level, as for `agent()`; converted once, at creation. */
  effort?: string;
  /**
   * The fallback chain for the session's *creating* turn alone: the
   * engine and model are fixed for the session's life once a target
   * answers, so a later turn's availability failure fails that turn and
   * escalation is a fresh dispatch.
   */
  fallback?: FallbackTarget[];
  cwd?: string;
  isolation?: IsolationMode;
  /** Per-turn deadline applied to every send; same semantics as a one-shot call's. */
  timeoutMs?: number;
  /** Per-turn retry bound applied to every send; same semantics as a one-shot call's. */
  maxAttempts?: number;
  label?: string;
  phase?: string;
  /**
   * Named tool-surface capabilities to strip from the session's worker,
   * enforced once at creation for the session's whole life.
   */
  strip?: StrippableCapability[];
  /** Opt-in lean start for the session's worker, arranged once at creation for its whole life (see `AgentOptions.lean`). */
  lean?: boolean;
  /**
   * The advisory staleness mark: on by default. When false the session
   * never reads stale, whatever its idle gap. The mark is author-facing
   * information only — it never blocks or reroutes a send.
   */
  stalenessMark?: boolean;
}

/**
 * The one per-turn variation a session permits: a restate turn's shape
 * differs from a build turn's, so each `send()` takes its own optional
 * schema under the same validated-return and bounded-retry contract as a
 * one-shot call.
 */
export interface SessionTurnOptions {
  schema?: JsonSchema;
}

/**
 * The identified resolution shape `identity: true` opts a call into. Every
 * resolution wears it — a text answer, a validated object, and the `null`
 * a dispatched worker's failure resolves to alike.
 */
export interface IdentifiedAgentResult {
  label: string | null;
  phase: string | null;
  output: unknown;
  /**
   * The discrimination: `null` on success — a `null` output beside a
   * `null` failure is a worker's genuine answer — and the failure's
   * one-line account when a combinator collapsed this leg, so a fan-in
   * tells a failed worker from one that legitimately answered `null`
   * without parsing logs.
   */
  failure: { message: string } | null;
}

/**
 * The canonical `agent()` call signature — the one overload set every
 * dispatch surface presents: the runtime method, the package-level
 * wrapper, and the typed hooks surface. Declared once so the surfaces
 * cannot drift; each conforms to this interface rather than restating
 * its own copy.
 *
 * Signature order is resolution order: `identity: true` wins over
 * `schema` (an identified schema call resolves the envelope), and the
 * final general signature admits the dynamically-composed options an
 * author builds at runtime — typed as the honest union, narrowed by
 * nothing, resolved by the runtime's own validation.
 */
export interface AgentCallSignature {
  (prompt: string, options: AgentOptions & { identity: true }): Promise<IdentifiedAgentResult>;
  (prompt: string, options: AgentOptions & { schema: JsonSchema }): Promise<unknown | null>;
  (prompt: string, options: AgentOptions & { schema?: undefined }): Promise<string | null>;
  (prompt: string, options: Partial<AgentOptions>): Promise<string | unknown | null>;
}

export interface RuntimeOptions {
  cwd?: string;
  codexBin?: string;
  agentCeiling?: number | null;
  concurrencyCaps?: EngineConcurrencyCaps;
  budgetCeilings?: EngineBudgetCeilings;
  requestTimeoutMs?: number;
  /**
   * Bounds total Codex silence after an in-band retry promise; expiry
   * terminalises the turn. A library-level option like `requestTimeoutMs` —
   * deliberately not a CLI flag or ambient setting. Defaults to 15 minutes.
   */
  retryPromiseSilenceTimeoutMs?: number;
  /**
   * Bounds a started Codex turn's wait for its first output-bearing frame;
   * expiry terminalises the turn. A library-level option like
   * `requestTimeoutMs` — deliberately not a CLI flag or ambient setting.
   * Defaults to 15 minutes.
   */
  firstOutputTimeoutMs?: number;
  startupHandshakeTimeoutMs?: number;
  /**
   * Idle gap after which a Claude multi-turn worker reads stale — the
   * deterministic cliff at the worker's configured prompt-cache TTL (the
   * 1-hour TTL its dispatch injects), past which resuming pays a full
   * uncached re-read. A library-level option like `requestTimeoutMs` —
   * deliberately not a CLI flag or ambient setting — so library callers
   * and tests can reach expiry. Defaults to 1 hour.
   */
  claudeSessionStaleAfterMs?: number;
  /**
   * Idle gap after which a Codex multi-turn worker reads stale — the
   * measured coin-flip point on Codex's cache-decay curve. Same library-only
   * seam as `claudeSessionStaleAfterMs`. Defaults to 60 minutes.
   */
  codexSessionStaleAfterMs?: number;
  /**
   * Machine-declared per-engine worker environment (the config file's
   * `worker_environment` section). Injected values override inherited ones
   * for the declared engine's workers only, so one engine's settings never
   * reach another's workers.
   */
  workerEnvironment?: EngineWorkerEnvironment;
  /**
   * The models opencode workers may name (the config file's
   * `opencode_models` section, or the library caller's own list). Omitted,
   * the opencode engine has no models and every opencode call is refused
   * before its worker spawns.
   */
  openCodeModels?: readonly OpenCodeModelRegistryEntry[];
  /**
   * Run-wide capability strip: united with every call's own `strip`
   * list before enforcement, so a run can restrict all its workers without
   * each call restating it. Union only — a call cannot lift a run-wide
   * strip.
   */
  strip?: StrippableCapability[];
  /**
   * Run-wide lean start: every worker begins without the operator's
   * interactive context, as if each call had asked (`AgentOptions.lean`).
   * Opt-in only — a call cannot lift it.
   */
  lean?: boolean;
  defaultTurnTimeoutMs?: number;
  defaultMaxAttempts?: number;
  clientName?: string;
  clientVersion?: string;
  /**
   * Directory holds are published to and answered in. Shared across
   * runs so open holds are enumerable machine-wide; defaults to
   * `<XDG_DATA_HOME>/ensemble/holds`.
   */
  holdsDir?: string;
  /**
   * The launcher-supplied scope this run's holds publish under: an
   * opaque key — a lead session's own id is a natural value — that confines
   * the scoped listing to one lead's holds. Outranks the inherited
   * `ENSEMBLE_HOLD_SCOPE` environment variable; omitted with no variable
   * set, holds land in the default shared scope.
   */
  holdScope?: string;
  /** Gap between hold decision-file polls; a library/test knob like the timeouts above. */
  holdPollIntervalMs?: number;
}

export interface Budget {
  spent(engine: EngineName): number;
  remaining(engine: EngineName): number;
}

export interface RuntimeEvent {
  method: string;
  params: JsonObject;
  receivedAt: number;
}

export interface TokenUsageBreakdown {
  cachedInputTokens: number;
  /**
   * The portion of `cachedInputTokens` spent *writing* cache rather than
   * reading it, where the engine separates the two (Claude reports
   * `cache_creation_input_tokens` beside `cache_read_input_tokens`).
   * Optional and absent for engines that report a single cached figure —
   * absent means "not separable", never "zero creation".
   */
  cacheCreationInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Reasoning output where the engine reports it separately. Absent means
   * the engine did not report a separable measurement, never zero spend.
   */
  reasoningOutputTokens?: number;
  totalTokens: number;
}

export interface TokenUsageEvent {
  threadId: string;
  turnId: string;
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  raw: JsonObject;
}

export interface EngineTranscriptArtifact {
  filename: string;
  format: "jsonl" | "text";
  source: string;
  content: string;
  /** True when the turn ended before its transcript proved completion. */
  partial?: boolean;
  threadId?: string;
  sessionId?: string;
}

/**
 * A background task a Claude worker started during a turn, and the wait it
 * cost: Claude Code backgrounds a long command (or a Monitor) and lets the
 * model end its turn with an interim message, then re-invokes it when the
 * task ends. The turn is not settled while such a task is outstanding.
 */
export interface BackgroundTaskWait {
  /** Claude Code's own task id, as its tool result and notification name it. */
  taskId: string;
  /** Claude Code's description of the task (the tool call's own description, else its command or name). */
  description: string;
  /** When the harness first observed the task outstanding (ISO 8601). */
  observedAt: string;
  /** When its ending notification was observed, or null where the attempt ended first. */
  endedAt: string | null;
}

/** What a live agent is waiting on right now, as the status snapshot shows it. */
export interface AgentWaitSnapshot {
  kind: "background-task";
  taskId: string;
  description: string;
  /** Epoch ms the wait was first observed. */
  sinceMs: number;
}

export interface TurnResult {
  text: string;
  resolvedModel?: string;
  resolvedEffort?: string;
  /**
   * The background tasks this turn waited on, in the order observed. Only
   * engines whose sessions can background work report it; omission means
   * the engine has no such observation.
   */
  backgroundWaits?: BackgroundTaskWait[];
  itemText?: string;
  deltaText: string;
  durationMs: number | null;
  firstDeltaMs: number | null;
  items: Record<string, number>;
  tokenUsageEvents: TokenUsageEvent[];
  transcripts?: EngineTranscriptArtifact[];
  /**
   * Whether this turn's engine-side transcript capture was still present when
   * the result was assembled. Only engines that own such a capture report it;
   * omission means the runtime has no observation to record.
   */
  transcriptCapture?: "retained" | "lost";
  /** Engine-specific operational evidence retained by the durable attempt record. */
  diagnostics?: JsonObject;
}

export interface TurnStartOptions {
  schema?: JsonSchema;
  model?: string;
  // Omitted → no per-turn deadline (unbounded). There is no default; a backstop
  // is the orchestrator's choice (see the skill's backstop section).
  timeoutMs?: number;
  /**
   * Called once, when the turn's first output-bearing frame arrives — the
   * same frame class that disarms the first-output deadline. Live liveness
   * evidence for a supervisor; never affects the turn's own outcome.
   */
  onFirstOutput?: () => void;
}

export interface ThreadStartOptions {
  cwd?: string;
  /** Requested model for the ephemeral thread whose response reports its resolved identity. */
  model?: string;
  /**
   * Requested reasoning effort for the thread, sent in `thread/start`'s
   * `config` overlay as `model_reasoning_effort`. The response's
   * `reasoningEffort` is then the server's own account of the level the
   * thread runs at — the one place the protocol confirms served effort,
   * which is why the pin rides the thread rather than the turn
   * (`turn/start`'s `effort` override is never echoed back; measured
   * 2026-09-27 against codex-cli 0.157.1).
   */
  effort?: string;
  /**
   * Per-thread configuration overlay, sent as `thread/start`'s `config`
   * field. The app server applies it over the machine's own `config.toml`
   * for this one thread — sibling threads on the same process are
   * unaffected, and the overlay wins over process-level config in both
   * directions. The Codex capability-stripping route rides this
   * (`{ agents: { enabled: false } }` removes the collaboration tool
   * namespace; skills disable bundled skills and deny every name from the
   * app-server's stabilised discovery result); it is sent only when a dispatch
   * asks for it, so an unstripped worker's thread/start stays byte-identical
   * and keeps the machine's own default tool surface.
   */
  threadConfig?: Record<string, unknown>;
}

export interface RuntimeTransport {
  readonly cwd: string;
  /** The Codex app-server's stabilised skill discovery result for a worker cwd. */
  listSkills?(cwd?: string): Promise<readonly string[]>;
  openThread(options: ThreadStartOptions): Promise<string>;
  runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult>;
  close(): Promise<void>;
}
