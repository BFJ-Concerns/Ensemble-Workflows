import type { StrippableCapability } from "./capability-stripping.js";

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

export interface AgentOptions {
  engine: EngineName;
  schema?: JsonSchema;
  model?: string;
  effort?: string;
  /** Claude only: declared degradation when the pinned model tier is unavailable. */
  fallbackModel?: string;
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
}

/** The identified resolution shape `identity: true` opts a call into. */
export interface IdentifiedAgentResult {
  label: string | null;
  phase: string | null;
  output: unknown;
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
  firstDeltaTimeoutMs?: number;
  startupHandshakeTimeoutMs?: number;
  /**
   * Machine-declared per-engine worker environment (the config file's
   * `worker_environment` section). Injected values override inherited ones
   * for the declared engine's workers only, so one engine's settings never
   * reach another's workers.
   */
  workerEnvironment?: EngineWorkerEnvironment;
  /**
   * Run-wide capability strip: united with every call's own `strip`
   * list before enforcement, so a run can restrict all its workers without
   * each call restating it. Union only — a call cannot lift a run-wide
   * strip.
   */
  strip?: StrippableCapability[];
  defaultTurnTimeoutMs?: number;
  defaultMaxAttempts?: number;
  clientName?: string;
  clientVersion?: string;
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
  reasoningOutputTokens: number;
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
  threadId?: string;
  sessionId?: string;
}

export interface TurnResult {
  text: string;
  resolvedModel?: string;
  resolvedEffort?: string;
  itemText?: string;
  deltaText: string;
  durationMs: number | null;
  firstDeltaMs: number | null;
  items: Record<string, number>;
  tokenUsageEvents: TokenUsageEvent[];
  transcripts?: EngineTranscriptArtifact[];
  /** Engine-specific operational evidence retained by the durable attempt record. */
  diagnostics?: JsonObject;
}

export interface TurnStartOptions {
  schema?: JsonSchema;
  model?: string;
  effort?: string;
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
}

export interface RuntimeTransport {
  readonly cwd: string;
  openThread(options: ThreadStartOptions): Promise<string>;
  runTurn(threadId: string, prompt: string, options: TurnStartOptions): Promise<TurnResult>;
  close(): Promise<void>;
}
